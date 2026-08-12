# dajashopweb Cutover Contract

Do not modify `dajashopweb` as part of this plan.

## Public Catalog

- `GET /api/v1/public/catalog/products`
- `GET /api/v1/public/catalog/products/:slug`
- `GET /api/v1/public/catalog/brands`
- `GET /api/v1/public/catalog/categories`

Filters: `brand`, `category`, `gender`, `minPrice`, `maxPrice`, `query`, `cursor`, `limit`, `sort`.

## Media

Uploads use presigned R2/S3 PUT URLs. Public reads use CDN/R2 public URLs. Existing valid R2 URLs from Firestore imports should be preserved instead of blindly reuploading files.

## EPC Resolver

`GET /api/v1/public/rfid/resolve/:epc` returns minimal navigation payload for opening the product page.

## Auth

Customer/Firebase token verification is not finalized in this repository. Production exposure requires a real token verification adapter before staff/customer private operations go online.

## Migration Sequence

1. Freeze or snapshot Firestore product source.
2. Run dry-run import.
3. Review reconciliation.
4. Execute import into staging.
5. Verify API and performance.
6. Cut frontend reads to DAJA Platform.
7. Stop Firestore `products` as master.

Rollback is DNS/config based before writes are accepted as authoritative by DAJA Platform.
