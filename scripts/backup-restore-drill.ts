import 'dotenv/config';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { databaseConnectionOptions } from '@daja/database';

// This command reads the source and restores only into an explicitly named,
// empty local database. It never migrates, seeds, cleans or drops the source.
async function main() {
  const sourceUrl = process.env.BACKUP_SOURCE_DATABASE_URL || process.env.DATABASE_URL;
  const targetUrl = process.env.BACKUP_RESTORE_DATABASE_URL;
  if (!sourceUrl || !targetUrl) throw new Error('Explicit source and restore URLs are required');
  const source = new URL(sourceUrl);
  const target = new URL(targetUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if (
    !local ||
    !/^\/daja_restore_[a-z0-9_]+$/.test(target.pathname) ||
    (source.hostname === target.hostname &&
      source.port === target.port &&
      source.pathname === target.pathname)
  ) {
    throw new Error('Restore target must be a separate local daja_restore_* database');
  }
  for (const binary of ['pg_dump', 'pg_restore']) {
    const result = spawnSync(binary, ['--version'], { stdio: 'ignore', windowsHide: true });
    if (result.error || result.status !== 0)
      throw new Error('PostgreSQL backup tools are unavailable');
  }
  const sourceClient = new pg.Client({
    ...databaseConnectionOptions(sourceUrl),
    connectionTimeoutMillis: 5000
  });
  const targetClient = new pg.Client({
    ...databaseConnectionOptions(targetUrl),
    connectionTimeoutMillis: 5000
  });
  try {
    await sourceClient.connect();
    await targetClient.connect();
    const existing =
      await targetClient.query<{ count: number }>(`SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p','v','m','S') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'`);
    if (Number(existing.rows[0]?.count) !== 0) throw new Error('Restore target must be empty');
    await sourceClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (
      await sourceClient.query<{ snapshot: string }>('SELECT pg_export_snapshot() AS snapshot')
    ).rows[0]!.snapshot;
    const expected = await counts(sourceClient);
    mkdirSync('tmp', { recursive: true });
    const backupPath = resolve('tmp', `restore-drill-${Date.now()}.dump`);
    run(
      'pg_dump',
      ['--format=custom', '--no-owner', '--no-acl', '--snapshot', snapshot, '--file', backupPath],
      source
    );
    await sourceClient.query('ROLLBACK');
    run(
      'pg_restore',
      [
        '--no-owner',
        '--no-acl',
        '--exit-on-error',
        '--single-transaction',
        '--dbname',
        decodeURIComponent(target.pathname.slice(1)),
        backupPath
      ],
      target
    );
    const restored = await counts(targetClient);
    if (JSON.stringify(expected) !== JSON.stringify(restored))
      throw new Error('Restored row counts differ');
    const checksum = createHash('sha256').update(readFileSync(backupPath)).digest('hex');
    const report = {
      backupPath,
      checksum,
      restored: true,
      tables: Object.keys(expected).length,
      counts: restored
    };
    writeFileSync(`${backupPath}.report.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ checksum, restored: true, tables: report.tables }));
  } finally {
    await sourceClient.end().catch(() => undefined);
    await targetClient.end().catch(() => undefined);
  }
}

async function counts(client: pg.Client): Promise<Record<string, string>> {
  const tables = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
  );
  const result: Record<string, string> = {};
  for (const { tablename } of tables.rows) {
    const identifier = '"' + tablename.replaceAll('"', '""') + '"';
    result[tablename] = (
      await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM public.${identifier}`
      )
    ).rows[0]!.count;
  }
  return result;
}

function run(binary: string, args: string[], url: URL) {
  const tls = databaseConnectionOptions(url.toString()).ssl;
  const result = spawnSync(binary, args, {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
      PGPORT: url.port || '5432',
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGSSLMODE: tls ? 'verify-full' : 'disable',
      PGSSLROOTCERT: tls ? 'system' : '',
      PGCONNECT_TIMEOUT: '5'
    }
  });
  if (result.error || result.status !== 0)
    throw new Error('PostgreSQL backup/restore command failed');
}

main().catch(() => {
  // Raw CLI/database failures can contain connection strings or SQL data.
  console.error(
    'Backup/restore drill failed. Check tool availability, configuration and the isolated restore database.'
  );
  process.exitCode = 1;
});
