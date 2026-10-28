# Storefront email

Contact requests go to `CONTACT_NOTIFICATION_EMAIL` (default `cvelenis42@yahoo.com`). The customer's validated address is used only as Reply-To; the sender remains a verified `@dajashop.rs` identity. The public endpoint validates lengths, limits requests, and ignores the honeypot. A request UUID prevents duplicate contact deliveries on retries.

API emails and privacy-worker notifications are stored in `email_deliveries`. Order creation, registration, verification/reset token creation, newsletter confirmation, and product notification claims enqueue messages in the same database transaction as the associated change. HTTP success means the message was saved for delivery, not that the recipient received it. SES failures are retained and retried with backoff until expiry. Sending is limited to one message per 1.1 seconds across API replicas. Delivery is at least once; a crash after SES acceptance and before the database acknowledgement can cause a duplicate.

Newsletter signup remains inactive until the recipient explicitly confirms through `/newsletter-confirm`. Confirmation links expire after 24 hours; account verification and password reset links expire after 15 and 30 minutes respectively. Unsubscribe links support both normal navigation and RFC 8058 POST requests. Revocation and local suppressions prevent pending marketing/product emails from being sent.

Configure these variables **on the API service**, not only in the frontend's local environment:

- `SES_REGION=eu-north-1`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`
- `SES_FROM_EMAIL=DajaShop <novosti@dajashop.rs>`
- `SES_ACCOUNT_FROM_EMAIL=DajaShop <nalog@dajashop.rs>`
- `SES_ORDER_FROM_EMAIL=DajaShop <porudzbine@dajashop.rs>`
- `SES_REPLY_TO_EMAIL` with a monitored, verified address
- `ORDER_NOTIFICATION_EMAILS` for order notifications
- `STOREFRONT_PUBLIC_BASE_URL=https://dajashop.rs`
- `SES_CONFIGURATION_SET=my-first-configuration-set`
- `SES_FEEDBACK_QUEUE_NAME=dajashop-email-feedback`
- `CONTACT_NOTIFICATION_EMAIL=cvelenis42@yahoo.com`

The privacy worker needs its sender, Reply-To and public-site settings; the API sends the saved privacy messages through the same delivery queue. API startup applies migration `086_reliable_email_delivery.sql` before starting the application.

SES event publishing is connected to SNS `dajashop-email-feedback` and the same-named SQS queue in `eu-north-1`. The API polls that queue with the SES IAM user's narrowly scoped SQS permissions. Permanent bounces and complaints are deduplicated, recorded and suppressed locally; newsletter and product subscriptions are deactivated. Transient bounces are recorded without permanently suppressing the address. SNS/SQS policies restrict publishers to this account's SES and this feedback topic. Email forwarding remains enabled as an additional operational channel.

Operations: inspect `email_deliveries` statuses/attempts/last_error and `email_feedback_events`; monitor API logs for queue/feedback failures. Terminal message bodies are removed, and delivery records expire after 30 days. Sender-side acceptance is not inbox delivery.

The AWS account remains in the SES sandbox until AWS approves production access. Arbitrary unverified recipients remain blocked by AWS; code changes do not remove that restriction. No synthetic messages are sent as part of deployment.
