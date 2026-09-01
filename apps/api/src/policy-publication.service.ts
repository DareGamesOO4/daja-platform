import { Inject, Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { Database, RedisConnection } from '@daja/database';
import { ValidationFailedError } from '@daja/security';
import { LEGAL_DOCUMENTS, LEGAL_POLICY_VERSION } from './legal-policy-content.js';
import { DATABASE, REDIS } from './tokens.js';

export const POLICY_NOTIFICATION_QUEUE_NAME = 'privacy-policy-notifications';

interface PolicyDeliveryJob {
  deliveryId: string;
}

@Injectable()
export class PolicyPublicationService {
  private readonly queue: Queue<PolicyDeliveryJob>;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(REDIS) redis: RedisConnection
  ) {
    this.queue = new Queue<PolicyDeliveryJob>(POLICY_NOTIFICATION_QUEUE_NAME, {
      connection: redis.client
    });
  }

  async list(organizationId: string) {
    const result = await this.database.pool.query<{
      id: string;
      version: string;
      material: boolean;
      active: boolean;
      change_summary: string;
      published_at: Date;
      effective_at: Date;
      recipient_count: string;
      sent_count: string;
    }>(
      `SELECT publication.id, publication.version, publication.material, publication.active,
              publication.change_summary, publication.published_at, publication.effective_at,
              count(delivery.id)::text AS recipient_count,
              count(delivery.id) FILTER (WHERE delivery.status = 'sent')::text AS sent_count
       FROM privacy_policy_publications publication
       LEFT JOIN policy_notification_deliveries delivery ON delivery.publication_id = publication.id
       WHERE publication.organization_id = $1
       GROUP BY publication.id
       ORDER BY publication.published_at DESC`,
      [organizationId]
    );
    return result.rows.map((row) => ({
      id: row.id,
      version: row.version,
      material: row.material,
      active: row.active,
      changeSummary: row.change_summary,
      publishedAt: row.published_at,
      effectiveAt: row.effective_at,
      recipientCount: Number(row.recipient_count),
      sentCount: Number(row.sent_count)
    }));
  }

  async publish(input: {
    organizationId: string;
    userId: string;
    version: string;
    material: boolean;
    changeSummary: string;
    effectiveAt?: Date;
  }) {
    if (input.version !== LEGAL_POLICY_VERSION) {
      throw new ValidationFailedError('Izabrana verzija pravnog teksta nije deo trenutno deployovanog paketa.');
    }
    if (!LEGAL_DOCUMENTS.every((document) => document.ready)) {
      throw new ValidationFailedError('Pravni tekst je i dalje nacrt i ne može se objaviti na produkciji.');
    }
    if (!input.changeSummary.trim()) {
      throw new ValidationFailedError('Upišite sažetak izmene politike.');
    }

    const client = await this.database.pool.connect();
    let deliveryIds: string[] = [];
    let publicationId = '';
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE privacy_policy_publications
         SET active = false
         WHERE organization_id = $1 AND active`,
        [input.organizationId]
      );
      const publication = await client.query<{ id: string }>(
        `INSERT INTO privacy_policy_publications (
           organization_id, version, change_summary, material, active, published_by_user_id, effective_at
         ) VALUES ($1, $2, $3, $4, true, $5, $6)
         ON CONFLICT (organization_id, version) DO UPDATE
         SET change_summary = EXCLUDED.change_summary,
             material = EXCLUDED.material,
             active = true,
             published_by_user_id = EXCLUDED.published_by_user_id,
             published_at = now(),
             effective_at = EXCLUDED.effective_at
         RETURNING id`,
        [
          input.organizationId,
          input.version,
          input.changeSummary.trim(),
          input.material,
          input.userId,
          input.effectiveAt ?? new Date()
        ]
      );
      publicationId = publication.rows[0]?.id ?? '';
      if (!publicationId) throw new ValidationFailedError('Objava politike nije sačuvana.');

      if (input.material) {
        const deliveries = await client.query<{ id: string }>(
          `WITH recipients AS (
             SELECT email, 0 AS priority, 'customer'::text AS recipient_kind
             FROM customers
             WHERE organization_id = $1 AND active AND email_verified AND email IS NOT NULL
             UNION ALL
             SELECT email, 1 AS priority, 'newsletter'::text AS recipient_kind
             FROM newsletter_subscribers
             WHERE organization_id = $1 AND active
           ), deduplicated AS (
             SELECT DISTINCT ON (lower(email)) email, recipient_kind
             FROM recipients
             ORDER BY lower(email), priority
           )
           INSERT INTO policy_notification_deliveries (publication_id, recipient_email, recipient_kind)
           SELECT $2, email, recipient_kind FROM deduplicated
           ON CONFLICT (publication_id, normalized_email) DO NOTHING
           RETURNING id`,
          [input.organizationId, publicationId]
        );
        deliveryIds = deliveries.rows.map((row) => row.id);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    await Promise.all(
      deliveryIds.map((deliveryId) =>
        this.queue.add(
          'deliver-policy-change',
          { deliveryId },
          {
            jobId: `privacy-policy:${deliveryId}`,
            attempts: 5,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: 1000,
            removeOnFail: 5000
          }
        )
      )
    );

    return { publicationId, recipientCount: deliveryIds.length, material: input.material };
  }
}
