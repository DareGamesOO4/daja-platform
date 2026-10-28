import type { DbClient } from './pool.js';

export interface QueuedEmail {
  recipients: string[];
  subject: string;
  text: string;
  html: string;
  tag: string;
  fromEmail?: string | undefined;
  replyTo?: string[] | undefined;
  unsubscribeUrl?: string | undefined;
  expiresAt?: Date | undefined;
  deduplicationKey?: string | undefined;
  policyDeliveryId?: string | undefined;
  productAlertSubscriptionId?: string | undefined;
  newsletterSubscriberId?: string | undefined;
}

export async function enqueueEmail(client: DbClient, input: QueuedEmail): Promise<void> {
  const recipients = [...new Set(input.recipients.map((value) => value.trim().toLowerCase()))];
  if (!recipients.length || recipients.some((value) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) {
    throw new Error('A valid email recipient is required');
  }
  await client.query(
    `INSERT INTO email_deliveries (recipient, payload, expires_at, deduplication_key)
     SELECT recipient, $2::jsonb, COALESCE($3::timestamptz, now() + interval '7 days'),
            CASE WHEN $4::text IS NULL THEN NULL ELSE $4 || ':' || recipient END
     FROM unnest($1::text[]) AS recipients(recipient)
     ON CONFLICT (deduplication_key) DO NOTHING`,
    [recipients, JSON.stringify(input), input.expiresAt ?? null, input.deduplicationKey ?? null]
  );
}
