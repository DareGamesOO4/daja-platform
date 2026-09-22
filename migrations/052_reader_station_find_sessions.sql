CREATE TABLE IF NOT EXISTS rfid_reader_find_sessions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  station_id uuid NOT NULL REFERENCES rfid_reader_stations(id),
  requester_user_id uuid NOT NULL REFERENCES users(id),
  requester_client_id uuid NOT NULL,
  epc text NOT NULL,
  product jsonb,
  status text NOT NULL CHECK (status IN ('active','completed','cancelled','expired')) DEFAULT 'active',
  last_proximity jsonb,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rfid_reader_find_sessions_active_station_idx
  ON rfid_reader_find_sessions (station_id, expires_at)
  WHERE status = 'active';
