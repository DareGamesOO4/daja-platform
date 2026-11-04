# WhatsApp phone verification — 04.11.2026

Phone login and profile phone linking accept an explicit `channel: sms | whatsapp`.
Existing clients default to SMS and retain Firebase ID-token verification.
WhatsApp uses server-generated codes, not Firebase. It never falls back to SMS.
No customer accounts are created by the WhatsApp provider: existing DAJA login
and authenticated phone-link ownership checks are retained.

## Current external blocker

Messaging account `2239869233236176` was initially Approved; Business Support Home
now reports **Disabled**, **Permanent**, Terms of Acceptable Use (04.11.2026).
The user added a payment method, but that does not clear the account restriction.
The attempted English `daja_verification_v1` Authentication template was rejected
with “restricted from creating a new template”. No OTP template exists yet.
The support page offers Request review; no appeal has been submitted.

https://business.facebook.com/business-support-home/4451418348505153/2239869233236176/

## Provider contract

- `GET /customer-auth/security-capabilities` returns `whatsappPhone.available`.
  No token, OTP HMAC key, or provider credentials are public.
- `POST /customer-auth/phone/start`: phone, purpose (`login` or `link`), channel,
  language (`sr` or `en`). Linking requires an authenticated DAJA customer.
- WhatsApp start sends one Authentication template with a cryptographically
  random six-digit code as both body parameter and URL OTP button parameter.
  Only an accepted Meta response with a message ID creates a usable challenge.
  This is provider acceptance, not proof of physical delivery.
- `POST /customer-auth/phone/verify`: phone, purpose, channel, challengeToken,
  and code (WhatsApp) or firebaseIdToken (SMS). Never interchange the proofs.
- Codes expire after 300 seconds, with at most five attempts. Redis Lua compares
  the scope/HMAC and consumes a valid challenge atomically across API instances.
  Scope binds organization, phone, purpose, customer and browser nonce.
- Send/verify rate limits and a 60-second phone cooldown are shared with SMS.
  A separate global rolling 24-hour counter caps WhatsApp OTP sends at 100 by
  default. Failed or ambiguous provider requests also consume this budget.
- Provider requests time out after 10 seconds, do not follow redirects, and are
  never automatically retried. Raw codes and credentials are not logged or stored
  in plaintext. The UI retains the selected channel during verification.

## Activation after Meta reinstates the account

Create Authentication templates named `daja_verification_v1` in **both** `sr`
and `en`, with Copy code, security recommendation, five-minute expiration and
five-minute message validity. Meta supplies the translated fixed body, e.g.:

- Serbian: `{{1}} je vaš verifikacioni kod.` + recommendation not to share it.
- English: `{{1}} is your verification code. For your security, do not share this code.`

Use Meta's generated language-specific copy button/expiration text, not a freeform
marketing template. The Serbian wording above is a draft; retain Meta's generated
text when creating it. Both language templates require approval before activation.

Configure these variables through the deployment secret store, never this repo:

| Variable | Purpose |
| --- | --- |
| `WHATSAPP_OTP_ENABLED` | Default false; enable only after sender/template approval |
| `WHATSAPP_OTP_TEMPLATES_APPROVED` | Default false; confirm approval of both languages |
| `WHATSAPP_ACCESS_TOKEN` | Server-only token authorized to send for this business |
| `WHATSAPP_PHONE_NUMBER_ID` | Numeric Graph phone-number ID, not the visible telephone number or WABA ID |
| `WHATSAPP_GRAPH_API_VERSION` | Explicit supported Graph version, e.g. `vNN.0`; no implicit version |
| `WHATSAPP_OTP_TEMPLATE_NAME` | Default `daja_verification_v1` |
| `WHATSAPP_OTP_SECRET` | Independent randomly generated secret of at least 32 characters |
| `WHATSAPP_OTP_DAILY_LIMIT` | Global cap, default 100, maximum 10000 |

Keep Firebase variables for SMS. The store remains usable with SMS/email while
WhatsApp is unavailable. Marketing consent, newsletter and product notifications
are separate from authentication and are not enabled by these flags.

## Validation

API/worker TypeScript compilation and web production build passed; no tests,
handset delivery, paid OTP requests, or deployment completion checks were run.
Android was not connected. No mobile/desktop SMS OTP entry points were found.

## References

- https://developers.facebook.com/docs/whatsapp/business-management-api/authentication-templates/
- https://www.postman.com/meta/whatsapp-business-platform/request/6vkv46u/create-authentication-template-w-otp-copy-code-button
