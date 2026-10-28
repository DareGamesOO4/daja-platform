import { createHash } from 'node:crypto';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import {
  SQSClient,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand
} from '@aws-sdk/client-sqs';
import type { AppConfig } from '@daja/config';
import type { Database, QueuedEmail } from '@daja/database';
import type { Logger } from '@daja/observability';

interface DeliveryRow {
  id: string;
  recipient: string;
  payload: QueuedEmail;
  attempts: number;
}

export class EmailWorker {
  private client: SESv2Client | undefined;
  private sqs: SQSClient | undefined;
  private queueUrl: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private feedbackTimer: NodeJS.Timeout | undefined;
  private dispatching = false;
  private readingFeedback = false;
  private maintenanceAt = 0;
  private stopping = false;
  private started = false;
  private dispatchTask: Promise<void> | undefined;
  private feedbackTask: Promise<void> | undefined;
  private readonly abort = new AbortController();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly database: Database
  ) {}

  start(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    if (!this.isConfigured()) {
      this.logger.warn('Amazon SES is not configured on the worker; messages remain queued');
    }
    this.timer = setInterval(() => this.scheduleDispatch(), 1200);
    this.feedbackTimer = setInterval(() => this.scheduleFeedback(), 5000);
    this.timer.unref();
    this.feedbackTimer.unref();
    this.scheduleDispatch();
    this.scheduleFeedback();
    this.logger.info('Email delivery and SES feedback worker started');
  }

  async close(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.feedbackTimer) clearInterval(this.feedbackTimer);
    // Let accepted deliveries finish before closing database connections.
    const deadline = setTimeout(() => this.abort.abort(), 20_000);
    try {
      await Promise.allSettled([this.dispatchTask, this.feedbackTask]);
    } finally {
      clearTimeout(deadline);
      this.abort.abort();
      this.client?.destroy();
      this.sqs?.destroy();
    }
  }

  private scheduleDispatch(): void {
    if (this.stopping || this.dispatchTask) return;
    this.dispatchTask = this.dispatch().finally(() => {
      this.dispatchTask = undefined;
    });
  }

  private scheduleFeedback(): void {
    if (this.stopping || this.feedbackTask || !this.isConfigured()) return;
    this.feedbackTask = this.readFeedback().finally(() => {
      this.feedbackTask = undefined;
    });
  }

  private requestSignal(): AbortSignal {
    return AbortSignal.any([this.abort.signal, AbortSignal.timeout(20_000)]);
  }

  private sender(input: QueuedEmail): string {
    if (input.fromEmail?.trim()) return input.fromEmail.trim();
    if (
      ['order-confirmation', 'new-order-notification', 'order-status-update'].includes(input.tag)
    ) {
      return this.config.SES_ORDER_FROM_EMAIL || this.config.SES_FROM_EMAIL;
    }
    if (['potvrda-email-adrese', 'promena-lozinke', 'contact-message'].includes(input.tag)) {
      return this.config.SES_ACCOUNT_FROM_EMAIL || this.config.SES_FROM_EMAIL;
    }
    return this.config.SES_FROM_EMAIL;
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
        await this.database.pool.query(`UPDATE email_deliveries d SET status = 'expired',
          last_error = 'Link already used, superseded, or too close to expiry'
          WHERE (d.status IN ('pending','failed') OR (d.status = 'sending' AND d.locked_until < now()))
            AND d.payload->>'linkTokenHash' IS NOT NULL AND NOT EXISTS (
              SELECT 1 FROM email_active_links l WHERE l.token_hash = d.payload->>'linkTokenHash' AND l.tag = d.tag
                AND l.expires_at > now() + d.minimum_validity_seconds * interval '1 second')`);
        await this.database.pool
          .query(`UPDATE email_deliveries SET status = 'expired', last_error = 'Message expired before delivery'
        WHERE expires_at <= now() + minimum_validity_seconds * interval '1 second'
          AND (status = 'pending' OR (status = 'sending' AND locked_until < now()))`);
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
        WHERE (status IN ('expired','suppressed') OR (status = 'failed' AND (NOT retryable OR expires_at <= now())))
          AND payload <> '{}'::jsonb`);
        await this.database.pool
          .query(`DELETE FROM email_deliveries WHERE status IN ('sent','failed','suppressed','expired')
        AND created_at < now() - interval '30 days'`);
        await this.database.pool.query(`INSERT INTO email_worker_health
          (region, heartbeat_at, sender_configured, feedback_configured, product_alerts_configured) VALUES ($1, now(), $2, $3, $4)
          ON CONFLICT (region) DO UPDATE SET heartbeat_at = now(), sender_configured = $2, feedback_configured = $3, product_alerts_configured = $4`,
          [this.config.SES_REGION, this.isConfigured(), Boolean(this.isConfigured() && this.config.SES_FEEDBACK_QUEUE_NAME),
            Boolean(this.config.PRIVACY_TOKEN_SECRET || this.config.JWT_ACCESS_SECRET)]);
        const backlog = await this.database.pool.query<{ pending: number; oldest_seconds: number; oldest_security_seconds: number }>(`SELECT
          count(*)::int AS pending, COALESCE(EXTRACT(epoch FROM now() - min(created_at)), 0)::int AS oldest_seconds,
          COALESCE(EXTRACT(epoch FROM now() - min(created_at) FILTER (WHERE priority = 0)), 0)::int AS oldest_security_seconds
          FROM email_deliveries WHERE status IN ('pending','sending')`);
        const health = backlog.rows[0];
        if (health && (health.oldest_seconds > 900 || health.oldest_security_seconds > 60)) {
          this.logger.warn({ ...health, senderConfigured: this.isConfigured() }, 'Email queue requires operator attention');
        }
        await this.database.pool.query(`DELETE FROM product_alert_confirmations WHERE expires_at < now() - interval '1 day'`);
        await this.database.pool.query(`DELETE FROM email_feedback_events WHERE created_at < now() - interval '90 days'`);
        this.maintenanceAt = Date.now() + 60_000;
      }
      if (!this.isConfigured() || this.stopping) return;
      // This shared permit also limits multiple worker replicas to the sandbox rate.
      const permit = await this.database.pool.query(
        `INSERT INTO email_sender_limits (region, next_attempt_at)
        VALUES ($1, now() + interval '1100 milliseconds') ON CONFLICT (region) DO UPDATE
        SET next_attempt_at = EXCLUDED.next_attempt_at WHERE email_sender_limits.next_attempt_at <= now() RETURNING region`,
        [this.config.SES_REGION]
      );
      if (!permit.rowCount) return;
      const claimed = await this.database.pool.query<DeliveryRow>(`WITH candidate AS (
        SELECT queued.id FROM email_deliveries queued
        WHERE expires_at > now() + minimum_validity_seconds * interval '1 second' AND available_at <= now()
          AND (status = 'pending' OR (status = 'sending' AND locked_until < now()))
          AND NOT EXISTS (SELECT 1 FROM email_suppressions s WHERE s.email = queued.recipient)
          AND (queued.payload->>'linkTokenHash' IS NULL OR EXISTS (
            SELECT 1 FROM email_active_links l WHERE l.token_hash = queued.payload->>'linkTokenHash' AND l.tag = queued.tag
              AND l.expires_at > now() + queued.minimum_validity_seconds * interval '1 second'))
          AND (queued.payload->>'newsletterSubscriberId' IS NULL OR EXISTS (
            SELECT 1 FROM newsletter_subscribers s WHERE s.id::text = queued.payload->>'newsletterSubscriberId' AND s.active))
          AND (queued.payload->>'productAlertSubscriptionId' IS NULL OR EXISTS (
            SELECT 1 FROM product_alert_subscriptions s WHERE s.id::text = queued.payload->>'productAlertSubscriptionId' AND s.revoked_at IS NULL))
        ORDER BY priority, created_at FOR UPDATE SKIP LOCKED LIMIT 1
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
          FromEmailAddress: this.sender(input),
          Destination: { ToAddresses: [row.recipient] },
          ReplyToAddresses: input.replyTo?.length
            ? input.replyTo
            : this.config.SES_REPLY_TO_EMAIL
              ? [this.config.SES_REPLY_TO_EMAIL]
              : undefined,
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
        }),
        { abortSignal: this.requestSignal() }
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
      // Configuration and sandbox rejections can recover without replacing the message.
      const failed = name === 'BadRequestException';
      const retryable = failed && error instanceof Error && /configuration|verified|paused|account|sending disabled/i.test(error.message);
      const delay = Math.min(3600, 15 * 2 ** Math.min(row.attempts, 8));
      await this.database.pool.query(
        `UPDATE email_deliveries SET status = $2, locked_until = NULL,
        available_at = now() + $3 * interval '1 second', last_error = $4, retryable = $5 WHERE id = $1`,
        [
          row.id,
          failed ? 'failed' : 'pending',
          delay,
          error instanceof Error ? `${name}: ${error.message}`.slice(0, 500) : name,
          retryable
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
          new GetQueueUrlCommand({ QueueName: this.config.SES_FEEDBACK_QUEUE_NAME }),
          { abortSignal: this.requestSignal() }
        )
      ).QueueUrl;
      if (!this.queueUrl) return;
      const messages = await this.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: this.queueUrl,
          MaxNumberOfMessages: 10,
          VisibilityTimeout: 60,
          WaitTimeSeconds: 0
        }),
        { abortSignal: this.requestSignal() }
      );
      for (const message of messages.Messages ?? []) {
        if (this.stopping) break;
        if (!message.Body || !message.ReceiptHandle || !message.MessageId) continue;
        try {
        const parsed: unknown = JSON.parse(message.Body);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid SES event');
        const event = parsed as {
          notificationType?: string;
          eventType?: string;
          mail?: { messageId?: string };
          bounce?: { bounceType?: string; bouncedRecipients?: Array<{ emailAddress: string }> };
          complaint?: { complainedRecipients?: Array<{ emailAddress: string }> };
        };
        const kind = event.notificationType || event.eventType;
        if (typeof kind !== 'string' || !['Bounce','Complaint','Delivery','DeliveryDelay','Reject','Rendering Failure',
          'RenderingFailure','Send','Open','Click','Subscription'].includes(kind) || typeof event.mail?.messageId !== 'string') {
          throw new Error('Invalid SES feedback envelope');
        }
        if (kind === 'Bounce' && !['Permanent','Transient','Undetermined'].includes(event.bounce?.bounceType ?? '')) {
          throw new Error('Invalid SES bounce type');
        }
        const affected = kind === 'Complaint' ? event.complaint?.complainedRecipients : kind === 'Bounce' ? event.bounce?.bouncedRecipients : [];
        if (!Array.isArray(affected) || (['Bounce', 'Complaint'].includes(kind) && !affected.length) || affected.some(value => !value || typeof value.emailAddress !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.emailAddress))) {
          throw new Error('Invalid SES feedback recipients');
        }
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
          }),
          { abortSignal: this.requestSignal() }
        );
        } catch (error) {
          // Keep this receipt for SQS redrive; one bad event must not block the rest of the batch.
          this.logger.error({ messageId: message.MessageId, errorName: error instanceof Error ? error.name : 'UnknownError' },
            'SES feedback message failed; retained for retry or dead-letter queue');
          await this.database.pool.query('UPDATE email_worker_health SET feedback_error_at = now() WHERE region = $1', [this.config.SES_REGION]);
        }
      }
      await this.database.pool.query('UPDATE email_worker_health SET feedback_checked_at = now() WHERE region = $1', [this.config.SES_REGION]);
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
