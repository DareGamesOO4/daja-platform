BEGIN;

-- The specification editor reads every variant in one department to rank
-- existing values. These covering indexes keep that read on the narrow path
-- used by the editor instead of repeatedly visiting catalog rows.
CREATE INDEX IF NOT EXISTS products_specification_editor_idx
  ON products (organization_id, department_id, id)
  INCLUDE (brand_id)
  WHERE deleted_at IS NULL;
-- Synchronization clients read supplier changes by revision. Preserve revision
-- order without scanning links that have never produced a state update.
CREATE INDEX IF NOT EXISTS supplier_product_links_state_sync_idx
  ON supplier_product_links (organization_id, state_revision)
  WHERE state_revision > 0;

-- A work-session heartbeat reads the most recent client snapshot only when a
-- browser takes over an existing session.
CREATE INDEX IF NOT EXISTS catalog_work_session_clients_recent_idx
  ON catalog_work_session_clients (session_id, updated_at DESC)
  INCLUDE (released);

COMMIT;
