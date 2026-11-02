import { Inject, Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import type { AppConfig } from '@daja/config';
import type { Logger } from '@daja/observability';
import { R2MediaStorageAdapter, type Database } from '@daja/database';
import { CONFIG, DATABASE, LOGGER } from './tokens.js';

@Injectable()
export class MediaCleanupService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  constructor(@Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig, @Inject(LOGGER) private readonly logger: Logger) {}
  onModuleInit() { this.schedule(); }
  onModuleDestroy() { this.stopped = true; if (this.timer) clearTimeout(this.timer); }
  private schedule() {
    if (!this.stopped) { this.timer = setTimeout(() => { void this.tick(); }, 2000); this.timer.unref(); }
  }
  private async tick() {
    try {
      // One atomic SQL statement leases the item; no connection/transaction is
      // held during the network call. Another replica can recover after a crash.
      const row = (await this.db.pool.query<{ organization_id: string; storage_key: string; attempts: number }>(
        `UPDATE media_storage_deletions d SET available_at=now()+interval '90 seconds', attempts=d.attempts+1
         FROM (SELECT organization_id,storage_key FROM media_storage_deletions WHERE available_at<=now()
           ORDER BY available_at LIMIT 1 FOR UPDATE SKIP LOCKED) candidate
         WHERE d.organization_id=candidate.organization_id AND d.storage_key=candidate.storage_key RETURNING d.*`)).rows[0];
      if (!row) return;
      try {
        await new R2MediaStorageAdapter(this.config).deleteObject(row.storage_key);
        await this.db.pool.query('DELETE FROM media_storage_deletions WHERE organization_id=$1 AND storage_key=$2', [row.organization_id, row.storage_key]);
      } catch {
        await this.db.pool.query(`UPDATE media_storage_deletions SET available_at=now()+($3*interval '1 second')
          WHERE organization_id=$1 AND storage_key=$2`, [row.organization_id, row.storage_key, Math.min(300, 2 ** Math.min(row.attempts, 8))]);
      }
    } catch (error) { this.logger.warn({ err: error }, 'Media storage cleanup will retry'); }
    finally { this.schedule(); }
  }
}
