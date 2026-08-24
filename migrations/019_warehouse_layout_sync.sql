BEGIN;

ALTER TABLE warehouse_zones
  ADD COLUMN IF NOT EXISTS display_order integer NOT NULL DEFAULT 0
    CHECK (display_order >= 0);

ALTER TABLE warehouse_bins
  ADD COLUMN IF NOT EXISTS capacity integer CHECK (capacity IS NULL OR capacity >= 0),
  ADD COLUMN IF NOT EXISTS low_stock_threshold integer
    CHECK (low_stock_threshold IS NULL OR low_stock_threshold >= 0),
  ADD COLUMN IF NOT EXISTS display_order integer NOT NULL DEFAULT 0
    CHECK (display_order >= 0),
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'blocked', 'critical', 'inactive'));

ALTER TABLE warehouse_bins
  ADD CONSTRAINT warehouse_bins_threshold_within_capacity
  CHECK (
    capacity IS NULL OR low_stock_threshold IS NULL OR low_stock_threshold <= capacity
  );

CREATE INDEX IF NOT EXISTS warehouses_org_location_active_idx
  ON warehouses (organization_id, location_id, code)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS warehouse_zones_org_warehouse_order_idx
  ON warehouse_zones (organization_id, warehouse_id, display_order, code)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS warehouse_bins_org_zone_order_idx
  ON warehouse_bins (organization_id, zone_id, display_order, code)
  WHERE deleted_at IS NULL;

COMMIT;
