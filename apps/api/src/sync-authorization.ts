import type pg from 'pg';
import type { RequestContext } from '@daja/shared';
import type { SyncPushEvent } from '@daja/database';
import { PermissionDeniedError, ValidationFailedError } from '@daja/security';

const commandPermissions: Record<string, string[]> = {
  'item.create': ['items.create', 'catalog.write'],
  'item.update': ['items.update', 'catalog.write'],
  'item.archive': ['items.archive', 'catalog.write'],
  'item.delete': ['items.archive', 'catalog.write'],
  'item.promotion.clear': ['items.update', 'catalog.write'],
  'tag.assign': ['inventory.update', 'rfid.assign'],
  'inventory.event': ['inventory.adjust_inventory', 'inventory.adjust'],
  'inventory.relocate': ['inventory.adjust_inventory', 'inventory.adjust'],
  'count.create': ['rfid_counts.create'],
  'count.action': ['rfid_counts.update'],
  'sale.confirm': ['sales.confirm'],
  'return.confirm': ['returns.confirm'],
  'receipt.draft.create': ['receipts.create'],
  'receipt.draft.update': ['receipts.update'],
  'receipt.item.add': ['receipts.update'],
  'receipt.confirm': ['receipts.confirm'],
  'transfer.create': ['transfers.create'],
  'transfer.action': ['transfers.update'],
  'location.upsert': ['settings.configure'],
  'location.delete': ['settings.configure'],
  'location.layout.initialize': ['settings.configure'],
  'warehouse.zone.upsert': ['warehouse.update', 'warehouse.create'],
  'warehouse.zone.delete': ['warehouse.delete'],
  'warehouse.bin.upsert': ['warehouse.update', 'warehouse.create'],
  'warehouse.bin.delete': ['warehouse.delete'],
  'category.upsert': ['settings.configure'],
  'category.delete': ['settings.configure'],
  'supplier.upsert': ['settings.configure'],
  'supplier.delete': ['settings.configure'],
  'settings.update': ['settings.configure'],
  'user.invite': ['users.create', 'admin.users'],
  'user.action': ['users.update', 'admin.users'],
  'user.assignments.update': ['users.update', 'admin.users'],
  'role.create': ['roles.create', 'admin.users'],
  'role.update': ['roles.update', 'admin.users'],
  'role.delete': ['roles.delete', 'admin.users'],
  'role.permissions.update': ['roles.manage_permissions', 'admin.users']
};
for (const entity of ['brand', 'category', 'specification']) {
  for (const action of ['create', 'update', 'delete'])
    commandPermissions[`catalog.${entity}.${action}`] = ['catalog.write'];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function authorizeSyncEvent(
  client: Pick<pg.PoolClient, 'query'>,
  ctx: RequestContext,
  event: SyncPushEvent
): Promise<void> {
  const command = record(event.payload.command);
  const snapshot = record(event.payload.operationalSnapshot);
  const payload =
    snapshot.kind === 'rfid.cycle_count' ? record(snapshot.count) : record(command.payload);
  if (payload.organizationId !== undefined && payload.organizationId !== ctx.organizationId)
    throw new PermissionDeniedError('sync.organization');
  if (payload.actorUserId !== undefined && payload.actorUserId !== ctx.userId)
    throw new PermissionDeniedError('sync.actor');
  const kind = typeof command.kind === 'string' ? command.kind : '';
  const permissions =
    snapshot.kind === 'rfid.cycle_count' ? ['rfid_counts.sync'] : commandPermissions[kind];
  if (!permissions) throw new ValidationFailedError('Unsupported sync command.');
  const required =
    kind === 'count.action' && payload.action === 'complete'
      ? ['rfid_counts.confirm']
      : permissions;
  const locations = new Set<string>();
  for (const key of [
    'locationId',
    'sourceLocationId',
    'targetLocationId',
    'destinationLocationId',
    'fromLocationId',
    'toLocationId'
  ]) {
    if (typeof payload[key] === 'string') locations.add(payload[key]);
  }
  if (event.locationId) locations.add(event.locationId);
  // Derive warehouse scope from authoritative rows, never only caller headers.
  if (kind.startsWith('warehouse.')) {
    const result = await client.query<{ location_id: string }>(
      `SELECT DISTINCT w.location_id FROM warehouses w
      LEFT JOIN warehouse_zones z ON z.warehouse_id = w.id AND z.organization_id = w.organization_id
      LEFT JOIN warehouse_bins b ON b.zone_id = z.id AND b.organization_id = w.organization_id
      WHERE w.organization_id = $1 AND (w.id::text = $2 OR z.id::text = $3 OR b.id::text = $4)`,
      [
        ctx.organizationId,
        payload.warehouseId ?? '',
        payload.zoneId ?? '',
        payload.binId ?? payload.id ?? ''
      ]
    );
    for (const row of result.rows) locations.add(row.location_id);
  }
  if (ctx.isOwner) return;
  const allows = (locationId?: string) =>
    required.some(
      (permission) =>
        ctx.permissions.includes(permission) &&
        ctx.scopedGrants?.some(
          (grant) =>
            grant.permission === permission &&
            (grant.scope === 'all_locations' ||
              (locationId !== undefined && grant.locationId === locationId))
        )
    );
  if (locations.size ? [...locations].some((location) => !allows(location)) : !allows())
    throw new PermissionDeniedError(required[0]!);
}
