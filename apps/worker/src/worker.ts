import { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { QueueEvents, Worker, type Job, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import sharp from 'sharp';
import type { AppConfig } from '@daja/config';
import {
  MediaRepository,
  OutboxRepository,
  productMediaThumbnailStorageKey,
  TransactionManager,
  sha256,
  type Database
} from '@daja/database';
import type { Logger } from '@daja/observability';

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
      concurrency: 2,
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
  return {
    workers: [foundation.worker, mediaWorker, privacyWorker],
    queueEvents: [foundation.queueEvents, mediaEvents, privacyEvents],
    close: async () => {
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
  job: Job<{ deliveryId: string }>,
  database: Database,
  config: AppConfig,
  logger: Logger
): Promise<void> {
  if (job.name !== 'deliver-policy-change') {
    throw new Error(`Unsupported privacy notification job: ${job.name}`);
  }
  if (!config.SES_ACCESS_KEY_ID || !config.SES_SECRET_ACCESS_KEY || !config.SES_FROM_EMAIL) {
    throw new Error('Amazon SES is required for privacy-policy notifications');
  }
  const claimed = await database.pool.query<{
    id: string;
    recipient_email: string;
    version: string;
    change_summary: string;
    effective_at: Date;
  }>(
    `UPDATE policy_notification_deliveries delivery
     SET status = 'sending', attempts = attempts + 1, last_error = NULL
     FROM privacy_policy_publications publication
     WHERE delivery.id = $1
       AND delivery.publication_id = publication.id
       AND delivery.status <> 'sent'
     RETURNING delivery.id, delivery.recipient_email, publication.version,
               publication.change_summary, publication.effective_at`,
    [job.data.deliveryId]
  );
  const delivery = claimed.rows[0];
  if (!delivery) return;

  try {
    const policyUrl = `${config.STOREFRONT_PUBLIC_BASE_URL.replace(/\/$/, '')}/privacy`;
    const sender = dajaShopSender(config.SES_FROM_EMAIL);
    const client = new SESv2Client({
      region: config.SES_REGION,
      credentials: {
        accessKeyId: config.SES_ACCESS_KEY_ID,
        secretAccessKey: config.SES_SECRET_ACCESS_KEY
      }
    });
    await client.send(
      new SendEmailCommand({
        FromEmailAddress: sender,
        Destination: { ToAddresses: [delivery.recipient_email] },
        ReplyToAddresses: config.SES_REPLY_TO_EMAIL ? [config.SES_REPLY_TO_EMAIL] : undefined,
        Content: {
          Simple: {
            Subject: { Charset: 'UTF-8', Data: 'Važno obaveštenje o politici privatnosti | DajaShop' },
            Body: {
              Text: {
                Charset: 'UTF-8',
                Data: [
                  'Objavili smo bitnu izmenu politike privatnosti i kolačića.',
                  `Sažetak: ${delivery.change_summary}`,
                  `Verzija: ${delivery.version}`,
                  `Datum primene: ${delivery.effective_at.toLocaleDateString('sr-RS')}`,
                  '',
                  `Pročitajte dokument: ${policyUrl}`
                ].join('\n')
              },
              Html: {
                Charset: 'UTF-8',
                Data: policyEmailHtml({
                  version: delivery.version,
                  summary: delivery.change_summary,
                  effectiveAt: delivery.effective_at,
                  policyUrl
                })
              }
            }
          }
        },
        EmailTags: [{ Name: 'type', Value: 'privacy-policy-change' }]
      })
    );
    await database.pool.query(
      `UPDATE policy_notification_deliveries
       SET status = 'sent', sent_at = now(), last_error = NULL
       WHERE id = $1`,
      [delivery.id]
    );
    logger.info({ deliveryId: delivery.id, recipient: delivery.recipient_email }, 'Privacy policy email sent');
  } catch (error) {
    await database.pool.query(
      `UPDATE policy_notification_deliveries
       SET status = 'failed', last_error = $2
       WHERE id = $1`,
      [delivery.id, error instanceof Error ? error.message.slice(0, 2000) : 'Unknown email delivery error']
    );
    throw error;
  }
}

function policyEmailHtml(input: {
  version: string;
  summary: string;
  effectiveAt: Date;
  policyUrl: string;
}): string {
  return (
    '<!doctype html><html lang="sr"><body style="margin:0;background:#f6f6f6;font-family:Arial,sans-serif;color:#1f1f1f">' +
    '<main style="max-width:560px;margin:32px auto;background:#fff;padding:40px;border-radius:12px">' +
    '<h1 style="margin:0 0 16px;font-size:26px">Izmena politike privatnosti</h1>' +
    '<p style="font-size:16px;line-height:1.6">Objavili smo bitnu izmenu politike privatnosti i kolačića.</p>' +
    `<p style="font-size:16px;line-height:1.6"><strong>Sažetak:</strong> ${escapeHtml(input.summary)}</p>` +
    `<p style="font-size:14px;line-height:1.6;color:#666">Verzija ${escapeHtml(input.version)} · primena ${escapeHtml(input.effectiveAt.toLocaleDateString('sr-RS'))}</p>` +
    `<p style="margin:28px 0"><a href="${escapeHtml(input.policyUrl)}" style="display:inline-block;background:#111;color:#fff;padding:14px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Pogledajte politiku</a></p>` +
    '<p style="margin:28px 0 0;font-size:14px;color:#666">DajaShop</p></main></body></html>'
  );
}

function dajaShopSender(configuredSender: string): string {
  const match = configuredSender.match(/<([^>]+)>/);
  const address = (match?.[1] || configuredSender).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)
    ? `DajaShop <${address}>`
    : configuredSender;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    };
    return entities[character] ?? character;
  });
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
    // Thumbnails are only useful for the active hero image. Gallery items keep
    // their original asset and avoid needless R2 objects and image processing.
    const primary = await database.pool.query(
      `SELECT 1 FROM product_media
       WHERE organization_id = $1 AND media_asset_id = $2 AND is_primary
       LIMIT 1`,
      [organizationId, mediaId]
    );
    const targetWidths = primary.rowCount ? [512] : [];
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
      const key = productMediaThumbnailStorageKey({
        originalKey: asset.storage_key,
        organizationId,
        mediaId,
        width
      });
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
    const markedReady = await tx.run(async (pgClient) => {
      const ready = await new MediaRepository(pgClient).markReady({
        organizationId,
        mediaId,
        width: sourceWidth,
        height: sourceHeight,
        derivatives
      });
      if (!ready) return false;
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
      return true;
    });
    if (!markedReady) {
      await Promise.all(
        derivatives.map((derivative) =>
          client.send(new DeleteObjectCommand({ Bucket: config.R2_BUCKET, Key: derivative.storageKey }))
        )
      );
    }
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
