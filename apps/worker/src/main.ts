import { config as loadEnvironment } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '@daja/config';
import { createDatabase, createRedisConnection } from '@daja/database';
import { createLogger } from '@daja/observability';
import { createPlatformWorkers, FOUNDATION_QUEUE_NAME } from './worker.js';

loadEnvironment({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const config = loadConfig();
const logger = createLogger(config, 'worker');
const redis = createRedisConnection(config, logger);
const database = createDatabase(config, logger);
await redis.ping();

const runtime = createPlatformWorkers(redis.client, database, config, logger);

async function shutdown(signal: string): Promise<void> {
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

logger.info({ queueNames: [FOUNDATION_QUEUE_NAME, 'media-processing'] }, 'DAJA worker listening');
