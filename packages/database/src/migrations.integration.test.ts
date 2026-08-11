import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate, migrationStatus, MigrationLockError } from './migrations.js';
import { createTestDatabase, resetDatabase } from '../test/helpers.js';
import type { Database } from './pool.js';

const MIGRATION_LOCK_ID = 74794652901801;

describe('migrations', () => {
  let database: Database;

  beforeAll(() => {
    database = createTestDatabase();
  });

  afterAll(async () => {
    await database.close();
  });

  it('applies all migrations from an empty database', async () => {
    await resetDatabase(database.pool);
    const status = await migrate(database.pool);
    expect(status.every((row) => row.applied)).toBe(true);
    expect(status.map((row) => row.version)).toEqual(['001', '002']);
  });

  it('does not rerun already applied migrations', async () => {
    await resetDatabase(database.pool);
    await migrate(database.pool);
    await migrate(database.pool);
    const rows = await database.query<{ count: string }>(
      'SELECT count(*) FROM schema_migrations WHERE version = $1',
      ['001']
    );
    expect(rows.rows[0]?.count).toBe('1');

    const status = await migrationStatus(database.pool);
    expect(status[0]?.applied).toBe(true);
  });

  it('fails when another process holds the migration advisory lock', async () => {
    await resetDatabase(database.pool);
    const locker = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await locker.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await expect(migrate(database.pool)).rejects.toBeInstanceOf(MigrationLockError);
    await locker.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    await locker.end();
  });
});
