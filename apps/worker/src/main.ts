import { QueueEvents, Worker } from 'bullmq';
import { loadConfig } from '@daja/config';
import { createRedisConnection } from '@daja/database';
import { createLogger } from '@daja/observability';

const config = loadConfig();
const logger = createLogger(config, 'worker');
const redis = createRedisConnection(config, logger);
await redis.ping();

const queueName = 'daja-foundation';
const worker = new Worker(
  queueName,
  (job) => {
    const startedAt = Date.now();
    try {
      throw new Error(`Unsupported production job: ${job.name}`);
    } finally {
      logger.info(
        { jobId: job.id, jobName: job.name, durationMs: Date.now() - startedAt },
        'Queue job finished processing attempt'
      );
    }
  },
  {
    connection: redis.client,
    concurrency: 5,
    limiter: { max: 100, duration: 1000 },
    settings: {
      backoffStrategy: () => 5000
    }
  }
);

const queueEvents = new QueueEvents(queueName, { connection: redis.client });
queueEvents.on('failed', ({ jobId, failedReason }) => {
  logger.error({ jobId, failedReason }, 'Queue job failed');
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Worker shutdown started');
  await worker.close();
  await queueEvents.close();
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

logger.info({ queueName }, 'DAJA worker listening');
