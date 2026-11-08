import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { AppConfig } from '@daja/config';
import type { Logger } from '@daja/observability';
import { MediaRepository, R2MediaStorageAdapter, TransactionManager, type Database } from '@daja/database';
import { CONFIG, DATABASE, LOGGER } from './tokens.js';

/** Remove abandoned presigned image uploads after their 15-minute PUT URL expires. */
@Injectable()
export class MediaUploadReaperService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger
  ) {}

  onModuleInit() { this.schedule(); }
  onModuleDestroy() { this.stopped = true; if (this.timer) clearTimeout(this.timer); }

  private schedule(delay = 15 * 60_000) {
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.tick(); }, delay);
    this.timer.unref();
  }

  private async tick() {
    try {
      await this.db.pool.query(
        `DELETE FROM media_import_cancellations WHERE (organization_id,request_id) IN (
          SELECT organization_id,request_id FROM media_import_cancellations WHERE expires_at<=now()
          ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED)`
      );
      const candidate = (await this.db.pool.query<{ organization_id: string; id: string }>(
        `SELECT a.organization_id,a.id FROM media_assets a
         WHERE a.status IN ('pending_upload','uploaded','failed') AND a.mime_type LIKE 'image/%' AND a.deleted_at IS NULL
         AND a.created_at<now()-interval '24 hours'
         AND NOT EXISTS (SELECT 1 FROM media_derivative_jobs j WHERE j.organization_id=a.organization_id AND j.media_asset_id=a.id)
         AND NOT EXISTS (SELECT 1 FROM product_media pm WHERE pm.organization_id=a.organization_id AND pm.media_asset_id=a.id)
         AND NOT EXISTS (SELECT 1 FROM brands b WHERE b.organization_id=a.organization_id AND b.logo_media_id=a.id AND b.deleted_at IS NULL)
         ORDER BY a.created_at,a.id LIMIT 1`
      )).rows[0];
      if (candidate) {
        await new TransactionManager(this.db.pool, this.logger).run(async client => {
          const current = (await client.query<{ id: string }>(
            `SELECT id FROM media_assets WHERE organization_id=$1 AND id=$2
             AND status IN ('pending_upload','uploaded','failed') AND mime_type LIKE 'image/%'
             AND NOT EXISTS (SELECT 1 FROM media_derivative_jobs j WHERE j.organization_id=media_assets.organization_id AND j.media_asset_id=media_assets.id)
             AND deleted_at IS NULL AND created_at<now()-interval '24 hours' FOR UPDATE`,
            [candidate.organization_id, candidate.id]
          )).rows[0];
          if (current) await new MediaRepository(client).discardUnreferenced(
            { organizationId: candidate.organization_id }, candidate.id, new R2MediaStorageAdapter(this.config)
          );
        });
      }
    } catch (error) {
      this.logger.warn({ err: error }, 'Abandoned media upload cleanup will retry');
    } finally {
      this.schedule();
    }
  }
}
