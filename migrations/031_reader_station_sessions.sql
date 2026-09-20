BEGIN;

CREATE TABLE IF NOT EXISTS rfid_reader_stations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  device_id uuid NOT NULL,
  name text NOT NULL,
  location_id uuid REFERENCES locations(id),
  registered_by uuid NOT NULL REFERENCES users(id),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, device_id)
);

CREATE TABLE IF NOT EXISTS rfid_reader_scan_sessions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  station_id uuid NOT NULL REFERENCES rfid_reader_stations(id),
  requester_user_id uuid NOT NULL REFERENCES users(id),
  requester_client_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('awaiting_epc', 'awaiting_barcode', 'completed', 'cancelled', 'expired')),
  epc text,
  barcode text,
  product jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS rfid_reader_stations_online_idx
  ON rfid_reader_stations (organization_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS rfid_reader_scan_sessions_active_idx
  ON rfid_reader_scan_sessions (station_id, expires_at)
  WHERE status IN ('awaiting_epc', 'awaiting_barcode');

INSERT INTO permissions (id, description) VALUES
  ('rfid.scan', 'Request and operate remote RFID reader scans')
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT roles.id, 'rfid.scan' FROM roles
WHERE lower(roles.name) IN ('storefront_admin', 'admin')
ON CONFLICT DO NOTHING;

COMMIT;
