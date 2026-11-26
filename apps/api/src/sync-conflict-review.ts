import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { RequestContext } from '@daja/shared';
import { PermissionDeniedError, ResourceNotFoundError, ValidationFailedError } from '@daja/security';
import { object, priceFields, readPriceState, type PriceChoices, type PriceComparison, type PriceState } from './sync-price-conflicts.js';

type Query = Pick<pg.PoolClient, 'query'>;
export type ConflictScope = 'own' | 'organization';

export interface ConflictRow extends pg.QueryResultRow {
  id: string;
  eventId: string | null;
  aggregateType: string;
  aggregateId: string;
  operation: string;
  userId: string | null;
  deviceId: string | null;
  locationId: string | null;
  actorName: string | null;
  deviceName: string | null;
  resolvedByName: string | null;
  baseVersion: string | null;
  serverVersion: string | null;
  clientPayload: Record<string, unknown>;
  serverPayload: Record<string, unknown>;
  status: 'unresolved' | 'resolved' | 'rejected';
  reason: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  details: Record<string, unknown>;
  resolution: Record<string, unknown>;
}

const columns = `c.id, c.event_id AS "eventId", c.aggregate_type AS "aggregateType", c.aggregate_id AS "aggregateId",
  c.operation, c.user_id AS "userId", c.device_id AS "deviceId", c.location_id AS "locationId",
  actor.display_name AS "actorName", device.display_name AS "deviceName",
  resolver.display_name AS "resolvedByName", c.base_version::text AS "baseVersion",
  c.server_version::text AS "serverVersion", c.client_payload AS "clientPayload",
  c.server_payload AS "serverPayload", c.status, c.reason, c.created_at AS "createdAt",
  c.resolved_at AS "resolvedAt", c.details, c.resolution`;
const source = `FROM sync_conflicts c
  LEFT JOIN users actor ON actor.id=c.user_id AND actor.organization_id=c.organization_id
  LEFT JOIN users resolver ON resolver.id=c.resolved_by AND resolver.organization_id=c.organization_id
  LEFT JOIN devices device ON device.id=c.device_id AND device.organization_id=c.organization_id`;
const resources = {
  product: 'products', product_variant: 'product_variants', variant: 'product_variants',
  rfid_tag: 'rfid_tags', inventory_item: 'inventory_items', transfer: 'stock_transfers'
} as const;

export function canSeeOrganizationConflicts(ctx: RequestContext): boolean {
  return !!ctx.isOwner || (ctx.permissions.includes('sync.conflicts') &&
    !!ctx.scopedGrants?.some(grant => grant.permission === 'sync.conflicts' && grant.scope === 'all_locations'));
}

export async function listConflictReviews(
  client: Query, ctx: RequestContext, scope: ConflictScope, status: string, limit: number, cursor?: string
) {
  if (scope === 'organization' && !canSeeOrganizationConflicts(ctx)) throw new PermissionDeniedError('sync.conflicts');
  const all = scope === 'organization';
  const rows = (await client.query<ConflictRow>(
    `SELECT ${columns} ${source}
     WHERE c.organization_id=$1 AND ($2 OR c.user_id=$3) AND c.status=$4
       AND ($5::uuid IS NULL OR (c.created_at,c.id) < (
         SELECT previous.created_at,previous.id FROM sync_conflicts previous
         WHERE previous.organization_id=$1 AND previous.id=$5 AND ($2 OR previous.user_id=$3)
       ))
     ORDER BY c.created_at DESC,c.id DESC LIMIT $6`,
    [ctx.organizationId, all, ctx.userId, status, cursor ?? null, limit + 1]
  )).rows;
  const page = rows.slice(0, limit);
  return {
    rows: page.map(row => summarize(row)),
    nextCursor: rows.length > limit ? page.at(-1)?.id ?? null : null,
    canSeeOrganization: canSeeOrganizationConflicts(ctx)
  };
}

export async function getConflictReview(client: Query, ctx: RequestContext, id: string, lock = false) {
  const result = await client.query<ConflictRow>(
    `SELECT ${columns} ${source}
     WHERE c.organization_id=$1 AND c.id=$2 AND (c.user_id=$3 OR $4)
     ${lock ? 'FOR UPDATE OF c' : ''}`,
    [ctx.organizationId, id, ctx.userId, canSeeOrganizationConflicts(ctx)]
  );
  const row = result.rows[0];
  if (!row) throw new ResourceNotFoundError('konflikt');
  return row;
}

export function summarize(row: ConflictRow) {
  const payload = object(object(row.clientPayload.command).payload);
  const remote = object(row.serverPayload.summary);
  const isPrice = row.details.kind === 'price';
  const reason = isPrice ? 'Cena je promenjena na obe strane u roku od jednog minuta.'
    : 'Na serveru postoji novija verzija ove stavke.';
  const document = object(row.serverPayload.summary);
  return {
    id: row.id, eventId: row.eventId, aggregateType: row.aggregateType, aggregateId: row.aggregateId,
    status: row.status, createdAt: row.createdAt, resolvedAt: row.resolvedAt,
    kind: isPrice ? 'price' : 'version',
    name: string(row.details.name) ?? string(payload.name) ?? string(document.number) ??
      string(remote.name) ?? string(remote.epc) ?? null,
    sku: string(row.details.sku) ?? string(payload.sku) ?? string(remote.sku) ?? null,
    actorName: row.actorName, deviceName: row.deviceName, resolvedByName: row.resolvedByName,
    localSavedAt: string(row.details.localSavedAt), reason
  };
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export async function compareConflict(client: Query, ctx: RequestContext, row: ConflictRow, lock = false) {
  if (row.status !== 'unresolved') {
    return { ...summarize(row), fields: Array.isArray(row.resolution.fields) ? row.resolution.fields : [],
      note: row.reason, strategy: string(row.resolution.strategy), token: null, canApplyLocal: false };
  }
  const current = row.details.kind === 'price'
    ? await readPriceState(client, ctx.organizationId, row.aggregateId, lock)
    : undefined;
  const live = row.details.kind === 'price' ? null : await readVersion(client, ctx.organizationId, row, lock);
  const shown = Array.isArray(row.details.fields) ? row.details.fields as PriceComparison[] : [];
  const fields = row.details.kind === 'price'
    ? shown.filter(entry => priceFields.includes(entry.field)).map(entry => ({
      ...entry,
      remote: current ? current[entry.field].value : entry.remote,
      remoteSavedAt: current ? current[entry.field].savedAt : entry.remoteSavedAt,
      remoteActorName: current ? current[entry.field].actorName : entry.remoteActorName,
      remoteDeviceName: current ? current[entry.field].deviceName : entry.remoteDeviceName
    }))
    : legacyFields(row, live?.summary);
  const token = createHash('sha256').update(JSON.stringify([row.id, live, current, fields])).digest('hex');
  return { ...summarize(row), fields, token, live, current,
    canApplyLocal: ctx.permissions.includes('sync.write') && !!(current ?? live) };
}

function legacyFields(row: ConflictRow, live?: Record<string, unknown>) {
  const local = object(object(row.clientPayload.command).payload);
  const remote = live ?? object(row.serverPayload.summary);
  const fields = ['name', 'sku', 'epc', 'status', 'quantity', 'number', 'active']
    .map(field => ({ field, before: null,
      local: local[field] ?? (field === 'status' ? local.toStatus : null) ?? null,
      remote: remote[field] ?? null }))
    .filter(entry => entry.local !== null || entry.remote !== null);
  return fields.length ? fields : [{ field: 'version', before: row.baseVersion,
    local: row.baseVersion, remote: row.serverVersion }];
}

async function readVersion(client: Query, organizationId: string, row: ConflictRow, lock: boolean) {
  if (!Object.hasOwn(resources, row.aggregateType)) return null;
  const table = resources[row.aggregateType as keyof typeof resources];
  const { rows: [data] } = await client.query<{ version: string; content: Record<string, unknown> }>(
    `SELECT version::text, ${table === 'stock_transfers' ? 'document' : 'to_jsonb(entry)'} AS content
     FROM ${table} entry WHERE organization_id=$1 AND id=$2 ${lock ? 'FOR UPDATE' : ''}`,
    [organizationId, row.aggregateId]
  );
  if (!data) return null;
  const summary = Object.fromEntries(['name', 'sku', 'epc', 'status', 'quantity', 'number', 'active']
    .filter(key => Object.hasOwn(data.content, key)).map(key => [key, data.content[key]]));
  return { version: Number(data.version), summary, transfer: table === 'stock_transfers' ? data.content : null,
    productId: string(data.content.product_id), variantId: string(data.content.variant_id) };
}

export function chosenPriceFields(
  comparisons: readonly PriceComparison[], strategy: 'local' | 'remote' | 'fields',
  choices: PriceChoices | undefined,
  newPeriod: { from: string; until: string } | undefined
) {
  return comparisons.map(entry => {
    const source = strategy === 'fields' ? choices?.[entry.field] : strategy;
    if (!source) throw new ValidationFailedError('Izaberi vrednost za svaku spornu cenu.');
    let value = source === 'local' ? entry.local : entry.remote;
    if (source === 'local' && entry.field === 'promotion' && value) {
      if (newPeriod) {
        if (Date.parse(newPeriod.until) <= Math.max(Date.now(), Date.parse(newPeriod.from)))
          throw new ValidationFailedError('Kraj akcije mora da bude posle početka i u budućnosti.');
        value = { ...value, ...newPeriod };
      }
      if (value.until && Date.parse(value.until) <= Date.now())
        throw new ValidationFailedError('Ova akcija je istekla. Unesi novi period ili zadrži stanje sa servera.');
    }
    return { ...entry, source, value };
  });
}

export function asPriceFields(review: Awaited<ReturnType<typeof compareConflict>>, state: PriceState): PriceComparison[] {
  return (review.fields as PriceComparison[]).filter(field =>
    priceFields.includes(field.field)
  ).map(field => ({ ...field, remote: state[field.field].value }));
}
