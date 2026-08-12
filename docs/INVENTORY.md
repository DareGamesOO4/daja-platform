# Inventory

Inventory uses append-only ledger semantics:

- `inventory_items` represent physical units.
- `inventory_events` records movements/adjustments.
- `inventory_balances` is a transactional projection.

No endpoint should directly set stock without a traceable event. Public catalog may expose a safe availability summary, but checkout or reservation logic must revalidate against PostgreSQL in a transaction.

Plan 3 sync push treats inventory ledger-style operations as append/idempotent events rather than last-write-wins mutations.
