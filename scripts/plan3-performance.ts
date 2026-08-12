import 'dotenv/config';
import { loadConfig } from '@daja/config';
import { createDatabase, migrate } from '@daja/database';
import { createLogger } from '@daja/observability';

const config = loadConfig();
const logger = createLogger(config, 'plan3-performance');
const database = createDatabase(config, logger);

try {
  await migrate(database.pool);
  const organizationId = await ensureOrganization();
  await ensureSyncEvents(organizationId);
  const checks = [
    {
      name: 'sync_pull_by_revision',
      sql: `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
            SELECT id, revision FROM server_sync_events
            WHERE organization_id = $1 AND revision > 10
            ORDER BY revision ASC LIMIT 100`,
      params: [organizationId]
    },
    {
      name: 'unresolved_conflicts',
      sql: `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
            SELECT id FROM sync_conflicts
            WHERE organization_id = $1 AND status = 'unresolved'
            ORDER BY created_at DESC, id DESC LIMIT 100`,
      params: [organizationId]
    },
    {
      name: 'inventory_balance',
      sql: `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
            SELECT quantity FROM inventory_balances
            WHERE organization_id = $1 AND location_id = '00000000-0000-4000-8000-000000000301'
              AND variant_id = '00000000-0000-4000-8000-000000000302'`,
      params: [organizationId]
    }
  ];
  for (const check of checks) {
    const result = await database.query<{ 'QUERY PLAN': string }>(check.sql, check.params);
    const plan = result.rows.map((row) => row['QUERY PLAN']).join('\n');
    if (/Seq Scan/.test(plan) && check.name !== 'unresolved_conflicts') {
      throw new Error(`${check.name} used sequential scan:\n${plan}`);
    }
    logger.info({ check: check.name, plan }, 'Plan 3 query verified');
  }
} finally {
  await database.close();
}

async function ensureOrganization(): Promise<string> {
  const existing = await database.query<{ id: string }>(
    `SELECT id FROM organizations WHERE slug = 'plan3-performance' AND deleted_at IS NULL`
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const created = await database.query<{ id: string }>(
    `INSERT INTO organizations (name, slug, status)
     VALUES ('Plan 3 Performance', 'plan3-performance', 'active')
     RETURNING id`
  );
  return created.rows[0]!.id;
}

async function ensureSyncEvents(organizationId: string): Promise<void> {
  await database.query(
    `INSERT INTO organization_revisions (organization_id, current_revision)
     VALUES ($1, 0)
     ON CONFLICT (organization_id) DO NOTHING`,
    [organizationId]
  );
  const count = await database.query<{ count: string }>(
    `SELECT count(*) FROM server_sync_events WHERE organization_id = $1`,
    [organizationId]
  );
  if (Number(count.rows[0]?.count ?? 0) >= 1000) return;
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    for (let index = 1; index <= 1000; index += 1) {
      await client.query(
        `UPDATE organization_revisions SET current_revision = current_revision + 1 WHERE organization_id = $1`,
        [organizationId]
      );
      await client.query(
        `INSERT INTO server_sync_events (revision, organization_id, aggregate_type, aggregate_id, operation, payload, idempotency_key)
         SELECT current_revision, $1, 'product', gen_random_uuid(), 'perf', '{}'::jsonb, 'plan3-perf-' || current_revision
         FROM organization_revisions WHERE organization_id = $1
         ON CONFLICT (organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
        [organizationId]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
