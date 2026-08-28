import { createHash, randomUUID } from 'node:crypto';
import {
  InventoryRepository,
  MediaRepository,
  SyncRepository,
  type MediaStorageAdapter,
  type SyncPushEvent
} from '@daja/database';
import { requirePermission, ValidationFailedError } from '@daja/security';
import type { RequestContext } from '@daja/shared';
import { normalizeEpc } from '@daja/validation';
import type pg from 'pg';

type ItemCommand = {
  kind: 'item.create' | 'item.update' | 'item.archive' | 'item.delete';
  payload: Record<string, unknown>;
};

type TagCommand = { kind: 'tag.assign'; payload: Record<string, unknown> };

// PostgreSQL stores catalog amounts in integer cents. Validate before the
// conversion so a malformed desktop value becomes a clear sync validation
// error instead of a generic database/server error.
const MAX_PRICE_RSD = Math.floor(2_147_483_647 / 100);

type LocationCommand = { kind: 'location.upsert'; payload: Record<string, unknown> };

type LocationLayoutCommand = {
  kind: 'location.layout.initialize';
  payload: Record<string, unknown>;
};

type WarehouseZoneCommand = {
  kind: 'warehouse.zone.upsert' | 'warehouse.zone.delete';
  payload: Record<string, unknown>;
};

type WarehouseBinCommand = {
  kind: 'warehouse.bin.upsert' | 'warehouse.bin.delete';
  payload: Record<string, unknown>;
};
type InventoryCommand = {
  kind: 'inventory.event' | 'inventory.relocate';
  payload: Record<string, unknown>;
};

type SettingsCommand = { kind: 'settings.update'; payload: Record<string, unknown> };
type CatalogBrandCommand = {
  kind: 'catalog.brand.create' | 'catalog.brand.update' | 'catalog.brand.delete';
  payload: Record<string, unknown>;
};
type CatalogCategoryCommand = {
  kind: 'catalog.category.create' | 'catalog.category.update' | 'catalog.category.delete';
  payload: Record<string, unknown>;
};
type CatalogSpecificationCommand = {
  kind:
    | 'catalog.specification.create'
    | 'catalog.specification.update'
    | 'catalog.specification.delete';
  payload: Record<string, unknown>;
};
type SupplierCommand = {
  kind: 'supplier.upsert' | 'supplier.delete';
  payload: Record<string, unknown>;
};

type RfidCycleCountSnapshot = {
  readonly kind: 'rfid.cycle_count';
  readonly protocolVersion: 1;
  readonly operation: 'create' | 'expected_batch' | 'read_batch' | 'state' | 'results';
  readonly count: Record<string, unknown>;
  readonly expectedItems?: readonly Record<string, unknown>[];
  readonly reads?: readonly Record<string, unknown>[];
  readonly results?: readonly Record<string, unknown>[];
  readonly action?: 'start' | 'restart' | 'pause' | 'resume' | 'review' | 'complete' | 'cancel' | 'claim' | undefined;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function nullableText(input: Record<string, unknown>, key: string): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(input, key)) return undefined;
  return text(input, key) ?? null;
}

/** The website stores Serbian gender labels with diacritics. Older desktop
 * builds emitted ASCII values, so normalize at the API boundary and keep one
 * catalog value across every client. */
function catalogGender(input: Record<string, unknown>): string | undefined {
  const value = text(input, 'gender');
  if (!value) return undefined;
  const comparable = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleUpperCase('sr-Latn-RS');
  if (comparable === 'MUSKI') return 'MUŠKI';
  if (comparable === 'ZENSKI') return 'ŽENSKI';
  if (comparable === 'UNISEX') return 'Unisex';
  return value;
}

function integer(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function decimal(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => record(item) !== undefined)
    : [];
}

function boolean(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = input[key];
  return typeof value === 'boolean' ? value : fallback;
}

function slug(value: string, suffix: string): string {
  const base = value
    .toLocaleLowerCase('sr-Latn-RS')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140);
  return `${base || 'artikal'}-${suffix.slice(0, 8)}`;
}

function catalogSlug(value: string, fallbackId: string): string {
  const normalized = value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return normalized || `item-${fallbackId.slice(0, 8)}`;
}

function uuid(value: string | undefined): value is string {
  return (
    value !== undefined &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

/**
 * Converts RFIDDaja's local business commands into writes against the actual
 * Platform tables. The resulting snapshot is persisted in server_sync_events,
 * so another desktop can apply the same canonical record without replaying a
 * local command.
 */
export class OperationalSyncProjector {
  private readonly staleMediaKeys = new Set<string>();

  constructor(
    private readonly client: Pick<pg.Pool | pg.PoolClient, 'query'>,
    private readonly mediaStorage?: MediaStorageAdapter
  ) {}

  takeStaleMediaKeys(): string[] {
    const keys = [...this.staleMediaKeys];
    this.staleMediaKeys.clear();
    return keys;
  }

  async materialize(ctx: RequestContext, event: SyncPushEvent): Promise<SyncPushEvent> {
    const envelope = record(event.payload);
    const operationalSnapshot = record(envelope?.operationalSnapshot);
    if (operationalSnapshot?.kind === 'rfid.cycle_count') {
      const snapshot = await this.rfidCycleCount(ctx, event, operationalSnapshot);
      return { ...event, payload: { ...event.payload, operationalSnapshot: snapshot } };
    }
    const command = record(envelope?.command);
    const kind = command?.kind;
    const commandPayload = record(command?.payload);
    if (!envelope || !command || !commandPayload || typeof kind !== 'string') return event;

    const entityIds = record(envelope.entityIds);
    // A desktop writes the business command before it emits the richer RFID
    // snapshot (which contains expected items and reads). Materialize the
    // header from that command as well, so an interrupted snapshot upload can
    // never leave its later RFID batches without a cloud parent record.
    if (kind === 'count.create') {
      const locationId = text(commandPayload, 'locationId');
      const createdByUserId = text(commandPayload, 'actorUserId') ?? ctx.userId;
      if (!locationId || !createdByUserId) {
        throw new ValidationFailedError('RFID cycle count command is incomplete');
      }
      const snapshot = await this.rfidCycleCount(ctx, event, {
        kind: 'rfid.cycle_count',
        protocolVersion: 1,
        operation: 'create',
        count: {
          id: event.aggregateId,
          locationId,
          name: 'RFID popis',
          status: 'draft',
          expectedTotal: 0,
          readTotal: 0,
          foundTotal: 0,
          missingTotal: 0,
          unexpectedTotal: 0,
          createdByUserId
        }
      });
      return { ...event, payload: { ...event.payload, operationalSnapshot: snapshot } };
    }
    if (kind.startsWith('item.')) {
      const snapshot = await this.item(
        ctx,
        event,
        { kind: kind as ItemCommand['kind'], payload: commandPayload },
        entityIds
      );
      const canonicalRecord = record(snapshot.record);
      const canonicalVariantId = text(canonicalRecord ?? {}, 'variantId');
      return {
        ...event,
        ...(canonicalVariantId ? { aggregateId: canonicalVariantId } : {}),
        payload: { ...event.payload, operationalSnapshot: snapshot }
      };
    }
    if (kind === 'tag.assign') {
      const snapshot = await this.tag(ctx, event, { kind: 'tag.assign', payload: commandPayload });
      return { ...event, payload: { ...event.payload, operationalSnapshot: snapshot } };
    }
    if (kind === 'location.upsert') {
      const snapshot = await this.location(ctx, event, {
        kind: 'location.upsert',
        payload: commandPayload
      });
      return { ...event, payload: { ...event.payload, operationalSnapshot: snapshot } };
    }
    if (kind === 'location.layout.initialize') {
      const snapshot = await this.locationLayout(
        ctx,
        event,
        {
          kind: 'location.layout.initialize',
          payload: commandPayload
        },
        entityIds
      );
      return { ...event, payload: { ...event.payload, operationalSnapshot: snapshot } };
    }
    if (kind === 'warehouse.zone.upsert' || kind === 'warehouse.zone.delete') {
      const snapshot = await this.warehouseZone(ctx, event, {
        kind,
        payload: commandPayload
      });
      return { ...event, payload: { ...event.payload, operationalSnapshot: snapshot } };
    }
    if (kind === 'warehouse.bin.upsert' || kind === 'warehouse.bin.delete') {
      const snapshot = await this.warehouseBin(ctx, event, {
        kind,
        payload: commandPayload
      });
      return { ...event, payload: { ...event.payload, operationalSnapshot: snapshot } };
    }
    if (kind === 'inventory.event' || kind === 'inventory.relocate') {
      const snapshot = await this.inventory(ctx, {
        kind,
        payload: commandPayload
      });
      return { ...event, payload: { ...event.payload, operationalSnapshot: snapshot } };
    }
    if (
      kind === 'catalog.brand.create' ||
      kind === 'catalog.brand.update' ||
      kind === 'catalog.brand.delete'
    ) {
      const snapshot = await this.catalogBrand(ctx, event, {
        kind,
        payload: commandPayload
      });
      return { ...event, payload: { ...event.payload, operationalSnapshot: snapshot } };
    }
    if (
      kind === 'catalog.category.create' ||
      kind === 'catalog.category.update' ||
      kind === 'catalog.category.delete'
    ) {
      const snapshot = await this.catalogCategory(ctx, event, {
        kind,
        payload: commandPayload
      });
      return { ...event, payload: { ...event.payload, operationalSnapshot: snapshot } };
    }
    if (
      kind === 'catalog.specification.create' ||
      kind === 'catalog.specification.update' ||
      kind === 'catalog.specification.delete'
    ) {
      const snapshot = await this.catalogSpecification(ctx, event, {
        kind,
        payload: commandPayload
      });
      return { ...event, payload: { ...event.payload, operationalSnapshot: snapshot } };
    }
    if (kind === 'supplier.upsert' || kind === 'supplier.delete') {
      const snapshot = await this.supplier(ctx, event, { kind, payload: commandPayload });
      return { ...event, payload: { ...event.payload, operationalSnapshot: snapshot } };
    }
    if (kind === 'settings.update') {
      const snapshot = await this.settings(ctx, {
        kind: 'settings.update',
        payload: commandPayload
      });
      return { ...event, payload: { ...event.payload, operationalSnapshot: snapshot } };
    }

    // Existing generic events remain compatible. They deliberately stay event
    // log entries until their server domain model has a matching projector.
    return event;
  }

  /**
   * Persist the complete RFID count protocol instead of replaying a desktop
   * command on another machine. Every row is organization and location
   * scoped; read packets are merged by (count, EPC), so retries and an
   * interrupted connection cannot create duplicate observations.
   */
  private async rfidCycleCount(
    ctx: RequestContext,
    event: SyncPushEvent,
    input: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    requirePermission(ctx, 'rfid_counts.sync');
    const protocolVersion = integer(input, 'protocolVersion');
    const operation = text(input, 'operation');
    const count = record(input.count);
    if (
      protocolVersion !== 1 ||
      !count ||
      !['create', 'expected_batch', 'read_batch', 'state', 'results'].includes(operation ?? '')
    ) {
      throw new ValidationFailedError('Invalid RFID cycle count sync payload');
    }
    const countId = text(count, 'id') ?? event.aggregateId;
    const locationId = text(count, 'locationId');
    if (!countId || countId !== event.aggregateId || !locationId) {
      throw new ValidationFailedError('RFID cycle count identity or location is missing');
    }
    const location = await this.client.query<{ id: string }>(
      `SELECT id FROM locations WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [ctx.organizationId, locationId]
    );
    if (!location.rows[0]) {
      throw new ValidationFailedError('RFID cycle count location is outside the organization');
    }
    if (event.locationId && event.locationId !== locationId) {
      throw new ValidationFailedError('RFID cycle count event location does not match its payload');
    }
    if (ctx.locationId && ctx.locationId !== locationId) {
      throw new ValidationFailedError('RFID cycle count is outside the active location scope');
    }
    const snapshot: RfidCycleCountSnapshot = {
      kind: 'rfid.cycle_count',
      protocolVersion: 1,
      operation: operation as RfidCycleCountSnapshot['operation'],
      count,
      ...(Array.isArray(input.expectedItems) ? { expectedItems: records(input.expectedItems) } : {}),
      ...(Array.isArray(input.reads) ? { reads: records(input.reads) } : {}),
      ...(Array.isArray(input.results) ? { results: records(input.results) } : {}),
      ...(text(input, 'action') ? { action: text(input, 'action') as RfidCycleCountSnapshot['action'] } : {})
    };

    if (snapshot.operation === 'create') {
      await this.upsertRfidCycleCount(ctx, countId, count, true);
    } else {
      const existing = await this.client.query<{
        id: string;
        ownerDeviceId: string | null;
        status: string;
        version: string;
      }>(
        `SELECT id, owner_device_id AS "ownerDeviceId", status, version::text AS version
         FROM rfid_cycle_counts
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [ctx.organizationId, countId]
      );
      if (!existing.rows[0]) {
        throw new ValidationFailedError('RFID cycle count has not been created in cloud yet');
      }
      if (snapshot.operation === 'state') {
        await this.applyRfidCycleCountState(ctx, countId, count, snapshot.action, existing.rows[0]);
      } else if (existing.rows[0].ownerDeviceId && existing.rows[0].ownerDeviceId !== ctx.deviceId) {
        throw new ValidationFailedError('RFID cycle count is owned by another desktop device');
      }
    }

    if (snapshot.operation === 'expected_batch') {
      await this.upsertRfidExpectedItems(ctx, countId, snapshot.expectedItems ?? []);
    }
    if (snapshot.operation === 'read_batch') {
      await this.upsertRfidReads(ctx, countId, snapshot.reads ?? []);
    }
    if (snapshot.operation === 'results') {
      await this.upsertRfidResults(ctx, countId, snapshot.results ?? []);
      await this.updateRfidCycleTotals(ctx.organizationId, countId);
    }

    const canonical = await this.client.query<{
      id: string;
      locationId: string;
      warehouseId: string | null;
      zoneId: string | null;
      binId: string | null;
      name: string;
      status: string;
      expectedTotal: number;
      readTotal: number;
      foundTotal: number;
      missingTotal: number;
      unexpectedTotal: number;
      startedAt: Date | null;
      completedAt: Date | null;
      createdByUserId: string;
      ownerDeviceId: string | null;
      ownerState: string;
      version: string;
      createdAt: Date;
      updatedAt: Date;
    }>(
      `SELECT id, location_id AS "locationId", warehouse_id AS "warehouseId", zone_id AS "zoneId",
              bin_id AS "binId", name, status, expected_total AS "expectedTotal",
              read_total AS "readTotal", found_total AS "foundTotal", missing_total AS "missingTotal",
              unexpected_total AS "unexpectedTotal", started_at AS "startedAt", completed_at AS "completedAt",
              created_by_user_id AS "createdByUserId", owner_device_id AS "ownerDeviceId",
              owner_state AS "ownerState", version::text AS version,
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM rfid_cycle_counts WHERE organization_id = $1 AND id = $2`,
      [ctx.organizationId, countId]
    );
    const header = canonical.rows[0];
    if (!header) throw new ValidationFailedError('RFID cycle count could not be materialized');
    return {
      kind: 'rfid.cycle_count',
      protocolVersion: 1,
      operation: snapshot.operation,
      ...(snapshot.action ? { action: snapshot.action } : {}),
      count: {
        ...header,
        version: Number(header.version),
        startedAt: header.startedAt?.toISOString() ?? null,
        completedAt: header.completedAt?.toISOString() ?? null,
        createdAt: header.createdAt.toISOString(),
        updatedAt: header.updatedAt.toISOString()
      },
      ...(snapshot.operation === 'expected_batch' ? { expectedItems: snapshot.expectedItems ?? [] } : {}),
      ...(snapshot.operation === 'read_batch' ? { reads: snapshot.reads ?? [] } : {}),
      ...(snapshot.operation === 'results' ? { results: snapshot.results ?? [] } : {})
    };
  }

  private async upsertRfidCycleCount(
    ctx: RequestContext,
    countId: string,
    input: Record<string, unknown>,
    creating: boolean
  ): Promise<void> {
    const name = text(input, 'name');
    const locationId = text(input, 'locationId');
    const createdByUserId = text(input, 'createdByUserId') ?? ctx.userId;
    if (!name || !locationId || !createdByUserId) {
      throw new ValidationFailedError('RFID cycle count header is incomplete');
    }
    const status = text(input, 'status') ?? 'draft';
    if (!['draft', 'ready', 'in_progress', 'paused', 'review', 'completed', 'cancelled'].includes(status)) {
      throw new ValidationFailedError('RFID cycle count status is invalid');
    }
    // Ownership belongs to the authenticated desktop session, never to a
    // caller-supplied reader identifier in the payload.
    const ownerDeviceId = ctx.deviceId ?? null;
    await this.client.query(
      `INSERT INTO rfid_cycle_counts (
         id, organization_id, location_id, warehouse_id, zone_id, bin_id, name, status,
         expected_total, read_total, found_total, missing_total, unexpected_total,
         started_at, completed_at, created_by_user_id, owner_device_id, owner_state, protocol_version
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14::timestamptz, $15::timestamptz, $16, $17, $18, 1
       )
       ON CONFLICT (id) DO UPDATE SET
         expected_total = GREATEST(rfid_cycle_counts.expected_total, EXCLUDED.expected_total),
         updated_at = now()
       WHERE rfid_cycle_counts.organization_id = EXCLUDED.organization_id`,
      [
        countId,
        ctx.organizationId,
        locationId,
        text(input, 'warehouseId') ?? null,
        text(input, 'zoneId') ?? null,
        text(input, 'binId') ?? null,
        name,
        status,
        integer(input, 'expectedTotal') ?? 0,
        integer(input, 'readTotal') ?? 0,
        integer(input, 'foundTotal') ?? 0,
        integer(input, 'missingTotal') ?? 0,
        integer(input, 'unexpectedTotal') ?? 0,
        text(input, 'startedAt') ?? null,
        text(input, 'completedAt') ?? null,
        createdByUserId,
        ownerDeviceId,
        ownerDeviceId ? 'owned' : 'none'
      ]
    );
    if (!creating) return;
  }

  private async applyRfidCycleCountState(
    ctx: RequestContext,
    countId: string,
    count: Record<string, unknown>,
    action: RfidCycleCountSnapshot['action'] | undefined,
    existing: { ownerDeviceId: string | null; status: string; version: string }
  ): Promise<void> {
    if (!action || !['start', 'restart', 'pause', 'resume', 'review', 'complete', 'cancel', 'claim'].includes(action)) {
      throw new ValidationFailedError('RFID cycle count state action is invalid');
    }
    if (!ctx.deviceId) throw new ValidationFailedError('RFID cycle count state requires a device');
    if (action === 'claim') {
      const claimed = await this.client.query(
        `UPDATE rfid_cycle_counts
         SET owner_device_id = $3, owner_state = 'owned', version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND status = 'paused'
           AND owner_device_id IS DISTINCT FROM $3 AND version = $4::bigint`,
        [ctx.organizationId, countId, ctx.deviceId, existing.version]
      );
      if (claimed.rowCount !== 1) {
        throw new ValidationFailedError('RFID cycle count cannot be claimed because it is already owned');
      }
      return;
    }
    if (action === 'restart') {
      if (!['in_progress', 'paused', 'review', 'completed'].includes(existing.status)) {
        throw new ValidationFailedError('RFID cycle count cannot be restarted from its current status');
      }
      const restarted = await this.client.query(
        `WITH authorized_count AS (
           SELECT id FROM rfid_cycle_counts
           WHERE organization_id = $1 AND id = $2
             AND (owner_device_id = $3 OR owner_device_id IS NULL)
         ), cleared_reads AS (
           DELETE FROM rfid_cycle_count_reads
           WHERE organization_id = $1 AND cycle_count_id = $2
             AND EXISTS (SELECT 1 FROM authorized_count)
         ), cleared_results AS (
           DELETE FROM rfid_cycle_count_results
           WHERE organization_id = $1 AND cycle_count_id = $2
             AND EXISTS (SELECT 1 FROM authorized_count)
         )
         UPDATE rfid_cycle_counts
         SET status = 'in_progress', started_at = COALESCE($4::timestamptz, now()), completed_at = NULL,
             owner_device_id = $3, owner_state = 'owned', read_total = 0, found_total = 0,
             missing_total = expected_total, unexpected_total = 0, version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2
           AND EXISTS (SELECT 1 FROM authorized_count)`,
        [ctx.organizationId, countId, ctx.deviceId, text(count, 'startedAt') ?? null]
      );
      if (restarted.rowCount !== 1) {
        throw new ValidationFailedError('Only the owning desktop may restart this RFID count');
      }
      return;
    }
    const nextStatus = text(count, 'status');
    if (!nextStatus || !['in_progress', 'paused', 'review', 'completed', 'cancelled'].includes(nextStatus)) {
      throw new ValidationFailedError('RFID cycle count next status is invalid');
    }
    const release = action === 'review' || action === 'complete' || action === 'cancel';
    // A desktop emits the business command and its RFID state snapshot for the
    // same terminal action. The command may release ownership before the
    // snapshot arrives, so accept that exact terminal state as a no-op.
    if (release && existing.ownerDeviceId === null && existing.status === nextStatus) return;
    if (existing.ownerDeviceId !== ctx.deviceId) {
      throw new ValidationFailedError('Only the owning desktop may change this RFID count');
    }
    const updated = await this.client.query(
      `UPDATE rfid_cycle_counts
       SET status = $3, started_at = COALESCE(started_at, $4::timestamptz),
           completed_at = COALESCE($5::timestamptz, completed_at),
           owner_device_id = CASE WHEN $6 THEN NULL ELSE owner_device_id END,
           owner_state = CASE WHEN $6 THEN 'released' ELSE 'owned' END,
           expected_total = GREATEST(expected_total, $7), read_total = GREATEST(read_total, $8),
           found_total = GREATEST(found_total, $9), missing_total = GREATEST(missing_total, $10),
           unexpected_total = GREATEST(unexpected_total, $11), version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND owner_device_id = $12`,
      [
        ctx.organizationId,
        countId,
        nextStatus,
        text(count, 'startedAt') ?? null,
        text(count, 'completedAt') ?? null,
        release,
        integer(count, 'expectedTotal') ?? 0,
        integer(count, 'readTotal') ?? 0,
        integer(count, 'foundTotal') ?? 0,
        integer(count, 'missingTotal') ?? 0,
        integer(count, 'unexpectedTotal') ?? 0,
        ctx.deviceId
      ]
    );
    if (updated.rowCount !== 1) throw new ValidationFailedError('RFID cycle count ownership changed');
  }

  private async upsertRfidExpectedItems(
    ctx: RequestContext,
    countId: string,
    rows: readonly Record<string, unknown>[]
  ): Promise<void> {
    for (const row of rows) {
      const id = text(row, 'id');
      const epcValue = text(row, 'epc');
      const expectedLocationId = text(row, 'expectedLocationId');
      if (!id || !epcValue || !expectedLocationId) {
        throw new ValidationFailedError('RFID expected item is incomplete');
      }
      const epc = normalizeEpc(epcValue);
      await this.client.query(
        `INSERT INTO rfid_cycle_count_expected_items (
           id, organization_id, cycle_count_id, rfid_tag_id, product_variant_id, epc,
           expected_location_id, expected_bin_id, snapshot_version
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (organization_id, cycle_count_id, epc) DO UPDATE SET
           rfid_tag_id = EXCLUDED.rfid_tag_id, product_variant_id = EXCLUDED.product_variant_id,
           expected_location_id = EXCLUDED.expected_location_id, expected_bin_id = EXCLUDED.expected_bin_id,
           snapshot_version = EXCLUDED.snapshot_version, version = rfid_cycle_count_expected_items.version + 1,
           updated_at = now()`,
        [
          id,
          ctx.organizationId,
          countId,
          text(row, 'rfidTagId') ?? null,
          text(row, 'productVariantId') ?? null,
          epc,
          expectedLocationId,
          text(row, 'expectedBinId') ?? null,
          integer(row, 'snapshotVersion') ?? 1
        ]
      );
    }
    await this.updateRfidCycleTotals(ctx.organizationId, countId);
  }

  private async upsertRfidReads(
    ctx: RequestContext,
    countId: string,
    rows: readonly Record<string, unknown>[]
  ): Promise<void> {
    if (!ctx.deviceId) throw new ValidationFailedError('RFID read packet requires a device');
    if (rows.length > 100) throw new ValidationFailedError('RFID read packet may contain at most 100 EPCs');
    for (const row of rows) {
      const id = text(row, 'id');
      const epcValue = text(row, 'epc');
      const firstSeenAt = text(row, 'firstReadAt');
      const lastSeenAt = text(row, 'lastReadAt');
      if (!id || !epcValue || !firstSeenAt || !lastSeenAt) {
        throw new ValidationFailedError('RFID read packet item is incomplete');
      }
      const epc = normalizeEpc(epcValue);
      await this.client.query(
        `INSERT INTO rfid_cycle_count_reads (
           id, organization_id, cycle_count_id, rfid_tag_id, epc, device_id, antenna,
           first_seen_at, last_seen_at, read_count, strongest_rssi, last_rssi, frequency_khz, sequence
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10, $11, $12, $13, $14)
         ON CONFLICT (organization_id, cycle_count_id, epc) DO UPDATE SET
           rfid_tag_id = COALESCE(EXCLUDED.rfid_tag_id, rfid_cycle_count_reads.rfid_tag_id),
           device_id = EXCLUDED.device_id, antenna = EXCLUDED.antenna,
           first_seen_at = LEAST(rfid_cycle_count_reads.first_seen_at, EXCLUDED.first_seen_at),
           last_seen_at = GREATEST(rfid_cycle_count_reads.last_seen_at, EXCLUDED.last_seen_at),
           read_count = GREATEST(rfid_cycle_count_reads.read_count, EXCLUDED.read_count),
           strongest_rssi = CASE
             WHEN rfid_cycle_count_reads.strongest_rssi IS NULL THEN EXCLUDED.strongest_rssi
             WHEN EXCLUDED.strongest_rssi IS NULL THEN rfid_cycle_count_reads.strongest_rssi
             ELSE GREATEST(rfid_cycle_count_reads.strongest_rssi, EXCLUDED.strongest_rssi)
           END,
           last_rssi = EXCLUDED.last_rssi, frequency_khz = EXCLUDED.frequency_khz,
           sequence = EXCLUDED.sequence, version = rfid_cycle_count_reads.version + 1, updated_at = now()`,
        [
          id,
          ctx.organizationId,
          countId,
          text(row, 'rfidTagId') ?? null,
          epc,
          ctx.deviceId,
          integer(row, 'antenna') ?? null,
          firstSeenAt,
          lastSeenAt,
          Math.max(1, integer(row, 'rawReadCount') ?? 1),
          decimal(row, 'strongestRssi') ?? null,
          decimal(row, 'lastRssi') ?? null,
          integer(row, 'frequencyKhz') ?? null,
          integer(row, 'sequence') ?? null
        ]
      );
    }
    await this.updateRfidCycleTotals(ctx.organizationId, countId);
  }

  private async upsertRfidResults(
    ctx: RequestContext,
    countId: string,
    rows: readonly Record<string, unknown>[]
  ): Promise<void> {
    for (const row of rows) {
      const id = text(row, 'id');
      const epcValue = text(row, 'epc');
      const classification = text(row, 'classification');
      if (!id || !epcValue || !['found', 'missing', 'unexpected'].includes(classification ?? '')) {
        throw new ValidationFailedError('RFID result is incomplete');
      }
      await this.client.query(
        `INSERT INTO rfid_cycle_count_results (
           id, organization_id, cycle_count_id, rfid_tag_id, product_variant_id, epc, classification,
           expected_location_id, observed_location_id, strongest_rssi, resolution, resolved_by_user_id, resolved_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz)
         ON CONFLICT (organization_id, cycle_count_id, epc) DO UPDATE SET
           rfid_tag_id = EXCLUDED.rfid_tag_id, product_variant_id = EXCLUDED.product_variant_id,
           classification = EXCLUDED.classification, expected_location_id = EXCLUDED.expected_location_id,
           observed_location_id = EXCLUDED.observed_location_id, strongest_rssi = EXCLUDED.strongest_rssi,
           resolution = EXCLUDED.resolution, resolved_by_user_id = EXCLUDED.resolved_by_user_id,
           resolved_at = EXCLUDED.resolved_at, version = rfid_cycle_count_results.version + 1, updated_at = now()`,
        [
          id, ctx.organizationId, countId, text(row, 'rfidTagId') ?? null,
          text(row, 'productVariantId') ?? null, normalizeEpc(epcValue), classification,
          text(row, 'expectedLocationId') ?? null, text(row, 'observedLocationId') ?? null,
          decimal(row, 'strongestRssi') ?? null, text(row, 'resolution') ?? null,
          text(row, 'resolvedByUserId') ?? null, text(row, 'resolvedAt') ?? null
        ]
      );
    }
  }

  private async updateRfidCycleTotals(organizationId: string, countId: string): Promise<void> {
    await this.client.query(
      `UPDATE rfid_cycle_counts count SET
         expected_total = (SELECT COUNT(*) FROM rfid_cycle_count_expected_items expected
                           WHERE expected.organization_id = count.organization_id AND expected.cycle_count_id = count.id),
         read_total = (SELECT COUNT(*) FROM rfid_cycle_count_reads reads
                       WHERE reads.organization_id = count.organization_id AND reads.cycle_count_id = count.id),
         found_total = (SELECT COUNT(*) FROM rfid_cycle_count_reads reads
                        JOIN rfid_cycle_count_expected_items expected
                          ON expected.organization_id = reads.organization_id
                         AND expected.cycle_count_id = reads.cycle_count_id AND expected.epc = reads.epc
                        WHERE reads.organization_id = count.organization_id AND reads.cycle_count_id = count.id),
         missing_total = (SELECT COUNT(*) FROM rfid_cycle_count_expected_items expected
                          WHERE expected.organization_id = count.organization_id AND expected.cycle_count_id = count.id
                            AND NOT EXISTS (SELECT 1 FROM rfid_cycle_count_reads reads
                                            WHERE reads.organization_id = expected.organization_id
                                              AND reads.cycle_count_id = expected.cycle_count_id AND reads.epc = expected.epc)),
         unexpected_total = (SELECT COUNT(*) FROM rfid_cycle_count_reads reads
                             WHERE reads.organization_id = count.organization_id AND reads.cycle_count_id = count.id
                               AND NOT EXISTS (SELECT 1 FROM rfid_cycle_count_expected_items expected
                                               WHERE expected.organization_id = reads.organization_id
                                                 AND expected.cycle_count_id = reads.cycle_count_id AND expected.epc = reads.epc)),
         updated_at = now()
       WHERE count.organization_id = $1 AND count.id = $2`,
      [organizationId, countId]
    );
  }

  /**
   * A location is the shared key between the RFID desktop inventory and the
   * web product modal. Persist the desktop UUID itself: inventing a second
   * Platform UUID makes later inventory and EPC events point at a location
   * that does not exist on the other side.
   */
  private async location(
    ctx: RequestContext,
    event: SyncPushEvent,
    command: LocationCommand
  ): Promise<Record<string, unknown>> {
    const input = command.payload;
    const id = text(input, 'id') ?? event.aggregateId;
    const code = text(input, 'code');
    const name = text(input, 'name');
    const type = text(input, 'type') ?? 'store';
    if (!code || !name || !['warehouse', 'store', 'office', 'virtual'].includes(type)) {
      throw new ValidationFailedError('Desktop location upsert command is incomplete');
    }

    const result = await this.client.query<{
      id: string;
      code: string;
      name: string;
      type: string;
      active: boolean;
      version: string;
    }>(
      `INSERT INTO locations (id, organization_id, code, name, type, timezone, active)
       VALUES ($1, $2, upper($3), $4, $5, 'Europe/Belgrade', $6)
       ON CONFLICT (id) DO UPDATE
       SET code = EXCLUDED.code,
           name = EXCLUDED.name,
           type = EXCLUDED.type,
           timezone = EXCLUDED.timezone,
           active = EXCLUDED.active,
           deleted_at = NULL,
           version = locations.version + 1,
           updated_at = now()
       RETURNING id, code, name, type, active, version::text AS version`,
      [id, ctx.organizationId, code, name, type, boolean(input, 'active', true)]
    );
    return { kind: 'location', location: result.rows[0] };
  }

  /**
   * A desktop location creates its warehouse, first zone and first shelf in
   * one local transaction.  Persist that same hierarchy in Platform instead
   * of treating the command as an opaque sync-log record.
   *
   * Older desktop outbox records did not include the generated child UUIDs.
   * They remain valid: Platform creates a canonical default zone and shelf.
   * New clients include the IDs in entityIds.layout, so all three levels keep
   * their exact identity across desktop and web.
   */
  private async locationLayout(
    ctx: RequestContext,
    event: SyncPushEvent,
    command: LocationLayoutCommand,
    entityIds: Record<string, unknown> | undefined
  ): Promise<Record<string, unknown>> {
    const locationId = text(command.payload, 'locationId');
    if (!locationId)
      throw new ValidationFailedError('Desktop location layout command is incomplete');
    const location = await this.client.query<{ code: string; name: string }>(
      `SELECT code, name FROM locations
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [ctx.organizationId, locationId]
    );
    const locationRow = location.rows[0];
    if (!locationRow)
      throw new ValidationFailedError('Desktop location does not exist on Platform');

    const layout = record(entityIds?.layout);
    const layoutWarehouse = record(layout?.warehouse);
    const warehouseId = text(layoutWarehouse ?? {}, 'id') ?? event.aggregateId;
    if (warehouseId !== event.aggregateId) {
      throw new ValidationFailedError('Desktop warehouse identity does not match sync aggregate');
    }
    const requestedWarehouseCode = text(layoutWarehouse ?? {}, 'code') ?? `SKL-${locationRow.code}`;
    const warehouseCode = await this.availableWarehouseCode(
      ctx.organizationId,
      warehouseId,
      requestedWarehouseCode
    );
    const warehouseName = text(layoutWarehouse ?? {}, 'name') ?? `Skladište ${locationRow.name}`;
    const warehouse = await this.client.query<{
      id: string;
      locationId: string;
      code: string;
      name: string;
      active: boolean;
      version: string;
    }>(
      `INSERT INTO warehouses (id, organization_id, location_id, code, name, active)
       VALUES ($1, $2, $3, upper($4), $5, true)
       ON CONFLICT (id) DO UPDATE
       SET location_id = EXCLUDED.location_id, code = EXCLUDED.code, name = EXCLUDED.name,
           active = true, deleted_at = NULL, version = warehouses.version + 1, updated_at = now()
       WHERE warehouses.organization_id = EXCLUDED.organization_id
       RETURNING id, location_id AS "locationId", code, name, active, version::text AS version`,
      [warehouseId, ctx.organizationId, locationId, warehouseCode, warehouseName]
    );
    if (!warehouse.rows[0])
      throw new ValidationFailedError('Warehouse belongs to another organization');

    const requestedZones = records(layout?.zones);
    const zoneInputs = requestedZones.length
      ? requestedZones
      : [
          {
            id: randomUUID(),
            code: 'ZONA-1',
            name: 'Osnovna zona',
            bins: [{ id: randomUUID(), code: 'POLICA-1', name: 'Osnovna polica' }]
          }
        ];
    const zones: Record<string, unknown>[] = [];
    for (const [zoneIndex, zoneInput] of zoneInputs.entries()) {
      const zoneId = text(zoneInput, 'id') ?? randomUUID();
      const zoneCode = text(zoneInput, 'code');
      const zoneName = text(zoneInput, 'name');
      if (!zoneCode || !zoneName)
        throw new ValidationFailedError('Desktop warehouse zone is incomplete');
      const zone = await this.client.query<{
        id: string;
        warehouseId: string;
        code: string;
        name: string;
        displayOrder: number;
        active: boolean;
        version: string;
      }>(
        `INSERT INTO warehouse_zones (id, organization_id, warehouse_id, code, name, display_order, active)
         VALUES ($1, $2, $3, upper($4), $5, $6, $7)
         ON CONFLICT (id) DO UPDATE
         SET warehouse_id = EXCLUDED.warehouse_id, code = EXCLUDED.code, name = EXCLUDED.name,
             display_order = EXCLUDED.display_order, active = EXCLUDED.active, deleted_at = NULL,
             version = warehouse_zones.version + 1, updated_at = now()
         WHERE warehouse_zones.organization_id = EXCLUDED.organization_id
         RETURNING id, warehouse_id AS "warehouseId", code, name,
                   display_order AS "displayOrder", active, version::text AS version`,
        [
          zoneId,
          ctx.organizationId,
          warehouseId,
          zoneCode,
          zoneName,
          zoneIndex,
          boolean(zoneInput, 'active', true)
        ]
      );
      const zoneRow = zone.rows[0];
      if (!zoneRow)
        throw new ValidationFailedError('Warehouse zone belongs to another organization');
      const bins: Record<string, unknown>[] = [];
      for (const [binIndex, binInput] of records(zoneInput.bins).entries()) {
        const binId = text(binInput, 'id') ?? randomUUID();
        const binCode = text(binInput, 'code');
        const binName = text(binInput, 'name');
        if (!binCode || !binName)
          throw new ValidationFailedError('Desktop warehouse shelf is incomplete');
        const bin = await this.client.query<{
          id: string;
          zoneId: string;
          code: string;
          name: string;
          displayOrder: number;
          active: boolean;
          status: string;
          version: string;
        }>(
          `INSERT INTO warehouse_bins (id, organization_id, zone_id, code, name, display_order, active, status)
           VALUES ($1, $2, $3, upper($4), $5, $6, true, 'active')
           ON CONFLICT (id) DO UPDATE
           SET zone_id = EXCLUDED.zone_id, code = EXCLUDED.code, name = EXCLUDED.name,
               display_order = EXCLUDED.display_order, active = EXCLUDED.active, status = EXCLUDED.status,
               deleted_at = NULL, version = warehouse_bins.version + 1, updated_at = now()
           WHERE warehouse_bins.organization_id = EXCLUDED.organization_id
           RETURNING id, zone_id AS "zoneId", code, name, display_order AS "displayOrder",
                     active, status, version::text AS version`,
          [binId, ctx.organizationId, zoneId, binCode, binName, binIndex]
        );
        if (!bin.rows[0])
          throw new ValidationFailedError('Warehouse shelf belongs to another organization');
        bins.push(bin.rows[0]);
      }
      if (bins.length === 0) {
        throw new ValidationFailedError('Every desktop warehouse zone must contain a shelf');
      }
      zones.push({ ...zoneRow, bins });
    }
    return { kind: 'warehouse.layout', warehouse: warehouse.rows[0], zones };
  }

  private async warehouseZone(
    ctx: RequestContext,
    event: SyncPushEvent,
    command: WarehouseZoneCommand
  ): Promise<Record<string, unknown>> {
    const zoneId =
      text(command.payload, 'id') ?? text(command.payload, 'zoneId') ?? event.aggregateId;
    if (zoneId !== event.aggregateId) {
      throw new ValidationFailedError(
        'Desktop warehouse zone identity does not match sync aggregate'
      );
    }
    if (command.kind === 'warehouse.zone.delete') {
      const current = await this.client.query<{ id: string; warehouseId: string }>(
        `SELECT id, warehouse_id AS "warehouseId" FROM warehouse_zones
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [ctx.organizationId, zoneId]
      );
      if (!current.rows[0])
        return { kind: 'warehouse.zone', id: zoneId, deleted: true, missing: true };
      const bins = await this.client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM warehouse_bins
         WHERE organization_id = $1 AND zone_id = $2 AND deleted_at IS NULL`,
        [ctx.organizationId, zoneId]
      );
      if (Number(bins.rows[0]?.count ?? 0) > 0) {
        throw new ValidationFailedError(
          'Warehouse zone cannot be deleted while it contains shelves'
        );
      }
      await this.client.query(
        `UPDATE warehouse_zones
         SET active = false, deleted_at = now(), version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2`,
        [ctx.organizationId, zoneId]
      );
      return { kind: 'warehouse.zone', id: zoneId, deleted: true };
    }

    const warehouseId = text(command.payload, 'warehouseId');
    const code = text(command.payload, 'code');
    const name = text(command.payload, 'name');
    if (!warehouseId || !code || !name) {
      throw new ValidationFailedError('Desktop warehouse zone command is incomplete');
    }
    const warehouse = await this.client.query<{ locationId: string }>(
      `SELECT location_id AS "locationId" FROM warehouses
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [ctx.organizationId, warehouseId]
    );
    if (!warehouse.rows[0])
      throw new ValidationFailedError('Desktop warehouse does not exist on Platform');
    const zone = await this.client.query<{
      id: string;
      warehouseId: string;
      code: string;
      name: string;
      displayOrder: number;
      active: boolean;
      version: string;
    }>(
      `INSERT INTO warehouse_zones (id, organization_id, warehouse_id, code, name, display_order, active)
       VALUES ($1, $2, $3, upper($4), $5, $6, $7)
       ON CONFLICT (id) DO UPDATE
       SET warehouse_id = EXCLUDED.warehouse_id, code = EXCLUDED.code, name = EXCLUDED.name,
           display_order = EXCLUDED.display_order, active = EXCLUDED.active, deleted_at = NULL,
           version = warehouse_zones.version + 1, updated_at = now()
       WHERE warehouse_zones.organization_id = EXCLUDED.organization_id
       RETURNING id, warehouse_id AS "warehouseId", code, name,
                 display_order AS "displayOrder", active, version::text AS version`,
      [
        zoneId,
        ctx.organizationId,
        warehouseId,
        code,
        name,
        integer(command.payload, 'displayOrder') ?? 0,
        boolean(command.payload, 'active', true)
      ]
    );
    if (!zone.rows[0])
      throw new ValidationFailedError('Warehouse zone belongs to another organization');
    return { kind: 'warehouse.zone', zone: zone.rows[0], locationId: warehouse.rows[0].locationId };
  }

  private async warehouseBin(
    ctx: RequestContext,
    event: SyncPushEvent,
    command: WarehouseBinCommand
  ): Promise<Record<string, unknown>> {
    const binId =
      text(command.payload, 'id') ?? text(command.payload, 'binId') ?? event.aggregateId;
    if (binId !== event.aggregateId) {
      throw new ValidationFailedError(
        'Desktop warehouse shelf identity does not match sync aggregate'
      );
    }
    if (command.kind === 'warehouse.bin.delete') {
      const current = await this.client.query<{ id: string }>(
        `SELECT id FROM warehouse_bins
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [ctx.organizationId, binId]
      );
      // Old desktop layout events did not carry the default shelf UUID. A
      // delete of that already-missing remote record is deliberately
      // idempotent, which clears the local outbox instead of retrying forever.
      if (!current.rows[0])
        return { kind: 'warehouse.bin', id: binId, deleted: true, missing: true };
      const inventory = await this.client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM inventory_items
         WHERE organization_id = $1 AND current_bin_id = $2 AND deleted_at IS NULL`,
        [ctx.organizationId, binId]
      );
      if (Number(inventory.rows[0]?.count ?? 0) > 0) {
        throw new ValidationFailedError(
          'Warehouse shelf cannot be deleted while it contains inventory'
        );
      }
      await this.client.query(
        `UPDATE warehouse_bins
         SET active = false, status = 'inactive', deleted_at = now(),
             version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2`,
        [ctx.organizationId, binId]
      );
      return { kind: 'warehouse.bin', id: binId, deleted: true };
    }

    const warehouseId = text(command.payload, 'warehouseId');
    const zoneId = text(command.payload, 'zoneId');
    const code = text(command.payload, 'code');
    const name = text(command.payload, 'name');
    if (!warehouseId || !zoneId || !code || !name) {
      throw new ValidationFailedError('Desktop warehouse shelf command is incomplete');
    }
    const scope = await this.client.query<{ locationId: string }>(
      `SELECT warehouse.location_id AS "locationId"
       FROM warehouse_zones zone
       JOIN warehouses warehouse ON warehouse.id = zone.warehouse_id
       WHERE zone.organization_id = $1 AND zone.id = $2 AND zone.warehouse_id = $3
         AND zone.deleted_at IS NULL AND warehouse.deleted_at IS NULL`,
      [ctx.organizationId, zoneId, warehouseId]
    );
    if (!scope.rows[0])
      throw new ValidationFailedError('Warehouse zone does not belong to selected warehouse');
    const status = text(command.payload, 'status') ?? 'active';
    if (!['active', 'blocked', 'critical', 'inactive'].includes(status)) {
      throw new ValidationFailedError('Desktop warehouse shelf status is invalid');
    }
    const capacity = integer(command.payload, 'capacity');
    const lowStockThreshold = integer(command.payload, 'lowStockThreshold');
    if (capacity !== undefined && lowStockThreshold !== undefined && lowStockThreshold > capacity) {
      throw new ValidationFailedError('Warehouse shelf low stock threshold exceeds capacity');
    }
    const bin = await this.client.query<{
      id: string;
      zoneId: string;
      code: string;
      name: string;
      capacity: number | null;
      lowStockThreshold: number | null;
      displayOrder: number;
      active: boolean;
      status: string;
      version: string;
    }>(
      `INSERT INTO warehouse_bins (
         id, organization_id, zone_id, code, name, capacity, low_stock_threshold,
         display_order, active, status
       ) VALUES ($1, $2, $3, upper($4), $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE
       SET zone_id = EXCLUDED.zone_id, code = EXCLUDED.code, name = EXCLUDED.name,
           capacity = EXCLUDED.capacity, low_stock_threshold = EXCLUDED.low_stock_threshold,
           display_order = EXCLUDED.display_order, active = EXCLUDED.active, status = EXCLUDED.status,
           deleted_at = NULL, version = warehouse_bins.version + 1, updated_at = now()
       WHERE warehouse_bins.organization_id = EXCLUDED.organization_id
       RETURNING id, zone_id AS "zoneId", code, name, capacity,
                 low_stock_threshold AS "lowStockThreshold", display_order AS "displayOrder",
                 active, status, version::text AS version`,
      [
        binId,
        ctx.organizationId,
        zoneId,
        code,
        name,
        capacity ?? null,
        lowStockThreshold ?? null,
        integer(command.payload, 'displayOrder') ?? 0,
        status !== 'inactive',
        status
      ]
    );
    if (!bin.rows[0])
      throw new ValidationFailedError('Warehouse shelf belongs to another organization');
    return { kind: 'warehouse.bin', bin: bin.rows[0], locationId: scope.rows[0].locationId };
  }

  /** Materialize desktop inventory commands into the Platform balance.  The
   * product snapshot returned below carries the chosen zone and shelf back to
   * the website and to other RFID desktops. */
  private async inventory(
    ctx: RequestContext,
    command: InventoryCommand
  ): Promise<Record<string, unknown>> {
    const variantId = text(command.payload, 'productVariantId');
    const quantity = integer(command.payload, 'quantity');
    if (!variantId || quantity === undefined || quantity === 0) {
      throw new ValidationFailedError('Desktop inventory command is incomplete');
    }
    const sourceLocationId = text(command.payload, 'sourceLocationId');
    const sourceBinId = text(command.payload, 'sourceBinId');
    const destinationLocationId = text(command.payload, 'destinationLocationId');
    const destinationBinId = text(command.payload, 'destinationBinId');
    const inventory = new InventoryRepository(this.client);
    const eventType = text(command.payload, 'eventType');
    const placement = async (locationId: string, binId: string | undefined) => {
      if (!binId) return { zoneId: undefined, binId: undefined };
      const result = await this.client.query<{ zoneId: string }>(
        `SELECT zone.id AS "zoneId"
         FROM warehouse_bins bin
         JOIN warehouse_zones zone
           ON zone.organization_id = bin.organization_id AND zone.id = bin.zone_id
         JOIN warehouses warehouse
           ON warehouse.organization_id = zone.organization_id AND warehouse.id = zone.warehouse_id
         WHERE bin.organization_id = $1 AND bin.id = $2 AND warehouse.location_id = $3
           AND bin.deleted_at IS NULL AND bin.active
           AND zone.deleted_at IS NULL AND zone.active
           AND warehouse.deleted_at IS NULL AND warehouse.active`,
        [ctx.organizationId, binId, locationId]
      );
      const zoneId = result.rows[0]?.zoneId;
      if (!zoneId)
        throw new ValidationFailedError('Desktop inventory shelf does not belong to location');
      return { zoneId, binId };
    };
    const adjust = async (locationId: string, binId: string | undefined, quantityDelta: number) => {
      const storage = await placement(locationId, binId);
      await inventory.adjust(ctx, {
        variantId,
        locationId,
        ...(storage.zoneId ? { zoneId: storage.zoneId } : {}),
        ...(storage.binId ? { binId: storage.binId } : {}),
        quantityDelta,
        sourceType: 'rfiddaja_sync',
        sourceId: null,
        metadata: { command: command.kind }
      });
    };
    const amount = Math.abs(quantity);
    if (eventType === 'tag_assignment') {
      // Tag assignment only links the EPC to a variant; the desktop ledger
      // deliberately does not change the quantity for that operation.
    } else if (command.kind === 'inventory.relocate' || eventType === 'relocation') {
      if (!sourceLocationId || !destinationLocationId) {
        throw new ValidationFailedError(
          'Desktop inventory relocation requires source and destination'
        );
      }
      await adjust(sourceLocationId, sourceBinId, -amount);
      await adjust(destinationLocationId, destinationBinId, amount);
    } else {
      if (['sale', 'transfer_out', 'count_missing', 'tag_retirement'].includes(eventType ?? '')) {
        if (!sourceLocationId)
          throw new ValidationFailedError('Desktop inventory command requires a source location');
        await adjust(sourceLocationId, sourceBinId, -amount);
      } else if (eventType === 'adjustment' && quantity < 0) {
        if (!sourceLocationId)
          throw new ValidationFailedError(
            'Desktop inventory adjustment requires a source location'
          );
        await adjust(sourceLocationId, sourceBinId, -amount);
      } else {
        if (!destinationLocationId) {
          throw new ValidationFailedError(
            'Desktop inventory command requires a destination location'
          );
        }
        await adjust(destinationLocationId, destinationBinId, amount);
      }
    }
    const variant = await this.client.query<{ productId: string }>(
      `SELECT product_id AS "productId"
       FROM product_variants
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [ctx.organizationId, variantId]
    );
    const productId = variant.rows[0]?.productId;
    if (!productId)
      throw new ValidationFailedError('Desktop inventory variant does not exist on Platform');
    return this.catalogSnapshot(ctx.organizationId, productId, variantId);
  }

  private async availableWarehouseCode(
    organizationId: string,
    warehouseId: string,
    requestedCode: string
  ): Promise<string> {
    const normalized = requestedCode.trim().toUpperCase() || `SKL-${warehouseId.slice(0, 8)}`;
    for (let suffix = 1; suffix < 1000; suffix += 1) {
      const code = suffix === 1 ? normalized : `${normalized}-${suffix}`;
      const conflict = await this.client.query<{ id: string }>(
        `SELECT id FROM warehouses
         WHERE organization_id = $1 AND code = $2 AND id <> $3 AND deleted_at IS NULL`,
        [organizationId, code, warehouseId]
      );
      if (!conflict.rows[0]) return code;
    }
    throw new ValidationFailedError('Unable to assign a unique warehouse code');
  }

  private async catalogBrand(
    ctx: RequestContext,
    event: SyncPushEvent,
    command: CatalogBrandCommand
  ): Promise<Record<string, unknown>> {
    requirePermission(ctx, 'catalog.write');
    const brandId =
      command.kind === 'catalog.brand.delete'
        ? text(command.payload, 'brandId') ?? event.aggregateId
        : text(command.payload, 'id') ?? event.aggregateId;
    if (brandId !== event.aggregateId) {
      throw new ValidationFailedError('Desktop brand identity does not match sync aggregate');
    }
    if (command.kind === 'catalog.brand.delete') {
      const used = await this.client.query(
        `SELECT 1 FROM products
         WHERE organization_id = $1 AND brand_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [ctx.organizationId, brandId]
      );
      if (used.rowCount) {
        throw new ValidationFailedError('Brand cannot be deleted while products still use it');
      }
      const deleted = await this.client.query(
        `UPDATE brands
         SET deleted_at = now(), active = false, version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [ctx.organizationId, brandId]
      );
      if (deleted.rowCount !== 1) {
        throw new ValidationFailedError('Desktop brand does not exist on Platform');
      }
      return { kind: 'catalog.brand', id: brandId, deleted: true };
    }
    const name = text(command.payload, 'name');
    const requestedDepartmentId = text(command.payload, 'departmentId');
    if (!name || name.length > 240 || !uuid(requestedDepartmentId)) {
      throw new ValidationFailedError('Desktop brand command is incomplete');
    }
    const departmentId = await this.resolveDepartmentId(ctx.organizationId, command.payload);
    if (!departmentId) {
      throw new ValidationFailedError('Selected brand department is not active');
    }
    if (command.kind === 'catalog.brand.update') {
      const updated = await this.client.query<{
        id: string;
        name: string;
        departmentId: string;
      }>(
        `UPDATE brands
         SET name = $3, slug = $4, department_id = $5, active = true, deleted_at = NULL,
             version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
         RETURNING id, name, department_id AS "departmentId"`,
        [ctx.organizationId, brandId, name, catalogSlug(name, brandId), departmentId]
      );
      if (!updated.rows[0]) throw new ValidationFailedError('Desktop brand does not exist on Platform');
      return { kind: 'catalog.brand', brand: updated.rows[0] };
    }
    const result = await this.client.query<{
      id: string;
      name: string;
      departmentId: string;
    }>(
      `INSERT INTO brands (id, organization_id, name, slug, department_id, active)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name, slug = EXCLUDED.slug, department_id = EXCLUDED.department_id,
           active = true, deleted_at = NULL, version = brands.version + 1, updated_at = now()
       RETURNING id, name, department_id AS "departmentId"`,
      [
        brandId,
        ctx.organizationId,
        name,
        catalogSlug(name, brandId),
        departmentId
      ]
    );
    if (!result.rows[0]) throw new ValidationFailedError('Desktop brand could not be saved');
    return { kind: 'catalog.brand', brand: result.rows[0] };
  }

  private async catalogCategory(
    ctx: RequestContext,
    event: SyncPushEvent,
    command: CatalogCategoryCommand
  ): Promise<Record<string, unknown>> {
    requirePermission(ctx, 'catalog.write');
    const categoryId =
      command.kind === 'catalog.category.delete'
        ? text(command.payload, 'categoryId') ?? event.aggregateId
        : text(command.payload, 'id') ?? event.aggregateId;
    if (categoryId !== event.aggregateId) {
      throw new ValidationFailedError('Desktop category identity does not match sync aggregate');
    }
    if (command.kind === 'catalog.category.delete') {
      const used = await this.client.query(
        `SELECT 1 FROM products
         WHERE organization_id = $1 AND primary_category_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [ctx.organizationId, categoryId]
      );
      if (used.rowCount) {
        throw new ValidationFailedError('Category cannot be deleted while products still use it');
      }
      const deleted = await this.client.query(
        `UPDATE categories
         SET deleted_at = now(), active = false, version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [ctx.organizationId, categoryId]
      );
      if (deleted.rowCount !== 1) {
        throw new ValidationFailedError('Desktop category does not exist on Platform');
      }
      return { kind: 'catalog.category', id: categoryId, deleted: true };
    }
    const name = text(command.payload, 'name');
    const requestedDepartmentId = text(command.payload, 'departmentId');
    const brandId = text(command.payload, 'brandId');
    if (!name || name.length > 240 || !uuid(requestedDepartmentId) || !uuid(brandId)) {
      throw new ValidationFailedError('Desktop category command is incomplete');
    }
    const departmentId = await this.resolveDepartmentId(ctx.organizationId, command.payload);
    if (!departmentId) {
      throw new ValidationFailedError('Selected category department is not active');
    }
    const brand = await this.client.query(
      `SELECT 1 FROM brands
       WHERE organization_id = $1 AND id = $2 AND department_id = $3
         AND active AND deleted_at IS NULL`,
      [ctx.organizationId, brandId, departmentId]
    );
    if (!brand.rowCount) {
      throw new ValidationFailedError('Selected category brand is not active in this department');
    }
    if (command.kind === 'catalog.category.update') {
      const updated = await this.client.query<{
        id: string;
        name: string;
        departmentId: string;
        brandId: string;
      }>(
        `UPDATE categories
         SET name = $3, slug = $4, department_id = $5, brand_id = $6, active = true,
             deleted_at = NULL, version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
         RETURNING id, name, department_id AS "departmentId", brand_id AS "brandId"`,
        [ctx.organizationId, categoryId, name, catalogSlug(name, categoryId), departmentId, brandId]
      );
      if (!updated.rows[0]) {
        throw new ValidationFailedError('Desktop category does not exist on Platform');
      }
      return { kind: 'catalog.category', category: updated.rows[0] };
    }
    const created = await this.client.query<{
      id: string;
      name: string;
      departmentId: string;
      brandId: string;
    }>(
      `INSERT INTO categories (id, organization_id, parent_id, department_id, brand_id, name, slug, sort_order, active)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, 0, true)
       ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name, slug = EXCLUDED.slug, department_id = EXCLUDED.department_id,
           brand_id = EXCLUDED.brand_id, active = true, deleted_at = NULL,
           version = categories.version + 1, updated_at = now()
       RETURNING id, name, department_id AS "departmentId", brand_id AS "brandId"`,
      [categoryId, ctx.organizationId, departmentId, brandId, name, catalogSlug(name, categoryId)]
    );
    if (!created.rows[0]) throw new ValidationFailedError('Desktop category could not be saved');
    return { kind: 'catalog.category', category: created.rows[0] };
  }

  private async catalogSpecification(
    ctx: RequestContext,
    event: SyncPushEvent,
    command: CatalogSpecificationCommand
  ): Promise<Record<string, unknown>> {
    requirePermission(ctx, 'catalog.write');
    const specificationId =
      command.kind === 'catalog.specification.delete'
        ? text(command.payload, 'specificationId') ?? event.aggregateId
        : text(command.payload, 'id') ?? event.aggregateId;
    if (specificationId !== event.aggregateId) {
      throw new ValidationFailedError('Desktop specification identity does not match sync aggregate');
    }
    if (command.kind === 'catalog.specification.delete') {
      const deleted = await this.client.query(
        `UPDATE spec_keys
         SET deleted_at = now(), active = false, version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [ctx.organizationId, specificationId]
      );
      if (deleted.rowCount !== 1) {
        throw new ValidationFailedError('Desktop specification does not exist on Platform');
      }
      return { kind: 'catalog.specification', id: specificationId, deleted: true };
    }
    const name = text(command.payload, 'name');
    const requestedDepartmentId = text(command.payload, 'departmentId');
    const rawUnit = command.payload.unit;
    const unit = typeof rawUnit === 'string' ? rawUnit.trim() : undefined;
    if (
      !name ||
      name.length > 240 ||
      !uuid(requestedDepartmentId) ||
      (rawUnit !== undefined && typeof rawUnit !== 'string') ||
      (unit !== undefined && unit.length > 80)
    ) {
      throw new ValidationFailedError('Desktop specification command is incomplete');
    }
    const departmentId = await this.resolveDepartmentId(ctx.organizationId, command.payload);
    if (!departmentId) {
      throw new ValidationFailedError('Selected specification department is not active');
    }
    if (command.kind === 'catalog.specification.update') {
      const updated = await this.client.query<{
        id: string;
        key: string;
        name: string;
        departmentId: string;
        unit: string | null;
      }>(
        `UPDATE spec_keys
         SET name = $3, slug = $4, department_id = $5, unit = $6, data_type = 'text', active = true,
             deleted_at = NULL, version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
         RETURNING id, slug AS key, name, department_id AS "departmentId", unit`,
        [ctx.organizationId, specificationId, name, catalogSlug(name, specificationId), departmentId, unit || null]
      );
      if (!updated.rows[0]) {
        throw new ValidationFailedError('Desktop specification does not exist on Platform');
      }
      return { kind: 'catalog.specification', specification: updated.rows[0] };
    }
    const specificationSlug = catalogSlug(name, specificationId);
    const existing = await this.client.query<{
      id: string;
      key: string;
      name: string;
      departmentId: string;
      unit: string | null;
    }>(
      `SELECT id, slug AS key, name, department_id AS "departmentId", unit
       FROM spec_keys
       WHERE organization_id = $1 AND deleted_at IS NULL
         AND (id = $2 OR slug = $3)
       ORDER BY CASE WHEN id = $2 THEN 0 ELSE 1 END
       LIMIT 1`,
      [ctx.organizationId, specificationId, specificationSlug]
    );
    if (existing.rows[0]) {
      const specification = existing.rows[0];
      // The website and a temporarily-offline desktop can create the same
      // logical specification independently. The active slug is unique per
      // organization, so acknowledge the desktop command with the canonical
      // server item instead of leaking a PostgreSQL unique-index error as 500.
      return {
        kind: 'catalog.specification',
        specification,
        ...(specification.id !== specificationId
          ? { replaceSpecificationId: specificationId }
          : {})
      };
    }
    const result = await this.client.query<{
      id: string;
      key: string;
      name: string;
      departmentId: string;
      unit: string | null;
    }>(
      `INSERT INTO spec_keys (id, organization_id, name, slug, department_id, unit, data_type, active)
       VALUES ($1, $2, $3, $4, $5, $6, 'text', true)
       ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name, slug = EXCLUDED.slug, department_id = EXCLUDED.department_id,
           unit = EXCLUDED.unit, data_type = 'text', active = true, deleted_at = NULL,
           version = spec_keys.version + 1, updated_at = now()
       RETURNING id, slug AS key, name, department_id AS "departmentId", unit`,
      [
        specificationId,
        ctx.organizationId,
        name,
        specificationSlug,
        departmentId,
        unit || null
      ]
    );
    if (!result.rows[0])
      throw new ValidationFailedError('Desktop specification could not be saved');
    return { kind: 'catalog.specification', specification: result.rows[0] };
  }

  /** Persist supplier master data as a canonical cloud record. Unlike the
   * older generic event, this snapshot can be applied by every desktop. */
  private async supplier(
    ctx: RequestContext,
    event: SyncPushEvent,
    command: SupplierCommand
  ): Promise<Record<string, unknown>> {
    const supplierId =
      command.kind === 'supplier.delete'
        ? text(command.payload, 'supplierId') ?? event.aggregateId
        : text(command.payload, 'id') ?? event.aggregateId;
    if (!uuid(supplierId) || supplierId !== event.aggregateId) {
      throw new ValidationFailedError('Desktop supplier identity does not match sync aggregate');
    }
    if (command.kind === 'supplier.delete') {
      const deleted = await this.client.query(
        `UPDATE suppliers
         SET active = false, deleted_at = COALESCE(deleted_at, now()),
             version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [ctx.organizationId, supplierId]
      );
      if (deleted.rowCount !== 1) {
        throw new ValidationFailedError('Desktop supplier does not exist on Platform');
      }
      return { kind: 'supplier', id: supplierId, deleted: true };
    }

    const code = text(command.payload, 'code')?.toUpperCase();
    const name = text(command.payload, 'name');
    const taxId = nullableText(command.payload, 'taxNumber');
    const contactEmail = nullableText(command.payload, 'contactEmail');
    if (
      !code ||
      code.length > 100 ||
      !name ||
      name.length > 200 ||
      (typeof taxId === 'string' && taxId.length > 100) ||
      (typeof contactEmail === 'string' &&
        (contactEmail.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)))
    ) {
      throw new ValidationFailedError('Desktop supplier command is incomplete');
    }
    const duplicate = await this.client.query<{ id: string }>(
      `SELECT id FROM suppliers
       WHERE organization_id = $1 AND code = $2 AND id <> $3 AND deleted_at IS NULL
       LIMIT 1`,
      [ctx.organizationId, code, supplierId]
    );
    if (duplicate.rows[0]) {
      throw new ValidationFailedError('Supplier code already exists in this organization');
    }
    const result = await this.client.query<{
      id: string;
      code: string;
      name: string;
      taxNumber: string | null;
      contactEmail: string | null;
      active: boolean;
      version: string;
    }>(
      `INSERT INTO suppliers (id, organization_id, code, name, tax_id, contact_email, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE
       SET code = EXCLUDED.code, name = EXCLUDED.name, tax_id = EXCLUDED.tax_id,
           contact_email = EXCLUDED.contact_email, active = EXCLUDED.active, deleted_at = NULL,
           version = suppliers.version + 1, updated_at = now()
       WHERE suppliers.organization_id = EXCLUDED.organization_id
       RETURNING id, code, name, tax_id AS "taxNumber", contact_email AS "contactEmail",
                 active, version::text AS version`,
      [
        supplierId,
        ctx.organizationId,
        code,
        name,
        taxId ?? null,
        contactEmail ?? null,
        boolean(command.payload, 'active', true)
      ]
    );
    if (!result.rows[0]) {
      throw new ValidationFailedError('Supplier belongs to another organization');
    }
    return { kind: 'supplier', supplier: result.rows[0] };
  }

  private async settings(
    ctx: RequestContext,
    command: SettingsCommand
  ): Promise<Record<string, unknown>> {
    const values = record(command.payload.values);
    if (!values || text(command.payload, 'scope') !== 'organization') {
      throw new ValidationFailedError('Desktop organization settings command is incomplete');
    }
    const result = await this.client.query<{
      id: string;
      name: string;
      legalName: string | null;
      taxNumber: string | null;
      version: string;
    }>(
      `UPDATE organizations
       SET name = COALESCE($2, name),
           legal_name = COALESCE($3, legal_name),
           tax_number = COALESCE($4, tax_number),
           version = version + 1,
           updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, name, legal_name AS "legalName", tax_number AS "taxNumber", version::text AS version`,
      [
        ctx.organizationId,
        text(values, 'company.name'),
        text(values, 'company.legalName'),
        text(values, 'company.taxNumber')
      ]
    );
    if (!result.rows[0])
      throw new ValidationFailedError('Desktop organization does not exist on Platform');
    return { kind: 'organization.settings', organization: result.rows[0] };
  }

  private async item(
    ctx: RequestContext,
    event: SyncPushEvent,
    command: ItemCommand,
    entityIds: Record<string, unknown> | undefined
  ): Promise<Record<string, unknown>> {
    const input = command.payload;
    const requestedSku = nullableText(input, 'sku');
    const name = text(input, 'name');
    const priceRsd = integer(input, 'salePriceMinor');
    const currency = text(input, 'currency') ?? 'RSD';
    const variantId =
      command.kind === 'item.create' ? event.aggregateId : (text(input, 'id') ?? event.aggregateId);
    if (command.kind === 'item.create') {
      if (!name || priceRsd === undefined || priceRsd < 0 || priceRsd > MAX_PRICE_RSD) {
        throw new ValidationFailedError('Desktop item create command is incomplete');
      }
      const sku = requestedSku ?? null;
      // Desktop has to create an ID while offline. It is only a correlation
      // key: Platform owns the canonical product and variant UUIDs, exactly
      // like it does for products created through the web admin.
      const sourceVariantId = event.aggregateId;
      const sourceProductId =
        text(input, 'productId') ??
        (entityIds === undefined ? undefined : text(entityIds, 'productId'));
      const categoryId = text(input, 'categoryId');
      const existing = await this.client.query<{ id: string; product_id: string }>(
        `SELECT v.id, v.product_id
         FROM products p
         JOIN product_variants v ON v.organization_id = p.organization_id AND v.product_id = p.id
         WHERE p.organization_id = $1 AND p.external_id = $2 AND p.deleted_at IS NULL
           AND v.deleted_at IS NULL
         LIMIT 1`,
        [ctx.organizationId, `rfiddaja:${sourceVariantId}`]
      );
      if (existing.rowCount === 1)
        return {
          ...(await this.catalogSnapshot(ctx.organizationId, existing.rows[0]!.product_id, existing.rows[0]!.id)),
          sourceProductId,
          sourceVariantId
        };

      const category = categoryId
        ? await this.client.query<{ id: string }>(
            `SELECT id FROM categories WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
            [ctx.organizationId, categoryId]
          )
        : undefined;
      const departmentId = await this.resolveDepartmentId(
        ctx.organizationId,
        entityIds,
        text(input, 'department')
      );
      // RFID stores a storefront category as a child of its local brand.
      // Sync sends that parent name explicitly; older clients fall back to
      // categoryName so their existing events remain compatible.
      const localBrandName =
        entityIds === undefined
          ? undefined
          : (text(entityIds, 'brandName') ?? text(entityIds, 'categoryName'));
      const brand = localBrandName
        ? await this.client.query<{ id: string }>(
            `SELECT id FROM brands
             WHERE organization_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL AND active
             LIMIT 1`,
            [ctx.organizationId, localBrandName]
          )
        : undefined;
      const resolvedProductId = randomUUID();
      const resolvedVariantId = randomUUID();
      await this.client.query(
        `INSERT INTO products (id, organization_id, name, slug, description, brand_id, primary_category_id, seo, features, model_3d_url, active, published, external_id, department_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug,
           description = EXCLUDED.description, seo = EXCLUDED.seo, features = EXCLUDED.features,
           model_3d_url = EXCLUDED.model_3d_url, department_id = EXCLUDED.department_id,
           active = EXCLUDED.active, published = EXCLUDED.published,
           updated_at = now(), version = products.version + 1`,
        [
          resolvedProductId,
          ctx.organizationId,
          name,
          text(input, 'slug') ?? slug(name, variantId),
          text(input, 'description') ?? null,
          brand?.rows[0]?.id ?? null,
          category?.rows[0]?.id ?? null,
          JSON.stringify(record(input.seo) ?? {}),
          JSON.stringify(Array.isArray(input.features) ? input.features : []),
          text(input, 'model3dUrl') ?? null,
          boolean(input, 'active', true),
          boolean(input, 'published', true),
          `rfiddaja:${sourceVariantId}`,
          departmentId
        ]
      );
      await this.client.query(
        `INSERT INTO product_variants (id, organization_id, product_id, sku, barcode, name, gender, current_price_amount, currency, attributes, active, published)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)`,
        [
          resolvedVariantId,
          ctx.organizationId,
          resolvedProductId,
          sku,
          text(input, 'barcode') ?? null,
          name,
          catalogGender(input) ?? null,
          priceRsd * 100,
          currency,
          JSON.stringify(record(input.attributes) ?? {}),
          boolean(input, 'active', true),
          boolean(input, 'published', true)
        ]
      );
      await this.client.query(
        `INSERT INTO variant_prices (organization_id, variant_id, amount_minor, currency, price_type, created_by)
         VALUES ($1, $2, $3, $4, 'sell', $5)`,
        [ctx.organizationId, resolvedVariantId, priceRsd * 100, currency, ctx.userId]
      );
      await this.addCatalogPrices(ctx, resolvedVariantId, input, currency);
      await this.setImages(ctx.organizationId, resolvedProductId, input);
      return {
        ...(await this.catalogSnapshot(ctx.organizationId, resolvedProductId, resolvedVariantId)),
        sourceProductId,
        sourceVariantId
      };
    }

    const current = await this.client.query<{
      product_id: string;
      version: string;
      product_slug: string;
      product_name: string;
      variant_sku: string | null;
    }>(
      `SELECT variant.product_id, variant.version::text, product.slug AS product_slug, product.name AS product_name,
              variant.sku AS variant_sku
       FROM product_variants variant
       JOIN products product
         ON product.organization_id = variant.organization_id AND product.id = variant.product_id
       WHERE variant.organization_id = $1 AND variant.id = $2 AND variant.deleted_at IS NULL
       FOR UPDATE`,
      [ctx.organizationId, variantId]
    );
    const row = current.rows[0];
    if (!row) throw new ValidationFailedError('Desktop item does not exist on Platform');
    if (command.kind === 'item.delete') {
      await this.removeProductMedia(ctx.organizationId, row.product_id);
      await this.client.query(
        `UPDATE product_variants SET deleted_at = now(), active = false, published = false,
         version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND product_id = $2 AND deleted_at IS NULL`,
        [ctx.organizationId, row.product_id]
      );
      // The admin product modal deliberately has one internal sellable row,
      // not user-managed variants. Deleting the RFID article must therefore
      // remove the complete product, including any stale internal rows.
      await this.client.query(
        `UPDATE products p
         SET deleted_at = now(), active = false, published = false,
             version = version + 1, updated_at = now()
         WHERE p.organization_id = $1 AND p.id = $2 AND p.deleted_at IS NULL`,
        [ctx.organizationId, row.product_id]
      );
      return { kind: 'catalog.item', deleted: true, productId: row.product_id, variantId };
    }
    if (command.kind === 'item.archive') {
      await this.client.query(
        `UPDATE product_variants SET active = false, published = false, version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2`,
        [ctx.organizationId, variantId]
      );
      return this.catalogSnapshot(ctx.organizationId, row.product_id, variantId);
    }
    const sku = requestedSku === undefined ? row.variant_sku : requestedSku;
    if (!name || priceRsd === undefined || priceRsd < 0 || priceRsd > MAX_PRICE_RSD) {
      throw new ValidationFailedError('Desktop item update command is incomplete');
    }
    const nextSlug =
      text(input, 'slug') ?? (row.product_name !== name ? slug(name, variantId) : row.product_slug);
    const categoryId = text(input, 'categoryId');
    const validCategory = categoryId
      ? await this.client.query<{ id: string }>(
          `SELECT id FROM categories WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
          [ctx.organizationId, categoryId]
        )
      : undefined;
    // An RFID local category is not an ecommerce department.  Only the
    // department identifier/name received in the canonical catalog snapshot
    // may change an existing Platform department.  This prevents a local
    // category such as "Satovi" from replacing "Daljinski" on save.
    const departmentId = await this.resolveDepartmentId(ctx.organizationId, entityIds);
    const localBrandName =
      entityIds === undefined
        ? undefined
        : (text(entityIds, 'brandName') ?? text(entityIds, 'categoryName'));
    const brand = localBrandName
      ? await this.client.query<{ id: string }>(
          `SELECT id FROM brands
           WHERE organization_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL AND active
           LIMIT 1`,
          [ctx.organizationId, localBrandName]
        )
      : undefined;
    await this.client.query(
      `UPDATE products SET name = $3, slug = COALESCE(NULLIF($4, ''), slug), description = COALESCE($5, description),
       brand_id = COALESCE($6, brand_id), primary_category_id = COALESCE($7, primary_category_id),
       seo = COALESCE($8::jsonb, seo), features = COALESCE($9::jsonb, features), model_3d_url = COALESCE($10, model_3d_url),
       active = $11, published = $12, department_id = COALESCE($13, department_id),
       version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2`,
      [
        ctx.organizationId,
        row.product_id,
        name,
        nextSlug,
        text(input, 'description') ?? null,
        brand?.rows[0]?.id ?? null,
        validCategory?.rows[0]?.id ?? null,
        input.seo === undefined ? null : JSON.stringify(record(input.seo) ?? {}),
        input.features === undefined
          ? null
          : JSON.stringify(Array.isArray(input.features) ? input.features : []),
        text(input, 'model3dUrl') ?? null,
        boolean(input, 'active', true),
        boolean(input, 'published', true),
        departmentId
      ]
    );
    await this.client.query(
      `UPDATE product_variants SET sku = $3, barcode = COALESCE(NULLIF($4, ''), barcode), name = $5, gender = COALESCE($6, gender), current_price_amount = $7, currency = $8,
       attributes = COALESCE($9::jsonb, attributes), active = $10, published = $11, version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2`,
      [
        ctx.organizationId,
        variantId,
        sku,
        text(input, 'barcode') ?? null,
        name,
        catalogGender(input) ?? null,
        priceRsd * 100,
        currency,
        input.attributes === undefined ? null : JSON.stringify(record(input.attributes) ?? {}),
        boolean(input, 'active', true),
        boolean(input, 'published', true)
      ]
    );
    await this.client.query(
      `UPDATE variant_prices SET valid_until = now() WHERE organization_id = $1 AND variant_id = $2 AND price_type = 'sell' AND valid_until IS NULL`,
      [ctx.organizationId, variantId]
    );
    await this.client.query(
      `INSERT INTO variant_prices (organization_id, variant_id, amount_minor, currency, price_type, created_by)
       VALUES ($1, $2, $3, $4, 'sell', $5)`,
      [ctx.organizationId, variantId, priceRsd * 100, currency, ctx.userId]
    );
    await this.addCatalogPrices(ctx, variantId, input, currency);
    await this.setImages(ctx.organizationId, row.product_id, input);
    if (row.product_slug !== nextSlug && this.mediaStorage) {
      const relocated = await new MediaRepository(this.client).relocateProductMedia(
        ctx,
        { productId: row.product_id, previousSlug: row.product_slug, nextSlug },
        () => this.mediaStorage!
      );
      relocated.sourceKeys.forEach((key) => this.staleMediaKeys.add(key));
    }
    return this.catalogSnapshot(ctx.organizationId, row.product_id, variantId);
  }

  private async tag(
    ctx: RequestContext,
    event: SyncPushEvent,
    command: TagCommand
  ): Promise<Record<string, unknown>> {
    const rawEpc = text(command.payload, 'epc');
    const variantId = text(command.payload, 'productVariantId');
    if (!rawEpc || !variantId)
      throw new ValidationFailedError('Desktop RFID command is incomplete');
    const epc = normalizeEpc(rawEpc);
    const locationId = text(command.payload, 'locationId');
    const binId = text(command.payload, 'binId');
    await this.client.query(
      `INSERT INTO rfid_tags (id, organization_id, epc, tid, variant_id, status)
       VALUES ($1, $2, upper($3), $4, $5, 'assigned')
       ON CONFLICT (id) DO UPDATE SET epc = EXCLUDED.epc, tid = EXCLUDED.tid, variant_id = EXCLUDED.variant_id,
         status = 'assigned', version = rfid_tags.version + 1, updated_at = now()
       RETURNING id, epc, tid, variant_id AS "variantId", status, version`,
      [event.aggregateId, ctx.organizationId, epc, text(command.payload, 'tid') ?? null, variantId]
    );
    // The desktop records a tag assignment separately from the inventory
    // quantity.  Preserve the selected shelf even when the initial quantity
    // is exactly one (there is then no follow-up inventory adjustment).
    if (locationId && binId) {
      const placement = await this.client.query<{ zoneId: string }>(
        `SELECT zone.id AS "zoneId"
         FROM warehouse_bins bin
         JOIN warehouse_zones zone
           ON zone.organization_id = bin.organization_id AND zone.id = bin.zone_id
         JOIN warehouses warehouse
           ON warehouse.organization_id = zone.organization_id AND warehouse.id = zone.warehouse_id
         WHERE bin.organization_id = $1 AND bin.id = $2 AND warehouse.location_id = $3
           AND bin.deleted_at IS NULL AND bin.active
           AND zone.deleted_at IS NULL AND zone.active
           AND warehouse.deleted_at IS NULL AND warehouse.active`,
        [ctx.organizationId, binId, locationId]
      );
      const zoneId = placement.rows[0]?.zoneId;
      if (!zoneId) {
        throw new ValidationFailedError('Desktop RFID shelf does not belong to location');
      }
      await new InventoryRepository(this.client).adjust(ctx, {
        variantId,
        locationId,
        zoneId,
        binId,
        quantityDelta: 0,
        sourceType: 'rfiddaja_tag_placement',
        sourceId: event.aggregateId,
        metadata: { command: command.kind }
      });
    }
    const variant = await this.client.query<{ productId: string }>(
      `SELECT product_id AS "productId"
       FROM product_variants
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [ctx.organizationId, variantId]
    );
    const productId = variant.rows[0]?.productId;
    if (!productId)
      throw new ValidationFailedError('Desktop RFID variant does not exist on Platform');
    return this.catalogSnapshot(ctx.organizationId, productId, variantId);
  }

  private async resolveDepartmentId(
    organizationId: string,
    entityIds: Record<string, unknown> | undefined,
    fallbackName?: string
  ): Promise<string | null> {
    const requestedId = entityIds === undefined ? undefined : text(entityIds, 'departmentId');
    if (requestedId) {
      const byId = await this.client.query<{ id: string }>(
        `SELECT id FROM departments
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL AND active`,
        [organizationId, requestedId]
      );
      if (byId.rows[0]) return byId.rows[0].id;
    }
    const requestedName =
      (entityIds === undefined ? undefined : text(entityIds, 'departmentName')) ?? fallbackName;
    if (!requestedName) return null;
    const byName = await this.client.query<{ id: string }>(
      `SELECT id FROM departments
       WHERE organization_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL AND active
       LIMIT 1`,
      [organizationId, requestedName]
    );
    return byName.rows[0]?.id ?? null;
  }

  private async addCatalogPrices(
    ctx: RequestContext,
    variantId: string,
    input: Record<string, unknown>,
    currency: string
  ): Promise<void> {
    const saleAmount = integer(input, 'promotionalPriceMinor');
    const costAmount = integer(input, 'costPriceMinor');
    if (saleAmount !== undefined && saleAmount >= 0) {
      await this.client.query(
        `INSERT INTO variant_prices (organization_id, variant_id, amount_minor, currency, price_type, valid_from, valid_until, created_by)
         VALUES ($1, $2, $3, $4, 'sale', COALESCE($5::timestamptz, now()), $6::timestamptz, $7)`,
        [
          ctx.organizationId,
          variantId,
          saleAmount * 100,
          currency,
          text(input, 'promotionalValidFrom') ?? null,
          text(input, 'promotionalValidUntil') ?? null,
          ctx.userId
        ]
      );
    }
    if (costAmount !== undefined && costAmount >= 0) {
      await this.client.query(
        `INSERT INTO variant_prices (organization_id, variant_id, amount_minor, currency, price_type, created_by)
         VALUES ($1, $2, $3, $4, 'cost', $5)`,
        [ctx.organizationId, variantId, costAmount * 100, currency, ctx.userId]
      );
    }
  }

  private async setImages(
    organizationId: string,
    productId: string,
    input: Record<string, unknown>
  ): Promise<void> {
    const hasImageInput = Array.isArray(input.imageUris) || Object.hasOwn(input, 'imageUri');
    if (!hasImageInput) return;
    const fromPayload = Array.isArray(input.imageUris)
      ? input.imageUris.filter((value): value is string => typeof value === 'string')
      : [];
    const imageUris = fromPayload.length
      ? fromPayload
      : [text(input, 'imageUri')].filter((value): value is string => value !== undefined);
    const mediaIds: string[] = [];
    let position = 0;
    for (const imageUri of imageUris) {
      if (!/^https?:\/\//i.test(imageUri)) continue;
      const mediaId = await this.setImage(organizationId, productId, imageUri, position++);
      if (mediaId && !mediaIds.includes(mediaId)) mediaIds.push(mediaId);
    }
    const existing = await this.client.query<{ id: string; media_asset_id: string }>(
      `SELECT id, media_asset_id FROM product_media
       WHERE organization_id = $1 AND product_id = $2`,
      [organizationId, productId]
    );
    const stale = existing.rows.filter((row) => !mediaIds.includes(row.media_asset_id));
    if (stale.length) {
      await this.client.query(
        `DELETE FROM product_media
         WHERE organization_id = $1 AND product_id = $2 AND id = ANY($3::uuid[])`,
        [organizationId, productId, stale.map((row) => row.id)]
      );
      for (const mediaId of new Set(stale.map((row) => row.media_asset_id))) {
        await this.discardMedia(organizationId, mediaId);
      }
    }
    await this.client.query(
      `UPDATE product_media SET is_primary = false
       WHERE organization_id = $1 AND product_id = $2`,
      [organizationId, productId]
    );
    for (const [index, mediaId] of mediaIds.entries()) {
      await this.client.query(
        `UPDATE product_media SET position = $4, is_primary = $5
         WHERE organization_id = $1 AND product_id = $2 AND media_asset_id = $3`,
        [organizationId, productId, mediaId, index, index === 0]
      );
    }
  }

  private async setImage(
    organizationId: string,
    productId: string,
    imageUri: string,
    position: number
  ): Promise<string | undefined> {
    // The RFID desktop app first imports a linked image through /media/external.
    // Reuse that R2 asset (and its 512px derivative) when the later catalog
    // sync event arrives. Older clients may still send arbitrary external URLs,
    // which retain the previous external-url fallback.
    const imported = await this.client.query<{ id: string }>(
      `SELECT id FROM media_assets
       WHERE organization_id = $1 AND public_url = $2
         AND storage_provider = 'r2' AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [organizationId, imageUri]
    );
    let mediaId = imported.rows[0]?.id;
    if (!mediaId) {
      const storageKey = createHash('sha256').update(imageUri).digest('hex');
      const media = await this.client.query<{ id: string }>(
        `INSERT INTO media_assets (organization_id, storage_provider, storage_bucket, storage_key, public_url, mime_type, status)
         VALUES ($1, 'external-url', 'external', $2, $3, 'image/*', 'ready')
         ON CONFLICT (organization_id, storage_bucket, storage_key) WHERE deleted_at IS NULL
         DO UPDATE SET public_url = EXCLUDED.public_url, status = 'ready', updated_at = now()
         RETURNING id`,
        [organizationId, storageKey, imageUri]
      );
      mediaId = media.rows[0]?.id;
    }
    if (!mediaId) return undefined;
    await this.client.query(
      `UPDATE product_media SET is_primary = false WHERE organization_id = $1 AND product_id = $2 AND $3 = 0`,
      [organizationId, productId, position]
    );
    await this.client.query(
      `INSERT INTO product_media (organization_id, product_id, media_asset_id, role, position, is_primary)
       SELECT $1, $2, $3, 'gallery', $4, $5
       WHERE NOT EXISTS (SELECT 1 FROM product_media WHERE organization_id = $1 AND product_id = $2 AND media_asset_id = $3)`,
      [organizationId, productId, mediaId, position, position === 0]
    );
    return mediaId;
  }

  private async removeProductMedia(organizationId: string, productId: string): Promise<void> {
    const removed = await this.client.query<{ media_asset_id: string }>(
      `DELETE FROM product_media
       WHERE organization_id = $1 AND product_id = $2
       RETURNING media_asset_id`,
      [organizationId, productId]
    );
    for (const mediaId of new Set(removed.rows.map((row) => row.media_asset_id))) {
      await this.discardMedia(organizationId, mediaId);
    }
  }

  private async discardMedia(organizationId: string, mediaId: string): Promise<void> {
    if (!this.mediaStorage) return;
    await new MediaRepository(this.client).discardUnreferenced(
      { organizationId },
      mediaId,
      this.mediaStorage
    );
  }

  async catalogSnapshot(
    organizationId: string,
    productId: string,
    variantId: string
  ): Promise<Record<string, unknown>> {
    const result = await this.client.query(
      `SELECT p.id AS "productId", p.external_id AS "externalId", p.name AS "productName", p.slug, p.description, p.seo, p.features, p.model_3d_url AS "model3dUrl", p.active AS "productActive", p.published AS "productPublished",
              p.department_id AS "departmentId", d.name AS "departmentName",
              p.brand_id AS "brandId", b.name AS "brandName",
              p.primary_category_id AS "categoryId", c.name AS "categoryName", p.version AS "productVersion",
              v.id AS "variantId", v.sku, v.barcode, v.name AS "variantName", v.gender,
              v.current_price_amount AS "priceAmount",
              v.currency, v.attributes, v.active, v.published, v.version AS "variantVersion", media.public_url AS "imageUri",
              sale.amount_minor AS "salePriceAmount", sale.valid_from AS "saleValidFrom", sale.valid_until AS "saleValidUntil",
              cost.amount_minor AS "costAmount",
              COALESCE(inventory.quantity, 0) AS quantity, inventory.location_id AS "locationId",
              inventory.zone_id AS "zoneId", inventory.bin_id AS "binId",
              tag.id AS "tagId", tag.epc, tag.status AS "tagStatus"
       FROM products p JOIN product_variants v ON v.organization_id = p.organization_id AND v.product_id = p.id
       LEFT JOIN departments d ON d.id = p.department_id AND d.organization_id = p.organization_id AND d.deleted_at IS NULL
       LEFT JOIN brands b ON b.id = p.brand_id AND b.organization_id = p.organization_id AND b.deleted_at IS NULL
       LEFT JOIN categories c ON c.id = p.primary_category_id AND c.organization_id = p.organization_id AND c.deleted_at IS NULL
       LEFT JOIN LATERAL (SELECT ma.public_url FROM product_media pm JOIN media_assets ma ON ma.id = pm.media_asset_id
                          WHERE pm.organization_id = p.organization_id AND pm.product_id = p.id AND ma.status = 'ready'
                          ORDER BY pm.is_primary DESC, pm.position LIMIT 1) media ON true
       LEFT JOIN LATERAL (
         SELECT SUM(ib.quantity)::integer AS quantity,
                (array_agg(ib.location_id ORDER BY ib.updated_at DESC))[1] AS location_id,
                (array_agg(ib.zone_id ORDER BY ib.updated_at DESC))[1] AS zone_id,
                (array_agg(ib.bin_id ORDER BY ib.updated_at DESC))[1] AS bin_id
         FROM inventory_balances ib
         WHERE ib.organization_id = p.organization_id AND ib.variant_id = v.id
       ) inventory ON true
       LEFT JOIN LATERAL (
         SELECT amount_minor, valid_from, valid_until FROM variant_prices
         WHERE organization_id = p.organization_id AND variant_id = v.id AND price_type = 'sale'
         ORDER BY created_at DESC LIMIT 1
       ) sale ON true
       LEFT JOIN LATERAL (
         SELECT amount_minor FROM variant_prices
         WHERE organization_id = p.organization_id AND variant_id = v.id AND price_type = 'cost'
         ORDER BY created_at DESC LIMIT 1
       ) cost ON true
       LEFT JOIN LATERAL (
         SELECT t.id, t.epc, t.status
         FROM rfid_tags t
         LEFT JOIN inventory_items ii ON ii.id = t.inventory_item_id AND ii.deleted_at IS NULL
         WHERE t.organization_id = p.organization_id AND t.deleted_at IS NULL
           AND (t.variant_id = v.id OR ii.variant_id = v.id)
         ORDER BY t.updated_at DESC
         LIMIT 1
       ) tag ON true
       WHERE p.organization_id = $1 AND p.id = $2 AND v.id = $3`,
      [organizationId, productId, variantId]
    );
    return { kind: 'catalog.item', record: result.rows[0] ?? { productId, variantId } };
  }

  async publishProductChange(
    ctx: RequestContext,
    productId: string,
    variantId: string,
    operation: 'create' | 'update' | 'delete' = 'update'
  ): Promise<void> {
    const snapshot =
      operation === 'delete'
        ? { kind: 'catalog.item', deleted: true, productId, variantId }
        : await this.catalogSnapshot(ctx.organizationId, productId, variantId);
    const record = (snapshot.record ?? {}) as Record<string, unknown>;
    // PostgreSQL bigint values are returned as strings by node-postgres by
    // default. Treating them as non-numeric made every update use version 1
    // and collide with the unique sync idempotency key after the first save.
    const version = Number(record.variantVersion) || 1;
    // Prices, inventory, media and RFID tags can change without incrementing
    // the variant row version. Include the canonical snapshot fingerprint so
    // those updates produce a new pull event instead of colliding with an
    // older `catalog:...:version` idempotency key.
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(snapshot))
      .digest('hex')
      .slice(0, 16);
    await new SyncRepository(this.client).appendServerEvent(ctx, {
      aggregateType: 'product_variant',
      aggregateId: variantId,
      operation,
      payload: { operationalSnapshot: snapshot },
      payloadVersion: 2,
      idempotencyKey: `catalog:${productId}:${variantId}:${operation}:${version}:${fingerprint}`
    });
  }

  /** Publish a canonical inventory/placement snapshot after a website change.
   * Website inventory writes do not pass through /sync/push, so without this
   * bridge a running RFID desktop never receives the selected zone or shelf. */
  async publishVariantChange(ctx: RequestContext, variantId: string): Promise<void> {
    const variant = await this.client.query<{ productId: string }>(
      `SELECT product_id AS "productId"
       FROM product_variants
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [ctx.organizationId, variantId]
    );
    const productId = variant.rows[0]?.productId;
    if (!productId) throw new ValidationFailedError('Variant does not belong to organization');
    await this.publishProductChange(ctx, productId, variantId);
  }
}
