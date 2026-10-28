# Storefront email

Contact requests go to `CONTACT_NOTIFICATION_EMAIL` (default `cvelenis42@yahoo.com`). The customer's validated address is used only as Reply-To; the sender remains a verified `@dajashop.rs` identity. The public endpoint validates lengths, limits requests, and ignores the honeypot. A request UUID prevents duplicate contact deliveries on retries.

API emails and privacy-worker notifications are stored in `email_deliveries`. Order creation, registration, verification/reset token creation, newsletter confirmation, and product notification claims enqueue messages in the same database transaction as the associated change. HTTP success means the message was saved for delivery, not that the recipient received it. Queue persistence does not require SES credentials on the API and missing credentials cannot roll back an otherwise valid order. The dedicated worker sends messages independently of API uptime. SES failures are retained and retried with backoff until expiry. Sending is limited to one message per 1.1 seconds across worker replicas. Delivery is at least once; a crash after SES acceptance and before the database acknowledgement can cause a duplicate.

Newsletter signup remains inactive until the recipient explicitly confirms through `/newsletter-confirm`. The public signup response contains status flags only; signed unsubscribe links and subscriber identifiers are never returned to anonymous callers. Confirmation links expire after 24 hours; account verification and password reset links expire after 15 and 30 minutes respectively. Unsubscribe links support both normal navigation and RFC 8058 POST requests. Revocation and local suppressions prevent pending marketing/product emails from being sent.

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

The API still needs `ORDER_NOTIFICATION_EMAILS` for order notification recipients, `CONTACT_NOTIFICATION_EMAIL`, and `STOREFRONT_PUBLIC_BASE_URL` for links and templates. Sender and Reply-To settings may be provided on the API to override worker defaults; SES credentials are used only by the worker. Contact messages always preserve the customer's validated Reply-To address.

The worker processes both ordinary emails and saved privacy notifications. It applies database migrations before starting consumers, so it can start without the API; an active API migration is allowed to finish under the shared advisory lock. Both Docker images include the migration files. On shutdown the email consumer stops claiming work, waits up to 20 seconds for active network work, and closes before the worker's database pool. Without SES configuration it logs a warning and leaves messages queued.

SES event publishing is connected to SNS `dajashop-email-feedback` and the same-named SQS queue in `eu-north-1`. The worker polls that queue with the SES IAM user's narrowly scoped SQS permissions. Permanent bounces and complaints are deduplicated, recorded and suppressed locally; newsletter and product subscriptions are deactivated. Transient bounces are recorded without permanently suppressing the address. SNS/SQS policies restrict publishers to this account's SES and this feedback topic. Email forwarding remains enabled as an additional operational channel.

Operations: inspect `email_deliveries` statuses/attempts/last_error and `email_feedback_events`; monitor worker logs for queue/feedback failures. Terminal message bodies are removed, and delivery records expire after 30 days. Sender-side acceptance is not inbox delivery.

The SES sandbox is intentional for current testing and must remain enabled. Arbitrary unverified recipients remain blocked by AWS; these code changes do not request production access. No synthetic messages are sent as part of deployment.
