import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { orderNotificationRecipients, type AppConfig } from '@daja/config';
import { TransactionManager, type Database } from '@daja/database';
import type { Logger } from '@daja/observability';
import { defaultMediaWorkerProfile, mediaWorkerProfileSchema } from '@daja/validation';
import { CONFIG, DATABASE, LOGGER } from './tokens.js';
import { EmailDeliveryService } from './email-delivery.service.js';

const studioOffline = "coalesce(studio_seen_at < now()-interval '3 minutes',false)";
const studioIssues = [
  { bit: 1, message: 'Donji DAJA Studio se ne javlja. Proveri računar, internet i Windows zadatak.' },
  { bit: 2, message: 'Donji DAJA Studio prijavljuje problem sa obradom slika.' },
  { bit: 4, message: 'Linkel provere su privremeno pauzirane zbog problema sa pristupom.' }
];

@Injectable()
export class LocalMediaPresence implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private checking = false;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly email: EmailDeliveryService
  ) {}

  onModuleInit() {
    if (this.config.NODE_ENV !== 'production' || !this.config.PUBLIC_ORGANIZATION_ID || !this.config.MEDIA_LOCAL_WORKER_TOKEN_HASH) return;
    this.timer = setInterval(() => void this.checkStudio(), 30_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  private async checkStudio() {
    if (this.checking) return;
    this.checking = true;
    try {
      const organizationId = this.config.PUBLIC_ORGANIZATION_ID;
      await new TransactionManager(this.db.pool, this.logger).run(async client => {
        const studio = (await client.query<{ mask: number; notified: number }>(
          `SELECT (CASE WHEN ${studioOffline} THEN 1 | (studio_notified_mask & 6) ELSE
            CASE WHEN studio_image_error_since <= now()-interval '2 minutes' THEN 2 ELSE 0 END
            + CASE WHEN studio_linkel_error_since <= now()-interval '2 minutes' THEN 4 ELSE 0 END
            END) AS mask, studio_notified_mask AS notified
           FROM media_worker_settings WHERE organization_id=$1 AND studio_seen_at IS NOT NULL FOR UPDATE`,
          [organizationId]
        )).rows[0];
        if (!studio || studio.mask === studio.notified) return;
        const newIssues = studioIssues.filter(issue => (studio.mask & ~studio.notified & issue.bit) !== 0);
        const recipients = orderNotificationRecipients(this.config);
        if (newIssues.length && recipients.length) {
          const messages = newIssues.map(issue => issue.message);
          await this.email.send({
            organizationId, recipients, tag: 'studio-health-alert', subject: 'DAJA Studio · upozorenje',
            text: messages.join('\n') + '\nDetalji: Admin → Slike.',
            html: messages.map(message => '<p>' + message + '</p>').join('') + '<p>Detalji: Admin → Slike.</p>'
          }, client);
        }
        await client.query('UPDATE media_worker_settings SET studio_notified_mask=$2 WHERE organization_id=$1',
          [organizationId, studio.mask]);
      });
    } catch (error) {
      this.logger.error({ err: error }, 'Studio health check failed');
    } finally {
      this.checking = false;
    }
  }

  async studioHeartbeat(organizationId: string, imageError: string | null) {
    await this.db.pool.query(
      `INSERT INTO media_worker_settings(organization_id,studio_seen_at,studio_image_error,studio_linkel_error,
        studio_image_error_since,studio_linkel_error_since)
       SELECT $1::uuid,now(),$2,provider.pause_reason,CASE WHEN $2::text IS NOT NULL THEN now() END,
         CASE WHEN provider.pause_reason IS NOT NULL THEN now() END
       FROM (SELECT 1) source LEFT JOIN supplier_provider_checks provider
         ON provider.provider_code='linkel' AND provider.paused_until>now()
       ON CONFLICT(organization_id) DO UPDATE SET studio_seen_at=now(),
        studio_image_error=excluded.studio_image_error,studio_linkel_error=excluded.studio_linkel_error,
        studio_image_error_since=CASE WHEN $2 IS NOT NULL THEN coalesce(media_worker_settings.studio_image_error_since,now()) END,
        studio_linkel_error_since=CASE WHEN excluded.studio_linkel_error IS NOT NULL THEN coalesce(media_worker_settings.studio_linkel_error_since,now()) END`,
      [organizationId, imageError]
    );
  }

  async status(organizationId: string) {
    const row = (await this.db.pool.query<{
      profile: unknown; pcSeenAt: Date | null; pcOnline: boolean;
      renderSeenAt: Date | null; renderOnline: boolean; renderCompletedAt: Date | null; renderErrorAt: Date | null;
      studioSeenAt: Date | null; studioOffline: boolean; studioImageError: string | null; studioLinkelError: string | null;
    }>(
      `SELECT s.profile, s.pc_seen_at AS "pcSeenAt",
        coalesce(s.pc_seen_at>now()-interval '45 seconds',false) OR EXISTS (
          SELECT 1 FROM media_derivative_jobs j WHERE j.organization_id=$1 AND j.lease_worker='pc' AND j.lease_until>now()
        ) AS "pcOnline",
        s.render_seen_at AS "renderSeenAt", coalesce(s.render_seen_at>now()-interval '6 minutes',false) AS "renderOnline",
        s.render_completed_at AS "renderCompletedAt", s.render_error_at AS "renderErrorAt",
        s.studio_seen_at AS "studioSeenAt", ${studioOffline} AS "studioOffline",
        s.studio_image_error AS "studioImageError", s.studio_linkel_error AS "studioLinkelError"
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
