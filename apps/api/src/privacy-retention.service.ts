import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Database } from '@daja/database';
import type { Logger } from '@daja/observability';
import { DATABASE, LOGGER } from './tokens.js';

/** Enforce existing consent-evidence deadlines without deleting business records. */
@Injectable()
export class PrivacyRetentionService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  constructor(@Inject(DATABASE) private readonly database: Database,
    @Inject(LOGGER) private readonly logger: Logger) {}

  onModuleInit() { this.schedule(60_000); }
  onModuleDestroy() { this.stopped = true; if (this.timer) clearTimeout(this.timer); }
  private schedule(delay = 60 * 60_000) {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.clean(), delay);
    this.timer.unref();
  }
  private async clean() {
    let client;
    try {
      client = await this.database.pool.connect();
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '5s'");
      const lock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('privacy-retention-v1', 0)) AS locked");
      if (lock.rows[0]?.locked) {
        // Keep evidence content unchanged. Closing an older grant's retention
        // window does not erase evidence of a later, separate opt-in.
        await client.query(`WITH expired_grants AS (
          SELECT e.id, min(r.occurred_at) + interval '3 years' AS deadline
          FROM marketing_consent_events e JOIN marketing_consent_events r
            ON r.organization_id=e.organization_id AND r.subject_email_hash=e.subject_email_hash
            AND r.purpose=e.purpose AND r.action='revoked' AND r.occurred_at>=e.occurred_at
            AND r.newsletter_subscriber_id IS NOT DISTINCT FROM e.newsletter_subscriber_id
            AND r.product_alert_subscription_id IS NOT DISTINCT FROM e.product_alert_subscription_id
          WHERE e.retain_until IS NULL AND e.action<>'revoked'
          GROUP BY e.id ORDER BY e.id LIMIT 500
        ) UPDATE marketing_consent_events e SET retain_until=g.deadline FROM expired_grants g WHERE e.id=g.id`);
        await client.query(`DELETE FROM privacy_consent_events WHERE id IN (
          SELECT id FROM privacy_consent_events WHERE retain_until<=now()
          ORDER BY retain_until LIMIT 500 FOR UPDATE SKIP LOCKED)`);
        await client.query(`DELETE FROM marketing_consent_events WHERE id IN (
          SELECT r.id FROM marketing_consent_events r WHERE r.retain_until<=now()
          AND (r.action<>'revoked' OR NOT EXISTS (
            SELECT 1 FROM marketing_consent_events e WHERE e.organization_id=r.organization_id
              AND e.subject_email_hash=r.subject_email_hash AND e.purpose=r.purpose
              AND e.retain_until IS NULL AND e.occurred_at<=r.occurred_at AND e.action<>'revoked'
              AND e.newsletter_subscriber_id IS NOT DISTINCT FROM r.newsletter_subscriber_id
              AND e.product_alert_subscription_id IS NOT DISTINCT FROM r.product_alert_subscription_id
          )) ORDER BY r.retain_until LIMIT 500 FOR UPDATE SKIP LOCKED)`);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => undefined);
      this.logger.warn({ err: error }, 'Consent retention cleanup will retry');
    } finally {
      client?.release();
      this.schedule();
    }
  }
}
