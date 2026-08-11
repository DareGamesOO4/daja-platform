# Plan 2 Status

Plan 2 is partially implemented as production code in this repository. It is not fully accepted because
live Cloudflare R2 credentials, MinIO media integration tests, Firestore credentials, performance
fixtures, and the full required domain test matrix are still pending.

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

## Verification

Verified locally:

```bash
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run build
npm.cmd test
```

Not yet verified:

- Real Cloudflare R2 account/bucket/domain upload.
- Local MinIO integration test for presign/complete/processing.
- Firestore product read with supplied service-account credentials.
- Required Plan 2 catalog/media/RFID/inventory/import negative and isolation test matrix.
- Performance fixtures and `EXPLAIN (ANALYZE, BUFFERS)` checks for EPC, slug, and SKU lookups.

## External Credentials

Live R2 verification requires:

- `R2_ACCOUNT_ID`
- `R2_BUCKET`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `MEDIA_PUBLIC_BASE_URL`

Firestore migration execution requires a Firebase service-account JSON supplied at runtime. It must
not be committed.
