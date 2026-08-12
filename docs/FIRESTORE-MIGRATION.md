# Firestore Migration

Batch 1 implements the safe migration foundation only.

Rules:

- Run Firestore imports as dry-run first.
- Preserve existing Firestore document IDs in `legacy_identity_mappings`.
- Preserve existing image references and public CDN URLs.
- Do not synthesize production data, product IDs, image URLs, credentials, or providers.
- Do not write imported products until dry-run counts and unmapped fields are reconciled.

DAJA Platform stores mapping reports in `firestore_mapping_reports` and source-to-target links in `legacy_identity_mappings`.

Known dajashopweb source areas:

- products, brands, categories, variants/specification fields from Firestore services
- order and image utilities from Firebase functions
- R2 image references served through `https://cdn.dajashop.rs`

The configured production image target is:

- bucket: `dajashop-images`
- public CDN / Worker route: `https://cdn.dajashop.rs/images`

## Dry-Run 2026-08-12

Source Firebase project: `daja-shop-site`.

`products` collection dry-run result:

- source rows: 20
- valid rows: 20
- invalid rows: 0
- rows with specs: 10
- rows with multiple images: 20
- distinct brands: 4
- distinct categories: 7

Image URL sample checks returned HTTP 200 with `Content-Type: image/webp` and `Cache-Control: public, max-age=31536000, immutable`.

No writes were made to Firebase. The dry-run wrote only local PostgreSQL `import_jobs` and `import_rows` records for reconciliation.

## Neon Staging Dry-Run 2026-08-12

Neon project region: Frankfurt / `eu-central-1`.

The same Firestore `products` dry-run was executed against the Neon staging database after applying migrations `001` through `005`.

Result:

- source rows: 20
- valid rows: 20
- invalid rows: 0
- rows with specs: 10
- rows with multiple images: 20
- distinct brands: 4
- distinct categories: 7

## Neon Staging Import 2026-08-12

`products` was imported into Neon staging with `dryRun=false`.

Result:

- imported rows: 20
- products: 20
- variants: 20
- brands: 4
- categories: 7
- media assets: 49
- media derivatives: 49
- product media links: 49
- public products: 20

The import preserves Firestore slugs, product brand/category mapping, image URLs, thumbnail URLs, and `specs` values where present.

Inventory quantities were not inferred from Firestore product documents; catalog API currently returns `availableQuantity: 0` until the inventory source is connected.
