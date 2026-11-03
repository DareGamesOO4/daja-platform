import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { z } from 'zod';
import {
  AuditRepository,
  TransactionManager,
  recordMediaFailure,
  type Database
} from '@daja/database';
import type { Logger } from '@daja/observability';
import {
  AppError,
  requirePermission,
  ResourceConflictError,
  ResourceNotFoundError
} from '@daja/security';
import { parseWithSchema, uuidSchema } from '@daja/validation';
import { resolveRequestContext } from './runtime/request-context.js';
import { DATABASE, LOGGER } from './tokens.js';

const querySchema = z.object({
  view: z.enum(['all', 'problems', 'queue', 'history']).default('problems'),
  page: z.coerce.number().int().min(1).max(500).default(1),
  q: z.string().trim().max(160).default(''),
  status: z
    .enum([
      'all',
      'queued',
      'processing',
      'failed',
      'interrupted',
      'resolved',
      'removed',
      'upload_again',
      'dismissed'
    ])
    .default('all'),
  phase: z.enum(['all', 'upload', 'overnight']).default('all'),
  unread: z.enum(['all', 'unread']).default('all'),
  sort: z.enum(['newest', 'oldest', 'attempts']).default('newest')
});
const readSchema = z.object({
  items: z
    .array(
      z.object({
        id: uuidSchema,
        eventKey: z.string().min(1).max(100)
      })
    )
    .min(1)
    .max(20)
});

const productJoin = `LEFT JOIN LATERAL (
  SELECT p.id,p.name,p.slug FROM products p WHERE p.organization_id=a.organization_id
  AND p.deleted_at IS NULL AND (p.id=(SELECT pm.product_id FROM product_media pm
    WHERE pm.organization_id=a.organization_id AND pm.media_asset_id=a.id
    ORDER BY pm.is_primary DESC,pm.position,pm.id LIMIT 1) OR p.slug=a.metadata->>'productSlug')
  ORDER BY p.id LIMIT 1
) p ON true`;
const imageFields = `a.id AS "mediaId",a.metadata->>'originalFilename' AS filename,
  CASE WHEN a.status='ready' AND a.deleted_at IS NULL THEN a.public_url ELSE NULL END AS "previewUrl",
  a.metadata->>'imageIndex' AS "imageIndex",p.id AS "productId",
  coalesce(p.name,a.metadata->>'productSlug') AS "productName",p.slug AS "productSlug"`;
const jobState = `CASE WHEN j.lease_until>now() THEN 'processing'
  WHEN j.paused_at IS NOT NULL OR j.attempts>=8 THEN 'failed'
  WHEN j.lease_until IS NOT NULL THEN 'interrupted'
  WHEN j.last_error_code IS NOT NULL THEN 'failed' ELSE 'queued' END`;

@Controller('admin/media-processing')
export class MediaProcessingController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(LOGGER) private readonly logger: Logger
  ) {}

  @Get('summary')
  async summary(@Req() request: Request) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.read');
    // An OOM/restart cannot run a catch handler. Surface expired leases on the
    // next admin visit, once per lease token, including outside the night window.
    await this.db.pool.query(
      `INSERT INTO media_processing_alerts
       (organization_id,media_asset_id,phase,error_code,message,event_key)
       SELECT j.organization_id,j.media_asset_id,'overnight','IMAGE_PROCESSING_INTERRUPTED',
       'Obrada je prekinuta pre završetka. Slika čeka ponovni pokušaj.',j.lease_token::text||':expired'
       FROM media_derivative_jobs j JOIN media_assets a ON a.id=j.media_asset_id AND a.organization_id=j.organization_id
       WHERE j.organization_id=$1 AND j.lease_until<=now() AND j.lease_token IS NOT NULL
       AND a.deleted_at IS NULL AND a.status='ready'
       ON CONFLICT (organization_id,media_asset_id,phase) DO UPDATE SET
         error_code=excluded.error_code,message=excluded.message,event_key=excluded.event_key,
         occurrences=media_processing_alerts.occurrences+1,last_failure_at=now(),resolved_at=NULL,resolution=NULL,retry_requested_at=NULL
       WHERE media_processing_alerts.event_key IS DISTINCT FROM excluded.event_key`,
      [ctx.organizationId]
    );
    const result = await this.db.pool.query(
      `SELECT
        (SELECT event_key FROM media_processing_alerts WHERE organization_id=$1 ORDER BY last_failure_at DESC,id DESC LIMIT 1) AS "latestEventKey",
        (SELECT count(*)::int FROM media_processing_alerts al WHERE al.organization_id=$1 AND al.resolved_at IS NULL) AS "openAlerts",
        (SELECT count(*)::int FROM media_processing_alerts al LEFT JOIN media_processing_alert_reads r
          ON r.alert_id=al.id AND r.user_id=$2 WHERE al.organization_id=$1
          AND (r.seen_event_key IS DISTINCT FROM al.event_key)) AS unread,
        (SELECT count(*)::int FROM media_derivative_jobs j WHERE j.organization_id=$1 AND j.paused_at IS NULL AND j.attempts<8) AS pending,
        (SELECT count(*)::int FROM media_derivative_jobs j WHERE j.organization_id=$1 AND j.lease_until>now()) AS processing`,
      [ctx.organizationId, ctx.userId]
    );
    return result.rows[0];
  }

  @Get()
  async list(@Req() request: Request, @Query() query: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.read');
    const { view, page, q, status, phase, unread, sort } = parseWithSchema(querySchema, query);
    const base =
      view === 'queue'
        ? `SELECT j.media_asset_id AS id,'overnight' AS phase,${imageFields},
        ${jobState} AS status,j.attempts,j.created_at AS "createdAt",j.last_error_at AS "lastFailureAt",
        j.available_at AS "availableAt",al.message,al.error_code AS "errorCode",al.event_key AS "eventKey",
        al.retry_requested_at AS "retryRequestedAt",coalesce(r.seen_event_key=al.event_key,false) AS "isRead",
        NOT coalesce(j.lease_until>now(),false) AS "canRetry"
       FROM media_derivative_jobs j JOIN media_assets a ON a.id=j.media_asset_id AND a.organization_id=j.organization_id
       LEFT JOIN media_processing_alerts al ON al.organization_id=j.organization_id AND al.media_asset_id=j.media_asset_id AND al.phase='overnight'
       LEFT JOIN media_processing_alert_reads r ON r.alert_id=al.id AND r.user_id=$2
       ${productJoin} WHERE j.organization_id=$1 AND a.deleted_at IS NULL`
        : `SELECT al.id,al.event_key AS "eventKey",al.phase,al.error_code AS "errorCode",al.message,al.occurrences,
        al.first_failure_at AS "createdAt",al.first_failure_at AS "firstFailureAt",al.last_failure_at AS "lastFailureAt",
        al.resolution,al.resolved_at AS "resolvedAt",al.retry_requested_at AS "retryRequestedAt",${imageFields},
        coalesce(r.seen_event_key=al.event_key,false) AS "isRead",
        CASE WHEN al.resolution='dismissed' THEN 'dismissed' WHEN al.resolution='removed' THEN 'removed'
          WHEN al.resolved_at IS NOT NULL THEN 'resolved' WHEN j.media_asset_id IS NULL THEN 'upload_again'
          ELSE ${jobState} END AS status,
        (al.resolved_at IS NULL AND j.media_asset_id IS NOT NULL AND a.deleted_at IS NULL
          AND NOT coalesce(j.lease_until>now(),false)) AS "canRetry",j.attempts,j.available_at AS "availableAt"
       FROM media_processing_alerts al JOIN media_assets a ON a.id=al.media_asset_id AND a.organization_id=al.organization_id
       LEFT JOIN media_processing_alert_reads r ON r.alert_id=al.id AND r.user_id=$2
       LEFT JOIN media_derivative_jobs j ON j.organization_id=al.organization_id AND j.media_asset_id=al.media_asset_id AND al.phase='overnight'
       ${productJoin} WHERE al.organization_id=$1 AND ${view === 'history' ? 'al.resolved_at IS NOT NULL' : view === 'problems' ? 'al.resolved_at IS NULL' : 'true'}`;
    const order =
      sort === 'oldest'
        ? `coalesce("lastFailureAt","createdAt") ASC,id ASC`
        : sort === 'attempts'
          ? `coalesce(attempts,${view === 'queue' ? '0' : 'occurrences'},0) DESC,coalesce("lastFailureAt","createdAt") DESC,id DESC`
          : `coalesce("lastFailureAt","createdAt") DESC,id DESC`;
    const rows = (
      await this.db.pool.query(
        `WITH entries AS (${base}) SELECT * FROM entries WHERE
       ($3='' OR strpos(lower(concat_ws(' ',"productName","productSlug",filename,"mediaId"::text)),lower($3))>0)
       AND ($4='all' OR status=$4) AND ($5='all' OR phase=$5)
       AND ($6='all' OR ("eventKey" IS NOT NULL AND NOT "isRead"))
       ORDER BY ${order} LIMIT 21 OFFSET $7`,
        [ctx.organizationId, ctx.userId, q, status, phase, unread, (page - 1) * 20]
      )
    ).rows;
    return { items: rows.slice(0, 20), hasMore: rows.length > 20, page, view };
  }

  @Post('read')
  async markRead(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.read');
    const { items } = parseWithSchema(readSchema, body);
    await this.db.pool.query(
      `INSERT INTO media_processing_alert_reads(alert_id,user_id,seen_through,seen_event_key)
       SELECT al.id,$2,al.last_failure_at,al.event_key
       FROM jsonb_to_recordset($3::jsonb) AS item(id uuid,event_key text)
       JOIN media_processing_alerts al ON al.id=item.id AND al.organization_id=$1 AND al.event_key=item.event_key
       ON CONFLICT (alert_id,user_id) DO UPDATE SET
         seen_through=excluded.seen_through,seen_event_key=excluded.seen_event_key
       WHERE media_processing_alert_reads.seen_through<=excluded.seen_through`,
      [
        ctx.organizationId,
        ctx.userId,
        JSON.stringify(items.map((item) => ({ id: item.id, event_key: item.eventKey })))
      ]
    );
    return { ok: true };
  }

  @Post(':mediaId/upload-failed')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async uploadFailed(@Req() request: Request, @Param('mediaId') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'media.upload');
    const mediaId = parseWithSchema(uuidSchema, id);
    await recordMediaFailure(
      this.db.pool,
      ctx.organizationId,
      mediaId,
      'upload',
      new AppError('IMAGE_UPLOAD_TRANSFER_FAILED', 'Image transfer failed', 503)
    );
    return { ok: true };
  }

  @Post('alerts/:alertId/close')
  async closeAlert(@Req() request: Request, @Param('alertId') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'media.upload');
    const alertId = parseWithSchema(uuidSchema, id);
    return new TransactionManager(this.db.pool, this.logger).run(async (client) => {
      const updated = await client.query<{ media_asset_id: string }>(
        `UPDATE media_processing_alerts SET resolved_at=now(),resolution='dismissed'
         WHERE organization_id=$1 AND id=$2 AND phase='upload' AND resolved_at IS NULL RETURNING media_asset_id`,
        [ctx.organizationId, alertId]
      );
      if (!updated.rows[0]) throw new ResourceNotFoundError('obaveštenje o slici');
      await new AuditRepository(client).append({
        ctx,
        aggregateType: 'media_asset',
        aggregateId: updated.rows[0].media_asset_id,
        operation: 'media.alert.close',
        afterPayload: { alertId }
      });
      return { ok: true };
    });
  }

  @Post(':mediaId/retry')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async retry(@Req() request: Request, @Param('mediaId') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'media.upload');
    const mediaId = parseWithSchema(uuidSchema, id);
    return new TransactionManager(this.db.pool, this.logger).run(async (client) => {
      const updated = await client.query(
        `UPDATE media_derivative_jobs j SET available_at=now(),lease_until=NULL,lease_token=NULL,
         paused_at=NULL,attempts=0,last_error_code=NULL,last_error_at=NULL
         WHERE j.organization_id=$1 AND j.media_asset_id=$2 AND NOT coalesce(j.lease_until>now(),false)
         AND EXISTS (SELECT 1 FROM media_assets a WHERE a.organization_id=$1 AND a.id=$2 AND a.status='ready' AND a.deleted_at IS NULL)
         RETURNING media_asset_id`,
        [ctx.organizationId, mediaId]
      );
      if (!updated.rowCount) {
        const existing = await client.query(
          'SELECT 1 FROM media_derivative_jobs WHERE organization_id=$1 AND media_asset_id=$2',
          [ctx.organizationId, mediaId]
        );
        if (existing.rowCount)
          throw new ResourceConflictError('Slika se već obrađuje. Sačekajte završetak.');
        throw new ResourceNotFoundError('posao obrade slike');
      }
      await client.query(
        `UPDATE media_processing_alerts SET retry_requested_at=now() WHERE organization_id=$1
         AND media_asset_id=$2 AND phase='overnight' AND resolved_at IS NULL`,
        [ctx.organizationId, mediaId]
      );
      await new AuditRepository(client).append({
        ctx,
        aggregateType: 'media_asset',
        aggregateId: mediaId,
        operation: 'media.derivatives.retry',
        afterPayload: { state: 'queued', window: '03:00-07:00', timeZone: 'Europe/Belgrade' }
      });
      return {
        state: 'queued',
        message: 'Ponovni pokušaj je zakazan. Obrada radi od 03:00 do 07:00 po vremenu u Srbiji.'
      };
    });
  }
}
