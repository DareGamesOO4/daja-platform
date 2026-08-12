# Plan 2 Status

Plan 2 is implemented as production code in this repository, but it is not fully accepted yet.
Local Docker verification now covers PostgreSQL, Redis, MinIO-compatible presigned uploads, media
completion, and media worker image processing. Full acceptance still requires live Cloudflare R2
and Firestore credentials plus the remaining required negative/isolation test matrix.

## Implemented Locally

- `002_catalog_media_rfid_inventory_imports.sql` creates catalog, pricing, media, RFID, inventory,
  warehouse, outbox, and import tracking tables.
- Public catalog routes:
  - `GET /api/v1/public/catalog/products`
  - `GET /api/v1/public/catalog/products/:slug`
  - `GET /api/v1/public/catalog/brands`
  - `GET /api/v1/public/catalog/categories`
- Staff catalog routes:
  - `POST /api/v1/products`
  - `GET /api/v1/products/:id`
  - `PATCH /api/v1/products/:id`
  - `DELETE /api/v1/products/:id`
  - `POST /api/v1/products/:id/variants`
  - `PATCH /api/v1/variants/:id`
- Atomic variant sell-price changes update current price, close/insert price history, write audit,
  and append outbox events in one transaction.
- Shared EPC normalization rejects malformed EPC values.
- Public RFID resolver:
  - `GET /api/v1/public/rfid/resolve/:epc`
- Staff RFID routes for create/read/assign/unassign/status/events.
- Inventory item creation, movement, adjustment ledger, and balance projection routes.
- R2/S3-compatible presigned upload adapter and media completion verification with object `HEAD`.
- `media-processing` worker uses Sharp to verify/decode images and upload WebP derivatives.
- XLSX import job/row tracking, validation, dry-run, execute, and reconciliation endpoints.
- Firestore migration job tracking is read-only and records that credentials are required at runtime.
- Public catalog/RFID routes can use `PUBLIC_ORGANIZATION_ID` without staff identity headers.
- Public RFID resolver is route-rate-limited and uses Redis cache with invalidation after RFID
  mutations.
- Public catalog slug reads use Redis cache with invalidation after catalog mutations.
- RFID and inventory mutations write audit/outbox records in the same DB transaction.
- `003_plan2_integrity_completion.sql` adds append-only protections, category cycle rejection, and
  cross-tenant integrity triggers for Plan 2 relationships.
- Firestore read-only migration can read supplied service-account credentials via Firestore REST and
  populate import rows without writing back to Firestore.
- `npm run plan2:perf` creates a non-production performance fixture and verifies EPC/slug/SKU plans
  reject sequential scans.

## Verification

Verified locally:

```bash
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
npm.cmd run test:unit
npm.cmd run test:integration
npm.cmd test
npm.cmd run format:check
npm.cmd run security:deps
npm.cmd run plan2:perf
```

Additional local smoke checks verified:

- Docker Compose starts PostgreSQL, Redis, and MinIO.
- MinIO presigned PUT upload succeeds and `completeUpload` verifies the object with `HEAD`.
- `media-processing` BullMQ worker decodes an uploaded PNG with Sharp and writes WebP derivative metadata.
- Built Nest API serves public catalog slug reads through the Redis-backed code path.

Not yet verified:

- Real Cloudflare R2 account/bucket/domain upload.
- Firestore product read with supplied service-account credentials.
- Required Plan 2 catalog/media/RFID/inventory/import negative and isolation test matrix beyond the
  current focused integration tests.

## External Credentials

Live R2 verification requires:

- `R2_ACCOUNT_ID`
- `R2_BUCKET`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `MEDIA_PUBLIC_BASE_URL`
- `R2_ENDPOINT` only for local S3-compatible testing such as MinIO.

Firestore migration execution requires a Firebase service-account JSON supplied at runtime. It must
not be committed.
