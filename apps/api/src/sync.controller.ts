/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  AuditRepository,
  DeviceRepository,
  OutboxRepository,
  type RedisConnection,
  SyncRepository,
  TransactionManager,
  type Database
} from '@daja/database';
import type { Logger } from '@daja/observability';
import { requirePermission } from '@daja/security';
import { parseWithSchema, syncLimitSchema, syncPushSchema, uuidSchema } from '@daja/validation';
import { DATABASE, LOGGER, REDIS } from './tokens.js';
import { resolveRequestContext } from './runtime/request-context.js';
import { OperationalSyncProjector } from './operational-sync-projector.js';
import { RealtimeGateway } from './realtime.gateway.js';

const deviceRegisterSchema = z.object({
  deviceKey: z.string().trim().min(8).max(240),
  displayName: z.string().trim().min(1).max(240),
  deviceType: z.enum(['rfiddaja_desktop', 'rfiddaja_mobile', 'pos', 'admin', 'bridge', 'other']),
  locationId: uuidSchema.nullable().optional(),
  offlineAuthorizationExpiresAt: z.string().datetime().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const conflictResolveSchema = z.object({
  strategy: z.enum(['local', 'remote']),
  reason: z.string().trim().min(1).max(2000),
});

@Controller('devices')
export class DeviceController {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(LOGGER) private readonly logger: Logger
  ) {}

  @Post()
  async register(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'admin.users');
    const input = parseWithSchema(deviceRegisterSchema, body);
    return new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      const device = await new DeviceRepository(client).registerDevice(ctx, input);
      await new AuditRepository(client).append({
        ctx,
        aggregateType: 'device',
        aggregateId: device.id,
        operation: 'register',
        afterPayload: device
      });
      return device;
    });
  }
}

@Controller('sync')
export class SyncController {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(REDIS) private readonly redis: RedisConnection,
    private readonly realtime: RealtimeGateway
  ) {}

  @Post('push')
  async push(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'sync.write');
    const input = parseWithSchema(syncPushSchema, body);
    const result = await new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      if (ctx.deviceId) {
        await new DeviceRepository(client).assertActiveDevice(ctx.organizationId, ctx.deviceId);
      }
      const projector = new OperationalSyncProjector(client);
      const results = await new SyncRepository(client).pushBatch(ctx, input.events, (event) =>
        projector.materialize(ctx, event)
      );
      await new OutboxRepository(client).append({
        ctx,
        eventType: 'SyncBatchPushed',
        aggregateType: 'sync_batch',
        aggregateId: input.events[0]!.aggregateId,
        payload: { results }
      });
      return { results, transactionSemantics: 'ordered-per-event' };
    });
    // A desktop-originated catalog change bypasses the staff catalog HTTP
    // controller, so invalidate its public cache and notify open storefronts
    // only after the transaction has committed.
    await this.publishCatalogChanges(ctx.organizationId, input.events, result.results);
    return result;
  }

  private async publishCatalogChanges(
    organizationId: string,
    events: ReadonlyArray<{
      eventId: string;
      aggregateType: string;
      aggregateId: string;
      payload: unknown;
    }>,
    results: ReadonlyArray<{ eventId: string; status: string }>
  ): Promise<void> {
    const appliedEventIds = new Set(
      results.filter((result) => result.status === 'applied').map((result) => result.eventId)
    );
    const commandKind = (payload: unknown): string | undefined => {
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
        return undefined;
      const envelope = payload as Record<string, unknown>;
      if (
        typeof envelope.command !== 'object' ||
        envelope.command === null ||
        Array.isArray(envelope.command)
      ) {
        return undefined;
      }
      const kind = (envelope.command as Record<string, unknown>).kind;
      return typeof kind === 'string' ? kind : undefined;
    };
    const catalogCollectionByCommand: Readonly<Record<string, string>> = {
      'catalog.brand.create': 'brands',
      'catalog.brand.update': 'brands',
      'catalog.brand.delete': 'brands',
      'catalog.category.create': 'categories',
      'catalog.category.update': 'categories',
      'catalog.category.delete': 'categories',
      'catalog.specification.create': 'spec_keys',
      'catalog.specification.update': 'spec_keys',
      'catalog.specification.delete': 'spec_keys'
    };
    const changedCollections = Array.from(
      new Set(
        events.flatMap((event) => {
          if (!appliedEventIds.has(event.eventId)) return [];
          const collection = catalogCollectionByCommand[commandKind(event.payload) ?? ''];
          return collection ? [collection] : [];
        })
      )
    );
    if (changedCollections.length > 0) {
      this.realtime.publish({
        organizationId,
        event: 'catalog.taxonomy.updated',
        payload: { collections: changedCollections }
      });
    }
    const deletedVariantIds = new Set(
      events
        .filter(
          (event) =>
            appliedEventIds.has(event.eventId) &&
            event.aggregateType === 'product_variant' &&
            commandKind(event.payload) === 'item.delete'
        )
        .map((event) => event.aggregateId)
    );
    const variantIds = Array.from(
      new Set(
        events.flatMap((event) => {
          if (!appliedEventIds.has(event.eventId)) return [];
          if (event.aggregateType === 'product_variant') return [event.aggregateId];

          // Inventory relocation, stock adjustment and RFID assignment are
          // separate desktop commands. They change a product's current
          // zone/shelf but their aggregate ID is the ledger/tag ID, not the
          // product variant ID. Read the command envelope so those changes
          // also notify an already open admin catalog.
          const envelope =
            typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload)
              ? (event.payload as Record<string, unknown>)
              : undefined;
          const command =
            envelope && typeof envelope.command === 'object' && envelope.command !== null
              ? (envelope.command as Record<string, unknown>)
              : undefined;
          const commandPayload =
            command && typeof command.payload === 'object' && command.payload !== null
              ? (command.payload as Record<string, unknown>)
              : undefined;
          const variantId = commandPayload?.productVariantId;
          return typeof variantId === 'string' && variantId.length > 0 ? [variantId] : [];
        })
      )
    );
    if (variantIds.length === 0) return;
    const products = await this.database.pool.query<{
      productId: string;
      slug: string;
      variantId: string;
    }>(
      `SELECT DISTINCT p.id AS "productId", p.slug, v.id AS "variantId"
       FROM products p
       JOIN product_variants v ON v.organization_id = p.organization_id AND v.product_id = p.id
       WHERE p.organization_id = $1 AND v.id = ANY($2::uuid[])`,
      [organizationId, variantIds]
    );
    const slugs = products.rows.map((product) => product.slug);
    if (slugs.length === 0) return;
    await this.redis.client.del(...slugs.map((slug) => `catalog:slug:${organizationId}:${slug}`));
    for (const product of products.rows) {
      this.realtime.publish({
        organizationId,
        event: 'product.updated',
        payload: {
          productId: product.productId,
          slug: product.slug,
          ...(deletedVariantIds.has(product.variantId) ? { deleted: true } : {})
        }
      });
    }
  }

  @Get('pull')
  async pull(@Req() request: Request, @Query() query: Record<string, string | undefined>) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'sync.read');
    return new SyncRepository(this.database.pool).pull(ctx, {
      afterRevision: z.coerce
        .number()
        .int()
        .min(0)
        .parse(query.afterRevision ?? 0),
      limit: parseWithSchema(syncLimitSchema, query.limit)
    });
  }

  @Get('bootstrap')
  async bootstrap(@Req() request: Request, @Query() query: Record<string, string | undefined>) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'sync.read');
    return new SyncRepository(this.database.pool).bootstrapSnapshot(ctx, {
      limit: parseWithSchema(syncLimitSchema, query.limit),
      cursor: query.cursor
    });
  }

  @Get('conflicts')
  async conflicts(@Req() request: Request, @Query() query: Record<string, string | undefined>) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'sync.conflicts');
    return new SyncRepository(this.database.pool).listConflicts(ctx, {
      status: query.status,
      limit: parseWithSchema(syncLimitSchema, query.limit)
    });
  }

  @Patch('conflicts/:id')
  async resolveConflict(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'sync.conflicts');
    const conflictId = parseWithSchema(uuidSchema, id);
    const input = parseWithSchema(conflictResolveSchema, body);
    const result = await new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      const sync = new SyncRepository(client);
      const conflicts = await sync.listConflicts(ctx, { status: 'unresolved', limit: 500 });
      const conflict = conflicts.find((candidate) => candidate.id === conflictId);
      if (!conflict) throw new Error('Konflikt nije pronađen ili je već razrešen.');

      let appliedEvent: { eventId: string; status: string } | undefined;
      if (input.strategy === 'local') {
        const eventId = randomUUID();
        const results = await sync.pushBatch(
          ctx,
          [{
            eventId,
            idempotencyKey: `conflict-resolution:${conflictId}:${eventId}`,
            aggregateType: conflict.aggregateType,
            aggregateId: conflict.aggregateId,
            operation: conflict.operation,
            baseVersion: conflict.serverVersion,
            payloadVersion: 1,
            clientTimestamp: new Date().toISOString(),
            payload: conflict.clientPayload
          }],
          (event) => new OperationalSyncProjector(client).materialize(ctx, event)
        );
        appliedEvent = results[0];
        if (!appliedEvent || appliedEvent.status !== 'applied') {
          throw new Error('Platform verzija se promenila. Osvežite konflikt pa pokušajte ponovo.');
        }
      }

      const resolved = await sync.resolveConflict(ctx, conflictId, {
        status: 'resolved',
        reason: input.reason,
        resolution: { strategy: input.strategy, ...(appliedEvent ? { appliedEventId: appliedEvent.eventId } : {}) }
      });
      await new AuditRepository(client).append({
        ctx,
        aggregateType: 'sync_conflict',
        aggregateId: conflictId,
        operation: `resolve.${input.strategy}`,
        afterPayload: resolved,
        reason: input.reason
      });
      return {
        ...resolved,
        strategy: input.strategy,
        appliedEventId: appliedEvent?.eventId,
        aggregateType: conflict.aggregateType,
        aggregateId: conflict.aggregateId
      };
    });
    if (input.strategy === 'local' && result.aggregateType === 'product_variant' && result.appliedEventId) {
      await this.publishCatalogChanges(ctx.organizationId, [{
        eventId: result.appliedEventId,
        aggregateType: result.aggregateType,
        aggregateId: result.aggregateId,
        payload: {}
      }], [{ eventId: result.appliedEventId, status: 'applied' }]);
    }
    return result;
  }
}
