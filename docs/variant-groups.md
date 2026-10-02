# Storefront variant groups

Apply `075_catalog_variant_groups.sql` before using the new admin tab or public resolver. This migration adds organization-scoped group metadata, per-product assignments and an optimistic revision. It grants `catalog.variant_groups.manage` to existing administrator roles and creates an optional `variant_groups_manager` role for employees.

These groups only control storefront navigation. Product variants, SKU, stock and prices are unchanged. Untouched automatic groups preserve the original case-sensitive prefix rule: remove the last hyphen-separated segment, then match names beginning with the remaining text, without brand/department restrictions.

Admin `GET /admin/variant-groups` returns the entire nondeleted catalog, generated and stored groups, effective membership and revision tokens. `POST /admin/variant-groups` saves metadata and optionally membership (`editMembers`). Names alone never create membership overrides. Mutation bodies include `expectedRevision` and `expectedCatalogRevision`; stale changes return conflict. Membership operations run under an organization advisory lock in a transaction. The catalog token covers product IDs and names so catalog additions, deletions or renames cannot silently alter a stale editor's selection.

Explicit assignments win over automatic rules. Edited live automatic rules use the longest matching prefix; frozen groups retain their snapshot. Removing a member persists a standalone policy. Restoring a product removes that policy and resolves the current automatic rules. Unfreezing releases snapshot assignments while preserving explicit additions and removals. Resetting an automatic group preserves its internal name and assignments made to other groups. Deleting a custom group restores only its remaining members; previously detached products remain standalone.

`GET /public/catalog/products/:slug/variants` returns only public catalog cards and never internal names. It reads the full catalog and uses existing publication rules, excluding unavailable/private members. At least two public members, including the source, are required. This endpoint uses `Cache-Control: no-store`; mutations publish `catalog.variant-groups.updated` to refresh connected clients. No persisted public grouping cache requires eviction.

The web administrator can grant employees access through the “Grupe varijanti” checkbox in “Korisnici i dozvole”; existing assignments are preserved. Existing staff sessions may need renewing to receive a newly granted permission.

Delivery verification for this change: source review and `git diff --check` only. Tests, build, runtime and migration execution were intentionally not performed.
