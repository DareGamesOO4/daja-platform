/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './migrations.js';
import { createTestDatabase, resetDatabase } from '../test/helpers.js';
import type { Database } from './pool.js';
import { CatalogRepository } from './catalog.js';
import { InventoryRepository } from './inventory.js';
import { RfidRepository } from './rfid.js';
import { AuditRepository } from './audit.js';
import { OutboxRepository } from './outbox.js';

const ctx = {
  requestId: '00000000-0000-4000-8000-000000000001',
  correlationId: '00000000-0000-4000-8000-000000000002',
  organizationId: '00000000-0000-4000-8000-000000000101',
  userId: '00000000-0000-4000-8000-000000000201',
  roles: ['owner'],
  permissions: ['catalog.write', 'catalog.read', 'rfid.assign', 'rfid.read', 'inventory.adjust']
};

describe('plan 2 domain acceptance', () => {
  let database: Database;

  beforeEach(async () => {
    database = createTestDatabase();
    await resetDatabase(database.pool);
    await migrate(database.pool);
    await seedFoundation(database);
  });

  afterEach(async () => {
    await database?.close();
  });

  it('creates catalog data, rejects duplicate SKU, and writes price history on price change', async () => {
    const catalog = new CatalogRepository(database.pool);
    const product = await catalog.createProduct(ctx, {
      name: 'Casio A130',
      slug: 'casio-a130',
      published: true
    });
    const variant = await catalog.createVariant(ctx, product.id, {
      sku: 'A130-1',
      currentPriceAmount: 1299000,
      currency: 'RSD',
      published: true
    });
    await expect(
      catalog.createVariant(ctx, product.id, {
        sku: 'A130-1',
        currentPriceAmount: 1299000,
        currency: 'RSD'
      })
    ).rejects.toThrow();
    await catalog.patchVariant(ctx, variant.id, {
      expectedVersion: variant.version,
      currentPriceAmount: 1199000
    });
    const prices = await database.query<{ count: string }>(
      `SELECT count(*) FROM variant_prices WHERE organization_id = $1 AND variant_id = $2`,
      [ctx.organizationId, variant.id]
    );
    expect(prices.rows[0]?.count).toBe('2');
  });

  it('keeps RFID resolver minimal and blocks unpublished products', async () => {
    const { product, variant } = await seedPublishedVariant(database);
    const item = await new InventoryRepository(database.pool).createItem(ctx, {
      variantId: variant.id,
      locationId: '00000000-0000-4000-8000-000000000301'
    });
    const tag = await new RfidRepository(database.pool).createTag(ctx, { epc: 'aa bb cc dd' });
    await new RfidRepository(database.pool).assignTag(ctx, {
      tagId: tag.id,
      inventoryItemId: item.id,
      reason: 'test'
    });
    const resolved = await new RfidRepository(database.pool).resolvePublic(ctx, 'AA-BB-CC-DD');
    expect(resolved).toEqual({
      found: true,
      productId: product.id,
      variantId: variant.id,
      slug: product.slug
    });
    expect(JSON.stringify(resolved)).not.toContain('tid');
    await new CatalogRepository(database.pool).patchProduct(ctx, product.id, {
      published: false
    });
    await expect(
      new RfidRepository(database.pool).resolvePublic(ctx, 'AA-BB-CC-DD')
    ).resolves.toEqual({
      found: false
    });
  });

  it('writes inventory ledger and rejects negative balances', async () => {
    const { variant } = await seedPublishedVariant(database);
    const inventory = new InventoryRepository(database.pool);
    await inventory.adjust(ctx, {
      variantId: variant.id,
      locationId: '00000000-0000-4000-8000-000000000301',
      quantityDelta: 3,
      sourceType: 'test'
    });
    await expect(
      inventory.adjust(ctx, {
        variantId: variant.id,
        locationId: '00000000-0000-4000-8000-000000000301',
        quantityDelta: -4,
        sourceType: 'test'
      })
    ).rejects.toThrow('Inventory balance cannot become negative');
    const events = await database.query<{ count: string }>(
      `SELECT count(*) FROM inventory_events WHERE organization_id = $1 AND variant_id = $2`,
      [ctx.organizationId, variant.id]
    );
    expect(events.rows[0]?.count).toBe('1');
  });

  it('enforces category cycles and append-only histories in the database', async () => {
    const parent = await database.query<{ id: string }>(
      `INSERT INTO categories (organization_id, name, slug) VALUES ($1, 'Parent', 'parent') RETURNING id`,
      [ctx.organizationId]
    );
    const child = await database.query<{ id: string }>(
      `INSERT INTO categories (organization_id, parent_id, name, slug) VALUES ($1, $2, 'Child', 'child') RETURNING id`,
      [ctx.organizationId, parent.rows[0]!.id]
    );
    await expect(
      database.query(`UPDATE categories SET parent_id = $1 WHERE id = $2`, [
        child.rows[0]!.id,
        parent.rows[0]!.id
      ])
    ).rejects.toThrow();
    const { variant } = await seedPublishedVariant(database);
    await database.query(
      `INSERT INTO variant_prices (organization_id, variant_id, amount_minor, currency, price_type, created_by)
       VALUES ($1, $2, 1000, 'RSD', 'sell', $3)`,
      [ctx.organizationId, variant.id, ctx.userId]
    );
    await expect(
      database.query(`DELETE FROM variant_prices WHERE organization_id = $1 AND variant_id = $2`, [
        ctx.organizationId,
        variant.id
      ])
    ).rejects.toThrow();
  });

  it('allows audit and outbox writes in the same transaction shape expected by controllers', async () => {
    const { product } = await seedPublishedVariant(database);
    await new AuditRepository(database.pool).append({
      ctx,
      aggregateType: 'product',
      aggregateId: product.id,
      operation: 'test'
    });
    await new OutboxRepository(database.pool).append({
      ctx,
      eventType: 'ProductUpdated',
      aggregateType: 'product',
      aggregateId: product.id,
      payload: { productId: product.id }
    });
    const rows = await database.query<{ audit: string; outbox: string }>(
      `SELECT
         (SELECT count(*) FROM audit_events)::text AS audit,
         (SELECT count(*) FROM domain_outbox)::text AS outbox`
    );
    expect(rows.rows[0]).toEqual({ audit: '1', outbox: '1' });
  });
});

async function seedFoundation(database: Database): Promise<void> {
  await database.query(
    `INSERT INTO organizations (id, name, slug, status)
     VALUES ($1, 'Public Org', 'public-org', 'active')`,
    [ctx.organizationId]
  );
  await database.query(
    `INSERT INTO users (id, organization_id, email, display_name)
     VALUES ($1, $2, 'owner@example.test', 'Owner')`,
    [ctx.userId, ctx.organizationId]
  );
  await database.query(
    `INSERT INTO locations (id, organization_id, code, name, type, timezone)
     VALUES ('00000000-0000-4000-8000-000000000301', $1, 'MAIN', 'Main', 'warehouse', 'Europe/Belgrade')`,
    [ctx.organizationId]
  );
}

async function seedPublishedVariant(database: Database) {
  const catalog = new CatalogRepository(database.pool);
  const product = await catalog.createProduct(ctx, {
    name: `Product ${randomUUID()}`,
    slug: `product-${randomUUID().slice(0, 8)}`,
    published: true
  });
  const variant = await catalog.createVariant(ctx, product.id, {
    sku: `SKU-${randomUUID().slice(0, 8)}`,
    currentPriceAmount: 1000,
    currency: 'RSD',
    published: true
  });
  return { product, variant };
}
