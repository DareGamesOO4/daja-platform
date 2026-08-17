/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  AuditRepository,
  DeviceRepository,
  OutboxRepository,
  SyncRepository,
  TransactionManager,
  type Database
} from '@daja/database';
import type { Logger } from '@daja/observability';
import { requirePermission } from '@daja/security';
import { parseWithSchema, syncLimitSchema, syncPushSchema, uuidSchema } from '@daja/validation';
import { DATABASE, LOGGER } from './tokens.js';
import { resolveRequestContext } from './runtime/request-context.js';
import { OperationalSyncProjector } from './operational-sync-projector.js';

const deviceRegisterSchema = z.object({
  deviceKey: z.string().trim().min(8).max(240),
  displayName: z.string().trim().min(1).max(240),
  deviceType: z.enum(['rfiddaja_desktop', 'rfiddaja_mobile', 'pos', 'admin', 'bridge', 'other']),
  locationId: uuidSchema.nullable().optional(),
  offlineAuthorizationExpiresAt: z.string().datetime().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const conflictResolveSchema = z.object({
  status: z.enum(['resolved', 'rejected']),
  reason: z.string().trim().min(1).max(2000),
  resolution: z.record(z.string(), z.unknown()).default({})
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
    @Inject(LOGGER) private readonly logger: Logger
  ) {}

  @Post('push')
  async push(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'sync.write');
    const input = parseWithSchema(syncPushSchema, body);
    return new TransactionManager(this.database.pool, this.logger).run(async (client) => {
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
    return new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      const resolved = await new SyncRepository(client).resolveConflict(ctx, conflictId, input);
      await new AuditRepository(client).append({
        ctx,
        aggregateType: 'sync_conflict',
        aggregateId: conflictId,
        operation: input.status,
        afterPayload: resolved,
        reason: input.reason
      });
      return resolved;
    });
  }
}
