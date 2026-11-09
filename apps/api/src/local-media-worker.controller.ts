import { randomUUID } from 'node:crypto';
import { Body, Controller, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import type { AppConfig } from '@daja/config';
import {
  MediaRepository, R2MediaStorageAdapter, StorefrontRepository, TransactionManager,
  productMediaVariantKeys, resolveMediaFailures, sha256, type Database, type MediaAssetRow
} from '@daja/database';
import type { Logger } from '@daja/observability';
import { AppError, AuthenticationRequiredError, ValidationFailedError } from '@daja/security';
import type { SystemRequestContext } from '@daja/shared';
import { defaultMediaWorkerProfile, mediaWorkerProfileSchema } from '@daja/validation';
import { equalSecret } from './runtime/edge-ingress.js';
import { CONFIG, DATABASE, LOGGER } from './tokens.js';
import { enqueueCatalogDelivery } from './catalog-delivery.service.js';
import { inspectLocalMediaSource } from './local-media-source.js';
import { LocalMediaPresence } from './local-media-presence.js';
import { apiUnderLoad } from './runtime/abuse-protection.js';
import { claimLocalLinkel, completeLocalLinkel, localLinkelQueueStatus } from './supplier-queue.js';

const variants = ['avif', 'webp', 'avifThumb', 'webpThumb'] as const;
type Variant = typeof variants[number];
const mime = (variant: Variant) => variant.startsWith('avif') ? 'image/avif' : 'image/webp';
const completeSchema = z.object({
  id: z.uuid(),
  leaseToken: z.uuid(),
  files: z.array(z.object({
    variant: z.enum(variants),
    width: z.number().int().min(1).max(2048),
    height: z.number().int().min(1).max(2048),
    maxSize: z.number().int().min(1).max(2048).optional(),
    bytes: z.number().int().min(1).max(25 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  })).length(4)
}).refine(value => new Set(value.files.map(file => file.variant)).size === variants.length);

type Job = { media_asset_id: string; source_key: string; source_checksum: string; lease_until: Date; asset: MediaAssetRow };
type VerifiedFile = Awaited<ReturnType<typeof inspectLocalMediaSource>> & {
  variant: Variant; storageKey: string; publicUrl: string;
};

@Controller('media/local-worker')
export class LocalMediaWorkerController {
  private verifying = false;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(LocalMediaPresence) private readonly presence: LocalMediaPresence
  ) {}

  private authenticate(request: Request): string {
    const match = /^Bearer ([A-Za-z0-9._~-]{32,128})$/.exec(request.headers.authorization ?? '');
    const organization = this.config.PUBLIC_ORGANIZATION_ID;
    if (!organization || !match?.[1] || !equalSecret(sha256(Buffer.from(match[1])), this.config.MEDIA_LOCAL_WORKER_TOKEN_HASH)) {
      throw new AuthenticationRequiredError();
    }
    return organization;
  }

  @Post('status')
  async status(@Req() request: Request, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const organizationId = this.authenticate(request);
    response.setHeader('Cache-Control', 'no-store');
    const report = z.object({ studio: z.object({
      imageError: z.string().max(220).nullable(),
      linkelError: z.string().max(220).nullable()
    }).optional() }).safeParse(body ?? {});
    if (!report.success) throw new ValidationFailedError('Invalid Studio status');
    if (report.data.studio) {
      await this.presence.studioHeartbeat(organizationId, report.data.studio.imageError);
    }
    const { renderOnline, renderSeenAt, renderCompletedAt, renderErrorAt } = await this.presence.status(organizationId);
    return { renderOnline, renderSeenAt, renderCompletedAt, renderErrorAt };
  }

  @Post('linkel/claim')
  async claimLinkel(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const organizationId = this.authenticate(request);
    response.setHeader('Cache-Control', 'no-store');
    const job = await claimLocalLinkel(this.db.pool, organizationId);
    // A status lookup must never prevent delivery of an already reserved lease.
    if (job) {
      response.setHeader('X-Daja-Linkel-Wait-Ms', '3000');
      return job;
    }
    const queue = await localLinkelQueueStatus(this.db.pool, organizationId);
    response.setHeader('X-Daja-Linkel-Wait-Ms', String(queue.wait_ms));
    response.setHeader('X-Daja-Linkel-State', queue.state);
    if (queue.next_at) response.setHeader('X-Daja-Linkel-Next-At', queue.next_at.toISOString());
    response.status(204);
  }

  @Post('linkel/rapid-start')
  async rapidStartLinkel(@Req() request: Request) {
    this.authenticate(request);
    throw new ValidationFailedError('Linkel radi po sedmodnevnom rasporedu. Za pojedinačni artikal koristi „Proveri sada“.');
  }

  @Post('linkel/complete')
  async completeLinkel(@Req() request: Request, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const organizationId = this.authenticate(request);
    const parsed = z.object({
      token: z.uuid(), homeHealthy: z.boolean(), blocked: z.boolean(),
      duration: z.number().int().min(0).max(90_000),
      outcome: z.discriminatedUnion('status', [
        z.object({ status: z.literal('available'), stockStatus: z.enum(['in_stock', 'out_of_stock']).nullable(),
          priceAmount: z.number().min(0).max(100_000_000), priceCurrency: z.literal('RSD') }),
        z.object({ status: z.literal('missing') }),
        z.object({ status: z.literal('error'), accessFailed: z.boolean() })
      ])
    }).safeParse(body);
    if (!parsed.success) throw new ValidationFailedError('Invalid Linkel result');
    const { token, outcome, homeHealthy, blocked, duration } = parsed.data;
    await completeLocalLinkel(this.db, organizationId, token, outcome, homeHealthy, blocked, duration);
    response.status(204);
  }

  @Post('queue')
  async queue(@Req() request: Request, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const organizationId = this.authenticate(request);
    const parsed = z.object({ page: z.number().int().min(0).max(10000) }).safeParse(body);
    if (!parsed.success) throw new ValidationFailedError('Invalid queue page');
    response.setHeader('Cache-Control', 'no-store');
    const { rows } = await this.db.pool.query<{
      id: string; slug: string | null; image: string | null; attempts: number; state: string;
      size: string; source_key: string; source_checksum: string; total: number;
    }>(
      `SELECT a.id, a.metadata->>'productSlug' AS slug, a.metadata->>'imageIndex' AS image,
        a.size_bytes AS size, j.attempts, j.source_key, j.source_checksum, count(*) OVER ()::int AS total,
        CASE WHEN j.lease_until>now() THEN 'active' WHEN j.paused_at IS NOT NULL OR j.attempts>=16 THEN 'paused'
          WHEN j.attempts>=8 THEN 'fallback' WHEN j.available_at>now() THEN 'retry' ELSE 'waiting' END AS state
       FROM media_derivative_jobs j JOIN media_assets a ON a.organization_id=j.organization_id AND a.id=j.media_asset_id
       WHERE j.organization_id=$1 AND j.local_worker AND a.status='ready' AND a.deleted_at IS NULL AND a.storage_key=j.avif_main_key
       ORDER BY COALESCE(j.lease_until>now(), false) DESC, j.available_at, j.created_at, a.id LIMIT 8 OFFSET $2`,
      [organizationId, parsed.data.page * 8]
    );
    const storage = new R2MediaStorageAdapter(this.config);
    return {
      total: rows[0]?.total ?? 0,
      items: await Promise.all(rows.map(async row => ({
        id: row.id, slug: row.slug, image: row.image, attempts: row.attempts, state: row.state, bytes: Number(row.size),
        key: row.id + ':' + row.source_checksum,
        preview: (await storage.createPresignedGet({ key: row.source_key })).downloadUrl
      })))
    };
  }

  @Post('claim')
  async claim(@Req() request: Request, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const organizationId = this.authenticate(request);
    const protocol = z.object({ profile: z.literal('avif95-v1'), managed: z.boolean().optional() }).safeParse(body);
    if (!protocol.success) {
      throw new ValidationFailedError('Unsupported worker profile');
    }
    response.setHeader('Cache-Control', 'no-store');
    const storage = new R2MediaStorageAdapter(this.config);
    const token = randomUUID();
    const job = await new TransactionManager(this.db.pool, this.logger).run(async client => {
      // Serialize claims per organization. Only one PC job may be outstanding.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['local-media:' + organizationId]);
      const saved = (await client.query<{ profile: unknown }>(
        'SELECT profile FROM media_worker_settings WHERE organization_id=$1', [organizationId]
      )).rows[0]?.profile;
      const profile = mediaWorkerProfileSchema.safeParse(saved).data ?? defaultMediaWorkerProfile;
      await client.query(
        `INSERT INTO media_worker_settings(organization_id,pc_seen_at,pc_available_at)
         VALUES($1,now(),CASE WHEN NOT $2::boolean THEN now() END)
         ON CONFLICT(organization_id) DO UPDATE SET pc_seen_at=now(),
         pc_available_at=CASE WHEN NOT $2 THEN now() ELSE media_worker_settings.pc_available_at END
         WHERE media_worker_settings.pc_seen_at IS NULL OR media_worker_settings.pc_seen_at<now()-interval '15 seconds'
         OR (NOT $2 AND media_worker_settings.pc_available_at IS NULL)`,
        [organizationId, profile.paused]
      );
      if (profile.paused) return { paused: true } as const;
      const claimed = (await client.query<Job>(
        'WITH candidate AS (' +
        ' SELECT j.media_asset_id FROM media_derivative_jobs j JOIN media_assets a ON a.id=j.media_asset_id AND a.organization_id=j.organization_id' +
        ' WHERE j.organization_id=$1 AND j.local_worker AND j.available_at<=now() AND j.paused_at IS NULL AND j.attempts<8' +
        ' AND (j.rendered_at IS NULL OR $3::boolean)' +
        ' AND (j.lease_until IS NULL OR j.lease_until<=now()) AND a.status=' + "'ready'" + ' AND a.deleted_at IS NULL AND a.storage_key=j.avif_main_key' +
        ' AND NOT EXISTS (SELECT 1 FROM media_derivative_jobs active WHERE active.organization_id=$1 AND active.local_worker AND active.lease_until>now())' +
        ' ORDER BY j.available_at,j.created_at,j.media_asset_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED' +
        ') UPDATE media_derivative_jobs j SET lease_until=now()+interval ' + "'5 minutes'" + ",lease_token=$2,lease_worker='pc',attempts=j.attempts+1" +
        ' FROM candidate c,media_assets a WHERE j.organization_id=$1 AND j.media_asset_id=c.media_asset_id AND a.id=j.media_asset_id' +
        ' RETURNING j.media_asset_id,j.source_key,j.source_checksum,j.lease_until,to_jsonb(a) AS asset',
        [organizationId, token, Boolean(protocol.data.managed)]
      )).rows[0];
      if (!claimed) return null;
      const keys = productMediaVariantKeys(claimed.asset, token);
      await client.query(
        "INSERT INTO media_storage_deletions(organization_id,storage_key,media_asset_id,available_at) " +
        "SELECT $1,key,$3,now()+interval '20 minutes' FROM unnest($2::text[]) AS uploads(key) ON CONFLICT DO NOTHING",
        [organizationId, variants.map(variant => keys[variant]), claimed.media_asset_id]
      );
      return { ...claimed, keys, profile };
    });
    if (!job || 'paused' in job) {
      if (job) response.setHeader('X-Daja-Worker-Paused', '1');
      response.status(204);
      return;
    }
    const [source, ...uploads] = await Promise.all([
      storage.createPresignedGet({ key: job.source_key }),
      ...variants.map(variant => storage.createWorkerUpload(job.keys[variant], mime(variant)))
    ] as const);
    response.status(200);
    return {
      id: job.media_asset_id, leaseToken: token, expiresAt: job.lease_until.toISOString(), customSizes: true,
      productSlug: typeof job.asset.metadata?.productSlug === 'string' ? job.asset.metadata.productSlug : undefined,
      imageIndex: Number(job.asset.metadata?.imageIndex) || undefined,
      sourceWidth: job.asset.width ?? undefined, sourceHeight: job.asset.height ?? undefined,
      ...(protocol.data.managed ? { profile: job.profile } : {}),
      source: { url: source.downloadUrl, sha256: job.source_checksum },
      uploads: Object.fromEntries(variants.map((variant, index) => [variant, uploads[index]]))
    };
  }

  @Post('complete')
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  async complete(@Req() request: Request, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const organizationId = this.authenticate(request);
    const parsed = completeSchema.safeParse(body);
    if (!parsed.success) throw new ValidationFailedError('Expected four distinct worker outputs');
    const { id, leaseToken, files } = parsed.data;
    response.setHeader('Cache-Control', 'no-store');
    const asset = (await this.db.pool.query<MediaAssetRow>(
      "SELECT * FROM media_assets WHERE organization_id=$1 AND id=$2 AND status='ready' AND deleted_at IS NULL",
      [organizationId, id]
    )).rows[0];
    if (!asset) throw new AppError('IMAGE_JOB_EXPIRED', 'Image job is no longer current', 409);
    const keys = productMediaVariantKeys(asset, leaseToken);
    if (asset.storage_key === keys.webp) {
      response.status(204);
      return;
    }
    if (apiUnderLoad()) throw new AppError('IMAGE_PROCESSING_BUSY', 'Image verification is temporarily busy', 503);
    const ownsJob = (await this.db.pool.query<{ source_key: string; source_width: number | null; source_height: number | null }>(
      `SELECT source_key,source_width,source_height FROM media_derivative_jobs WHERE organization_id=$1
       AND media_asset_id=$2 AND local_worker AND lease_token=$3 AND lease_until>now() AND avif_main_key=$4
       AND coalesce(lease_worker,'pc')='pc'`,
      [organizationId, id, leaseToken, asset.storage_key]
    )).rows[0];
    if (!ownsJob) throw new AppError('IMAGE_JOB_EXPIRED', 'Image job is no longer current', 409);

    if (this.verifying) throw new AppError('IMAGE_PROCESSING_BUSY', 'Image verification is temporarily busy', 503);
    this.verifying = true;
    const verified: VerifiedFile[] = [];
    try {
      const storage = new R2MediaStorageAdapter(this.config);
      const verificationDeadline = AbortSignal.timeout(45_000);
      for (const file of files) {
        const storageKey = keys[file.variant];
        const mimeType = mime(file.variant);
        const limit = file.variant.endsWith('Thumb') ? 512 : 2048;
        const maximum = file.maxSize ?? limit;
        const sourceWidth = ownsJob.source_width ?? asset.width ?? 0;
        const sourceHeight = ownsJob.source_height ?? asset.height ?? 0;
        const scale = Math.min(1, maximum / Math.max(sourceWidth, sourceHeight));
        const matchesDimensions = maximum <= limit && sourceWidth > 0 && sourceHeight > 0 &&
          file.width <= Math.min(sourceWidth, maximum) && file.height <= Math.min(sourceHeight, maximum) &&
          Math.abs(file.width - Math.max(1, Math.round(sourceWidth * scale))) <= 1 &&
          Math.abs(file.height - Math.max(1, Math.round(sourceHeight * scale))) <= 1;
        const publicUrl = storage.publicUrl(storageKey);
        const object = await storage.headObject(storageKey, verificationDeadline);
        if (!publicUrl || object.mimeType !== mimeType || object.sizeBytes !== file.bytes ||
          !matchesDimensions) {
          throw new ValidationFailedError('Worker object metadata does not match');
        }
        const image = await inspectLocalMediaSource(await storage.getObject(storageKey, verificationDeadline), verificationDeadline);
        if (image.checksumSha256 !== file.sha256 || image.mimeType !== mimeType ||
          image.width !== file.width || image.height !== file.height || image.sizeBytes !== file.bytes) {
          throw new ValidationFailedError('Worker object bytes do not match');
        }
        verified.push({ variant: file.variant, ...image, storageKey, publicUrl });
      }
      verificationDeadline.throwIfAborted();
    } finally {
      this.verifying = false;
    }
    const original = verified.find(file => file.variant === 'webp')!;
    const ctx: SystemRequestContext = {
      organizationId, requestId: leaseToken, correlationId: leaseToken,
      userId: null, roles: [], permissions: []
    };
    await new TransactionManager(this.db.pool, this.logger).run(async client => {
      const products = await client.query<{ id: string; slug: string }>(
        'SELECT p.id,p.slug FROM products p WHERE p.organization_id=$1 AND p.deleted_at IS NULL ' +
        'AND EXISTS (SELECT 1 FROM product_media pm WHERE pm.organization_id=$1 AND pm.product_id=p.id AND pm.media_asset_id=$2) ' +
        'ORDER BY p.id FOR UPDATE',
        [organizationId, id]
      );
      const current = (await client.query<MediaAssetRow>(
        'SELECT * FROM media_assets WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE', [organizationId, id]
      )).rows[0];
      if (current?.status === 'ready' && current.storage_key === keys.webp) return;
      if (current?.status !== 'ready' || current.storage_key !== asset.storage_key) {
        throw new AppError('IMAGE_JOB_EXPIRED', 'Image job is no longer current', 409);
      }
      const job = await client.query(
        `DELETE FROM media_derivative_jobs WHERE organization_id=$1 AND media_asset_id=$2 AND local_worker
         AND lease_token=$3 AND lease_until>now() AND avif_main_key=$4 AND coalesce(lease_worker,'pc')='pc'`,
        [organizationId, id, leaseToken, asset.storage_key]
      );
      if (!job.rowCount) throw new AppError('IMAGE_JOB_EXPIRED', 'Image job is no longer current', 409);
      await client.query(
        `INSERT INTO media_storage_deletions(organization_id,storage_key,media_asset_id,available_at)
         SELECT $1,key,$2,CASE WHEN key=$5 THEN now()+interval '1 day' ELSE now() END
         FROM (SELECT unnest($3::text[]) AS key UNION
          SELECT storage_key FROM media_derivatives WHERE organization_id=$1 AND media_asset_id=$2) retired
         WHERE NOT (key=ANY($4::text[]))
         ON CONFLICT (organization_id,storage_key) DO UPDATE
         SET available_at=LEAST(media_storage_deletions.available_at,excluded.available_at),
             media_asset_id=excluded.media_asset_id`,
        [organizationId, id, [asset.storage_key, ownsJob.source_key], variants.map(variant => keys[variant]), ownsJob.source_key]
      );
      const updated = await new MediaRepository(client).markReady({
        organizationId, mediaId: id, width: original.width, height: original.height, original,
        replaceDerivatives: true, derivatives: verified.filter(file => file.variant !== 'webp')
      });
      if (!updated) throw new AppError('IMAGE_JOB_EXPIRED', 'Image job is no longer current', 409);
      await client.query(
        'DELETE FROM media_storage_deletions WHERE organization_id=$1 AND storage_key=ANY($2::text[])',
        [organizationId, variants.map(variant => keys[variant])]
      );
      await resolveMediaFailures(client, organizationId, id, 'overnight');
      for (const product of products.rows) {
        await client.query('UPDATE products SET updated_at=now() WHERE organization_id=$1 AND id=$2', [organizationId, product.id]);
        await new StorefrontRepository(client).refreshProductSnapshots({ organizationId, productId: product.id });
        await enqueueCatalogDelivery(client, ctx, product.id, [product.slug]);
      }
    });
    response.status(204);
  }
}
