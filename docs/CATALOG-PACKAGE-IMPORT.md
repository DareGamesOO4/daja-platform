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

## Linkel remote controls

`scripts/import-linkel-remotes.ts` accepts the reviewed 1,072-product
`daja.catalog-package.v1` package with AVIF quality 60. It uses the existing
`daljinski` department and C31 location, creates or reuses the compatibility
brands and their category bindings, uploads every original and thumbnail,
and publishes each product with one unit through `/admin/catalog/save`.
The package records the user's temporary price of 900 RSD for 178 products
whose source price was missing or zero. Supplier prices, supplier SKUs,
availability and replacement models remain separate from these overrides.
Unique import SKUs and slugs must already be resolved in the package.

Use the same required flags and credential environment as the battery
import, replacing the script, package and report paths. The default mode
validates all local AVIF checksums, dimensions, identities and current
catalogue conflicts without writes. `--apply` performs the import with four
bounded workers and atomic report checkpoints. An advisory lock prevents a
second remotes import from running concurrently. A retry reuses immutable
media and idempotent staff-save requests; completed products are skipped
without resetting stock. Transient API failures are retried only for reads
and staff saves carrying a stable request ID; rolled-back database deadlocks
also have bounded retries. Taxonomy POSTs are not blindly repeated.
Untranslated supplier descriptions stay in the
source language rather than being labelled as English translations.

The report receives `completedAt` only after persisted product, price,
publication, image and initial inventory totals match the package. This
script runs locally against the staff API and does not require waiting
for a deployment.

### Reviewed remote specifications and prices

`scripts/enrich-linkel-remotes.cjs` exports `run({ planPath, reportPath,
pool, token, apiBase, organizationId, apply, concurrency })`. Use the existing authorized
staff session and configured tenant database pool; never store credentials
in the plan or report. Preview is read-only. An explicit `apply: true`
creates the department's specification definitions and offered answers,
configures its four admin editor groups, then patches the reviewed variants
through the staff API with their current `expectedVersion`.

The reviewed plan covers all 1,072 products and 1,414 source photos. It
updates 1,071 products: `LINKEL-195` / `L021` remains completely excluded at
the owner's request because its earlier 36 RSD price needed manual review.
At final verification it already had a separate 3,600 RSD edit dated before
the first enrichment write; that edit is preserved. Prices
round down to a multiple of 100 RSD; the existing temporary 900 RSD prices
remain 900. The owner's confirmed two-year warranty is separate evidence
from supplier descriptions and photographs.

Each populated specification has field or photo provenance. Unknown
properties stay absent. Explicit negative supplier notes take precedence
over photographed buttons; a microphone symbol alone does not establish
voice functionality, and a HEAT button does not establish heating support.
Conflicting battery markings or frequency ranges are withheld. Model and
compatibility text remain free text; categorical and boolean definitions
have offered answers. The controls group uses dropdowns so an unknown
answer is not displayed as “Ne” in the admin editor.
Final photo refinements are recorded separately from the immutable base
plan. In particular, a physical button marked only “Amazon” keeps that
literal label rather than inferring “Prime Video”. Refinements retain the
base plan hash and update their own evidence through versioned staff patches.

Only imported legacy `tip` and `supplier_sku` attributes are replaced by
registered specifications. Other attributes and translations are retained;
review evidence and original prices live under `_catalog_import`.
Compatibility brands must remain `Za Sony`, `Za Samsung`, etc. This script
does not change brands, inventory, publication, media, descriptions or EPCs.
API patches provide audit records, snapshots, cache invalidation and
operational synchronization. Atomic reports and per-product plan hashes
allow interrupted runs to resume; changed user data is rejected rather
than overwritten. Idle database disconnects and transient request errors
receive bounded recovery without logging credentials.
Concurrency defaults to three and is limited to six. Read requests retry
transient HTTP/network failures, including non-JSON gateway responses;
uncertain mutations return to their reconciliation logic before a retry.

### Reviewed battery descriptions and equivalents

`scripts/prepare-linkel-battery-enrichment.cjs <research-dir> <plan-path>`
builds the reviewed 49-product battery plan from `before.json`,
`linkel-details.json` and `photo-index.json`. The facts cover 88 individually
reviewed supplier photographs, NEXcell's published model tables and primary
manufacturer cross-reference documents. Source URLs and photo references
are attached to every product. Catalogue dimensions describe the cell format;
they are not measurements of the physical stock. Capacities from a different
brand or NEXcell series are deliberately not transferred.

`scripts/enrich-linkel-batteries.cjs` exports
`run({ planPath, reportPath, pool, token, apiBase, organizationId, apply })`.
Use an existing authorized staff session. With `apply: true` it registers 17
department specification definitions with offered answers in five groups,
saves Serbian descriptions and English names/descriptions, and replaces the
old generic `tip` field with reviewed attributes. Prices, quantities, media,
SKUs, publication, brands and categories are preserved. Each product and
variant update uses the current version through the staff API, retaining
audit, snapshots, cache invalidation and synchronization. Interrupted writes
are reconciled independently; concurrent content changes are rejected.

Five supplier records remain explicitly marked for the owner's manual review:
`LINKEL-7826`, `LINKEL-7827`, `LINKEL-7849`, `LINKEL-8200`, `LINKEL-8202`.
Their conflicting model/capacity claims are not filled in as confirmed specs.
Misleading capacity/model text is removed from the display title, with the
original inventory identifiers retained. The description asks buyers to
confirm the actual item before ordering. Review evidence stays under
`attributes._catalog_import.batteryReview`, outside public specification cards.

Silver-oxide SR/number equivalents are separate from conditional alkaline
AG/LR substitutes. In particular SR621SW/364 corresponds to the AG1/LR621
format; the supplier's AG11 is not a valid equivalent. Silver-oxide labels
state 1.55 V. Ni-MH batteries in the 9V physical format are labelled 8.4 V.
For 14500 and 752540, the photographed 3.7 V cell label is kept separate
from the supplier bag's 3.6 V designation. No unverified Li-ion protection,
connector type, cycle life, expiry or generic AA compatibility is asserted.

The price remains per individual battery. The factory pack count in a source
photo is labelled separately and does not change the selling quantity.
Five manual-review cases and additional supplier inconsistencies are included
in the owner report. Read-only persistence verification compares all saved
descriptions/translations/specs and ensures prices and stock are unchanged;
it is separate from deployment verification.

### Selling packs and a permanent full-box discount

The owner subsequently changed the selling unit from individual cells to the
photographed factory pack, and authorized a choice of 4 cells or a full 40-cell
box for alkaline AA/AAA, with 20% off the full box. This supersedes the per-cell
selling unit above. `prepare-battery-packs.cjs` takes a fresh inventory snapshot,
the reviewed enrichment plan and an output path. `apply-battery-packs.cjs`
exports the same staff-session `run` interface as the other reviewed scripts.

Thirty existing products become packs (2/4/5/6/40 cells); nineteen remain singles.
Prices are explicit complete-pack totals. For each 40-cell box, the reference
unit price comes from the corresponding existing 4-cell SKU, not its historical
supplier bulk-cell price: full price = ten 4-packs; final box price = 80% of that.
The final net price is saved as the server's current variant price. No invented
sale end date, browser-only price override, extra inventory or duplicate SKU is
needed. Existing AAA `LR03/4PK` / `LR03/40PK` and AA `LR6/4PK` / `LR6/40PK`
products form two explicit custom variant groups. Their identifiers and stock
balances are preserved, and a cart quantity of one now means one selling pack.

Pack size, reference unit price, reference total, final total, discount and
source SKU are recorded in `_catalog_import.packaging`; the versioned review
hash and prior per-cell price are retained alongside it. The two new registered
specifications describe pack size and selling unit. Existing offered answers
and editor configuration rules are preserved while adding verified aliases.
The five unresolved supplier conflicts remain for manual review.

Serbian first paragraphs are 145–160 characters and are also saved as SEO meta
descriptions. English text is prepared separately with the same 160-character
limit. Descriptions use one newline per paragraph, avoiding empty spacer
paragraphs; the storefront keeps the existing small paragraph margin. The
storefront displays pack price, quantity × unit price, net per-cell price and
the two labelled pack choices. An optional money precision preserves cents
in these breakdowns without changing default formatting elsewhere.

The 20% reference display is conditional on the saved price still matching the
reviewed calculation; later price edits do not leave a stale discount claim.
All checkout, cart, order and inventory operations continue to use the existing
product/variant IDs and authoritative server pack price. The import verifies
saved amounts, texts, versions, the two groups and unchanged stock using reads.
