/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import type { Request } from 'express';
import { loadConfig } from '@daja/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from './pool.js';
import { migrate } from './migrations.js';
import { DeviceRepository, SyncRepository } from './sync.js';
import { createTestDatabase, resetDatabase } from '../test/helpers.js';
import { OperationalSyncProjector } from '../../../apps/api/src/operational-sync-projector.js';
import { OfflineInventoryController } from '../../../apps/api/src/offline-inventory.controller.js';

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
  isOwner: true,
  permissions: ['sync.read', 'sync.write', 'sync.conflicts', 'admin.users', 'rfid_counts.sync']
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

    const result = await new SyncRepository(database.pool).pushBatch(ctx, [
      {
        ...event('sync-delete-stale-1', variant.rows[0]!.id, {
          command: { kind: 'item.delete', payload: {} }
        }),
        aggregateType: 'product_variant',
        baseVersion: 1
      }
    ]);

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

  it('pages mobile variants, keeps tag and quantity location scoped, and signs the live count baseline', async () => {
    const secondLocation = randomUUID();
    const variant = '00000000-0000-4000-8000-000000000709';
    const anotherVariant = '00000000-0000-4000-8000-000000000710';
    const product = randomUUID();
    const tag = randomUUID();
    const tagAtSecondLocation = randomUUID();
    const epc = 'E20000000000000000000001';
    const otherEpc = 'E20000000000000000000002';
    const role = randomUUID();
    const media = randomUUID();
    const thumb = 'https://media.example.test/thumb.webp';
    await database.query("INSERT INTO roles(id, organization_id, name) VALUES($1,$2,'Fixture')", [role, organizationId]);
    await database.query(
      "INSERT INTO user_role_assignments(organization_id,user_id,role_id,scope,location_id) VALUES($1,$2,$3,'location',$4)",
      [organizationId,userId,role,locationId]
    );
    await database.query(
      "INSERT INTO locations(id,organization_id,code,name,type,timezone) VALUES($1,$2,'SECOND','Second','store','Europe/Belgrade')",
      [secondLocation, organizationId]
    );
    await database.query("INSERT INTO products(id,organization_id,name,slug) VALUES($1,$2,'Fixture','fixture-product')", [product, organizationId]);
    await database.query(
      "INSERT INTO product_variants(id,organization_id,product_id,sku,currency,current_price_amount,active) VALUES($1,$3,$4,'A1','RSD',5000,true),($2,$3,$4,'A2','RSD',8000,false)",
      [variant, anotherVariant, organizationId, product]
    );
    await database.query(
      "INSERT INTO inventory_balances(organization_id,location_id,variant_id,quantity) VALUES($1,$2,$4,1),($1,$3,$4,2)",
      [organizationId,locationId,secondLocation,variant]
    );
    await database.query(
      "INSERT INTO rfid_tags(id,organization_id,epc,variant_id,status) VALUES($1,$3,$4,$6,'in_stock'),($2,$3,$5,$6,'in_stock')",
      [tag,tagAtSecondLocation,organizationId,epc,otherEpc,variant]
    );
    await database.query(
      "INSERT INTO rfid_tag_events(organization_id,tag_id,location_id,event_type) VALUES($1,$2,$4,'assigned'),($1,$3,$5,'assigned')",
      [organizationId,tag,tagAtSecondLocation,locationId,secondLocation]
    );
    await database.query(
      "INSERT INTO media_assets(id,organization_id,storage_provider,storage_bucket,storage_key,public_url,mime_type,status) VALUES($1,$2,'external-url','fixture','file','https://media.example.test/full.jpg','image/jpeg','ready')",
      [media,organizationId]
    );
    await database.query(
      "INSERT INTO product_media(organization_id,product_id,media_asset_id,role,is_primary) VALUES($1,$2,$3,'hero',true)",
      [organizationId,product,media]
    );
    await database.query(
      "INSERT INTO media_derivatives(organization_id,media_asset_id,width,height,mime_type,storage_key,public_url,size_bytes) VALUES($1,$2,160,160,'image/webp','thumb',$3,10)",
      [organizationId,media,thumb]
    );

    const deviceId = await registerSyncDevice(database, 'mobile-offline-fixture');
    const scoped = { ...ctx, isOwner: false, deviceId, policyVersion: 4,
      scopedGrants: [{ permission: 'sync.read', scope: 'location' as const, locationId },
        { permission: 'rfid_counts.sync', scope: 'location' as const, locationId }] };
    const sync = new SyncRepository(database.pool);
    const first = await sync.bootstrapSnapshot(scoped, { limit: 1, mobile: { includeState: true } });
    expect(first).toMatchObject({ hasMore: true, nextCursor: variant });
    expect(first.items).toEqual([expect.objectContaining({ variantId: variant, quantity: 1, thumbnailUri: thumb,
      rfidPieces: [expect.objectContaining({ tagId: tag, epc, locationId })] })]);
    const second = await sync.bootstrapSnapshot(scoped, { limit: 1, cursor: variant, mobile: { includeState: false } });
    expect(second.items).toEqual([expect.objectContaining({ variantId: anotherVariant, active: false })]);

    const key = generateKeyPairSync('ed25519');
    const controller = new OfflineInventoryController(database, {
      ...loadConfig(), OFFLINE_PACKAGE_SIGNING_PRIVATE_KEY: key.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    });
    const request = { authContext: scoped, headers: {} } as unknown as Request;
    const baseline = await controller.mobileBaseline(request, { locationId });
    expect(baseline.expectedTags).toEqual([expect.objectContaining({ tagId: tag, epc, productVariantId: variant })]);
    const envelope = await controller.mobileReserve(request, { locationId });
    const bytes = Buffer.from(envelope.payload, 'base64url');
    expect(verify(null, bytes, key.publicKey, Buffer.from(envelope.signature, 'base64url'))).toBe(true);
    const reserve = JSON.parse(bytes.toString('utf8'));
    expect(reserve).toMatchObject({ schemaVersion: 2, organizationId, userId, deviceId, policyVersion: 4, baseline });
    expect(Date.parse(reserve.expiresAt) - Date.parse(reserve.issuedAt)).toBe(24 * 3600_000);
    await expect(controller.mobileReserve(request, { locationId: secondLocation })).rejects.toThrow();
  });

  it('applies a mobile sale once when the same event is replayed after reconnect', async () => {
    const product = randomUUID();
    const variant = randomUUID();
    const sale = randomUUID();
    const deviceId = await registerSyncDevice(database, 'mobile-sale-fixture');
    await database.query("INSERT INTO products(id,organization_id,name,slug) VALUES($1,$2,'Sale fixture','sale-fixture')", [product,organizationId]);
    await database.query("INSERT INTO product_variants(id,organization_id,product_id,sku,currency,current_price_amount) VALUES($1,$2,$3,'SALE','RSD',10000)", [variant,organizationId,product]);
    await database.query("INSERT INTO inventory_balances(organization_id,location_id,variant_id,quantity) VALUES($1,$2,$3,2)", [organizationId,locationId,variant]);
    const saleEvent = {
      ...event('mobile-sale-replay', sale, { command: { kind: 'sale.confirm', payload: {
        saleId: sale, locationId, paymentMethod: 'cash', cashPaidMinor: 10000,
        lines: [{ productVariantId: variant, quantity: 1, unitPriceMinor: 10000 }]
      } } }), aggregateType: 'sale', operation: 'command'
    };
    const owner = { ...ctx, deviceId };
    const sync = new SyncRepository(database.pool);
    const projector = new OperationalSyncProjector(database.pool as never);
    const replay = async () => sync.pushBatch(owner, [saleEvent], row => projector.materialize(owner, row));
    expect(await replay()).toMatchObject([{ status: 'applied' }]);
    expect(await replay()).toMatchObject([{ status: 'duplicate' }]);
    expect((await database.query("SELECT quantity FROM inventory_balances WHERE variant_id=$1", [variant])).rows).toEqual([{ quantity: 1 }]);
    expect((await database.query("SELECT id FROM internal_sales WHERE id=$1", [sale])).rows).toEqual([{ id: sale }]);
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

  it('reassigns an EPC that already exists in Platform instead of failing the desktop sync', async () => {
    const sourceProduct = await database.query<{ id: string }>(
      `INSERT INTO products (organization_id, name, slug, published)
       VALUES ($1, 'Old tag owner', 'old-tag-owner', true) RETURNING id`,
      [organizationId]
    );
    const targetProduct = await database.query<{ id: string }>(
      `INSERT INTO products (organization_id, name, slug, published)
       VALUES ($1, 'New tag owner', 'new-tag-owner', true) RETURNING id`,
      [organizationId]
    );
    const sourceVariant = await database.query<{ id: string }>(
      `INSERT INTO product_variants (organization_id, product_id, sku, current_price_amount, currency, published)
       VALUES ($1, $2, 'OLD-TAG', 1000, 'RSD', true) RETURNING id`,
      [organizationId, sourceProduct.rows[0]!.id]
    );
    const targetVariant = await database.query<{ id: string }>(
      `INSERT INTO product_variants (organization_id, product_id, sku, current_price_amount, currency, published)
       VALUES ($1, $2, 'NEW-TAG', 1000, 'RSD', true) RETURNING id`,
      [organizationId, targetProduct.rows[0]!.id]
    );
    const epc = 'E200470F651060273BDD0109';
    const existingTag = await database.query<{ id: string }>(
      `INSERT INTO rfid_tags (organization_id, epc, variant_id, status)
       VALUES ($1, $2, $3, 'assigned') RETURNING id`,
      [organizationId, epc, sourceVariant.rows[0]!.id]
    );
    const desktopTagId = randomUUID();
    const projector = new OperationalSyncProjector(database.pool);
    const result = await new SyncRepository(database.pool).pushBatch(
      ctx,
      [
        {
          eventId: randomUUID(),
          idempotencyKey: 'desktop-tag-reassignment',
          aggregateType: 'rfid_tag',
          aggregateId: desktopTagId,
          operation: 'command',
          payloadVersion: 1,
          clientTimestamp: new Date().toISOString(),
          locationId,
          payload: {
            command: {
              kind: 'tag.assign',
              payload: {
                schemaVersion: 1,
                organizationId,
                productVariantId: targetVariant.rows[0]!.id,
                epc,
                locationId,
                actorUserId: userId,
                deviceId: randomUUID()
              }
            }
          }
        }
      ],
      (input) => projector.materialize(ctx, input)
    );

    expect(result[0]?.status).toBe('applied');
    const tag = await database.query<{ id: string; variantId: string }>(
      `SELECT id, variant_id AS "variantId" FROM rfid_tags
       WHERE organization_id = $1 AND epc = $2 AND deleted_at IS NULL`,
      [organizationId, epc]
    );
    expect(tag.rows).toEqual([
      { id: existingTag.rows[0]!.id, variantId: targetVariant.rows[0]!.id }
    ]);
    const assignment = await database.query<{ tagId: string; locationId: string }>(
      `SELECT tag_id AS "tagId", location_id AS "locationId" FROM rfid_tag_events
       WHERE organization_id = $1 AND tag_id = $2 AND event_type = 'assigned'`,
      [organizationId, existingTag.rows[0]!.id]
    );
    expect(assignment.rows).toEqual([{ tagId: existingTag.rows[0]!.id, locationId }]);
  });

  it('merges retried RFID read packets, preserves the paused owner and transfers atomically', async () => {
    const firstDevice = await registerSyncDevice(database, 'rfid-cloud-owner');
    const secondDevice = await registerSyncDevice(database, 'rfid-cloud-claimant');
    const countId = randomUUID();
    const projector = new OperationalSyncProjector(database.pool);
    const firstContext = { ...ctx, deviceId: firstDevice };
    const secondContext = { ...ctx, deviceId: secondDevice };
    const push = async (
      context: typeof firstContext,
      key: string,
      snapshot: Record<string, unknown>
    ) =>
      new SyncRepository(database.pool).pushBatch(
        context,
        [rfidEvent(key, countId, snapshot)],
        (input) => projector.materialize(context, input)
      );

    const header = {
      id: countId,
      locationId,
      name: 'Cloud RFID count',
      status: 'in_progress',
      expectedTotal: 1,
      readTotal: 0,
      foundTotal: 0,
      missingTotal: 1,
      unexpectedTotal: 0,
      createdByUserId: userId
    };
    await push(firstContext, 'rfid-create', {
      operationalSnapshot: {
        kind: 'rfid.cycle_count',
        protocolVersion: 1,
        operation: 'create',
        count: header
      }
    });
    await push(firstContext, 'rfid-expected', {
      operationalSnapshot: {
        kind: 'rfid.cycle_count',
        protocolVersion: 1,
        operation: 'expected_batch',
        count: header,
        expectedItems: [
          {
            id: randomUUID(),
            epc: 'E2000017221101441890ABCD',
            expectedLocationId: locationId,
            snapshotVersion: 1
          }
        ]
      }
    });
    const read = {
      id: randomUUID(),
      epc: 'E2000017221101441890ABCD',
      deviceId: firstDevice,
      firstReadAt: '2026-08-26T10:00:00.000Z',
      lastReadAt: '2026-08-26T10:00:01.000Z',
      rawReadCount: 1,
      strongestRssi: -62,
      lastRssi: -62,
      antenna: 1,
      sequence: 1
    };
    await push(firstContext, 'rfid-read-first', {
      operationalSnapshot: {
        kind: 'rfid.cycle_count',
        protocolVersion: 1,
        operation: 'read_batch',
        count: header,
        reads: [read]
      }
    });
    await push(firstContext, 'rfid-read-retry', {
      operationalSnapshot: {
        kind: 'rfid.cycle_count',
        protocolVersion: 1,
        operation: 'read_batch',
        count: header,
        reads: [
          {
            ...read,
            id: randomUUID(),
            lastReadAt: '2026-08-26T10:00:03.000Z',
            rawReadCount: 4,
            strongestRssi: -48,
            lastRssi: -48,
            sequence: 4
          }
        ]
      }
    });
    const merged = await database.query<{
      count: string;
      reads: string;
      strongest: number;
      last: Date;
    }>(
      `SELECT COUNT(*)::text AS count, MAX(read_count)::text AS reads, MAX(strongest_rssi) AS strongest, MAX(last_seen_at) AS last
       FROM rfid_cycle_count_reads WHERE organization_id = $1 AND cycle_count_id = $2`,
      [organizationId, countId]
    );
    expect(merged.rows[0]).toMatchObject({ count: '1', reads: '4', strongest: -48 });
    expect(merged.rows[0]?.last.toISOString()).toBe('2026-08-26T10:00:03.000Z');

    await push(firstContext, 'rfid-pause', {
      operationalSnapshot: {
        kind: 'rfid.cycle_count',
        protocolVersion: 1,
        operation: 'state',
        action: 'pause',
        count: { ...header, status: 'paused', readTotal: 1, foundTotal: 1, missingTotal: 0 }
      }
    });
    const paused = await database.query<{ owner: string; status: string }>(
      `SELECT owner_device_id::text AS owner, status FROM rfid_cycle_counts WHERE organization_id = $1 AND id = $2`,
      [organizationId, countId]
    );
    expect(paused.rows[0]).toEqual({ owner: firstDevice, status: 'paused' });

    await push(secondContext, 'rfid-claim', {
      operationalSnapshot: {
        kind: 'rfid.cycle_count',
        protocolVersion: 1,
        operation: 'state',
        action: 'claim',
        count: { ...header, status: 'paused' }
      }
    });
    const claimed = await database.query<{ owner: string; status: string }>(
      `SELECT owner_device_id::text AS owner, status FROM rfid_cycle_counts WHERE organization_id = $1 AND id = $2`,
      [organizationId, countId]
    );
    expect(claimed.rows[0]).toEqual({ owner: secondDevice, status: 'paused' });

    await push(secondContext, 'rfid-resume', {
      operationalSnapshot: {
        kind: 'rfid.cycle_count',
        protocolVersion: 1,
        operation: 'state',
        action: 'resume',
        count: { ...header, status: 'in_progress', readTotal: 1, foundTotal: 1, missingTotal: 0 }
      }
    });
    const resumed = await database.query<{ owner: string; status: string }>(
      `SELECT owner_device_id::text AS owner, status FROM rfid_cycle_counts WHERE organization_id = $1 AND id = $2`,
      [organizationId, countId]
    );
    expect(resumed.rows[0]).toEqual({ owner: secondDevice, status: 'in_progress' });
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

async function registerSyncDevice(database: Database, deviceKey: string): Promise<string> {
  const device = await database.query<{ id: string }>(
    `INSERT INTO devices (organization_id, user_id, location_id, device_key, display_name, device_type)
     VALUES ($1, $2, $3, $4, $5, 'rfiddaja_desktop') RETURNING id`,
    [organizationId, userId, locationId, deviceKey, deviceKey]
  );
  return device.rows[0]!.id;
}

function rfidEvent(idempotencyKey: string, aggregateId: string, payload: Record<string, unknown>) {
  return {
    eventId: randomUUID(),
    idempotencyKey,
    aggregateType: 'cycle_count',
    aggregateId,
    operation: 'event',
    payloadVersion: 2,
    clientTimestamp: new Date().toISOString(),
    locationId,
    payload
  };
}
