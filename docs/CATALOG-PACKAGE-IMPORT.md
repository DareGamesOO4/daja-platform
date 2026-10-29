# Reviewed Linkel battery package

`scripts/import-linkel-batteries.ts` imports the reviewed 49-product
`daja.catalog-package.v1` package. It creates the Nextcell brand and the four
battery categories under the existing Baterije department. It publishes each
new product at the package's RSD price, with one unit at the existing C31
location. The supplier's availability remains source metadata and does not
override this explicitly requested initial stock.

Supply an authorized staff access token in `CATALOG_IMPORT_TOKEN`. The token
must belong to `--actor` and `--organization` and have catalogue and inventory
permissions. Explicit ignored env files supply database and R2 credentials;
an optional override file can supply current storage settings. The script
prefers `RENDER_DATABASE_URL` when an external database URL is configured.
Do not put credentials or tokens in arguments, reports or version control.

```powershell
node --import tsx scripts/import-linkel-batteries.ts `
  --package C:/catalog/linkel-avif65/uvoz.json `
  --env-file C:/private/catalog.env `
  --api-url https://daja-platform-api.onrender.com/api/v1 `
  --organization ORGANIZATION_UUID --actor STAFF_UUID `
  --report C:/catalog/import-report.json
```

The default mode only reads configuration, the package, staff catalogue lists
and duplicate records. Add `--apply` to perform the import. Every local AVIF
file is checked against its checksum, size and dimensions before any writes.
Prepared originals and thumbnails are uploaded without another image encode,
then registered as ready media. Stock and product creation use the same
idempotent staff save endpoint as the admin product modal. Internal translations
and provenance are saved through the database domain repository with audit,
outbox and operational sync events. This supports API versions that predate
reserved attribute keys, without requiring a deployment wait.

The script holds an import advisory lock. Immutable media IDs, per-save request
IDs and a package fingerprint allow resuming a failed run. Existing unrelated
SKUs, slugs or external IDs abort the run; they are never overwritten. A record
from an interrupted save is only recovered when its linked media proves it
belongs to this package. Already completed products are skipped, including
their stock; a later rerun does not restock a product that has been sold.
The final persisted count, publication, stock, price and image checks must pass
before the report receives `completedAt`. A partially completed report records
the last successful products and can be used for recovery.

The script is intentionally scoped to this reviewed battery package. Review
new supplier data and prices before adapting it to a different import.
