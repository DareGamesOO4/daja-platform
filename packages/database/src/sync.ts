/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import type pg from 'pg';
import type { QueryResultRow } from 'pg';
import {
  ResourceConflictError,
  ResourceNotFoundError,
  TenantAccessDeniedError,
  ValidationFailedError
} from '@daja/security';
import type { RequestContext } from '@daja/shared';

export interface SyncPushEvent {
  eventId: string;
  idempotencyKey: string;
  aggregateType: string;
  aggregateId: string;
  operation: string;
  baseVersion?: number | null | undefined;
  payloadVersion: number;
  clientTimestamp?: string | undefined;
  payload: Record<string, unknown>;
  locationId?: string | undefined;
  deviceSequence?: number | undefined;
  basePayload?: Record<string, unknown> | undefined;
  offlinePackageId?: string | undefined;
  baselineRevision?: number | undefined;
  correlationId?: string | undefined;
  businessCommandId?: string | undefined;
}

export interface SyncEventRecord {
  id: string;
  schemaVersion: number;
  revision: number;
  organizationId: string;
  locationId: string | null;
  deviceId: string | null;
  userId: string | null;
  aggregateType: string;
  aggregateId: string;
  operation: string;
  payload: Record<string, unknown>;
  payloadVersion: number;
  baseVersion: number | null;
  clientTimestamp: Date | null;
  serverTimestamp: Date;
  idempotencyKey: string | null;
  deviceSequence: number;
  basePayload: Record<string, unknown> | null;
  offlinePackageId: string | null;
  baselineRevision: number | null;
  correlationId: string | null;
  businessCommandId: string | null;
}

export class SyncRepository {
  constructor(private readonly client: Pick<pg.Pool | pg.PoolClient, 'query'>) {}

  async ensureRevisionRow(organizationId: string): Promise<void> {
    await this.client.query(
      `INSERT INTO organization_revisions (organization_id, current_revision)
       VALUES ($1, 0)
       ON CONFLICT (organization_id) DO NOTHING`,
      [organizationId]
    );
  }

  async appendServerEvent(
    ctx: Pick<
      RequestContext,
      'organizationId' | 'requestId' | 'correlationId' | 'userId' | 'deviceId' | 'locationId'
    >,
    input: {
      aggregateType: string;
      aggregateId: string;
      operation: string;
      payload: Record<string, unknown>;
      payloadVersion?: number | undefined;
      baseVersion?: number | null | undefined;
      clientTimestamp?: Date | null | undefined;
      idempotencyKey?: string | null | undefined;
      locationId?: string | undefined;
      deviceSequence?: number | undefined;
      basePayload?: Record<string, unknown> | undefined;
      offlinePackageId?: string | undefined;
      baselineRevision?: number | undefined;
      correlationId?: string | undefined;
      businessCommandId?: string | undefined;
    }
  ): Promise<SyncEventRecord> {
    await this.ensureRevisionRow(ctx.organizationId);
    const next = await this.client.query<{ revision: string }>(
      `UPDATE organization_revisions
       SET current_revision = current_revision + 1, updated_at = now()
       WHERE organization_id = $1
       RETURNING current_revision AS revision`,
      [ctx.organizationId]
    );
    const revision = next.rows[0]?.revision;
    if (!revision) {
      throw new ResourceNotFoundError('organization revision');
    }
    const result = await this.client.query<SyncEventRow>(
      `INSERT INTO server_sync_events (
         revision, organization_id, location_id, device_id, user_id, aggregate_type, aggregate_id,
         operation, payload, payload_version, base_version, client_timestamp, idempotency_key,
         request_id, correlation_id, device_sequence, base_payload, offline_package_id, baseline_revision, business_command_id
       )
       VALUES ($1, $2, COALESCE($3, $16::uuid), $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $17, $18::jsonb, $19::uuid, $20, $21::uuid)
       RETURNING id, schema_version, revision, organization_id, location_id, device_id, user_id,
                 aggregate_type, aggregate_id, operation, payload, payload_version, base_version,
                 client_timestamp, server_timestamp, idempotency_key, device_sequence, base_payload, offline_package_id, baseline_revision, correlation_id, business_command_id`,
      [
        revision,
        ctx.organizationId,
        ctx.locationId ?? null,
        ctx.deviceId ?? null,
        ctx.userId ?? null,
        input.aggregateType,
        input.aggregateId,
        input.operation,
        JSON.stringify(input.payload),
        input.payloadVersion ?? 1,
        input.baseVersion ?? null,
        input.clientTimestamp ?? null,
        input.idempotencyKey ?? null,
        ctx.requestId,
        input.correlationId ?? ctx.correlationId,
        input.locationId ?? null,
        input.deviceSequence ?? 0,
        input.basePayload === undefined ? null : JSON.stringify(input.basePayload),
        input.offlinePackageId ?? null,
        input.baselineRevision ?? null,
        input.businessCommandId ?? null
      ]
    );
    return mapSyncEvent(requireRow(result));
  }

  async pushBatch(
    ctx: RequestContext,
    events: SyncPushEvent[],
    materialize?: (event: SyncPushEvent) => Promise<SyncPushEvent>
  ): Promise<
    Array<{
      eventId: string;
      status: string;
      revision?: number;
      conflictId?: string;
      code?: string;
    }>
  > {
    if (events.length === 0 || events.length > 100) {
      throw new ValidationFailedError('Sync push batch size must be between 1 and 100');
    }
    const results: Array<{
      eventId: string;
      status: string;
      revision?: number;
      conflictId?: string;
      code?: string;
    }> = [];
    for (const event of events) {
      const existing = await this.client.query<{ revision: string }>(
        `SELECT revision
         FROM server_sync_events
         WHERE organization_id = $1 AND idempotency_key = $2`,
        [ctx.organizationId, event.idempotencyKey]
      );
      const existingRow = existing.rows[0];
      if (existingRow) {
        results.push({
          eventId: event.eventId,
          status: 'duplicate',
          revision: Number(existingRow.revision)
        });
        continue;
      }

      // Check the stable aggregate identity before the projector mutates a
      // canonical table. This turns an offline stale write into a durable
      // sync_conflict instead of a transaction error.
      const conflict = await this.detectConflict(ctx.organizationId, event);
      if (conflict) {
        const conflictId = await this.createConflict(ctx, event, conflict);
        results.push({ eventId: event.eventId, status: 'conflict', conflictId });
        continue;
      }
      const projected = materialize === undefined ? event : await materialize(event);

      const appended = await this.appendServerEvent(ctx, {
        aggregateType: projected.aggregateType,
        aggregateId: projected.aggregateId,
        operation: projected.operation,
        payload: projected.payload,
        payloadVersion: projected.payloadVersion,
        baseVersion: projected.baseVersion ?? null,
        clientTimestamp: projected.clientTimestamp ? new Date(projected.clientTimestamp) : null,
        idempotencyKey: projected.idempotencyKey,
        locationId: projected.locationId,
        deviceSequence: projected.deviceSequence,
        basePayload: projected.basePayload,
        offlinePackageId: projected.offlinePackageId,
        baselineRevision: projected.baselineRevision,
        correlationId: projected.correlationId,
        businessCommandId: projected.businessCommandId
      });
      results.push({ eventId: event.eventId, status: 'applied', revision: appended.revision });
    }
    return results;
  }

  async pull(
    ctx: Pick<RequestContext, 'organizationId' | 'locationId'>,
    input: { afterRevision: number; limit: number }
  ): Promise<{
    events: SyncEventRecord[];
    nextRevision: number;
    hasMore: boolean;
    serverTime: string;
  }> {
    if (input.afterRevision < 0 || input.limit < 1 || input.limit > 500) {
      throw new ValidationFailedError('Invalid sync pull pagination');
    }
    const result = await this.client.query<SyncEventRow>(
      `SELECT id, schema_version, revision, organization_id, location_id, device_id, user_id,
              aggregate_type, aggregate_id, operation, payload, payload_version, base_version,
              client_timestamp, server_timestamp, idempotency_key, device_sequence, base_payload, offline_package_id, baseline_revision, correlation_id, business_command_id
       FROM server_sync_events
       WHERE organization_id = $1 AND revision > $2
         AND ($3::uuid IS NULL OR location_id IS NULL OR location_id = $3)
       ORDER BY revision ASC
       LIMIT $4`,
      [ctx.organizationId, input.afterRevision, ctx.locationId ?? null, input.limit + 1]
    );
    const rows = result.rows.slice(0, input.limit).map(mapSyncEvent);
    return {
      events: rows,
      nextRevision: rows.at(-1)?.revision ?? input.afterRevision,
      hasMore: result.rows.length > input.limit,
      serverTime: new Date().toISOString()
    };
  }

  async bootstrapSnapshot(
    ctx: Pick<RequestContext, 'organizationId'>,
    input: { limit: number; cursor?: string | undefined }
  ) {
    await this.ensureRevisionRow(ctx.organizationId);
    const revision = await this.client.query<{ current_revision: string }>(
      `SELECT current_revision FROM organization_revisions WHERE organization_id = $1`,
      [ctx.organizationId]
    );
    const cursor = input.cursor ?? '';
    const result = await this.client.query(
      `SELECT p.id AS "productId", p.slug, p.name AS "productName", p.description, p.primary_category_id AS "categoryId",
              b.name AS "brandName", p.version AS "productVersion",
              v.id AS "variantId", v.sku, v.barcode, v.name AS "variantName", v.current_price_amount AS "priceAmount", v.currency,
              v.attributes, v.active, v.published, v.version AS "variantVersion", media.public_url AS "imageUri",
              t.id AS "tagId", t.epc
       FROM products p
       JOIN product_variants v ON v.organization_id = p.organization_id AND v.product_id = p.id
        AND v.deleted_at IS NULL AND v.active
       LEFT JOIN brands b ON b.id = p.brand_id AND b.organization_id = p.organization_id AND b.deleted_at IS NULL
       LEFT JOIN rfid_tags t ON t.organization_id = p.organization_id
        AND (t.variant_id = v.id OR t.inventory_item_id IN (
          SELECT ii.id FROM inventory_items ii WHERE ii.organization_id = p.organization_id AND ii.variant_id = v.id
        ))
        AND t.deleted_at IS NULL
       LEFT JOIN LATERAL (
         SELECT ma.public_url FROM product_media pm
         JOIN media_assets ma ON ma.id = pm.media_asset_id AND ma.status = 'ready'
         WHERE pm.organization_id = p.organization_id AND pm.product_id = p.id
         ORDER BY pm.is_primary DESC, pm.position ASC LIMIT 1
       ) media ON true
       WHERE p.organization_id = $1 AND p.deleted_at IS NULL AND p.id::text > $2
       ORDER BY p.id
       LIMIT $3`,
      [ctx.organizationId, cursor, input.limit + 1]
    );
    const rows = result.rows.slice(0, input.limit);
    return {
      watermarkRevision: Number(revision.rows[0]?.current_revision ?? 0),
      items: rows,
      nextCursor: result.rows.length > input.limit ? rows.at(-1)?.productId : null,
      hasMore: result.rows.length > input.limit
    };
  }

  async listConflicts(
    ctx: Pick<RequestContext, 'organizationId'>,
    input: { status?: string | undefined; limit: number }
  ) {
    const status = input.status ?? 'unresolved';
    const result = await this.client.query(
      `SELECT id, aggregate_type AS "aggregateType", aggregate_id AS "aggregateId", operation,
              base_version AS "baseVersion", server_version AS "serverVersion", client_payload AS "clientPayload",
              server_payload AS "serverPayload", status, reason, created_at AS "createdAt",
              resolved_at AS "resolvedAt"
       FROM sync_conflicts
       WHERE organization_id = $1 AND status = $2
       ORDER BY created_at DESC, id DESC
       LIMIT $3`,
      [ctx.organizationId, status, input.limit]
    );
    return result.rows;
  }

  async resolveConflict(
    ctx: RequestContext,
    conflictId: string,
    input: { resolution: Record<string, unknown>; status: 'resolved' | 'rejected'; reason: string }
  ) {
    const result = await this.client.query(
      `UPDATE sync_conflicts
       SET status = $3, resolution = $4::jsonb, reason = $5, resolved_at = now(), resolved_by = $6
       WHERE organization_id = $1 AND id = $2 AND status = 'unresolved'
       RETURNING id, status, resolution, reason, resolved_at AS "resolvedAt"`,
      [
        ctx.organizationId,
        conflictId,
        input.status,
        JSON.stringify(input.resolution),
        input.reason,
        ctx.userId
      ]
    );
    if (result.rowCount !== 1) {
      throw new TenantAccessDeniedError();
    }
    return result.rows[0];
  }

  private async detectConflict(organizationId: string, event: SyncPushEvent) {
    if (event.baseVersion === undefined || event.baseVersion === null) {
      return null;
    }
    const current = await this.client.query<{ version: string; payload: Record<string, unknown> }>(
      `SELECT version::text, to_jsonb(source) AS payload
       FROM (
         SELECT id, version FROM products WHERE organization_id = $1 AND id = $2 AND $3 = 'product'
         UNION ALL
         SELECT id, version FROM product_variants WHERE organization_id = $1 AND id = $2 AND $3 IN ('variant', 'product_variant')
         UNION ALL
         SELECT id, version FROM rfid_tags WHERE organization_id = $1 AND id = $2 AND $3 = 'rfid_tag'
         UNION ALL
         SELECT id, version FROM inventory_items WHERE organization_id = $1 AND id = $2 AND $3 = 'inventory_item'
       ) source`,
      [organizationId, event.aggregateId, event.aggregateType]
    );
    const row = current.rows[0];
    if (!row) {
      return null;
    }
    const version = Number(row.version);
    return version !== event.baseVersion
      ? { serverVersion: version, serverPayload: row.payload ?? {} }
      : null;
  }

  private async createConflict(
    ctx: RequestContext,
    event: SyncPushEvent,
    conflict: { serverVersion: number; serverPayload: Record<string, unknown> }
  ): Promise<string> {
    const result = await this.client.query<{ id: string }>(
      `INSERT INTO sync_conflicts (
         organization_id, device_id, user_id, aggregate_type, aggregate_id, operation,
         base_version, server_version, client_payload, server_payload, reason
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11)
       RETURNING id`,
      [
        ctx.organizationId,
        ctx.deviceId ?? null,
        ctx.userId,
        event.aggregateType,
        event.aggregateId,
        event.operation,
        event.baseVersion ?? null,
        conflict.serverVersion,
        JSON.stringify(event.payload),
        JSON.stringify(conflict.serverPayload),
        'Base version does not match server version'
      ]
    );
    return requireRow(result).id;
  }
}

export class DeviceRepository {
  constructor(private readonly client: Pick<pg.Pool | pg.PoolClient, 'query'>) {}

  async registerDevice(
    ctx: RequestContext,
    input: {
      deviceKey: string;
      displayName: string;
      deviceType: string;
      locationId?: string | null | undefined;
      offlineAuthorizationExpiresAt?: string | null | undefined;
      metadata?: Record<string, unknown> | undefined;
    }
  ) {
    try {
      const result = await this.client.query(
        `INSERT INTO devices (
           organization_id, user_id, location_id, device_key, display_name, device_type,
           offline_authorization_expires_at, metadata
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (organization_id, device_key) WHERE deleted_at IS NULL
         DO UPDATE SET
           user_id = EXCLUDED.user_id,
           location_id = EXCLUDED.location_id,
           display_name = EXCLUDED.display_name,
           device_type = EXCLUDED.device_type,
           active = true,
           revoked_at = NULL,
           last_seen_at = now(),
           offline_authorization_expires_at = EXCLUDED.offline_authorization_expires_at,
           metadata = EXCLUDED.metadata,
           version = devices.version + 1,
           updated_at = now()
         RETURNING id, organization_id AS "organizationId", user_id AS "userId",
                   location_id AS "locationId", device_key AS "deviceKey",
                   display_name AS "displayName", device_type AS "deviceType",
                   active, revoked_at AS "revokedAt", last_seen_at AS "lastSeenAt",
                   offline_authorization_expires_at AS "offlineAuthorizationExpiresAt", version`,
        [
          ctx.organizationId,
          ctx.userId,
          input.locationId ?? ctx.locationId ?? null,
          input.deviceKey,
          input.displayName,
          input.deviceType,
          input.offlineAuthorizationExpiresAt ?? null,
          JSON.stringify(input.metadata ?? {})
        ]
      );
      return result.rows[0];
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23514'
      ) {
        throw new ResourceConflictError('Device registration violates tenant integrity');
      }
      throw error;
    }
  }

  async assertActiveDevice(organizationId: string, deviceId: string): Promise<void> {
    const result = await this.client.query(
      `UPDATE devices
       SET last_seen_at = now(), updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND active AND revoked_at IS NULL AND deleted_at IS NULL`,
      [organizationId, deviceId]
    );
    if (result.rowCount !== 1) {
      throw new TenantAccessDeniedError();
    }
  }
}

interface SyncEventRow {
  id: string;
  schema_version: number;
  revision: string;
  organization_id: string;
  location_id: string | null;
  device_id: string | null;
  user_id: string | null;
  aggregate_type: string;
  aggregate_id: string;
  operation: string;
  payload: Record<string, unknown>;
  payload_version: number;
  base_version: string | null;
  client_timestamp: Date | null;
  server_timestamp: Date;
  idempotency_key: string | null;
  device_sequence: number;
  base_payload: Record<string, unknown> | null;
  offline_package_id: string | null;
  baseline_revision: string | null;
  correlation_id: string | null;
  business_command_id: string | null;
}

function mapSyncEvent(row: SyncEventRow): SyncEventRecord {
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    revision: Number(row.revision),
    organizationId: row.organization_id,
    locationId: row.location_id,
    deviceId: row.device_id,
    userId: row.user_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    operation: row.operation,
    payload: row.payload,
    payloadVersion: row.payload_version,
    baseVersion: row.base_version === null ? null : Number(row.base_version),
    clientTimestamp: row.client_timestamp,
    serverTimestamp: row.server_timestamp,
    idempotencyKey: row.idempotency_key,
    deviceSequence: row.device_sequence,
    basePayload: row.base_payload,
    offlinePackageId: row.offline_package_id,
    baselineRevision: row.baseline_revision === null ? null : Number(row.baseline_revision),
    correlationId: row.correlation_id,
    businessCommandId: row.business_command_id
  };
}

function requireRow<T extends QueryResultRow>(result: pg.QueryResult<T>): T {
  const row = result.rows[0];
  if (!row) {
    throw new ResourceNotFoundError('database row');
  }
  return row;
}
