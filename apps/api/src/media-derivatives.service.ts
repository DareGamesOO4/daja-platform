import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { AppConfig } from '@daja/config';
import type { Logger } from '@daja/observability';
import type { SystemRequestContext } from '@daja/shared';
import {
  MediaRepository,
  mediaFailure,
  recordMediaFailure,
  resolveMediaFailures,
  R2MediaStorageAdapter,
  StorefrontRepository,
  TransactionManager,
  prepareRemainingImageVariants,
  runMediaProcessing,
  sha256,
  type Database,
  type MediaAssetRow
} from '@daja/database';
import { AppError } from '@daja/security';
import { CONFIG, DATABASE, LOGGER } from './tokens.js';
import { apiUnderLoad } from './runtime/abuse-protection.js';
import { enqueueCatalogDelivery } from './catalog-delivery.service.js';

type DerivativeJob = {
  organization_id: string;
  media_asset_id: string;
  source_key: string;
  source_checksum: string;
  avif_main_key: string;
  lease_token: string;
  attempts: number;
};

const clock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Belgrade',
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});

function nightWindowClosesAt(): number | undefined {
  const parts = clock.formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const hour = part('hour');
  if (hour < 3 || hour >= 7) return undefined;
  return Date.now() + ((7 - hour) * 3600 - part('minute') * 60 - part('second')) * 1000;
}

/** The deployed API consumes the durable queue; no extra paid Render service is required. */
@Injectable()
export class MediaDerivativesService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger
  ) {}

  onModuleInit() {
    this.schedule();
  }
  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(delay = 30_000) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delay);
    this.timer.unref();
  }

  private async tick() {
    let processed = false;
    try {
      const stopAt = nightWindowClosesAt();
      if (!stopAt || apiUnderLoad()) return;
      processed = await runMediaProcessing(this.config, () => this.processOne(), {
        background: true,
        stopAt
      });
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'IMAGE_PROCESSING_BUSY'))
        this.logger.warn({ err: error }, 'Overnight image queue will retry');
    } finally {
      this.schedule(processed ? 1000 : 30_000);
    }
  }

  private async processOne(): Promise<boolean> {
    const token = randomUUID();
    // One statement claims a row; no transaction/client is held during R2 or CPU work.
    const job = (
      await this.db.pool.query<DerivativeJob>(
        `UPDATE media_derivative_jobs j SET lease_until=now()+interval '5 minutes',
         lease_token=$1, attempts=j.attempts+1
       FROM (SELECT organization_id,media_asset_id FROM media_derivative_jobs
         WHERE available_at<=now() AND paused_at IS NULL AND attempts<8
         AND (lease_until IS NULL OR lease_until<now())
         AND (now() AT TIME ZONE 'Europe/Belgrade')::time >= time '03:00'
         AND (now() AT TIME ZONE 'Europe/Belgrade')::time < time '07:00'
         ORDER BY available_at,created_at,media_asset_id LIMIT 1 FOR UPDATE SKIP LOCKED) candidate
       WHERE j.organization_id=candidate.organization_id AND j.media_asset_id=candidate.media_asset_id RETURNING j.*`,
        [token]
      )
    ).rows[0];
    if (!job) return false;
    const ctx: SystemRequestContext = {
      organizationId: job.organization_id,
      requestId: token,
      correlationId: token,
      userId: null,
      roles: [],
      permissions: []
    };
    const storage = new R2MediaStorageAdapter(this.config);
    const created = new Set<string>();
    try {
      const asset = (
        await this.db.pool.query<MediaAssetRow>(
          `SELECT * FROM media_assets WHERE organization_id=$1 AND id=$2
         AND deleted_at IS NULL AND status='ready' AND storage_key=$3`,
          [job.organization_id, job.media_asset_id, job.avif_main_key]
        )
      ).rows[0];
      if (!asset) {
        await this.cancelJob(job);
        return true;
      }
      const source = await storage.getObject(job.source_key);
      if (sha256(source) !== job.source_checksum)
        throw new AppError('IMAGE_SOURCE_CHANGED', 'Deferred image source checksum mismatch', 409);
      const { webp, avifThumbnail } = await prepareRemainingImageVariants(source);
      const mainKey = job.avif_main_key.replace(
        /-avif65-webp75-main\.avif$/,
        `-${token}-avif65-webp75-main.webp`
      );
      const thumbKey = mainKey.replace(/-main\.webp$/, '-thumb.webp');
      const objects = [
        { key: mainKey, image: webp.original, mimeType: 'image/webp' },
        { key: thumbKey, image: webp.thumbnail, mimeType: 'image/webp' },
        { key: thumbKey.replace(/\.webp$/, '.avif'), image: avifThumbnail, mimeType: 'image/avif' }
      ];
      for (const object of objects) {
        created.add(object.key);
        await storage.putObject({
          key: object.key,
          body: object.image.data,
          contentType: object.mimeType,
          cacheControl: 'public, max-age=31536000, immutable'
        });
      }
      await new TransactionManager(this.db.pool, this.logger).run(async (client) => {
        // Gallery saves lock product before asset. Use that order too, so an
        // employee saving a product cannot deadlock with overnight publication.
        const products = await client.query<{ id: string; slug: string }>(
          `SELECT p.id,p.slug FROM products p WHERE p.organization_id=$1 AND p.deleted_at IS NULL
           AND EXISTS (SELECT 1 FROM product_media pm WHERE pm.organization_id=$1 AND pm.product_id=p.id AND pm.media_asset_id=$2)
           ORDER BY p.id FOR UPDATE`,
          [job.organization_id, job.media_asset_id]
        );
        const current = (
          await client.query<MediaAssetRow>(
            'SELECT * FROM media_assets WHERE organization_id=$1 AND id=$2 FOR UPDATE',
            [job.organization_id, job.media_asset_id]
          )
        ).rows[0];
        const owned = (
          await client.query(
            `SELECT 1 FROM media_derivative_jobs WHERE organization_id=$1 AND media_asset_id=$2
           AND lease_token=$3 AND lease_until>now() FOR UPDATE`,
            [job.organization_id, job.media_asset_id, token]
          )
        ).rowCount;
        if (
          !owned ||
          !current ||
          current.status !== 'ready' ||
          current.storage_key !== job.avif_main_key
        )
          throw new Error('Deferred image job is no longer current');
        const publicUrl = (key: string) => {
          const url = storage.publicUrl(key);
          if (!url) throw new Error('Media public URL is required');
          return url;
        };
        const original = objects[0]!;
        const updated = await new MediaRepository(client).markReady({
          ...ctx,
          mediaId: job.media_asset_id,
          width: webp.original.width,
          height: webp.original.height,
          original: {
            storageKey: mainKey,
            publicUrl: publicUrl(mainKey),
            mimeType: 'image/webp',
            sizeBytes: original.image.data.length,
            checksumSha256: sha256(original.image.data)
          },
          replaceDerivatives: true,
          derivatives: [
            {
              storageKey: current.storage_key,
              publicUrl: publicUrl(current.storage_key),
              width: current.width!,
              height: current.height!,
              mimeType: 'image/avif',
              sizeBytes: Number(current.size_bytes),
              ...(current.checksum_sha256 ? { checksumSha256: current.checksum_sha256 } : {})
            },
            ...objects.slice(1).map((object) => ({
              storageKey: object.key,
              publicUrl: publicUrl(object.key),
              width: object.image.width,
              height: object.image.height,
              mimeType: object.mimeType,
              sizeBytes: object.image.data.length,
              checksumSha256: sha256(object.image.data)
            }))
          ]
        });
        if (!updated) throw new Error('Deferred image was removed');
        await resolveMediaFailures(client, job.organization_id, job.media_asset_id, 'overnight');
        await client.query(
          `INSERT INTO media_storage_deletions(organization_id,storage_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [job.organization_id, job.source_key]
        );
        await client.query(
          'DELETE FROM media_derivative_jobs WHERE organization_id=$1 AND media_asset_id=$2 AND lease_token=$3',
          [job.organization_id, job.media_asset_id, token]
        );
        for (const product of products.rows) {
          await client.query(
            'UPDATE products SET updated_at=now() WHERE organization_id=$1 AND id=$2',
            [job.organization_id, product.id]
          );
          await new StorefrontRepository(client).refreshProductSnapshots({
            organizationId: job.organization_id,
            productId: product.id
          });
          await enqueueCatalogDelivery(client, ctx, product.id, [product.slug]);
        }
      });
      return true;
    } catch (error) {
      await new MediaRepository(this.db.pool)
        .cleanupAttempt(ctx, job.media_asset_id, storage, created)
        .catch(() => undefined);
      await new TransactionManager(this.db.pool, this.logger).run(async (client) => {
        await client.query(
          'SELECT id FROM media_assets WHERE organization_id=$1 AND id=$2 FOR UPDATE',
          [job.organization_id, job.media_asset_id]
        );
        const deferred = await client.query(
          `UPDATE media_derivative_jobs SET lease_until=NULL,lease_token=NULL,
         paused_at=CASE WHEN $5::text IS NOT NULL AND attempts>=8 THEN now() ELSE paused_at END,
         attempts=CASE WHEN $5::text IS NULL THEN greatest(attempts-1,0) ELSE attempts END,
         last_error_code=CASE WHEN $5::text IS NOT NULL THEN $5 ELSE last_error_code END,
         last_error_at=CASE WHEN $5::text IS NOT NULL THEN now() ELSE last_error_at END,
         available_at=now()+($4*interval '1 second') WHERE organization_id=$1 AND media_asset_id=$2 AND lease_token=$3`,
          [
            job.organization_id,
            job.media_asset_id,
            token,
            Math.min(3600, 30 * 2 ** Math.min(job.attempts, 7)),
            mediaFailure(error)?.code ?? null
          ]
        );
        if (deferred.rowCount)
          await recordMediaFailure(
            client,
            job.organization_id,
            job.media_asset_id,
            'overnight',
            error,
            token
          );
      });
      throw error;
    }
  }

  private async cancelJob(job: DerivativeJob) {
    await new TransactionManager(this.db.pool, this.logger).run(async (client) => {
      const removed = await client.query(
        'DELETE FROM media_derivative_jobs WHERE organization_id=$1 AND media_asset_id=$2 AND lease_token=$3 RETURNING source_key',
        [job.organization_id, job.media_asset_id, job.lease_token]
      );
      if (removed.rowCount) {
        await resolveMediaFailures(
          client,
          job.organization_id,
          job.media_asset_id,
          undefined,
          'removed'
        );
        await client.query(
          `INSERT INTO media_storage_deletions(organization_id,storage_key)
         SELECT $1,$2 WHERE NOT EXISTS (SELECT 1 FROM media_assets WHERE organization_id=$1 AND storage_key=$2 AND deleted_at IS NULL)
         ON CONFLICT DO NOTHING`,
          [job.organization_id, job.source_key]
        );
      }
    });
  }
}
