import { config as loadEnvironment } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '@daja/config';
import { createDatabase, createRedisConnection, migrateWhenAvailable } from '@daja/database';
import { createLogger } from '@daja/observability';
import {
  createPlatformWorkers,
  FOUNDATION_QUEUE_NAME,
  POLICY_NOTIFICATION_QUEUE_NAME
} from './worker.js';

loadEnvironment({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const config = loadConfig();
const logger = createLogger(config, 'worker');
const redis = createRedisConnection(config, logger);
const database = createDatabase(config, logger);
await redis.ping();

// The mail consumer must be able to start while the API is stopped. Both
// processes share the migrator's advisory lock when a release starts them together.
await migrateWhenAvailable(database.pool);

const runtime = createPlatformWorkers(redis.client, database, config, logger);

let shutdownPromise: Promise<void> | undefined;

function shutdown(signal: string): Promise<void> {
  shutdownPromise ??= stop(signal);
  return shutdownPromise;
}

async function stop(signal: string): Promise<void> {
  logger.info({ signal }, 'Worker shutdown started');
  await runtime.close();
  await database.close();
  await redis.close();
  logger.info('Worker shutdown completed');
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM').then(() => process.exit(0));
});

process.on('SIGINT', () => {
  void shutdown('SIGINT').then(() => process.exit(0));
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled rejection');
  process.exitCode = 1;
});

logger.info(
  { queueNames: [FOUNDATION_QUEUE_NAME, 'media-processing', POLICY_NOTIFICATION_QUEUE_NAME], emailConsumer: 'database-outbox' },
  'DAJA worker listening'
);
