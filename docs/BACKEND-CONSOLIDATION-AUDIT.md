# Backend Consolidation Audit

Date: 2026-08-12

Scope: local `daja-platform`, latest default branch of `RFIDDaja`, and latest default branch of `dajashopweb`.

## RFIDDaja Findings

- Auth shape: `POST /auth/login`, refresh rotation, JWT access/refresh split, `typ`, `sub`, `org`, `fam`, `jti`, `dev` claims, device binding, session family reuse detection.
- Request boundary: server derives tenant/user context from verified access token; tenant and device headers are validation inputs, not identity sources.
- Sync contract: batch push/pull/bootstrap/conflict endpoints require `sync.create`, `sync.view`, and `sync.update`; events carry org/location/device/user, aggregate identity, operation, payload version, base version, timestamp, and idempotency key.
- Data model: older generic resource tables are not copied into DAJA Platform. DAJA keeps typed PostgreSQL catalog, RFID, inventory, media, sync, and audit tables.

## dajashopweb Findings

- Source systems: Firebase/Firestore for catalog and commerce data; Cloudflare R2 for images.
- Image expectation: existing references and public CDN URLs must be preserved during migration. The existing production bucket/domain are `dajashop-images` and `https://cdn.dajashop.rs`.
- Migration approach: import must run as dry-run/reconciliation first. No generated product IDs, image rewrites, or fake Firestore/R2 providers are allowed.

## DAJA Platform Gap Closure In Batch 1

- Added real staff authentication with Argon2id password verification, JWT access tokens, JWT refresh tokens, session families, refresh rotation, reuse revocation, device binding, `/auth/login`, `/auth/refresh`, `/auth/logout`, and `/auth/me`.
- Replaced default trusted identity headers with token-derived `RequestContext`.
- Kept legacy identity headers only behind `TRUSTED_IDENTITY_HEADERS=true`, disabled by default.
- Added RFIDDaja-compatible login body and token claims.
- Added schema support for session family metadata and legacy Firestore identity mappings.

## Deferred By Plan Stop Rule

- Customer Firebase ID token cutover remains behind the later customer-auth phase.
- Full dajashopweb import execution is not run without production Firestore credentials and explicit dry-run approval.
- RFIDDaja client cutover is not forced until contract verification and rollout steps are completed.
