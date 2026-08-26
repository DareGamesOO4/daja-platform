-- Canonical, normalized RFID cycle-count data. This schema is intentionally
-- separate from legacy offline packages and is populated only by the v1 RFID
-- snapshot protocol.
INSERT INTO permissions (id, description) VALUES
  ('rfid_counts.sync', 'Synchronize RFID cycle-count snapshots')
ON CONFLICT (id) DO NOTHING;

-- Keep existing desktop roles working while still making the authorization
-- explicit and independently auditable from generic sync.write.
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, 'rfid_counts.sync'
FROM role_permissions rp
WHERE rp.permission_id = 'sync.write'
ON CONFLICT DO NOTHING;

CREATE TABLE rfid_cycle_counts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  location_id uuid NOT NULL REFERENCES locations (id),
  warehouse_id uuid REFERENCES warehouses (id),
  zone_id uuid REFERENCES warehouse_zones (id),
  bin_id uuid REFERENCES warehouse_bins (id),
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'ready', 'in_progress', 'paused', 'review', 'completed', 'cancelled')),
  expected_total integer NOT NULL DEFAULT 0 CHECK (expected_total >= 0),
  read_total integer NOT NULL DEFAULT 0 CHECK (read_total >= 0),
  found_total integer NOT NULL DEFAULT 0 CHECK (found_total >= 0),
  missing_total integer NOT NULL DEFAULT 0 CHECK (missing_total >= 0),
  unexpected_total integer NOT NULL DEFAULT 0 CHECK (unexpected_total >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  created_by_user_id uuid NOT NULL REFERENCES users (id),
  owner_device_id uuid REFERENCES devices (id),
  owner_state text NOT NULL DEFAULT 'none' CHECK (owner_state IN ('none', 'owned', 'released')),
  protocol_version integer NOT NULL DEFAULT 1 CHECK (protocol_version = 1),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX rfid_cycle_counts_org_location_idx
  ON rfid_cycle_counts (organization_id, location_id, updated_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX rfid_cycle_counts_claim_idx
  ON rfid_cycle_counts (organization_id, id, status, owner_device_id)
  WHERE deleted_at IS NULL;

CREATE TABLE rfid_cycle_count_expected_items (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  cycle_count_id uuid NOT NULL REFERENCES rfid_cycle_counts (id) ON DELETE CASCADE,
  rfid_tag_id uuid REFERENCES rfid_tags (id),
  product_variant_id uuid REFERENCES product_variants (id),
  epc text NOT NULL CHECK (epc = upper(epc) AND epc ~ '^[0-9A-F]{8,64}$'),
  expected_location_id uuid NOT NULL REFERENCES locations (id),
  expected_bin_id uuid REFERENCES warehouse_bins (id),
  snapshot_version bigint NOT NULL CHECK (snapshot_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (organization_id, cycle_count_id, epc)
);
CREATE INDEX rfid_cycle_expected_count_idx
  ON rfid_cycle_count_expected_items (organization_id, cycle_count_id);

CREATE TABLE rfid_cycle_count_reads (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  cycle_count_id uuid NOT NULL REFERENCES rfid_cycle_counts (id) ON DELETE CASCADE,
  rfid_tag_id uuid REFERENCES rfid_tags (id),
  epc text NOT NULL CHECK (epc = upper(epc) AND epc ~ '^[0-9A-F]{8,64}$'),
  device_id uuid NOT NULL REFERENCES devices (id),
  antenna integer,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  read_count integer NOT NULL DEFAULT 1 CHECK (read_count >= 1),
  strongest_rssi real,
  last_rssi real,
  frequency_khz integer,
  sequence integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (organization_id, cycle_count_id, epc)
);
CREATE INDEX rfid_cycle_reads_count_seen_idx
  ON rfid_cycle_count_reads (organization_id, cycle_count_id, last_seen_at DESC);

CREATE TABLE rfid_cycle_count_results (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  cycle_count_id uuid NOT NULL REFERENCES rfid_cycle_counts (id) ON DELETE CASCADE,
  rfid_tag_id uuid REFERENCES rfid_tags (id),
  product_variant_id uuid REFERENCES product_variants (id),
  epc text NOT NULL CHECK (epc = upper(epc) AND epc ~ '^[0-9A-F]{8,64}$'),
  classification text NOT NULL CHECK (classification IN ('found', 'missing', 'unexpected')),
  expected_location_id uuid REFERENCES locations (id),
  observed_location_id uuid REFERENCES locations (id),
  strongest_rssi real,
  resolution text CHECK (resolution IN ('accepted', 'corrected', 'ignored')),
  resolved_by_user_id uuid REFERENCES users (id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (organization_id, cycle_count_id, epc)
);
CREATE INDEX rfid_cycle_results_count_class_idx
  ON rfid_cycle_count_results (organization_id, cycle_count_id, classification);
