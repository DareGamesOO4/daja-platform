# WhatsApp notifications — 05.11.2026

Cloud API notifications are separate from OTP and email. Existing email/SMS consent
is never reused. Production activation remains gated by explicit flags and secrets.

## Consent and unsubscribe

The storefront newsletter forms and product-alert dialog use
`POST /whatsapp/subscriptions/request` (phone, language sr/en, purpose newsletter /
price_change / back_in_stock, explicit consent, policy version; product/variant IDs
required for product alerts). Only Serbian recipient numbers are accepted initially.
The server returns a 30-minute `wa.me` link. No outbound message is sent to an
unverified number. Sending `DAJA <token>` from the entered number activates that
exact subscription. The database stores only the SHA-256 token hash. A short
confirmation reply is queued in the customer's language for a fresh inbound opt-in.

Inbound STOP / ODJAVA / UNSUBSCRIBE / PREKINI revokes all WhatsApp subscriptions for
that phone and organization, cancels pending deliveries, and leaves email and OTP
untouched. Consent changes and outbound sends share a phone advisory lock. An
already accepted/in-flight message cannot be recalled. New subscriptions require
a fresh opt-in; replayed or already-used confirmation messages do not reactivate them.

## Delivery and admin

Migration 103 stores consent, immutable campaign keys, queued messages and webhook
receipts/statuses. The API process scans up to 100 active product subscriptions
per tick in rotation; compares effective regular/sale price; checks published
products and inventory; queues changed-price or one-shot back-in-stock alerts.
Polling observes the current state, not every intermediate price/stock transition.
Back-in-stock delivery is consumed once Meta accepts it, not on proven delivery.

The API consumes one message per 15-second tick. Multiple instances claim separate
rows with SKIP LOCKED. An attempt is committed as `sending` before the network
call; interrupted/ambiguous sends become `unknown` and are not automatically retried.
Explicit Graph 4xx errors become `failed`; raw provider errors, phones and tokens
are not exposed. Queued messages expire after 23 hours. The shared Redis notification
budget defaults to 100 attempts per rolling 24 hours, independent of OTP's budget;
Redis data loss can reset it. Failed/unknown messages need operator investigation
and a fresh deliberate campaign/subscription after fixing the cause.

`accepted` means Meta accepted the request, not delivery. Signed status callbacks
advance to sent/delivered/read or failed; out-of-order statuses are retained even
if received before the send response is stored. Webhook receipts expire in 30 days;
unconfirmed expired subscription intents are removed after one day.

Admin WhatsApp tab requires `promotions.write`. It shows subscriber counts and the
last 30 outcomes, supports language-specific newsletter text, preview and explicit
send to confirmed recipients of that language. `POST /admin/whatsapp/campaigns`
accepts a UUID campaignId, language and text up to 900 characters. Repeating the
same campaign ID cannot enqueue a second copy. No campaign was actually sent.

## Webhook

Use the direct callback URL:
`https://daja-platform-api.onrender.com/api/v1/whatsapp/webhook`

GET verifies a separate verification token and returns the raw hub.challenge.
POST verifies X-Hub-Signature-256 with the Meta app secret over the original body
bytes before parsing; processes only the configured phone-number ID. Only this
exact GET/POST callback bypasses the DAJA edge key. All public subscriptions and
staff endpoints keep normal gateway/authentication/CSRF protection. A callback
on the browser storefront URL will encounter browser CSRF handling; use the direct
Render callback above. No customer or staff session is needed by Meta.

## Configuration

See `.env.example` and [WHATSAPP_SETUP.md](WHATSAPP_SETUP.md). Both OTP and
notifications remain disabled until their own approval/enable flags are set.
The notification approval flag means all three notification templates in both
languages are approved. An OTP-only setup can be enabled separately.

No tests, build, actual sending, migration execution or deployment-completion
verification were performed for this change, per the user's instructions.

Provider references:
- https://www.postman.com/meta/whatsapp-business-platform/request/o65u5m5/send-message-template-text
- https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/
