BEGIN;

-- Match the first-variant and latest-balance lateral lookups in admin lists.
CREATE INDEX IF NOT EXISTS product_variants_admin_first_idx
  ON product_variants (organization_id, product_id, created_at, id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS inventory_balances_admin_latest_idx
  ON inventory_balances (organization_id, variant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS product_media_admin_cover_idx
  ON product_media (organization_id, product_id, is_primary DESC, position, id);

-- Employee pagination includes deleted records; the catalog queue does not.
CREATE INDEX IF NOT EXISTS products_worker_created_idx
  ON products (organization_id, created_by_user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS products_worker_queue_idx
  ON products (organization_id, created_by_user_id,
    (CASE WHEN quality_review_status = 'changes_requested' THEN 1 ELSE 0 END) DESC,
    (COALESCE(quality_reviewed_at, updated_at)) DESC, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS audit_events_quality_returns_idx
  ON audit_events (organization_id, aggregate_id, occurred_at DESC)
  WHERE aggregate_type = 'product' AND operation = 'quality_changes_requested';

COMMIT;
