import 'dotenv/config';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '@daja/config';
import { createDatabase, migrate } from '@daja/database';
import { createLogger } from '@daja/observability';

const config = loadConfig();
if (config.NODE_ENV === 'production') {
  throw new Error('Local backup restore drill refuses to run in production');
}

const logger = createLogger(config, 'backup-restore-drill');
const database = createDatabase(config, logger);
const backupPath = 'tmp/backup-restore-drill.sql';

try {
  await migrate(database.pool);
  await database.query(
    `INSERT INTO organizations (name, slug, status)
     VALUES ('Backup Drill', 'backup-drill-' || replace(gen_random_uuid()::text, '-', ''), 'active')`
  );
  mkdirSync('tmp', { recursive: true });
  writeFileSync(backupPath, dumpDatabase(config.DATABASE_URL));
  const checksum = createHash('sha256').update(readFileSync(backupPath)).digest('hex');
  const counts = await database.query(
    `SELECT
       (SELECT count(*)::integer FROM organizations) AS organizations,
       (SELECT count(*)::integer FROM products) AS products,
       (SELECT count(*)::integer FROM server_sync_events) AS sync_events`
  );
  console.log(JSON.stringify({ backupPath, checksum, counts: counts.rows[0] }));
} finally {
  await database.close();
}

function dumpDatabase(databaseUrl: string): Buffer {
  const local = spawnSync('pg_dump', [databaseUrl, '--schema=public'], { encoding: 'buffer' });
  if (!local.error && local.status === 0) {
    return local.stdout;
  }

  const url = new URL(databaseUrl);
  const databaseName = url.pathname.replace(/^\//, '');
  const user = decodeURIComponent(url.username);
  const viaDocker = execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'pg_dump',
      '-U',
      user,
      '-d',
      databaseName,
      '--schema=public'
    ],
    { encoding: 'buffer' }
  );
  return viaDocker;
}
