BEGIN;
-- Persist the DB-only stage so cache invalidation can retry outside a transaction.
ALTER TABLE catalog_deliveries ADD COLUMN projected_at timestamptz;
COMMIT;
