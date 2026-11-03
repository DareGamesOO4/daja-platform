# Firebase phone authentication — 03.11.2026.

## Cloud setup

New project: `dajashop-sms` / DajaShop SMS, owned through `dajashopnis@gmail.com`.
Old project `daja-shop-site` and existing Google OAuth were not changed.
Registered web app: DajaShop web SMS (`1:1046056114150:web:d830d862e4b7d18e916827`).
Phone provider is enabled with user approval; authorized production domain is
`dajashop.rs`. SMS region policy allows only Serbia (RS). Gemini and Analytics
were disabled when creating the new project.

Render API has FIREBASE_PHONE_PROJECT_ID, FIREBASE_PHONE_API_KEY and
FIREBASE_PHONE_APP_ID prepared. FIREBASE_PHONE_ENABLED remains false pending
approval of linking Firebase Payment billing and paid SMS. Spark is the last
confirmed plan; no real SMS delivery has been verified. The billing dialog has
an unsaved 5 USD alert amount: this is a notification threshold, not a hard cap.

## Runtime flow

- /customer-auth/security-capabilities returns public Firebase web configuration
  only when all required values and FIREBASE_PHONE_ENABLED=true are present.
  These web configuration fields are public client identifiers, not server keys.
- Phone start validates Serbian number, purpose and authenticated customer for
  linking. It applies per-IP/account rate limits and a 60-second send cooldown.
- DAJA issues a 10-minute Redis challenge bound to phone, organization, purpose,
  customer and a host-only HttpOnly browser nonce. Failed resend does not change
  the existing browser binding.
- Browser lazily loads Firebase Auth and uses reCAPTCHA and signInWithPhoneNumber.
  The UI enters code mode only after Firebase accepts the sending request.
- Firebase checks the SMS code. DAJA receives its ID token and challenge token,
  never trusts client-supplied phone verification flags or the raw SMS code.
- Admin SDK verifies signature, issuer, audience and expiration for this project.
  DAJA additionally requires phone provider, exact phone match and authentication
  after challenge creation, at most 10 minutes old. Redis atomically consumes the
  challenge and the UID/auth-time proof to prevent reuse across purposes.
- Existing DAJA phone accounts can sign in. Linking requires a DAJA session.
  This does not create DAJA customers from arbitrary Firebase identities.
- Firebase uses in-memory persistence and signs out after proof exchange. DAJA
  browser sessions continue using existing HttpOnly cookies and CSRF handling.
- No service-account private key is created; verification uses Google's public
  certificates with the configured project ID. Revocation lookup is not enabled.
- AWS SMS remains denied. Product alerts remain email-only; Firebase Auth is
  not a general-purpose marketing or order-notification SMS gateway.

## Activation

1. Obtain user approval before linking paid billing/accepting additional terms.
2. Complete Blaze billing setup in the prepared Firebase console dialog.
3. Set FIREBASE_PHONE_ENABLED=true on Render API; preserve all other variables.
4. User can request one code from profile linking, then confirm it. Sending or
   successful SDK acceptance is not proof of handset delivery. Do not auto-send.
5. Do not wait for deployment completion unless the user changes that instruction.

Builds: web production build and API/worker TypeScript build passed. No tests,
SMS, physical handset verification or deployment-completion checks were run.

References:
- https://firebase.google.com/docs/auth/web/phone-auth
- https://firebase.google.com/docs/auth/admin/verify-id-tokens
- https://firebase.google.com/docs/auth/limits

## WhatsApp follow-up

User also requested WhatsApp OTP preparation. Firebase Phone has no WhatsApp
channel. A separate Meta WhatsApp Business setup is needed. WhatsApp Manager is
waiting for user Facebook sign-in; the user reports no Meta Business account.
No Meta credentials, business phone, approved authentication template or billing
has been supplied. No WhatsApp provider is active or implemented in this change.
Do not invent account/phone IDs or use a personal WhatsApp session as an API.
