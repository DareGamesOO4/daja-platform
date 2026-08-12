import 'dotenv/config';
import { loadConfig } from '@daja/config';
import { createDatabase, migrate } from '@daja/database';
import { createLogger } from '@daja/observability';

const config = loadConfig();
const logger = createLogger(config, 'plan2-performance');
const database = createDatabase(config, logger);

const scale = {
  products: Number(process.env.PLAN2_PERF_PRODUCTS ?? 10_000),
  variants: Number(process.env.PLAN2_PERF_VARIANTS ?? 20_000),
  items: Number(process.env.PLAN2_PERF_ITEMS ?? 50_000),
  tags: Number(process.env.PLAN2_PERF_TAGS ?? 50_000)
};

try {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Performance fixture is disabled in production');
  }
  await migrate(database.pool);
  const organizationId = await ensureOrganization();
  await generateFixture(organizationId);
  await verifyPlans(organizationId);
} finally {
  await database.close();
}

async function ensureOrganization(): Promise<string> {
  const existing = await database.query<{ id: string }>(
    `SELECT id FROM organizations WHERE slug = 'plan2-performance' AND deleted_at IS NULL`
  );
  if (existing.rows[0]) {
    return existing.rows[0].id;
  }
  const created = await database.query<{ id: string }>(
    `INSERT INTO organizations (name, slug, status)
     VALUES ('Plan 2 Performance', 'plan2-performance', 'active')
     RETURNING id`
  );
  return created.rows[0]!.id;
}

async function generateFixture(organizationId: string): Promise<void> {
  const client = await database.pool.connect();
  try {
    await client.query(`SET statement_timeout = '120s'`);
    await client.query(
      `INSERT INTO products (organization_id, name, slug, published)
       SELECT $1, 'Product ' || gs, 'perf-product-' || gs, true
       FROM generate_series(1, $2) gs
       ON CONFLICT (organization_id, slug) WHERE deleted_at IS NULL DO NOTHING`,
      [organizationId, scale.products]
    );
    await client.query(
      `INSERT INTO product_variants (organization_id, product_id, sku, current_price_amount, currency, published)
       SELECT $1, p.id, 'PERF-' || gs, 10000 + gs, 'RSD', true
       FROM generate_series(1, $2) gs
       JOIN products p ON p.organization_id = $1 AND p.slug = 'perf-product-' || (((gs - 1) % $3) + 1)
       ON CONFLICT (organization_id, normalized_sku) WHERE deleted_at IS NULL DO NOTHING`,
      [organizationId, scale.variants, scale.products]
    );
    await client.query(
      `INSERT INTO inventory_items (organization_id, variant_id, status)
       SELECT $1, v.id, 'in_stock'
       FROM generate_series(1, $2) gs
       JOIN product_variants v ON v.organization_id = $1 AND v.normalized_sku = 'PERF-' || (((gs - 1) % $3) + 1)
       ON CONFLICT DO NOTHING`,
      [organizationId, scale.items, scale.variants]
    );
    await client.query(
      `INSERT INTO rfid_tags (organization_id, epc, status, variant_id)
       SELECT $1, upper(lpad(to_hex(gs), 24, '0')), 'assigned', v.id
       FROM generate_series(1, $2) gs
       JOIN product_variants v ON v.organization_id = $1 AND v.normalized_sku = 'PERF-' || (((gs - 1) % $3) + 1)
       ON CONFLICT (organization_id, epc) WHERE deleted_at IS NULL DO NOTHING`,
      [organizationId, scale.tags, scale.variants]
    );
  } finally {
    client.release();
  }
}

async function verifyPlans(organizationId: string): Promise<void> {
  const checks = [
    {
      name: 'epc',
      sql: `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
            SELECT id FROM rfid_tags WHERE organization_id = $1 AND epc = $2 AND deleted_at IS NULL`,
      params: [organizationId, '000000000000000000000001']
    },
    {
      name: 'slug',
      sql: `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
            SELECT id FROM products WHERE organization_id = $1 AND slug = $2 AND deleted_at IS NULL`,
      params: [organizationId, 'perf-product-1']
    },
    {
      name: 'sku',
      sql: `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
            SELECT id FROM product_variants WHERE organization_id = $1 AND normalized_sku = $2 AND deleted_at IS NULL`,
      params: [organizationId, 'PERF-1']
    }
  ];
  for (const check of checks) {
    const result = await database.query<{ 'QUERY PLAN': string }>(check.sql, check.params);
    const text = result.rows.map((row) => row['QUERY PLAN']).join('\n');
    if (/Seq Scan/.test(text)) {
      throw new Error(`${check.name} lookup used sequential scan:\n${text}`);
    }
    logger.info({ check: check.name, plan: text }, 'Plan 2 lookup verified');
  }
}
