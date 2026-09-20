// Explicit connection only. All fixtures are TEMP tables on one connection;
// no production rows/schema are written, and the transaction is rolled back.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import {
  workforceSummary,
  effectiveRateSql,
  meaningfulSpecsSql
} from '../apps/api/src/workforce-data.js';

if (!process.env.WORKFORCE_TEST_DATABASE_URL)
  throw new Error('Set WORKFORCE_TEST_DATABASE_URL explicitly.');
const client = new pg.Client({
  connectionString: process.env.WORKFORCE_TEST_DATABASE_URL,
  connectionTimeoutMillis: 15000
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
try {
  await client.connect();
  await client.query('BEGIN');
  await client.query("SET LOCAL search_path = pg_temp; SET LOCAL statement_timeout = '15s'");
  for (const table of [
    'organizations',
    'users',
    'departments',
    'categories',
    'products',
    'product_variants',
    'roles',
    'user_role_assignments',
    'audit_events',
    'product_media',
    'media_assets',
    'catalog_contributor_rates',
    'catalog_contributor_settings'
  ]) {
    await client.query(
      `CREATE TEMP TABLE ${table} ON COMMIT DROP AS SELECT * FROM public.${table} WITH NO DATA`
    );
  }
  for (const table of ['organizations', 'users', 'departments', 'categories'])
    await client.query(`ALTER TABLE pg_temp.${table} ADD PRIMARY KEY (id)`);
  const migration = await readFile(
    new URL('../migrations/050_workforce_scoped_rates.sql', import.meta.url),
    'utf8'
  );
  await client.query(
    migration
      .replace(/^BEGIN;\s*/, '')
      .replace(/COMMIT;\s*$/, '')
      .replace('CREATE TABLE ', 'CREATE TEMP TABLE ')
  );
  await client.query('INSERT INTO organizations (id) VALUES ($1),($2)', [id(1), id(2)]);
  await client.query(
    `INSERT INTO users (id,organization_id,display_name,email) VALUES ($1,$2,'Worker','worker@example.test'),($3,$2,'Empty worker','empty@example.test'),($4,$5,'Other org','other@example.test')`,
    [id(10), id(1), id(11), id(12), id(2)]
  );
  await client.query('INSERT INTO departments (id,organization_id) VALUES ($1,$2)', [
    id(20),
    id(1)
  ]);
  await client.query(
    'INSERT INTO categories (id,organization_id,department_id) VALUES ($1,$2,$3)',
    [id(30), id(1), id(20)]
  );
  await client.query(
    "INSERT INTO roles (id,organization_id,code) VALUES ($1,$2,'catalog_contributor')",
    [id(40), id(1)]
  );
  await client.query(
    'INSERT INTO user_role_assignments (organization_id,user_id,role_id) VALUES ($1,$2,$3)',
    [id(1), id(11), id(40)]
  );
  await client.query(
    `INSERT INTO products (id,organization_id,created_by_user_id,name,description,department_id,brand_id,primary_category_id,quality_review_status,created_at,compensation_approved_at,compensation_amount_minor)
    SELECT ids.id::uuid,$1,$2,'Watch','Description',$3,$3,$4,'pending',
      ((now() AT TIME ZONE 'Europe/Belgrade')::date + ids.hour::time) AT TIME ZONE 'Europe/Belgrade',NULL,NULL
    FROM (VALUES ($5::text,'01:00'),($6::text,'02:00')) ids(id,hour)`,
    [id(1), id(10), id(20), id(30), id(100), id(101)]
  );
  await client.query(
    `INSERT INTO product_variants (id,organization_id,product_id,sku,current_price_amount,gender,attributes,created_at)
    SELECT id,$1,id,'SKU',10000,'unisex','{"size":"40","color":"red","empty":"","additional_barcodes":["123"],"_meta":"hidden"}'::jsonb,created_at FROM products`,
    [id(1)]
  );
  await client.query("INSERT INTO media_assets (id,status) VALUES ($1,'ready')", [id(200)]);
  await client.query(
    'INSERT INTO product_media (organization_id,product_id,media_asset_id) SELECT $1,id,$2 FROM products',
    [id(1), id(200)]
  );
  await client.query(
    "INSERT INTO audit_events (organization_id,aggregate_type,aggregate_id,operation) VALUES ($1,'product',$2,'quality_changes_requested'),($1,'product',$2,'quality_changes_requested')",
    [id(1), id(100)]
  );
  const summary = (await workforceSummary(client, id(1), '2000-01-01', '2100-01-01')).find(
    (r) => r.id === id(10)
  );
  assert.equal(summary.createdTotal, 2);
  assert.equal(summary.createdToday, 2);
  assert.equal(summary.incompleteCount, 2);
  assert.equal(summary.returnedTotal, 2);
  assert.equal(summary.returnedProductsCount, 1);
  assert.deepEqual(summary.hourly, { '01': 1, '02': 1 });
  const all = await workforceSummary(client, id(1), '2000-01-01', '2100-01-01');
  assert.equal(all.length, 2);
  assert.equal(all.find((r) => r.id === id(11)).createdTotal, 0);
  assert.equal(
    Number(
      (await client.query(`SELECT ${meaningfulSpecsSql} AS n FROM product_variants v LIMIT 1`))
        .rows[0].n
    ),
    2
  );
  await client.query(
    'INSERT INTO catalog_contributor_settings (organization_id,default_rate_minor) VALUES ($1,100)',
    [id(1)]
  );
  const rate = async () =>
    Number(
      (
        await client.query(`SELECT ${effectiveRateSql('p')} AS rate FROM products p WHERE id=$1`, [
          id(100)
        ])
      ).rows[0].rate
    );
  assert.equal(await rate(), 100);
  const addRule = async (user: string | null, category: string | null, amount: number) =>
    client.query(
      'INSERT INTO catalog_contributor_rate_rules (organization_id,user_id,department_id,category_id,rate_minor) VALUES ($1,$2,$3,$4,$5)',
      [id(1), user, id(20), category, amount]
    );
  await addRule(null, null, 200);
  assert.equal(await rate(), 200);
  await addRule(null, id(30), 300);
  assert.equal(await rate(), 300);
  await client.query(
    'INSERT INTO catalog_contributor_rates (organization_id,user_id,rate_minor) VALUES ($1,$2,400)',
    [id(1), id(10)]
  );
  assert.equal(await rate(), 400);
  await addRule(id(10), null, 500);
  assert.equal(await rate(), 500);
  await addRule(id(10), id(30), 0);
  assert.equal(await rate(), 0);
  await client.query(
    'DELETE FROM catalog_contributor_rate_rules WHERE user_id=$1 AND category_id=$2',
    [id(10), id(30)]
  );
  assert.equal(await rate(), 500);
  const approve = () =>
    client.query(
      `UPDATE products SET compensation_amount_minor=CASE WHEN compensation_approved_at IS NULL THEN ${effectiveRateSql('products')} ELSE compensation_amount_minor END, compensation_approved_at=COALESCE(compensation_approved_at,now()),quality_review_status='approved' WHERE id=$1`,
      [id(100)]
    );
  await approve();
  await client.query("UPDATE products SET quality_review_status='pending' WHERE id=$1", [id(100)]);
  await client.query('UPDATE catalog_contributor_rate_rules SET rate_minor=999 WHERE user_id=$1', [
    id(10)
  ]);
  await approve();
  await client.query('UPDATE products SET deleted_at=now() WHERE id=$1', [id(100)]);
  const final = (await workforceSummary(client, id(1), '2000-01-01', '2100-01-01')).find(
    (r) => r.id === id(10)
  );
  assert.equal(Number(final.approvedAmountMinor), 500);
  assert.equal(final.creditedCount, 1);
  assert.equal(final.deletedCount, 1);
  assert.equal(final.createdTotal, 2);
  assert.equal(final.returnedTotal, 2);
  console.log(
    'PASS: migration 050; isolated workforce counts/hourly/returns; empty workers; tenant isolation; meaningful specs; six rate priorities and zero override; immutable one-time compensation; deleted-product history.'
  );
} finally {
  await client.query('ROLLBACK').catch(() => {});
  await client.end();
}
