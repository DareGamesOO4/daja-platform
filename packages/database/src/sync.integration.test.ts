/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from './pool.js';
import { migrate } from './migrations.js';
import { DeviceRepository, SyncRepository } from './sync.js';
import { createTestDatabase, resetDatabase } from '../test/helpers.js';

const organizationId = '00000000-0000-4000-8000-000000000701';
const otherOrganizationId = '00000000-0000-4000-8000-000000000702';
const userId = '00000000-0000-4000-8000-000000000703';
const locationId = '00000000-0000-4000-8000-000000000704';

const ctx = {
  requestId: '00000000-0000-4000-8000-000000000001',
  correlationId: '00000000-0000-4000-8000-000000000002',
  organizationId,
  userId,
  locationId,
  roles: ['owner'],
  permissions: ['sync.read', 'sync.write', 'sync.conflicts', 'admin.users']
};

describe('plan 3 sync foundation', () => {
  let database: Database;

  beforeEach(async () => {
    database = createTestDatabase();
    await resetDatabase(database.pool);
    await migrate(database.pool);
    await seedFoundation(database);
  });

  afterEach(async () => {
    await database.close();
  });

  it('pushes idempotently and pulls in revision order within one tenant', async () => {
    const sync = new SyncRepository(database.pool);
    const aggregateId = randomUUID();
    const first = await sync.pushBatch(ctx, [
      event('sync-key-1', aggregateId, { name: 'A' }),
      event('sync-key-2', randomUUID(), { name: 'B' })
    ]);
    expect(first.map((item) => item.status)).toEqual(['applied', 'applied']);
    expect(first[0]!.revision).toBe(1);
    expect(first[1]!.revision).toBe(2);

    const duplicate = await sync.pushBatch(ctx, [event('sync-key-1', aggregateId, { name: 'A' })]);
    expect(duplicate[0]).toMatchObject({ status: 'duplicate', revision: 1 });

    const pulled = await sync.pull(ctx, { afterRevision: 0, limit: 10 });
    expect(pulled.events.map((item) => item.revision)).toEqual([1, 2]);
    expect(pulled.hasMore).toBe(false);

    const otherPull = await sync.pull(
      { organizationId: otherOrganizationId },
      { afterRevision: 0, limit: 10 }
    );
    expect(otherPull.events).toEqual([]);
  });

  it('records conflicts when base version differs from server version', async () => {
    const product = await database.query<{ id: string; version: string }>(
      `INSERT INTO products (organization_id, name, slug, published, version)
       VALUES ($1, 'Conflict Product', 'conflict-product', true, 4)
       RETURNING id, version`,
      [organizationId]
    );
    const result = await new SyncRepository(database.pool).pushBatch(ctx, [
      {
        ...event('sync-conflict-1', product.rows[0]!.id, { name: 'Changed' }),
        aggregateType: 'product',
        baseVersion: 3
      }
    ]);
    expect(result[0]?.status).toBe('conflict');
    expect(result[0]?.conflictId).toBeDefined();
    const conflicts = await new SyncRepository(database.pool).listConflicts(ctx, {
      limit: 10
    });
    expect(conflicts).toHaveLength(1);
  });

  it('accepts an explicit desktop item delete even with a stale base version', async () => {
    const product = await database.query<{ id: string }>(
      `INSERT INTO products (organization_id, name, slug, published, version)
       VALUES ($1, 'Delete Product', 'delete-product', true, 4)
       RETURNING id`,
      [organizationId]
    );
    const variant = await database.query<{ id: string }>(
      `INSERT INTO product_variants (organization_id, product_id, sku, current_price_amount, currency, published, version)
       VALUES ($1, $2, 'DELETE-1', 1000, 'RSD', true, 4)
       RETURNING id`,
      [organizationId, product.rows[0]!.id]
    );

    const result = await new SyncRepository(database.pool).pushBatch(ctx, [{
      ...event('sync-delete-stale-1', variant.rows[0]!.id, {
        command: { kind: 'item.delete', payload: {} }
      }),
      aggregateType: 'product_variant',
      baseVersion: 1
    }]);

    expect(result[0]?.status).toBe('applied');
  });

  it('creates device identity and bootstrap snapshot watermark', async () => {
    const device = await new DeviceRepository(database.pool).registerDevice(ctx, {
      deviceKey: 'rfiddaja-device-1',
      displayName: 'RFIDDaja Register',
      deviceType: 'rfiddaja_desktop',
      locationId
    });
    expect(device.deviceKey).toBe('rfiddaja-device-1');

    const product = await database.query<{ id: string }>(
      `INSERT INTO products (organization_id, name, slug, published)
       VALUES ($1, 'Bootstrap Product', 'bootstrap-product', true)
       RETURNING id`,
      [organizationId]
    );
    await database.query(
      `INSERT INTO product_variants (organization_id, product_id, sku, current_price_amount, currency, published)
       VALUES ($1, $2, 'BOOT-1', 1000, 'RSD', true)`,
      [organizationId, product.rows[0]!.id]
    );
    await new SyncRepository(database.pool).pushBatch(ctx, [
      event('bootstrap-event-1', product.rows[0]!.id, { slug: 'bootstrap-product' })
    ]);
    const snapshot = await new SyncRepository(database.pool).bootstrapSnapshot(ctx, { limit: 50 });
    expect(snapshot.watermarkRevision).toBe(1);
    expect(snapshot.items.length).toBeGreaterThan(0);
  });

  it('keeps server sync events append-only', async () => {
    const pushed = await new SyncRepository(database.pool).pushBatch(ctx, [
      event('append-only-1', randomUUID(), { ok: true })
    ]);
    await expect(
      database.query(
        `DELETE FROM server_sync_events WHERE organization_id = $1 AND revision = $2`,
        [organizationId, pushed[0]!.revision]
      )
    ).rejects.toThrow();
  });
});

function event(idempotencyKey: string, aggregateId: string, payload: Record<string, unknown>) {
  return {
    eventId: randomUUID(),
    idempotencyKey,
    aggregateType: 'product',
    aggregateId,
    operation: 'upsert',
    payloadVersion: 1,
    clientTimestamp: new Date().toISOString(),
    payload
  };
}

async function seedFoundation(database: Database): Promise<void> {
  await database.query(
    `INSERT INTO organizations (id, name, slug, status)
     VALUES ($1, 'Sync Org', 'sync-org', 'active'), ($2, 'Other Org', 'other-sync-org', 'active')`,
    [organizationId, otherOrganizationId]
  );
  await database.query(
    `INSERT INTO users (id, organization_id, email, display_name)
     VALUES ($1, $2, 'sync@example.test', 'Sync User')`,
    [userId, organizationId]
  );
  await database.query(
    `INSERT INTO locations (id, organization_id, code, name, type, timezone)
     VALUES ($1, $2, 'SYNC', 'Sync Location', 'warehouse', 'Europe/Belgrade')`,
    [locationId, organizationId]
  );
}
