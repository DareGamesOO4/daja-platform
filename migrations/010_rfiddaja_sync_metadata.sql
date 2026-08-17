BEGIN;

ALTER TABLE server_sync_events
  ALTER COLUMN correlation_id TYPE text USING correlation_id::text,
  ADD COLUMN IF NOT EXISTS device_sequence bigint NOT NULL DEFAULT 0 CHECK (device_sequence >= 0),
  ADD COLUMN IF NOT EXISTS base_payload jsonb,
  ADD COLUMN IF NOT EXISTS offline_package_id uuid,
  ADD COLUMN IF NOT EXISTS baseline_revision bigint CHECK (baseline_revision IS NULL OR baseline_revision >= 0),
  ADD COLUMN IF NOT EXISTS business_command_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS server_sync_events_device_sequence_uq
  ON server_sync_events (organization_id, device_id, device_sequence)
  WHERE device_sequence > 0;

COMMIT;
