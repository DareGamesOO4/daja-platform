/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, Header, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import type { AppConfig } from '@daja/config';
import {
  AuditRepository,
  DeviceRepository,
  MediaRepository,
  OutboxRepository,
  R2MediaStorageAdapter,
  SyncRepository,
  TransactionManager,
  type Database
} from '@daja/database';
import type { Logger } from '@daja/observability';
import { ResourceConflictError, ValidationFailedError, requirePermission } from '@daja/security';
import { parseWithSchema, syncLimitSchema, syncPushSchema, uuidSchema } from '@daja/validation';
import { CONFIG, DATABASE, LOGGER } from './tokens.js';
import { resolveRequestContext } from './runtime/request-context.js';
import { requireScopedPermission } from './access-policy.js';
import { OperationalSyncProjector } from './operational-sync-projector.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { CatalogDeliveryService } from './catalog-delivery.service.js';
import { authorizeSyncEvent } from './sync-authorization.js';
import { object, preparePriceEdit, preserveUneditedItemFields, priceFields, samePrice, type PricePlan, type PriceValue } from './sync-price-conflicts.js';
import { asPriceFields, chosenPriceFields, compareConflict, getConflictReview, listConflictReviews } from './sync-conflict-review.js';

const deviceRegisterSchema = z.object({
  deviceKey: z.string().trim().min(8).max(240),
  displayName: z.string().trim().min(1).max(240),
  deviceType: z.enum(['rfiddaja_desktop', 'rfiddaja_mobile', 'pos', 'admin', 'bridge', 'other']),
  locationId: uuidSchema.nullable().optional(),
  offlineAuthorizationExpiresAt: z.string().datetime().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const conflictResolveSchema = z.object({
  strategy: z.enum(['local', 'remote', 'fields']),
  reason: z.string().trim().max(2000).default(''),
  token: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  choices: z.object({ regular: z.enum(['local', 'remote']).optional(), promotion: z.enum(['local', 'remote']).optional() }).strict().optional(),
  newPeriod: z.object({ from: z.string().datetime(), until: z.string().datetime() }).strict().optional()
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
    @Inject(CatalogDeliveryService) private readonly catalogDelivery: CatalogDeliveryService,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly realtime: RealtimeGateway
  ) {}

  @Post('push')
  async push(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'sync.write');
    const input = parseWithSchema(syncPushSchema, body);
    const { specificationOptionsChanged, ...result } = await new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      if (ctx.deviceId) {
        await new DeviceRepository(client).assertActiveDevice(ctx.organizationId, ctx.deviceId);
      }
      const projector = new OperationalSyncProjector(client, new R2MediaStorageAdapter(this.config));
      const results = await new SyncRepository(client).pushBatch(ctx, input.events, async (event) => {
        if (event.basePayload?.priceEdit) await authorizeSyncEvent(client, ctx, event);
        const price = await preparePriceEdit(client, ctx, event);
        if (!price) return projector.materialize(ctx, event);
        if (price.disputes.length) {
          return { conflict: {
            serverVersion: price.state.version,
            serverPayload: { regular: price.state.regular.value, promotion: price.state.promotion.value },
            details: { kind: 'price', fields: price.disputes, name: price.state.name, sku: price.state.sku,
              preserve: [...price.plan.preserve], localSavedAt: price.savedAt,
              baseline: event.basePayload?.priceEdit, proposedPromotion: price.plan.promotion }
          } };
        }
        return projector.materialize(ctx, price.event, price.plan);
      }, event => authorizeSyncEvent(client, ctx, event));
      await new OutboxRepository(client).append({
        ctx,
        eventType: 'SyncBatchPushed',
        aggregateType: 'sync_batch',
        aggregateId: input.events[0]!.aggregateId,
        payload: { results }
      });
      return {
        results,
        transactionSemantics: 'ordered-per-event',
        staleMediaKeys: projector.takeStaleMediaKeys(),
        specificationOptionsChanged: projector.hasSpecificationOptionChanges(results)
      };
    });
    await this.cleanupRelocatedMedia(result.staleMediaKeys);
    // A desktop-originated catalog change bypasses the staff catalog HTTP
    // controller, so invalidate its public cache and notify open storefronts
    // only after the transaction has committed.
    if (result.results.some(item => item.status === 'applied')) {
      this.realtime.publish({ organizationId: ctx.organizationId, event: 'sync.changed', payload: {} });
    }
    await this.publishCatalogChanges(ctx.organizationId, input.events, result.results, specificationOptionsChanged);
    return result;
  }

  private async cleanupRelocatedMedia(keys: Iterable<string>): Promise<void> {
    const uniqueKeys = [...new Set(keys)];
    if (!uniqueKeys.length) return;
    try {
      await new MediaRepository(this.database.pool).deleteStorageObjects(
        new R2MediaStorageAdapter(this.config),
        uniqueKeys
      );
    } catch (error) {
      // New keys are already committed in the catalog. Preserve those working
      // image URLs if cleanup is temporarily unavailable and retry on a later
      // maintenance pass instead of failing the desktop sync.
      this.logger.warn({ err: error, keys: uniqueKeys.length }, 'Could not delete old product media keys');
    }
  }

  private async publishCatalogChanges(
    organizationId: string,
    events: ReadonlyArray<{
      eventId: string;
      aggregateType: string;
      aggregateId: string;
      payload: unknown;
    }>,
    results: ReadonlyArray<{ eventId: string; status: string }>,
    specificationOptionsChanged = false
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
    if (specificationOptionsChanged && !changedCollections.includes('spec_keys')) changedCollections.push('spec_keys');
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
    try {
      await this.catalogDelivery.invalidateKeys([...new Set(slugs)].flatMap(slug => [
        'catalog:slug:' + organizationId + ':' + slug,
        'catalog:slug:public-v4:' + organizationId + ':' + slug,
      ]));
    } catch (error) {
      this.logger.warn({ err: error }, 'Synced product cache will refresh at expiry');
    }
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

  @Get('status')
  @Header('Cache-Control', 'private, no-store')
  async status(@Req() request: Request, @Query('include') include?: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'sync.read');
    if (ctx.deviceId) await new DeviceRepository(this.database.pool).assertActiveDevice(ctx.organizationId, ctx.deviceId);
    const repository = new SyncRepository(this.database.pool);
    const status = await repository.status(ctx.organizationId);
    if (include !== 'mobileStartup' || status.policyVersion !== (ctx.policyVersion ?? 1)) return status;
    return { ...status, mobileStartup: await repository.mobileStartupSummary(ctx) };
  }

  @Get('pull')
  async pull(@Req() request: Request, @Query() query: Record<string, string | undefined>) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'sync.read');
    const result = await new SyncRepository(this.database.pool).pull(ctx, {
      afterRevision: z.coerce
        .number()
        .int()
        .min(0)
        .parse(query.afterRevision ?? 0),
      limit: parseWithSchema(syncLimitSchema, query.limit)
    });
    return query.client === 'mobile' ? { ...result, policyVersion: ctx.policyVersion ?? 1 } : result;
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

  @Get('mobile/catalog')
  async mobileCatalog(@Req() request: Request, @Query() query: Record<string, string | undefined>) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'sync.read');
    const ids = (value: string | undefined) => value === undefined ? undefined
      : parseWithSchema(z.array(uuidSchema).min(1).max(100), value.split(','));
    return new SyncRepository(this.database.pool).bootstrapSnapshot(ctx, {
      limit: query.layoutOnly === 'true' ? 0 : parseWithSchema(syncLimitSchema, query.limit),
      cursor: query.cursor === undefined ? undefined : parseWithSchema(uuidSchema, query.cursor),
      mobile: { variantIds: ids(query.variantIds), productIds: ids(query.productIds), includeState: query.state === 'true' }
    });
  }

  @Get('conflicts')
  async conflicts(@Req() request: Request, @Query() query: Record<string, string | undefined>) {
    const ctx = resolveRequestContext(request);
    if (query.scope) {
      requirePermission(ctx, 'sync.read');
      return listConflictReviews(
        this.database.pool, ctx, parseWithSchema(z.enum(['own', 'organization']), query.scope),
        parseWithSchema(z.enum(['unresolved', 'resolved', 'rejected']).default('unresolved'), query.status),
        parseWithSchema(syncLimitSchema, query.limit),
        query.cursor ? parseWithSchema(uuidSchema, query.cursor) : undefined
      );
    }
    requirePermission(ctx, 'sync.conflicts');
    requireScopedPermission(ctx, ['sync.conflicts']);
    return new SyncRepository(this.database.pool).listConflicts(ctx, {
      status: query.status,
      limit: parseWithSchema(syncLimitSchema, query.limit)
    });
  }

  @Get('conflicts/:id')
  async conflictDetail(@Req() request: Request, @Param('id') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'sync.read');
    const row = await getConflictReview(this.database.pool, ctx, parseWithSchema(uuidSchema, id));
    return this.publicConflictReview(await compareConflict(this.database.pool, ctx, row));
  }

  private publicConflictReview(review: Awaited<ReturnType<typeof compareConflict>>) {
    if (!('live' in review)) return review;
    const { live: _live, current: _current, ...data } = review;
    return data;
  }

  @Patch('conflicts/:id')
  async resolveConflict(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'sync.read');
    const conflictId = parseWithSchema(uuidSchema, id);
    const input = parseWithSchema(conflictResolveSchema, body);
    const { specificationOptionsChanged, ...result } = await new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      const sync = new SyncRepository(client);
      const originalEvent = (await getConflictReview(client, ctx, conflictId)).eventId;
      if (originalEvent) await sync.lockEvent(ctx.organizationId, originalEvent);
      const conflict = await getConflictReview(client, ctx, conflictId, true);
      const review = await compareConflict(client, ctx, conflict, true);
      if (!('live' in review) || conflict.status !== 'unresolved') {
        return { ...this.publicConflictReview(review), staleMediaKeys: [], specificationOptionsChanged: false, appliedEventId: undefined };
      }
      if ((input.token || conflict.details.kind === 'price') && input.token !== review.token)
        throw new ResourceConflictError('Podaci na serveru su se promenili. Pogledaj nove vrednosti i ponovo potvrdi izbor.');

      let appliedEvent: { eventId: string; status: string } | undefined;
      let staleMediaKeys: string[] = [];
      let specificationOptionsChanged = false;
      let fields: unknown[] = review.fields;
      let prices: PricePlan | undefined;
      const original = object(conflict.clientPayload.command);
      const originalPayload = object(original.payload);
      const payload: Record<string, unknown> = {
        ...(review.current ? preserveUneditedItemFields(originalPayload, conflict.details.baseline, review.current) : originalPayload),
        actorUserId: ctx.userId, deviceId: ctx.deviceId
      };
      const snapshot = object(conflict.clientPayload.operationalSnapshot);
      const replay = {
        ...conflict.clientPayload,
        ...(original.kind ? { command: { ...original, payload } } : {}),
        ...(snapshot.kind === 'rfid.cycle_count' ? {
          operationalSnapshot: { ...snapshot, count: { ...object(snapshot.count), actorUserId: ctx.userId } }
        } : {})
      };
      if (conflict.details.kind === 'price') {
        if (!review.current) throw new ResourceConflictError('Artikal više nije dostupan na serveru.');
        const selected = chosenPriceFields(asPriceFields(review, review.current), input.strategy, input.choices, input.newPeriod);
        fields = selected;
        const current = review.current;
        const preserve = new Set(priceFields.filter(field => {
          const choice = selected.find(entry => entry.field === field);
          return choice ? choice.source === 'remote' :
            (Array.isArray(conflict.details.preserve) && conflict.details.preserve.includes(field)) ||
            !samePrice((conflict.serverPayload[field] ?? null) as PriceValue, current[field].value);
        }));
        const promotion = selected.find(entry => entry.field === 'promotion' && entry.source === 'local');
        if (promotion && promotion.value && input.newPeriod) {
          Object.assign(payload, { promotionalValidFrom: promotion.value.from, promotionalValidUntil: promotion.value.until });
        }
        const promotionValue = promotion?.value ?? (!selected.some(entry => entry.field === 'promotion')
          ? conflict.details.proposedPromotion as PricePlan['promotion'] : undefined);
        prices = { preserve, replacePromotion: true, ...(promotionValue ? { promotion: promotionValue } : {}) };
      } else {
        if (input.strategy === 'fields') throw new ValidationFailedError('Izaberi celu verziju ove stavke.');
        fields = review.fields.map(entry => ({ ...entry, source: input.strategy,
          value: input.strategy === 'local' ? entry.local : entry.remote }));
      }

      if (input.strategy === 'local' || prices) {
        requirePermission(ctx, 'sync.write');
        const eventId = randomUUID();
        const projector = new OperationalSyncProjector(
          client,
          new R2MediaStorageAdapter(this.config)
        );
        const results = await sync.pushBatch(
          ctx,
          [{
            eventId,
            idempotencyKey: `conflict-resolution:${conflictId}`,
            aggregateType: conflict.aggregateType,
            aggregateId: conflict.aggregateId,
            operation: conflict.operation,
            baseVersion: review.current?.version ?? review.live?.version ?? Number(conflict.serverVersion),
            ...(conflict.locationId ? { locationId: conflict.locationId } : {}),
            payloadVersion: 1,
            clientTimestamp: new Date().toISOString(),
            payload: replay
          }],
          (event) => projector.materialize(ctx, event, prices),
          event => authorizeSyncEvent(client, ctx, event)
        );
        staleMediaKeys = projector.takeStaleMediaKeys();
        specificationOptionsChanged = projector.hasSpecificationOptionChanges(results);
        appliedEvent = results[0];
        if (!appliedEvent || appliedEvent.status !== 'applied') {
          throw new ResourceConflictError('Podaci na serveru su se promenili. Pogledaj nove vrednosti i ponovo potvrdi izbor.');
        }
      }

      const projector = new OperationalSyncProjector(client);
      let canonical = !appliedEvent && review.live?.transfer
        ? { kind: 'stock.transfer', transfer: review.live.transfer, locations: [], balances: [], tags: [] }
        : !appliedEvent && review.live?.productId && ['variant', 'product_variant'].includes(conflict.aggregateType)
          ? await projector.catalogSnapshot(ctx.organizationId, review.live.productId, conflict.aggregateId)
          : undefined;
      if (!appliedEvent && !canonical && review.live?.variantId) {
        const { rows: [variant] } = await client.query<{ product_id: string }>(
          'SELECT product_id FROM product_variants WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL',
          [ctx.organizationId, review.live.variantId]
        );
        if (variant) canonical = await projector.catalogSnapshot(ctx.organizationId, variant.product_id, review.live.variantId);
      }
      await sync.appendServerEvent(ctx, {
        aggregateId: conflict.aggregateId, aggregateType: conflict.aggregateType, operation: 'update',
        idempotencyKey: `conflict-result:${conflictId}`,
        locationId: conflict.locationId ?? undefined,
        payload: { conflictResult: { conflictId, eventId: conflict.eventId, userId: conflict.userId, deviceId: conflict.deviceId },
          ...(canonical ? { operationalSnapshot: canonical } : {}) }
      });

      const resolved = await sync.resolveConflict(ctx, conflictId, {
        status: 'resolved',
        reason: input.reason,
        resolution: { strategy: input.strategy, fields, ...(appliedEvent ? { appliedEventId: appliedEvent.eventId } : {}) }
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
        ...this.publicConflictReview(await compareConflict(client, ctx, await getConflictReview(client, ctx, conflictId))),
        strategy: input.strategy,
        appliedEventId: appliedEvent?.eventId,
        aggregateType: conflict.aggregateType,
        aggregateId: conflict.aggregateId,
        staleMediaKeys,
        specificationOptionsChanged
      };
    });
    await this.cleanupRelocatedMedia(result.staleMediaKeys);
    if (result.aggregateType === 'product_variant' && result.appliedEventId) {
      await this.publishCatalogChanges(ctx.organizationId, [{
        eventId: result.appliedEventId,
        aggregateType: result.aggregateType,
        aggregateId: result.aggregateId,
        payload: {}
      }], [{ eventId: result.appliedEventId, status: 'applied' }], specificationOptionsChanged);
    }
    return result;
  }
}
