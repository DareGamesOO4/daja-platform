# WhatsApp notifications — 05.11.2026

## Priprema prelaska na v2

- `STOP` i `STOP NOVOSTI` gase novosti. `STOP CENE` gasi sva praćenja cena i
  automatsko uključivanje budućih favorita. `STOP SVE` gasi sve WhatsApp pretplate.
  Dosadašnji `STOP SATOVI` ostaje prečica za `STOP CENE`.
- `STOP SAT <šifra>` radi i pre prve poruke o ceni. `MOJI SATOVI` prikazuje
  aktivne šifre, po deset po strani. `STOP SAT` poslat kao odgovor radi za
  konkretnu prijavu iz poruke. Nova prijava ima novu šifru. Šifre se prikazuju
  i na nalogu sa potvrđenim brojem. Engleske komande su `STOP NEWS`,
  `STOP PRICES`, `STOP ALL`, `STOP WATCH`, `MY WATCHES` i `HELP`.
- Kupac može da zatraži odjavu i preko podrške. Osoblje sa pravom
  `promotions.write` evidentira zahtev u WhatsApp admin panelu nakon
  provere broja i obima zahteva. Ova radnja ne šalje reklamne poruke.
- [Uputstvo za unos šablona v2 i redosled dugmadi](WHATSAPP_SETUP.md).
  API dozvoljava nove prijave i slanje tek kada su postavljena oba v2 imena
  i odobrenje šablona. Odjava iz dolaznog webhooka radi i dok slanje čeka.
  Za primaoce starih poruka čuva se značenje odjave iz tih poruka.
- Migracija 126 dodaje šifre, red odgovora i minimalnu evidenciju za
  buduće ograničeno čuvanje. `WHATSAPP_RETENTION_APPROVED` ostaje false dok
  rukovalac ne potvrdi svrhu, pravni osnov, rokove i pravila za konkretne
  otvorene zahteve. Pre uključivanja postaviti zaseban
  `WHATSAPP_RETENTION_HMAC_KEY` u secret store i uskladiti javno obaveštenje.
  Mehanizam čuva tehničke zapise do 90 dana, a minimalni dokaz odjavljene
  potvrđene saglasnosti do 12 meseci od odjave.
- Na odobrenom test broju potvrdi newsletter, jedan ručno izabran sat
  i praćenje Liste želja. Sa `MOJI SATOVI` uzmi šifru i odjavi jedan sat
  pre prve promene cene. Proveri da pogrešna ili stara šifra ne dira drugu
  prijavu. Proveri odvojeno obe akcije dugmadi, `STOP CENE` uz newsletter
  koji ostaje aktivan i `STOP SVE`. Osveži nalog nakon odjave i proveri
  pretplate i red. Test šablona se šalje samo na test broj.

## Istorija v1

13.11.2026: WhatsApp Manager lists both language versions of the newsletter and
price-change templates as Active (Quality pending). The two notification flags
were enabled on the Render API. Meta still refuses creation of the Authentication
template, and WhatsApp back-in-stock remains disabled. Delivery and deployment
completion were not checked.

Cloud API notifications are separate from OTP and email. Existing email/SMS consent
is never reused. Production activation remains gated by explicit flags and secrets.

User scope update: WhatsApp back-in-stock alerts are disabled. The unfinished
stock template was abandoned, not submitted. `WHATSAPP_STOCK_ALERTS_ENABLED=false`
gates public capabilities, new subscriptions, scanning and outbound attempts.
The notification approval flag covers the four Marketing templates for the
newsletter and price-change alerts in sr/en.

## Consent and unsubscribe

The storefront newsletter forms and product-alert dialog use
`POST /whatsapp/subscriptions/request` (phone, language sr/en, purpose newsletter /
price_change / back_in_stock, explicit consent, policy version; product/variant IDs
required for product alerts). Only Serbian recipient numbers are accepted initially.
Price alerts on the product page can also be activated by an explicit request from the
authenticated account that owns the exact verified number. The server checks the current
customer record. New numbers can be verified using the existing phone code flow.

For the inbound confirmation flow, the server returns a 30-minute `wa.me` link. No outbound message is sent to an
unverified number. Sending `DAJA <token>` from the entered number activates that
exact subscription. The database stores only the SHA-256 token hash. A short
confirmation reply is queued in the customer's language for a fresh inbound opt-in.

The account and wishlist expose separate controls per exact watch and channel.
Wishlist opt-in follows current and future favorites on the selected verified
contact. Removing a favorite revokes only alerts created by wishlist tracking.
An individually enabled alert stays active until explicitly revoked. A per-watch
opt-out stays in effect while the watch remains on the list. Removing and adding
the watch again is a new wishlist entry. All-watch opt-out turns off automatic
tracking for that channel. Historic subscriptions retain their previous scope. In WhatsApp, reply to a specific
watch notification with `STOP SAT` or `STOP WATCH` to revoke alerts for that watch.
Send `STOP SATOVI` or `STOP WATCHES` to revoke all watch alerts without revoking
newsletters. The current approved templates still carry the generic STOP text.

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
accepts a UUID campaignId, language and campaign text. Repeating the
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
The notification approval flag means newsletter and price-change templates in
both languages are approved. Stock alerts require separate explicit enablement
and an approved stock template if the user requests them later. An OTP-only setup
can be enabled separately, but Meta currently refuses to create its template.

No tests, build, actual sending, migration execution or deployment-completion
verification were performed for this change, per the user's instructions.

Provider references:
- https://www.postman.com/meta/whatsapp-business-platform/request/o65u5m5/send-message-template-text
- https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/
