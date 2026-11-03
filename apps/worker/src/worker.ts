import { QueueEvents, Worker, type Job, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { AppConfig } from '@daja/config';
import { brandedEmail, emailEscape } from '@daja/shared';
import {
  MediaRepository,
  runMediaProcessing,
  enqueueEmail,
  OutboxRepository,
  R2MediaStorageAdapter,
  TransactionManager,
  type Database
} from '@daja/database';
import type { Logger } from '@daja/observability';
import { EmailWorker } from './email-worker.js';
import { ProductAlertWorker } from './product-alert-worker.js';

export const FOUNDATION_QUEUE_NAME = 'daja-foundation';
export const POLICY_NOTIFICATION_QUEUE_NAME = 'privacy-policy-notifications';

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
  const privacyConnection = redis.duplicate();
  const privacyEventsConnection = redis.duplicate();
  const mediaWorker = new Worker<{ organizationId: string; mediaId: string }>(
    'media-processing',
    (job) => processMediaJob(job, database, config, logger),
    {
      connection: mediaConnection,
      concurrency: 1,
      limiter: { max: 20, duration: 1000 }
    }
  );
  const mediaEvents = new QueueEvents('media-processing', { connection: mediaEventsConnection });
  mediaEvents.on('failed', ({ jobId, failedReason }) => {
    logger.error({ jobId, failedReason }, 'Media job failed');
  });
  const privacyWorker = new Worker<{ deliveryId: string }>(
    POLICY_NOTIFICATION_QUEUE_NAME,
    (job) => processPolicyNotificationJob(job, database, config, logger),
    {
      connection: privacyConnection,
      concurrency: 4,
      limiter: { max: 20, duration: 1000 }
    }
  );
  const privacyEvents = new QueueEvents(POLICY_NOTIFICATION_QUEUE_NAME, {
    connection: privacyEventsConnection
  });
  privacyEvents.on('failed', ({ jobId, failedReason }) => {
    logger.error({ jobId, failedReason }, 'Privacy-policy notification job failed');
  });
  const emailWorker = new EmailWorker(config, logger, database);
  emailWorker.start();
  const productAlertWorker = new ProductAlertWorker(config, logger, database);
  productAlertWorker.start();
  return {
    workers: [foundation.worker, mediaWorker, privacyWorker],
    queueEvents: [foundation.queueEvents, mediaEvents, privacyEvents],
    close: async () => {
      await emailWorker.close();
      await productAlertWorker.close();
      await privacyWorker.close();
      await privacyEvents.close();
      await privacyConnection.quit();
      await privacyEventsConnection.quit();
      await mediaWorker.close();
      await mediaEvents.close();
      await mediaConnection.quit();
      await mediaEventsConnection.quit();
      await foundation.close();
    }
  };
}

async function processPolicyNotificationJob(
  job: Job<{ deliveryId: string }>, database: Database, config: AppConfig, logger: Logger
): Promise<void> {
  if (job.name !== 'deliver-policy-change') throw new Error('Unsupported privacy notification job');
  await new TransactionManager(database.pool, logger).run(async client => {
    const claimed = await client.query<{ id: string; organization_id: string; recipient_email: string; version: string;
      change_summary: string; effective_at: Date }>(
      `UPDATE policy_notification_deliveries delivery SET status = 'sending', attempts = attempts + 1, last_error = NULL
       FROM privacy_policy_publications publication
       WHERE delivery.id = $1 AND delivery.publication_id = publication.id AND delivery.status <> 'sent'
         AND NOT EXISTS (SELECT 1 FROM email_deliveries d
           WHERE d.deduplication_key = 'privacy:' || delivery.id::text || ':' || lower(delivery.recipient_email))
       RETURNING delivery.id, publication.organization_id, delivery.recipient_email, publication.version, publication.change_summary, publication.effective_at`,
      [job.data.deliveryId]);
    const delivery = claimed.rows[0];
    if (!delivery) return;
    const policyUrl = new URL('/privacy', config.STOREFRONT_PUBLIC_BASE_URL).toString();
    await enqueueEmail(client, {
      organizationId: delivery.organization_id,
      recipients: [delivery.recipient_email], fromEmail: dajaShopSender(config.SES_FROM_EMAIL),
      replyTo: config.SES_REPLY_TO_EMAIL ? [config.SES_REPLY_TO_EMAIL] : [],
      subject: 'Važno obaveštenje o politici privatnosti | DajaShop',
      text: ['Objavili smo bitnu izmenu politike privatnosti i kolačića.', 'Sažetak: ' + delivery.change_summary,
        'Verzija: ' + delivery.version, 'Pročitajte dokument: ' + policyUrl].join('\n'),
      html: brandedEmail({ siteUrl: config.STOREFRONT_PUBLIC_BASE_URL, eyebrow: 'VAŽNO OBAVEŠTENJE',
        title: 'Izmena politike privatnosti', content: '<p>Objavili smo bitnu izmenu politike privatnosti i kolačića.</p><p><strong>Sažetak:</strong> ' +
          emailEscape(delivery.change_summary) + '</p><p>Verzija ' + emailEscape(delivery.version) + ' · primena ' +
          emailEscape(delivery.effective_at.toLocaleDateString('sr-RS')) + '</p>',
        button: { label: 'Pogledajte politiku', url: policyUrl } }),
      tag: 'privacy-policy-change', deduplicationKey: 'privacy:' + delivery.id, policyDeliveryId: delivery.id
    });
    logger.info({ deliveryId: delivery.id }, 'Privacy policy email queued');
  });
}

function dajaShopSender(configuredSender: string): string {
  const match = configuredSender.match(/<([^>]+)>/);
  const address = (match?.[1] || configuredSender).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)
    ? `DajaShop <${address}>`
    : configuredSender;
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
  return runMediaProcessing(config, async () => {
    const storage = new R2MediaStorageAdapter(config);
    const createdKeys = new Set<string>();
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
      const prepared = await new MediaRepository(database.pool).stageUploadedImage({ organizationId }, mediaId, storage, createdKeys);
      const result = await tx.run(async pgClient => {
        const result = await new MediaRepository(pgClient).optimizeUploadedImage(
          { organizationId }, mediaId, storage, createdKeys, undefined, prepared
        );
        await new OutboxRepository(pgClient).append({
          ctx: { organizationId }, eventType: 'MediaReady', aggregateType: 'media_asset', aggregateId: mediaId,
          payload: { mediaId, publicUrl: result.publicUrl, thumbnailUrl: result.thumbnailUrl }
        });
        return result;
      });
      createdKeys.clear();
      for (const key of result.obsoleteStorageKeys) {
        await storage.deleteObject(key).catch(error =>
          logger.warn({ error, mediaId, key }, 'Could not remove source upload after image optimization'));
      }
    } catch (error) {
      await new MediaRepository(database.pool).cleanupAttempt({ organizationId }, mediaId, storage, createdKeys).catch(() => undefined);
      await tx.run((pgClient) =>
        new MediaRepository(pgClient).markFailed(
          organizationId,
          mediaId,
          error instanceof Error ? error.message : 'Unknown media processing failure'
        )
      );
      throw error;
    }
  });
}
