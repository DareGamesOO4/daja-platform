import type { DbClient } from './pool.js';

export interface QueuedEmail {
  organizationId?: string | undefined;
  recipients: string[];
  subject: string;
  text: string;
  html: string;
  tag: string;
  linkTokenHash?: string | undefined;
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
  // Catalog names and other dynamic subject fragments must remain a single header line.
  input = { ...input, subject: input.subject.replace(/[\r\n\u0000]+/g, ' ').trim() };
  const recipients = [...new Set(input.recipients.map((value) => value.trim().toLowerCase()))];
  if (!recipients.length || recipients.some((value) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) {
    throw new Error('A valid email recipient is required');
  }
  const securityLink = ['novosti-potvrda', 'potvrda-email-adrese', 'promena-lozinke', 'product-alert-confirmation'].includes(input.tag);
  const priority = securityLink ? 0 : input.tag.startsWith('product-') || input.newsletterSubscriberId ? 20 : 10;
  await client.query(
    `INSERT INTO email_deliveries (recipient, payload, expires_at, deduplication_key, priority, minimum_validity_seconds, organization_id, tag)
     SELECT recipient, $2::jsonb, COALESCE($3::timestamptz, now() + interval '7 days'),
            CASE WHEN $4::text IS NULL THEN NULL ELSE $4 || ':' || recipient END, $5, $6, $7, $8
     FROM unnest($1::text[]) AS recipients(recipient)
     ON CONFLICT (deduplication_key) DO NOTHING`,
    [recipients, JSON.stringify(input), input.expiresAt ?? null, input.deduplicationKey ?? null, priority, securityLink ? 120 : 0, input.organizationId ?? null, input.tag]
  );
}
