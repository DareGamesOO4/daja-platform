import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { QueueEvents, Worker, type Job, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import sharp from 'sharp';
import type { AppConfig } from '@daja/config';
import {
  MediaRepository,
  OutboxRepository,
  TransactionManager,
  sha256,
  type Database
} from '@daja/database';
import type { Logger } from '@daja/observability';

export const FOUNDATION_QUEUE_NAME = 'daja-foundation';

export interface FoundationWorkerRuntime {
  worker: Worker;
  queueEvents: QueueEvents;
  close(): Promise<void>;
}

export interface WorkerRuntime {
  workers: Worker[];
  queueEvents: QueueEvents[];
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

export function createPlatformWorkers(
  redis: Redis,
  database: Database,
  config: AppConfig,
  logger: Logger
): WorkerRuntime {
  const foundation = createFoundationWorker(redis, logger);
  const mediaConnection = redis.duplicate();
  const mediaEventsConnection = redis.duplicate();
  const mediaWorker = new Worker<{ organizationId: string; mediaId: string }>(
    'media-processing',
    (job) => processMediaJob(job, database, config, logger),
    {
      connection: mediaConnection,
      concurrency: 2,
      limiter: { max: 20, duration: 1000 }
    }
  );
  const mediaEvents = new QueueEvents('media-processing', { connection: mediaEventsConnection });
  mediaEvents.on('failed', ({ jobId, failedReason }) => {
    logger.error({ jobId, failedReason }, 'Media job failed');
  });
  return {
    workers: [foundation.worker, mediaWorker],
    queueEvents: [foundation.queueEvents, mediaEvents],
    close: async () => {
      await mediaWorker.close();
      await mediaEvents.close();
      await mediaConnection.quit();
      await mediaEventsConnection.quit();
      await foundation.close();
    }
  };
}

async function processMediaJob(
  job: Job<{ organizationId: string; mediaId: string }>,
  database: Database,
  config: AppConfig,
  logger: Logger
): Promise<void> {
  if (job.name !== 'process-media') {
    throw new Error(`Unsupported media job: ${job.name}`);
  }
  const { organizationId, mediaId } = job.data;
  if (
    !config.R2_BUCKET ||
    !config.R2_ACCOUNT_ID ||
    !config.R2_ACCESS_KEY_ID ||
    !config.R2_SECRET_ACCESS_KEY
  ) {
    throw new Error('R2 credentials are required for media processing');
  }
  const client = new S3Client({
    region: 'auto',
    endpoint: config.R2_ENDPOINT || `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    forcePathStyle: Boolean(config.R2_ENDPOINT),
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY
    }
  });
  const tx = new TransactionManager(database.pool, logger);
  const asset = await tx.run(async (pgClient) =>
    new MediaRepository(pgClient).markProcessing({ organizationId }, mediaId)
  );
  try {
    if (!asset.mime_type.startsWith('image/')) {
      await tx.run((pgClient) =>
        new MediaRepository(pgClient).markReady({
          organizationId,
          mediaId,
          width: asset.width ?? 1,
          height: asset.height ?? 1,
          derivatives: []
        })
      );
      return;
    }
    const original = await client.send(
      new GetObjectCommand({ Bucket: config.R2_BUCKET, Key: asset.storage_key })
    );
    const originalBuffer = await streamToBuffer(original.Body);
    const metadata = await sharp(originalBuffer, { limitInputPixels: 80_000_000 }).metadata();
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width > 12_000 ||
      metadata.height > 12_000
    ) {
      throw new Error('Image dimensions are unsupported');
    }
    const sourceWidth = metadata.width;
    const sourceHeight = metadata.height;
    const targetWidths = [1024, 512, 256].filter((width) => width <= sourceWidth);
    const derivatives: Array<{
      width: number;
      height: number;
      mimeType: string;
      storageKey: string;
      publicUrl: string;
      sizeBytes: number;
      checksumSha256: string;
    }> = [];
    for (const width of targetWidths) {
      const output = await sharp(originalBuffer, { limitInputPixels: 80_000_000 })
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer({ resolveWithObject: true });
      const key = `org/${organizationId}/media/${mediaId}/derivatives/${width}.webp`;
      await client.send(
        new PutObjectCommand({
          Bucket: config.R2_BUCKET,
          Key: key,
          Body: output.data,
          ContentType: 'image/webp',
          CacheControl: 'public, max-age=31536000, immutable'
        })
      );
      derivatives.push({
        width: output.info.width,
        height: output.info.height,
        mimeType: 'image/webp',
        storageKey: key,
        publicUrl: `${config.MEDIA_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`,
        sizeBytes: output.data.length,
        checksumSha256: sha256(output.data)
      });
    }
    await tx.run(async (pgClient) => {
      await new MediaRepository(pgClient).markReady({
        organizationId,
        mediaId,
        width: sourceWidth,
        height: sourceHeight,
        derivatives
      });
      await new OutboxRepository(pgClient).append({
        ctx: { organizationId },
        eventType: 'MediaReady',
        aggregateType: 'media_asset',
        aggregateId: mediaId,
        payload: {
          mediaId,
          derivatives: derivatives.map((item) => ({ width: item.width, publicUrl: item.publicUrl }))
        }
      });
    });
  } catch (error) {
    await tx.run((pgClient) =>
      new MediaRepository(pgClient).markFailed(
        organizationId,
        mediaId,
        error instanceof Error ? error.message : 'Unknown media processing failure'
      )
    );
    throw error;
  }
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      } else if (typeof chunk === 'string' || chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk));
      } else {
        throw new Error('Unsupported S3 stream chunk');
      }
    }
    return Buffer.concat(chunks);
  }
  throw new Error('Unsupported S3 body stream');
}
