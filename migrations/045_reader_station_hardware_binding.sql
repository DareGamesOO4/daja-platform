BEGIN;

ALTER TABLE rfid_reader_stations
  ADD COLUMN IF NOT EXISTS hardware_key uuid;

CREATE UNIQUE INDEX IF NOT EXISTS rfid_reader_stations_hardware_key_idx
  ON rfid_reader_stations (organization_id, hardware_key)
  WHERE hardware_key IS NOT NULL;

COMMIT;
