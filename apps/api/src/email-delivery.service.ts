import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  type OnModuleDestroy,
  type OnModuleInit
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import {
  SQSClient,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand
} from '@aws-sdk/client-sqs';
import type { AppConfig } from '@daja/config';
import { enqueueEmail, type Database, type DbClient, type QueuedEmail } from '@daja/database';
import type { Logger } from '@daja/observability';
import { CONFIG, DATABASE, LOGGER } from './tokens.js';

export type TransactionalEmail = QueuedEmail;
interface DeliveryRow {
  id: string;
  recipient: string;
  payload: QueuedEmail;
  attempts: number;
}

@Injectable()
export class EmailDeliveryService implements OnModuleInit, OnModuleDestroy {
  private client: SESv2Client | undefined;
  private sqs: SQSClient | undefined;
  private queueUrl: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private feedbackTimer: NodeJS.Timeout | undefined;
  private dispatching = false;
  private readingFeedback = false;
  private maintenanceAt = 0;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(DATABASE) private readonly database: Database
  ) {}

  onModuleInit(): void {
    if (!this.isConfigured()) {
      this.logger.warn('Amazon SES is not configured; email requests will return an error');
      return;
    }
    this.timer = setInterval(() => void this.dispatch(), 1200);
    this.feedbackTimer = setInterval(() => void this.readFeedback(), 30_000);
    this.timer.unref();
    this.feedbackTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.feedbackTimer) clearInterval(this.feedbackTimer);
  }

  // Resolves only after the message is durably saved. It does not claim delivery.
  async send(input: TransactionalEmail, client: DbClient = this.database.pool): Promise<void> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'Email trenutno nije dostupan. Pokušajte ponovo kasnije.'
      );
    }
    if (['novosti-potvrda', 'potvrda-email-adrese', 'promena-lozinke'].includes(input.tag)) {
      await client.query(
        `UPDATE email_deliveries SET status = 'expired', payload = '{}'::jsonb,
        last_error = 'Superseded by a newer link' WHERE recipient = ANY($1::text[])
          AND payload->>'tag' = $2 AND status = 'pending'`,
        [input.recipients.map((value) => value.trim().toLowerCase()), input.tag]
      );
    }
    await enqueueEmail(client, {
      ...input,
      fromEmail: input.fromEmail || this.config.SES_FROM_EMAIL,
      replyTo:
        input.replyTo ?? (this.config.SES_REPLY_TO_EMAIL ? [this.config.SES_REPLY_TO_EMAIL] : [])
    });
  }

  private isConfigured(): boolean {
    return Boolean(
      this.config.SES_ACCESS_KEY_ID &&
      this.config.SES_SECRET_ACCESS_KEY &&
      this.config.SES_FROM_EMAIL
    );
  }

  private credentials() {
    return {
      accessKeyId: this.config.SES_ACCESS_KEY_ID,
      secretAccessKey: this.config.SES_SECRET_ACCESS_KEY
    };
  }

  private async dispatch(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      if (Date.now() >= this.maintenanceAt) {
        await this.database.pool
          .query(`UPDATE email_deliveries SET status = 'expired', last_error = 'Message expired before delivery'
        WHERE expires_at <= now() AND (status = 'pending' OR (status = 'sending' AND locked_until < now()))`);
        await this.database.pool.query(`UPDATE email_deliveries d SET status = 'suppressed',
        last_error = s.reason FROM email_suppressions s WHERE d.recipient = s.email AND d.status = 'pending'`);
        await this.database.pool.query(`UPDATE email_deliveries d SET status = 'suppressed',
        last_error = 'Consent revoked' WHERE d.status = 'pending' AND (
          EXISTS (SELECT 1 FROM newsletter_subscribers s WHERE s.id::text = d.payload->>'newsletterSubscriberId' AND NOT s.active)
          OR EXISTS (SELECT 1 FROM product_alert_subscriptions s
            WHERE s.id::text = d.payload->>'productAlertSubscriptionId' AND s.revoked_at IS NOT NULL))`);
        await this.database.pool
          .query(`UPDATE policy_notification_deliveries p SET status = 'failed', last_error = d.last_error
        FROM email_deliveries d WHERE d.status IN ('failed','expired','suppressed')
          AND d.payload->>'policyDeliveryId' = p.id::text AND p.status <> 'sent'`);
        await this.database.pool.query(`UPDATE email_deliveries SET payload = '{}'::jsonb
        WHERE status IN ('failed','expired','suppressed') AND payload <> '{}'::jsonb`);
        await this.database.pool
          .query(`DELETE FROM email_deliveries WHERE status IN ('sent','failed','suppressed','expired')
        AND created_at < now() - interval '30 days'`);
        this.maintenanceAt = Date.now() + 60_000;
      }
      // This shared permit also limits multiple API replicas to the sandbox rate.
      const permit = await this.database.pool.query(
        `INSERT INTO email_sender_limits (region, next_attempt_at)
        VALUES ($1, now() + interval '1100 milliseconds') ON CONFLICT (region) DO UPDATE
        SET next_attempt_at = EXCLUDED.next_attempt_at WHERE email_sender_limits.next_attempt_at <= now() RETURNING region`,
        [this.config.SES_REGION]
      );
      if (!permit.rowCount) return;
      const claimed = await this.database.pool.query<DeliveryRow>(`WITH candidate AS (
        SELECT queued.id FROM email_deliveries queued WHERE expires_at > now() AND available_at <= now()
          AND (status = 'pending' OR (status = 'sending' AND locked_until < now()))
          AND NOT EXISTS (SELECT 1 FROM email_suppressions s WHERE s.email = queued.recipient)
          AND (payload->>'newsletterSubscriberId' IS NULL OR EXISTS (
            SELECT 1 FROM newsletter_subscribers s WHERE s.id::text = payload->>'newsletterSubscriberId' AND s.active))
          AND (payload->>'productAlertSubscriptionId' IS NULL OR EXISTS (
            SELECT 1 FROM product_alert_subscriptions s WHERE s.id::text = payload->>'productAlertSubscriptionId' AND s.revoked_at IS NULL))
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE email_deliveries d SET status = 'sending', attempts = attempts + 1,
          locked_until = now() + interval '5 minutes'
        FROM candidate WHERE d.id = candidate.id RETURNING d.id, d.recipient, d.payload, d.attempts`);
      const row = claimed.rows[0];
      if (row) await this.deliver(row);
    } catch (error) {
      this.logger.error({ err: error }, 'Email queue processing failed');
    } finally {
      this.dispatching = false;
    }
  }

  private async deliver(row: DeliveryRow): Promise<void> {
    const input = row.payload;
    try {
      this.client ??= new SESv2Client({
        region: this.config.SES_REGION,
        credentials: this.credentials(),
        maxAttempts: 3
      });
      const response = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: input.fromEmail || this.config.SES_FROM_EMAIL,
          Destination: { ToAddresses: [row.recipient] },
          ReplyToAddresses: input.replyTo,
          FeedbackForwardingEmailAddress: this.config.SES_REPLY_TO_EMAIL || undefined,
          ConfigurationSetName: this.config.SES_CONFIGURATION_SET || undefined,
          Content: {
            Simple: {
              Subject: { Charset: 'UTF-8', Data: input.subject },
              ...(input.unsubscribeUrl
                ? {
                    Headers: [
                      { Name: 'List-Unsubscribe', Value: `<${input.unsubscribeUrl}>` },
                      { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }
                    ]
                  }
                : {}),
              Body: {
                Text: { Charset: 'UTF-8', Data: input.text },
                Html: { Charset: 'UTF-8', Data: input.html }
              }
            }
          },
          EmailTags: [{ Name: 'type', Value: input.tag }]
        })
      );
      await this.database.pool.query(
        `WITH sent AS (
        UPDATE email_deliveries SET status = 'sent', sent_at = now(), ses_message_id = $2,
          locked_until = NULL, last_error = NULL, payload = '{}'::jsonb WHERE id = $1 RETURNING id
        ) UPDATE policy_notification_deliveries SET status = 'sent', sent_at = now(), last_error = NULL
          WHERE id = $3::uuid AND EXISTS (SELECT 1 FROM sent)`,
        [row.id, response.MessageId, input.policyDeliveryId ?? null]
      );
      this.logger.info(
        { deliveryId: row.id, messageId: response.MessageId, tag: input.tag },
        'Email accepted by SES'
      );
    } catch (error) {
      const name = error instanceof Error ? error.name : 'UnknownError';
      // Sandbox recipient rejection may recover after production approval.
      const failed = ['BadRequestException', 'MailFromDomainNotVerifiedException'].includes(name);
      const delay = Math.min(3600, 15 * 2 ** Math.min(row.attempts, 8));
      await this.database.pool.query(
        `UPDATE email_deliveries SET status = $2, locked_until = NULL,
        available_at = now() + $3 * interval '1 second', last_error = $4 WHERE id = $1`,
        [
          row.id,
          failed ? 'failed' : 'pending',
          delay,
          error instanceof Error ? `${name}: ${error.message}`.slice(0, 500) : name
        ]
      );
      this.logger.error(
        { deliveryId: row.id, errorName: name },
        'Email attempt failed; recoverable failures remain queued'
      );
    }
  }

  private async readFeedback(): Promise<void> {
    if (this.readingFeedback || !this.config.SES_FEEDBACK_QUEUE_NAME) return;
    this.readingFeedback = true;
    try {
      this.sqs ??= new SQSClient({
        region: this.config.SES_REGION,
        credentials: this.credentials()
      });
      this.queueUrl ??= (
        await this.sqs.send(
          new GetQueueUrlCommand({ QueueName: this.config.SES_FEEDBACK_QUEUE_NAME })
        )
      ).QueueUrl;
      if (!this.queueUrl) return;
      const messages = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: 10,
          VisibilityTimeout: 60,
          WaitTimeSeconds: 0
        })
      );
      for (const message of messages.Messages ?? []) {
        if (!message.Body || !message.ReceiptHandle || !message.MessageId) continue;
        const event = JSON.parse(message.Body) as {
          notificationType?: string;
          eventType?: string;
          mail?: { messageId?: string };
          bounce?: { bounceType?: string; bouncedRecipients?: Array<{ emailAddress: string }> };
          complaint?: { complainedRecipients?: Array<{ emailAddress: string }> };
        };
        const kind = event.notificationType || event.eventType || 'Unknown';
        const recipients =
          kind === 'Complaint'
            ? event.complaint?.complainedRecipients
            : kind === 'Bounce' && event.bounce?.bounceType === 'Permanent'
              ? event.bounce.bouncedRecipients
              : [];
        const client = await this.database.pool.connect();
        try {
          await client.query('BEGIN');
          const inserted = await client.query(
            `INSERT INTO email_feedback_events (event_id, event_type, ses_message_id)
            VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id`,
            [message.MessageId, kind, event.mail?.messageId ?? null]
          );
          if (inserted.rowCount) {
            for (const recipient of recipients ?? []) {
              const email = recipient.emailAddress.trim().toLowerCase();
              await client.query(
                `INSERT INTO email_suppressions (email, reason) VALUES ($1,$2)
                ON CONFLICT (email) DO UPDATE SET reason = EXCLUDED.reason`,
                [email, kind === 'Complaint' ? 'COMPLAINT' : 'BOUNCE']
              );
              const emailHash = createHash('sha256').update(email).digest('hex');
              await client.query(
                `WITH revoked AS (
                UPDATE newsletter_subscribers SET active = false, revoked_at = now(),
                  confirmation_token_hash = NULL, confirmation_expires_at = NULL, updated_at = now()
                WHERE normalized_email = $1 AND (active OR confirmation_token_hash IS NOT NULL)
                RETURNING id, organization_id
              ) INSERT INTO marketing_consent_events (organization_id, subject_email_hash,
                  newsletter_subscriber_id, purpose, action, source, retain_until)
                SELECT organization_id, $2, id, 'newsletter', 'revoked', 'ses_feedback', now() + interval '3 years' FROM revoked`,
                [email, emailHash]
              );
              await client.query(
                `WITH revoked AS (
                UPDATE product_alert_subscriptions SET active = false, revoked_at = now(), updated_at = now()
                WHERE lower(email) = $1 AND revoked_at IS NULL RETURNING id, organization_id, customer_id
              ) INSERT INTO marketing_consent_events (organization_id, subject_email_hash, customer_id,
                  product_alert_subscription_id, purpose, action, source, retain_until)
                SELECT organization_id, $2, customer_id, id, 'product_alert', 'revoked', 'ses_feedback',
                  now() + interval '3 years' FROM revoked`,
                [email, emailHash]
              );
            }
          }
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
        await this.sqs.send(
          new DeleteMessageCommand({
            QueueUrl: this.queueUrl,
            ReceiptHandle: message.ReceiptHandle
          })
        );
      }
    } catch (error) {
      this.logger.error(
        { errorName: error instanceof Error ? error.name : 'UnknownError' },
        'SES feedback processing failed'
      );
    } finally {
      this.readingFeedback = false;
    }
  }
}
