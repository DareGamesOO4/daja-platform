# Security

Current baseline:

- Environment validation fails fast through Zod.
- Helmet is enabled.
- CORS uses an explicit allowlist from `CORS_ALLOWED_ORIGINS`.
- JSON and urlencoded request bodies are limited to `1mb`.
- Nest validation pipe rejects unknown DTO fields.
- Stable error envelopes avoid stack traces, SQL strings, and credentials.
- Pino redacts authorization, cookie, password, token, and secret fields.
- Rate-limit infrastructure is installed through `@nestjs/throttler`.
- Password hashing dependency is Argon2 for future local staff auth.

No secrets use `VITE_` names. `.env.example` contains safe placeholders only.

Tenant scope is resolved from trusted request identity headers in this foundation phase. Repositories require `organizationId` explicitly and reject cross-tenant reads.
