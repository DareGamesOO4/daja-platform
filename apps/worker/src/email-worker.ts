import { createHash } from 'node:crypto';
import { GetAccountCommand, SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import {
  SQSClient,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand
} from '@aws-sdk/client-sqs';
import { orderNotificationRecipients, type AppConfig } from '@daja/config';
import type { Database, QueuedEmail } from '@daja/database';
import type { Logger } from '@daja/observability';

interface DeliveryRow {
  id: string;
  recipient: string;
  payload: QueuedEmail;
  attempts: number;
  firebase_fallback: boolean;
}

type SesSendingMode = 'disabled' | 'sandbox' | 'production';
const firebaseEmailTags = [
  'order-confirmation', 'new-order-notification', 'order-status-update',
  'potvrda-email-adrese', 'promena-lozinke'
];

export class EmailWorker {
  private client: SESv2Client | undefined;
  private sqs: SQSClient | undefined;
  private queueUrl: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private feedbackTimer: NodeJS.Timeout | undefined;
  private dispatching = false;
  private readingFeedback = false;
  private maintenanceAt = 0;
  private checkAccountAt = 0;
  private sendingMode: SesSendingMode = 'disabled';
  private readonly internalOrderRecipients: string[];
  private stopping = false;
  private started = false;
  private dispatchTask: Promise<void> | undefined;
  private feedbackTask: Promise<void> | undefined;
  private readonly abort = new AbortController();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly database: Database
  ) {
    this.internalOrderRecipients = orderNotificationRecipients(config).map(email => email.toLowerCase());
  }

  start(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    if (!this.isConfigured() && !this.hasFirebaseFallback()) {
      this.logger.warn('No email transport is configured on the worker; messages remain queued');
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

  private hasFirebaseFallback(): boolean {
    return Boolean(this.config.FIREBASE_EMAIL_URL && this.config.FIREBASE_EMAIL_SECRET &&
      this.config.SES_ORDER_FROM_EMAIL && this.config.SES_ACCOUNT_FROM_EMAIL);
  }

  private credentials() {
    return {
      accessKeyId: this.config.SES_ACCESS_KEY_ID,
      secretAccessKey: this.config.SES_SECRET_ACCESS_KEY
    };
  }

  private sesClient(): SESv2Client {
    return this.client ??= new SESv2Client({
      region: this.config.SES_REGION,
      credentials: this.credentials(),
      // The outbox owns send retries after an ambiguous response.
      maxAttempts: 1
    });
  }

  private async refreshSendingMode(): Promise<SesSendingMode> {
    if (Date.now() < this.checkAccountAt) return this.sendingMode;
    this.checkAccountAt = Date.now() + 60_000;
    this.sendingMode = 'disabled';
    try {
      const account = await this.sesClient().send(new GetAccountCommand({}), {
        abortSignal: this.requestSignal()
      });
      if (account.SendingEnabled === true) {
        this.sendingMode = account.ProductionAccessEnabled === true ? 'production' : 'sandbox';
      }
    } catch (error) {
      this.logger.warn({ errorName: (error as Error).name }, 'Could not read SES account status');
    }
    return this.sendingMode;
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
        last_error = s.reason FROM email_suppressions s WHERE d.recipient = s.email AND (d.status = 'pending' OR (d.status = 'sending' AND d.locked_until < now()))`);
        await this.database.pool.query(`UPDATE email_deliveries d SET status = 'suppressed',
        last_error = 'Consent revoked or subscription removed'
        WHERE (d.status = 'pending' OR (d.status = 'sending' AND d.locked_until < now())) AND (
          (d.payload->>'newsletterSubscriberId' IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM newsletter_subscribers s WHERE s.id::text = d.payload->>'newsletterSubscriberId' AND s.active))
          OR (d.payload->>'productAlertSubscriptionId' IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM product_alert_subscriptions s WHERE s.id::text = d.payload->>'productAlertSubscriptionId' AND s.revoked_at IS NULL)))`);
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
          [this.config.SES_REGION, this.isConfigured() || this.hasFirebaseFallback(), Boolean(this.isConfigured() && this.config.SES_FEEDBACK_QUEUE_NAME),
            Boolean(this.config.PRIVACY_TOKEN_SECRET || this.config.JWT_ACCESS_SECRET)]);
        const backlog = await this.database.pool.query<{ pending: number; oldest_seconds: number; oldest_security_seconds: number }>(`SELECT
          count(*)::int AS pending, COALESCE(EXTRACT(epoch FROM now() - min(created_at)), 0)::int AS oldest_seconds,
          COALESCE(EXTRACT(epoch FROM now() - min(created_at) FILTER (WHERE priority = 0)), 0)::int AS oldest_security_seconds
          FROM email_deliveries WHERE status IN ('pending','sending')`);
        const health = backlog.rows[0];
        if (health && (health.oldest_seconds > 900 || health.oldest_security_seconds > 60)) {
          this.logger.warn({ ...health, senderConfigured: this.isConfigured() || this.hasFirebaseFallback() }, 'Email queue requires operator attention');
        }
        await this.database.pool.query(`DELETE FROM product_alert_confirmations WHERE expires_at < now() - interval '1 day'`);
        await this.database.pool.query(`DELETE FROM email_feedback_events WHERE created_at < now() - interval '90 days'`);
        this.maintenanceAt = Date.now() + 60_000;
      }
      const fallback = this.hasFirebaseFallback();
      if (this.stopping || (!this.isConfigured() && !fallback)) return;
      const mode = this.isConfigured() ? await this.refreshSendingMode() : 'disabled';
      if (this.stopping || (mode === 'disabled' && !fallback)) return;
      // Keep the existing shared limit across worker replicas.
      const permit = await this.database.pool.query(
        `INSERT INTO email_sender_limits (region, next_attempt_at)
        VALUES ($1, now() + interval '1100 milliseconds') ON CONFLICT (region) DO UPDATE
        SET next_attempt_at = EXCLUDED.next_attempt_at WHERE email_sender_limits.next_attempt_at <= now() RETURNING region`,
        [this.config.SES_REGION]
      );
      if (!permit.rowCount) return;
      const claimed = await this.database.pool.query<DeliveryRow>(`WITH candidate AS (
        SELECT queued.id, queued.ses_timeout_at IS NOT NULL OR (queued.payload->>'firebaseFallback' = 'true') IS TRUE OR NOT
          ($1::text = 'production' OR ($1 = 'sandbox' AND queued.tag IN ('new-order-notification', 'studio-health-alert')
            AND lower(queued.recipient) = ANY($2::text[]))) AS firebase_fallback
        FROM email_deliveries queued
        WHERE expires_at > now() + minimum_validity_seconds * interval '1 second' AND available_at <= now()
          AND (status = 'pending' OR (status = 'sending' AND locked_until < now()))
          AND (CASE WHEN queued.ses_timeout_at IS NOT NULL OR queued.payload->>'firebaseFallback' = 'true' THEN $3::boolean
            ELSE $1 = 'production' OR ($1 = 'sandbox' AND queued.tag IN ('new-order-notification', 'studio-health-alert')
              AND lower(queued.recipient) = ANY($2::text[]))
              OR ($3::boolean AND queued.attempts = 0 AND queued.tag = ANY($4::text[])) END)
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
          payload = CASE WHEN candidate.firebase_fallback THEN d.payload || '{"firebaseFallback":true}'::jsonb ELSE d.payload END,
          locked_until = now() + interval '5 minutes'
        FROM candidate WHERE d.id = candidate.id RETURNING d.id, d.recipient, d.payload, d.attempts, candidate.firebase_fallback`,
        [mode, this.internalOrderRecipients, fallback, firebaseEmailTags]);
      const row = claimed.rows[0];
      if (row) await this.deliver(row);
    } catch (error) {
      this.logger.error({ err: error }, 'Email queue processing failed');
    } finally {
      this.dispatching = false;
    }
  }

  private async deliverViaFirebase(row: DeliveryRow): Promise<void> {
    const input = row.payload;
    try {
      const claim = await this.database.pool.query(
        `SELECT id FROM email_deliveries WHERE id = $1 AND status = 'sending' AND attempts = $2`,
        [row.id, row.attempts]
      );
      if (!claim.rowCount) return;
      const response = await fetch(this.config.FIREBASE_EMAIL_URL, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${this.config.FIREBASE_EMAIL_SECRET}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          id: row.id,
          from: this.sender(input),
          to: row.recipient,
          subject: input.subject,
          text: input.text,
          html: input.html,
          replyTo: input.replyTo?.length ? input.replyTo : this.config.SES_REPLY_TO_EMAIL || undefined
        }),
        signal: this.requestSignal()
      });
      if (response.status !== 204) throw new Error(`Firebase Email HTTP ${response.status}`);
      const acceptedAt = Date.parse(response.headers.get('x-daja-accepted-at') ?? '');
      await this.database.pool.query(
        `UPDATE email_deliveries SET status = 'sent', sent_at = COALESCE(sent_at, $2, now()),
          icloud_accepted_at = COALESCE(icloud_accepted_at, $2, now()),
          locked_until = NULL, last_error = NULL, payload = '{}'::jsonb WHERE id = $1`,
        [row.id, Number.isFinite(acceptedAt) ? new Date(acceptedAt) : null]
      );
      this.logger.info({ deliveryId: row.id, tag: input.tag }, 'Email accepted by Firebase SMTP');
    } catch (error) {
      const delay = Math.min(3600, 15 * 2 ** Math.min(row.attempts, 8));
      await this.database.pool.query(
        `UPDATE email_deliveries SET status = 'pending', locked_until = NULL,
          available_at = now() + $2 * interval '1 second', last_error = $3
          WHERE id = $1 AND status = 'sending' AND attempts = $4`,
        [row.id, delay, 'Firebase SMTP acceptance unconfirmed', row.attempts]
      );
      this.logger.warn({ deliveryId: row.id, errorName: (error as Error).name }, 'Firebase SMTP acceptance unconfirmed');
    }
  }

  private async deliver(row: DeliveryRow): Promise<void> {
    if (row.firebase_fallback) {
      await this.deliverViaFirebase(row);
      return;
    }
    const input = row.payload;
    let accepted = false;
    let messageId: string | undefined;
    const signal = this.requestSignal();
    try {
      const response = await this.sesClient().send(
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
          EmailTags: [{ Name: 'type', Value: input.tag }, { Name: 'daja_delivery_id', Value: row.id }]
        }),
        { abortSignal: signal }
      );
      accepted = true;
      messageId = response.MessageId;
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
      if (accepted) {
        // SES has already accepted the message. Keep its lease rather than immediately scheduling another send.
        this.logger.error({ deliveryId: row.id, messageId, errorName: error instanceof Error ? error.name : 'UnknownError' },
          'Email accepted by SES but database acknowledgement failed; reconcile this message before retrying');
        return;
      }
      const name = error instanceof Error ? error.name : 'UnknownError';
      if (this.hasFirebaseFallback() && firebaseEmailTags.includes(input.tag) &&
          (signal.reason?.name === 'TimeoutError' || name === 'TimeoutError')) {
        await this.database.pool.query(
          `UPDATE email_deliveries SET status = 'pending', locked_until = NULL,
            available_at = now() + interval '60 seconds', ses_timeout_at = now(),
            last_error = 'Waiting for SES feedback after timeout'
          WHERE id = $1 AND status = 'sending' AND attempts = $2`,
          [row.id, row.attempts]
        );
        this.logger.warn({ deliveryId: row.id }, 'SES timed out; waiting 60 seconds for feedback');
        return;
      }
      // Only a definitive service rejection on the first attempt can switch transports.
      if (row.attempts === 1 && this.hasFirebaseFallback() && firebaseEmailTags.includes(input.tag) &&
          ['TooManyRequestsException', 'AccountSuspendedException', 'SendingPausedException',
            'MailFromDomainNotVerifiedException', 'ForbiddenException', 'NotFoundException', 'LimitExceededException'].includes(name)) {
        const switched = await this.database.pool.query(
          `UPDATE email_deliveries SET payload = payload || '{"firebaseFallback":true}'::jsonb
            WHERE id = $1 AND status = 'sending' AND attempts = $2`,
          [row.id, row.attempts]
        );
        if (switched.rowCount) await this.deliverViaFirebase(row);
        return;
      }
      // Configuration and sandbox rejections can recover without replacing the message.
      const failed = name === 'BadRequestException';
      const retryable = failed && error instanceof Error && /configuration|verified|paused|account|sending disabled/i.test(error.message);
      const delay = Math.min(3600, 15 * 2 ** Math.min(row.attempts, 8));
      await this.database.pool.query(
        `UPDATE email_deliveries SET status = $2, locked_until = NULL,
        available_at = now() + $3 * interval '1 second', last_error = $4, retryable = $5
        WHERE id = $1 AND status = 'sending' AND attempts = $6`,
        [
          row.id,
          failed ? 'failed' : 'pending',
          delay,
          error instanceof Error ? `${name}: ${error.message}`.slice(0, 500) : name,
          retryable,
          row.attempts
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
          const event = parseSesFeedback(message.Body);
          const kind = event.kind;
          const recipients = event.suppressedRecipients;
          const fingerprint = 'ses:' + createHash('sha256').update(message.Body).digest('hex');
          const client = await this.database.pool.connect();
          try {
            await client.query('BEGIN');
            const inserted = await client.query(
              `INSERT INTO email_feedback_events (event_id, event_type, ses_message_id)
              SELECT $1,$2,$3 WHERE NOT EXISTS (SELECT 1 FROM email_feedback_events WHERE event_id = $4)
              ON CONFLICT DO NOTHING RETURNING event_id`,
              [fingerprint, kind, event.messageId, message.MessageId]
            );
            if (inserted.rowCount) {
              if (event.deliveryId && ['Send', 'Delivery', 'DeliveryDelay'].includes(kind)) {
                await client.query(
                  `WITH previous AS (
                    SELECT id, (payload->>'policyDeliveryId')::uuid AS policy_id FROM email_deliveries
                    WHERE id = $1 AND attempts > 0 AND status IN ('pending', 'sending', 'sent') FOR UPDATE
                  ), accepted AS (
                    UPDATE email_deliveries d SET status = 'sent', sent_at = COALESCE(sent_at, now()),
                      ses_message_id = COALESCE(ses_message_id, $2),
                      ses_delivered_at = CASE WHEN $3 = 'Delivery' THEN COALESCE(ses_delivered_at, now()) ELSE ses_delivered_at END,
                      locked_until = NULL, last_error = NULL, payload = '{}'::jsonb
                    FROM previous WHERE d.id = previous.id RETURNING previous.policy_id
                  ) UPDATE policy_notification_deliveries SET status = 'sent', sent_at = COALESCE(sent_at, now()), last_error = NULL
                  WHERE id = (SELECT policy_id FROM accepted)`,
                  [event.deliveryId, event.messageId, kind]
                );
              }
              for (const recipient of recipients ?? []) {
                const email = recipient;
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
          this.logger.error({ messageId: message.MessageId, errorName: error instanceof Error ? error.name : 'UnknownError',
            reason: error instanceof Error && error.message.startsWith('Invalid SES ') ? error.message : undefined },
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

interface SesFeedback {
  kind: string;
  messageId: string;
  suppressedRecipients: string[];
  deliveryId?: string;
}

function parseSesFeedback(body: string): SesFeedback {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new Error('Invalid SES JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid SES event');
  const event = parsed as {
    eventType?: unknown; notificationType?: unknown; mail?: { messageId?: unknown; tags?: Record<string, unknown> };
    bounce?: { bounceType?: unknown; bouncedRecipients?: unknown };
    complaint?: { complainedRecipients?: unknown };
  };
  const kind = event.notificationType || event.eventType;
  if (typeof kind !== 'string' || !['Bounce','Complaint','Delivery','DeliveryDelay','Reject','Rendering Failure',
    'RenderingFailure','Send','Open','Click','Subscription'].includes(kind)
    || typeof event.mail?.messageId !== 'string' || !event.mail.messageId.trim()) {
    throw new Error('Invalid SES feedback envelope');
  }
  if (kind === 'Bounce' && !['Permanent','Transient','Undetermined'].includes(String(event.bounce?.bounceType))) {
    throw new Error('Invalid SES bounce type');
  }
  const affected = kind === 'Complaint' ? event.complaint?.complainedRecipients
    : kind === 'Bounce' ? event.bounce?.bouncedRecipients : [];
  if (!Array.isArray(affected) || (['Bounce','Complaint'].includes(kind) && !affected.length)) {
    throw new Error('Invalid SES feedback recipients');
  }
  const recipients = affected.map((value: unknown) => {
    const address = value && typeof value === 'object' ? (value as { emailAddress?: unknown }).emailAddress : null;
    if (typeof address !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address.trim())) {
      throw new Error('Invalid SES feedback address');
    }
    return address.trim().toLowerCase();
  });
  const deliveryTags = event.mail.tags?.daja_delivery_id;
  const deliveryId = Array.isArray(deliveryTags) && typeof deliveryTags[0] === 'string' &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(deliveryTags[0]) ? deliveryTags[0] : undefined;
  return { kind, messageId: event.mail.messageId, ...(deliveryId ? { deliveryId } : {}), suppressedRecipients:
    kind === 'Complaint' || (kind === 'Bounce' && event.bounce?.bounceType === 'Permanent') ? [...new Set(recipients)] : [] };
}
