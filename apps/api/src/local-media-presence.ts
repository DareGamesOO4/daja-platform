import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@daja/config';
import type { Database } from '@daja/database';
import { defaultMediaWorkerProfile, mediaWorkerProfileSchema } from '@daja/validation';
import { CONFIG, DATABASE } from './tokens.js';

@Injectable()
export class LocalMediaPresence {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig
  ) {}

  async status(organizationId: string) {
    const row = (await this.db.pool.query<{
      profile: unknown; pcSeenAt: Date | null; pcOnline: boolean;
      renderSeenAt: Date | null; renderOnline: boolean; renderCompletedAt: Date | null; renderErrorAt: Date | null;
    }>(
      `SELECT s.profile, s.pc_seen_at AS "pcSeenAt",
        coalesce(s.pc_seen_at>now()-interval '45 seconds',false) OR EXISTS (
          SELECT 1 FROM media_derivative_jobs j WHERE j.organization_id=$1 AND j.lease_worker='pc' AND j.lease_until>now()
        ) AS "pcOnline",
        s.render_seen_at AS "renderSeenAt", coalesce(s.render_seen_at>now()-interval '6 minutes',false) AS "renderOnline",
        s.render_completed_at AS "renderCompletedAt", s.render_error_at AS "renderErrorAt"
       FROM (SELECT $1::uuid AS id) org LEFT JOIN media_worker_settings s ON s.organization_id=org.id`,
      [organizationId]
    )).rows[0]!;
    return {
      ...row, profile: mediaWorkerProfileSchema.safeParse(row.profile).data ?? defaultMediaWorkerProfile,
      pcEnabled: organizationId === this.config.PUBLIC_ORGANIZATION_ID && Boolean(this.config.MEDIA_LOCAL_WORKER_TOKEN_HASH)
    };
  }

  async renderHeartbeat(organizationId: string, result?: 'completed' | 'error') {
    await this.db.pool.query(
      `INSERT INTO media_worker_settings(organization_id,render_seen_at,render_completed_at,render_error_at)
       VALUES ($1,now(),CASE WHEN $2='completed' THEN now() END,CASE WHEN $2='error' THEN now() END)
       ON CONFLICT(organization_id) DO UPDATE SET render_seen_at=excluded.render_seen_at,
       render_completed_at=coalesce(excluded.render_completed_at,media_worker_settings.render_completed_at),
       render_error_at=coalesce(excluded.render_error_at,media_worker_settings.render_error_at)`,
      [organizationId, result ?? null]
    );
  }
}
