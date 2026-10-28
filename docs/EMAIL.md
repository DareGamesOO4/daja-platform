# Storefront email

Contact requests go to `CONTACT_NOTIFICATION_EMAIL` (default `cvelenis42@yahoo.com`). The customer's validated address is used only as Reply-To; the sender remains a verified `@dajashop.rs` identity. The public endpoint validates lengths, limits requests, and ignores the honeypot. A request UUID prevents duplicate contact deliveries on retries.

API emails and privacy-worker notifications are stored in `email_deliveries`. Order creation, registration, verification/reset token creation, newsletter confirmation, and product notification claims enqueue messages in the same database transaction as the associated change. HTTP success means the message was saved for delivery, not that the recipient received it. Queue persistence does not require SES credentials on the API and missing credentials cannot roll back an otherwise valid order. The dedicated worker sends messages independently of API uptime. SES failures are retained and retried with backoff until expiry. Sending is limited to one message per 1.1 seconds across worker replicas. Delivery is at least once; a crash after SES acceptance and before the database acknowledgement can cause a duplicate.

Newsletter signup remains inactive until the recipient explicitly confirms through `/newsletter-confirm`. Guest product alerts similarly require an explicit confirmation through `/product-alert-confirm`. An email-only request stores a pending intent and cannot replace an existing owner's management key or change active subscriptions. The management key is returned only after email confirmation. Existing guest keys issued without proof are invalidated by migration 087; those subscriptions need a fresh opt-in. Unverified customer accounts cannot inspect or revoke alerts using their claimed email address.

The public newsletter signup response contains status flags only; signed unsubscribe links and subscriber identifiers are never returned to anonymous callers. Newsletter and guest alert confirmation links expire after 24 hours; account verification and password reset links expire after 15 and 30 minutes respectively. Verification and newsletter confirmation safely accept repeats, including a retry after a lost HTTP response, without granting consent again after revocation. Reset and verification requests have an atomic five-minute cooldown per customer; guest confirmation requests have a five-minute cooldown per intent and a five-per-hour email limit. Invalidating requests do not bypass these limits by switching IP address.

Security links have priority over transactional messages, then marketing/product messages. The worker checks a link's current database token and requires at least two minutes of remaining validity before sending it. It does not extend tokens independently of their database expiry. Superseded, used and almost-expired links are expired in the queue. Request a fresh link when needed. Repeating an unchanged order status neither writes new status history nor queues another email; actual transitions use the order version as a deduplication key.

GET unsubscribe links only open a confirmation page; the button submits POST. RFC 8058 POST remains an immediate unsubscribe, without login or another confirmation. Link scanners following GET cannot revoke consent. Revocation and local suppressions prevent pending marketing/product emails from being sent.

Configure SES credentials and delivery settings **on the worker service**, not only in the frontend's local environment:

- `SES_REGION=eu-north-1`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`
- `SES_FROM_EMAIL=DajaShop <novosti@dajashop.rs>`
- `SES_ACCOUNT_FROM_EMAIL=DajaShop <nalog@dajashop.rs>`
- `SES_ORDER_FROM_EMAIL=DajaShop <porudzbine@dajashop.rs>`
- `SES_REPLY_TO_EMAIL` with a monitored, verified address
- `STOREFRONT_PUBLIC_BASE_URL=https://dajashop.rs`
- `SES_CONFIGURATION_SET=my-first-configuration-set`
- `SES_FEEDBACK_QUEUE_NAME=dajashop-email-feedback`
- `CONTACT_NOTIFICATION_EMAIL=cvelenis42@yahoo.com`
- `API_PUBLIC_BASE_URL=https://daja-platform-api.onrender.com`
- `PRIVACY_TOKEN_SECRET` (or the `JWT_ACCESS_SECRET` fallback), identical on API and worker

Scheduled regular-price and sale-start events are dispatched by the worker every minute, including when the API is stopped. For SMS price alerts the worker also needs `SNS_SMS_REGION`, `SNS_SMS_ACCESS_KEY_ID`, `SNS_SMS_SECRET_ACCESS_KEY` and `SNS_SMS_SENDER_ID`; these are separate from SES settings. Render production configuration is deferred and has not been changed or verified by this source update.

The API still needs `ORDER_NOTIFICATION_EMAILS` for order notification recipients, `CONTACT_NOTIFICATION_EMAIL`, and `STOREFRONT_PUBLIC_BASE_URL` for links and templates. Sender and Reply-To settings may be provided on the API to override worker defaults; SES credentials are used only by the worker. Contact messages always preserve the customer's validated Reply-To address.

The worker processes both ordinary emails and saved privacy notifications. It applies database migrations before starting consumers, so it can start without the API; an active API migration is allowed to finish under the shared advisory lock. Both Docker images include the migration files. On shutdown the email consumer stops claiming work, waits up to 20 seconds for active network work, and closes before the worker's database pool. Without SES configuration it logs a warning; expiration, cleanup, queue warnings and database heartbeat continue to run.

SES event publishing is connected to SNS `dajashop-email-feedback` and the same-named SQS queue in `eu-north-1`. The worker polls that queue with the SES IAM user's narrowly scoped SQS permissions. Permanent bounces and complaints are deduplicated, recorded and suppressed locally; newsletter and product subscriptions are deactivated. Transient bounces are recorded without permanently suppressing the address. SNS/SQS policies restrict publishers to this account's SES and this feedback topic. Email forwarding remains enabled as an additional operational channel.

Feedback messages are validated and processed independently. A malformed event does not block the remaining batch and is not acknowledged. The source SQS queue redrives to `dajashop-email-feedback-dlq` after five receives; the DLQ retains messages for 14 days and only accepts redrive from this source queue. Inspect worker error logs and the DLQ before correcting and redriving events; do not delete them merely to clear an alert.

Operations: the admin privacy tab includes an email panel, scoped by organization and protected by `privacy.manage`. `GET /admin/emails` reports status counts, oldest queued time, recent unsent messages and the worker/feedback heartbeat. `POST /admin/emails/:id/retry` brings forward a recoverable pending/failed message without resetting attempts or reviving expired/suppressed messages. Configuration failures keep their body only until expiry for a controlled retry. Invalid terminal payloads, expired/suppressed bodies and successfully accepted bodies are scrubbed; delivery records are removed after 30 days. Old queue records are assigned from subscription/publication metadata or the sole organization if unambiguous; unattributed records in a multi-organization database remain visible only to database operators and global worker backlog warnings. `email_feedback_events` are retained for 90 days.

Monitor `email_deliveries`, `email_feedback_events`, the admin panel and worker logs. The worker warns when any message waits over 15 minutes or a security message waits over one minute. Sender-side acceptance is not inbox delivery. SES has no end-to-end idempotency key for this flow, so the acceptance/database crash window still means at-least-once delivery; this does not promise exactly one physical email.

The SES sandbox is intentional for current testing and must remain enabled. Arbitrary unverified recipients remain blocked by AWS; these code changes do not request production access. No synthetic messages are sent as part of deployment.
