-- Keep the selected zone and shelf with the quantity balance.  A location can
-- still have one aggregate balance per variant, while the placement is shared
-- by the website and RFID desktop clients.
ALTER TABLE inventory_balances
  ADD COLUMN IF NOT EXISTS zone_id uuid REFERENCES warehouse_zones (id),
  ADD COLUMN IF NOT EXISTS bin_id uuid REFERENCES warehouse_bins (id);

CREATE INDEX IF NOT EXISTS inventory_balances_org_zone_idx
  ON inventory_balances (organization_id, zone_id)
  WHERE zone_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS inventory_balances_org_bin_idx
  ON inventory_balances (organization_id, bin_id)
  WHERE bin_id IS NOT NULL;
