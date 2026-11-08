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
  prepareAvifMainImage,
  prepareRemainingImageVariants,
  productMediaVariantKeys,
  runMediaProcessing,
  mediaProcessingSignal,
  sha256,
  type Database,
  type MediaAssetRow
} from '@daja/database';
import { AppError } from '@daja/security';
import { CONFIG, DATABASE, LOGGER } from './tokens.js';
import { apiUnderLoad } from './runtime/abuse-protection.js';
import { enqueueCatalogDelivery } from './catalog-delivery.service.js';
import { LocalMediaPresence } from './local-media-presence.js';

type DerivativeJob = {
  organization_id: string;
  media_asset_id: string;
  source_key: string;
  source_checksum: string;
  avif_main_key: string;
  lease_token: string;
  attempts: number;
  local_worker: boolean;
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
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(LocalMediaPresence) private readonly presence: LocalMediaPresence
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
    const organizationId = this.config.PUBLIC_ORGANIZATION_ID;
    try {
      if (organizationId) await this.presence.renderHeartbeat(organizationId);
      const stopAt = nightWindowClosesAt();
      if (!stopAt || apiUnderLoad()) return;
      processed = await runMediaProcessing(this.config, () => this.processOne(), {
        background: true,
        stopAt
      });
      if (processed && organizationId) await this.presence.renderHeartbeat(organizationId, 'completed');
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'IMAGE_PROCESSING_BUSY')) {
        if (organizationId) await this.presence.renderHeartbeat(organizationId, 'error').catch(() => {});
        this.logger.warn({ err: error }, 'Overnight image queue will retry');
      }
    } finally {
      this.schedule(processed ? 1000 : 30_000);
    }
  }

  private async processOne(): Promise<boolean> {
    const token = randomUUID();
    // Use the same claim lock as the Windows worker. Release it before R2 or CPU work.
    const job = await new TransactionManager(this.db.pool, this.logger).run(async client => {
      if (this.config.PUBLIC_ORGANIZATION_ID) await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))', ['local-media:' + this.config.PUBLIC_ORGANIZATION_ID]
      );
      return (await client.query<DerivativeJob>(
        `UPDATE media_derivative_jobs j SET lease_until=now()+interval '5 minutes',
         lease_token=$1,lease_worker='render',
         attempts=j.attempts+CASE WHEN j.local_worker THEN 0 ELSE 1 END,
         render_attempts=j.render_attempts+CASE WHEN j.local_worker THEN 1 ELSE 0 END
       FROM (SELECT organization_id,media_asset_id FROM media_derivative_jobs
         WHERE available_at<=now()
         AND (NOT local_worker AND attempts<8 AND paused_at IS NULL OR local_worker AND render_attempts<8
              AND rendered_at IS NULL AND created_at<=now()-interval '7 days'
              AND (NOT $2::boolean OR NOT EXISTS (SELECT 1 FROM media_worker_settings s
                WHERE s.organization_id=media_derivative_jobs.organization_id
                AND s.pc_available_at>now()-interval '7 days'))
              AND NOT EXISTS (SELECT 1 FROM media_derivative_jobs active
                WHERE active.organization_id=media_derivative_jobs.organization_id AND active.local_worker AND active.lease_until>now()))
         AND (lease_until IS NULL OR lease_until<now())
         AND (now() AT TIME ZONE 'Europe/Belgrade')::time >= time '03:00'
         AND (now() AT TIME ZONE 'Europe/Belgrade')::time < time '07:00'
         ORDER BY available_at,created_at,media_asset_id LIMIT 1 FOR UPDATE SKIP LOCKED) candidate
       WHERE j.organization_id=candidate.organization_id AND j.media_asset_id=candidate.media_asset_id RETURNING j.*`,
        [token, Boolean(this.config.MEDIA_LOCAL_WORKER_TOKEN_HASH)]
      )).rows[0];
    });
    if (!job) return false;
    const parentDeadline = mediaProcessingSignal();
    const deadline = AbortSignal.any([AbortSignal.timeout(210_000), ...(parentDeadline ? [parentDeadline] : [])]);
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
      const source = await storage.getObject(job.source_key, deadline);
      if (sha256(source) !== job.source_checksum)
        throw new AppError('IMAGE_SOURCE_CHANGED', 'Deferred image source checksum mismatch', 409);
      const { webp, avifThumbnail } = await prepareRemainingImageVariants(source);
      const keys = productMediaVariantKeys(asset, token, 'render');
      // Record every candidate key before writing to R2, even if the API restarts mid-upload.
      const reserved = await new TransactionManager(this.db.pool, this.logger).run(async client => {
        const current = await client.query(
          `SELECT id FROM media_assets WHERE organization_id=$1 AND id=$2
           AND deleted_at IS NULL AND status='ready' AND storage_key=$3 FOR UPDATE`,
          [job.organization_id, job.media_asset_id, job.avif_main_key]
        );
        if (!current.rowCount) return false;
        await client.query(
          `INSERT INTO media_storage_deletions(organization_id,storage_key,media_asset_id,available_at)
           SELECT $1,key,$3,now()+interval '20 minutes' FROM unnest($2::text[]) AS files(key)
           ON CONFLICT DO NOTHING`,
          [job.organization_id, Object.values(keys), job.media_asset_id]
        );
        return true;
      });
      if (!reserved) {
        await this.cancelJob(job);
        return true;
      }
      const mainKey = keys.webp;
      const thumbKey = keys.webpThumb;
      const objects = [
        { key: mainKey, image: webp.original, mimeType: 'image/webp' },
        { key: thumbKey, image: webp.thumbnail, mimeType: 'image/webp' },
        { key: keys.avifThumb, image: avifThumbnail, mimeType: 'image/avif' }
      ];
      if (job.local_worker) {
        objects.push({ key: keys.avif, image: await prepareAvifMainImage(source), mimeType: 'image/avif' });
      } else {
        // Keep existing AVIF URLs and put a copy next to the WebP.
        created.add(keys.avif);
        await storage.copyObject(job.avif_main_key, keys.avif, deadline);
      }
      for (const object of objects) {
        created.add(object.key);
        await storage.putObject({
          key: object.key,
          body: object.image.data,
          contentType: object.mimeType,
          cacheControl: 'public, max-age=31536000, immutable'
        }, deadline);
      }
      deadline.throwIfAborted();
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
            ...(!job.local_worker ? [{
              storageKey: keys.avif,
              publicUrl: publicUrl(keys.avif),
              width: current.width!, height: current.height!, mimeType: 'image/avif',
              sizeBytes: Number(current.size_bytes),
              ...(current.checksum_sha256 ? { checksumSha256: current.checksum_sha256 } : {})
            },
            {
              storageKey: current.storage_key,
              publicUrl: publicUrl(current.storage_key),
              width: current.width!,
              height: current.height!,
              mimeType: 'image/avif',
              sizeBytes: Number(current.size_bytes),
              ...(current.checksum_sha256 ? { checksumSha256: current.checksum_sha256 } : {})
            }] : []),
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
          'DELETE FROM media_storage_deletions WHERE organization_id=$1 AND storage_key=ANY($2::text[])',
          [job.organization_id, Object.values(keys)]
        );
        if (job.local_worker) {
          // Keep the original for the PC. The four Render files stay live until
          // the PC publishes a complete replacement in a later transaction.
          await client.query(
            `UPDATE media_derivative_jobs SET rendered_at=now(),avif_main_key=$4,source_width=$5,source_height=$6,
             lease_token=NULL,lease_until=NULL,lease_worker=NULL,available_at=now(),attempts=0,paused_at=NULL,
             last_error_code=NULL,last_error_at=NULL WHERE organization_id=$1 AND media_asset_id=$2 AND lease_token=$3`,
            [job.organization_id, job.media_asset_id, token, mainKey, current.width, current.height]
          );
        } else {
          await client.query(
            'INSERT INTO media_storage_deletions(organization_id,storage_key) VALUES ($1,$2) ON CONFLICT DO NOTHING',
            [job.organization_id, job.source_key]
          );
          await client.query(
            'DELETE FROM media_derivative_jobs WHERE organization_id=$1 AND media_asset_id=$2 AND lease_token=$3',
            [job.organization_id, job.media_asset_id, token]
          );
        }
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
          `UPDATE media_derivative_jobs SET lease_until=NULL,lease_token=NULL,lease_worker=NULL,
         paused_at=CASE WHEN $5::text IS NOT NULL AND NOT local_worker AND attempts>=8 THEN now() ELSE paused_at END,
         attempts=CASE WHEN $5::text IS NULL AND NOT local_worker THEN greatest(attempts-1,0) ELSE attempts END,
         render_attempts=CASE WHEN $5::text IS NULL AND local_worker THEN greatest(render_attempts-1,0) ELSE render_attempts END,
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
