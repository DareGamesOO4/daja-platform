# Catalog filter configuration

Migration `073_catalog_filter_configuration.sql` stores configuration per organization and department (`satovi`, `daljinski`, `baterije`, `naocare`). The first read creates a versioned snapshot of the existing public catalog filters. Later product/specification changes never automatically add published choices.

## API

- `GET /public/catalog/filters/:department`: `{ configuration }`, published configuration only, public organization context.
- `GET /admin/catalog/filters/:department`: `{ revision, draft, published, history }`, requires `catalog.read`.
- `PUT /admin/catalog/filters/:department/draft`: `{ revision, configuration }`, requires `catalog.write`.
- `POST /admin/catalog/filters/:department/publish`: `{ revision, restoreRevision? }`, publishes the saved draft or an earlier published version, requires `catalog.write`.

Save and publication require the current revision; conflicts return HTTP 409. Publications and restorations create a new immutable history entry in the same transaction as the updated published configuration. Saving a draft does not modify published state.

## Configuration version 1

`{ schemaVersion: 1, filters: FilterNode[] }`

Each node has `id`, `title`, `description`, `visible`, `open`, `priority`, `mode` (`group` / `options`), `style` (`checkbox` / `color` / `material` / `range`), `match` (`any` / `all`), `columns`, `showCounts`, `unit`, `sources`, `options`, and `children`. Groups only contain children. Option nodes only contain sources and options. IDs remain stable when labels or positions change.

An option has `id`, `label`, `visible`, `color` (empty or six-digit HEX), `image` (empty, HTTPS or same-origin path), and `conditions`. Each condition has a `source` and approved `values`. Sources are `brand`, `gender`, `category`, `price`, `spec:<attribute key>` or `feature:<exact feature title>`. Feature presence is represented by `Da`. A condition matches any approved value; an option matches any of its conditions. A node matches any/all selected options according to `match`. Different nodes always combine with AND.

Ranges require one numeric source and a consistent unit. Only explicit choices/rules are published; arbitrary function names are not inferred as true. Public product cards now include optional `features` so the web can evaluate feature-presence rules without fetching every product detail.

The web supports legacy brand/gender/category/specification/price URL parameters by translating them to approved options/ranges. Hidden, removed and unapproved selections are ignored and removed from the active URL. New links use stable `cf_<node id>` option IDs and `cf_min_<node id>` / `cf_max_<node id>` bounds.

## Delivery

RFID apps are not changed. No tests or deployment polling are part of this delivery, per the user's instruction. Review criteria: draft isolation, atomic publish/restore, revision conflicts, hide/remove URL cleanup, group merge/split, numeric-unit validation and AND matching for multiple functions.
