import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { fileURLToPath } from 'node:url';

const MIGRATION_LOCK_ID = 74794652901801;

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrationStatus {
  version: string;
  name: string;
  checksum: string;
  applied: boolean;
  appliedAt: Date | null;
}

export class MigrationLockError extends Error {
  constructor() {
    super('Another migration process already holds the PostgreSQL advisory lock');
  }
}

export function defaultMigrationsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../migrations');
}

export async function readMigrations(dir = defaultMigrationsDir()): Promise<MigrationFile[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort();
  return Promise.all(
    files.map(async (file) => {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const match = /^(\d+)_(.+)\.sql$/.exec(file);
      if (!match) {
        throw new Error(`Invalid migration filename: ${file}`);
      }
      const [, version, name] = match;
      if (!version || !name) {
        throw new Error(`Invalid migration filename: ${file}`);
      }
      return {
        version,
        name,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex')
      };
    })
  );
}

export async function migrationStatus(pool: pg.Pool): Promise<MigrationStatus[]> {
  const migrations = await readMigrations();
  await ensureHistoryTable(pool);
  const applied = await pool.query<{
    version: string;
    name: string;
    checksum: string;
    applied_at: Date;
  }>('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC');
  const appliedByVersion = new Map(applied.rows.map((row) => [row.version, row]));

  return migrations.map((migration) => {
    const row = appliedByVersion.get(migration.version);
    if (row && row.checksum !== migration.checksum) {
      throw new Error(`Checksum mismatch for migration ${migration.version}`);
    }
    return {
      version: migration.version,
      name: migration.name,
      checksum: migration.checksum,
      applied: Boolean(row),
      appliedAt: row?.applied_at ?? null
    };
  });
}

export async function migrate(pool: pg.Pool): Promise<MigrationStatus[]> {
  const client = await pool.connect();
  try {
    const locked = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [MIGRATION_LOCK_ID]
    );
    if (locked.rows[0]?.locked !== true) {
      throw new MigrationLockError();
    }

    await ensureHistoryTable(client);
    const migrations = await readMigrations();
    for (const migration of migrations) {
      const existing = await client.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE version = $1',
        [migration.version]
      );
      if (existing.rowCount === 1) {
        if (existing.rows[0]?.checksum !== migration.checksum) {
          throw new Error(`Checksum mismatch for migration ${migration.version}`);
        }
        continue;
      }

      await client.query(migration.sql);
      await client.query(
        'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [migration.version, migration.name, migration.checksum]
      );
    }

    return migrationStatus(pool);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

async function ensureHistoryTable(client: Pick<pg.Pool | pg.PoolClient, 'query'>): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}
