import 'dotenv/config';
import { loadConfig } from '@daja/config';
import { createRedisConnection } from '@daja/database';
import { createLogger } from '@daja/observability';
import { createFoundationWorker, FOUNDATION_QUEUE_NAME } from './worker.js';

const config = loadConfig();
const logger = createLogger(config, 'worker');
const redis = createRedisConnection(config, logger);
await redis.ping();

const runtime = createFoundationWorker(redis.client, logger);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Worker shutdown started');
  await runtime.close();
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

logger.info({ queueName: FOUNDATION_QUEUE_NAME }, 'DAJA worker listening');
