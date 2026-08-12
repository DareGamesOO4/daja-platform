import 'dotenv/config';
import { access } from 'node:fs/promises';
import { loadConfig } from '@daja/config';
import {
  createDatabase,
  createRedisConnection,
  migrationStatus,
  R2MediaStorageAdapter
} from '@daja/database';
import { createLogger } from '@daja/observability';

const config = loadConfig();
const logger = createLogger({ ...config, LOG_LEVEL: 'silent' }, 'preflight-production');
const database = createDatabase(config, logger);
const redis = createRedisConnection(config, logger);

try {
  await access('apps/api/dist/main.js');
  await access('apps/worker/dist/main.js');
  await database.query('SELECT 1');
  const status = await migrationStatus(database.pool);
  const pending = status.filter((item) => !item.applied);
  if (pending.length > 0) {
    throw new Error(`Pending migrations: ${pending.map((item) => item.name).join(', ')}`);
  }
  await redis.ping();
  if (config.NODE_ENV === 'production') {
    new R2MediaStorageAdapter(config);
    if (!config.MEDIA_PUBLIC_BASE_URL) {
      throw new Error('MEDIA_PUBLIC_BASE_URL is required in production');
    }
    if (!config.PUBLIC_ORGANIZATION_ID) {
      throw new Error(
        'PUBLIC_ORGANIZATION_ID is required for public catalog/RFID production routes'
      );
    }
  }
  console.log('production preflight passed');
} finally {
  await redis.close().catch(() => undefined);
  await database.close();
}
