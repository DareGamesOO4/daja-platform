import { QueueEvents, Worker, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from '@daja/observability';

export const FOUNDATION_QUEUE_NAME = 'daja-foundation';

export interface FoundationWorkerRuntime {
  worker: Worker;
  queueEvents: QueueEvents;
  close(): Promise<void>;
}

export function createFoundationWorker(
  redis: Redis,
  logger: Logger,
  options: { queueName?: string; concurrency?: number } = {}
): FoundationWorkerRuntime {
  const queueName = options.queueName ?? FOUNDATION_QUEUE_NAME;
  const workerConnection = redis.duplicate();
  const eventsConnection = redis.duplicate();
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
      connection: workerConnection,
      concurrency: options.concurrency ?? 5,
      limiter: { max: 100, duration: 1000 },
      settings: {
        backoffStrategy: () => 5000
      }
    }
  );

  const queueEvents = new QueueEvents(queueName, { connection: eventsConnection });
  queueEvents.on('failed', ({ jobId, failedReason }) => {
    logger.error({ jobId, failedReason }, 'Queue job failed');
  });

  return {
    worker,
    queueEvents,
    close: async () => {
      await worker.close();
      await queueEvents.close();
      await workerConnection.quit();
      await eventsConnection.quit();
    }
  };
}

export const defaultRetryOptions: JobsOptions = {
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 5000
  },
  removeOnComplete: 1000,
  removeOnFail: 5000
};
