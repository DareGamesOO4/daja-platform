BEGIN;

INSERT INTO permissions (id, description) VALUES
  ('auth.session.manage', 'Manage own authenticated sessions'),
  ('realtime.read', 'Subscribe to realtime organization updates'),
  ('sync.create', 'Push offline sync events'),
  ('sync.view', 'Pull offline sync events and conflicts'),
  ('sync.update', 'Resolve sync conflicts')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE device_sessions
  ADD COLUMN IF NOT EXISTS family_id uuid,
  ADD COLUMN IF NOT EXISTS refresh_jti text,
  ADD COLUMN IF NOT EXISTS replaced_by_session_id uuid REFERENCES device_sessions (id),
  ADD COLUMN IF NOT EXISTS revoked_reason text;

UPDATE device_sessions SET family_id = id WHERE family_id IS NULL;

ALTER TABLE device_sessions
  ALTER COLUMN family_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS device_sessions_refresh_hash_uq
  ON device_sessions (refresh_token_hash)
  WHERE refresh_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS device_sessions_family_active_idx
  ON device_sessions (organization_id, family_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS device_sessions_user_active_idx
  ON device_sessions (organization_id, user_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS legacy_identity_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  source_system text NOT NULL CHECK (source_system IN ('firestore', 'rfiddaja', 'manual')),
  source_collection text NOT NULL,
  source_id text NOT NULL,
  target_table text NOT NULL,
  target_id uuid NOT NULL,
  source_checksum text,
  imported_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  UNIQUE (organization_id, source_system, source_collection, source_id, target_table)
);

CREATE INDEX IF NOT EXISTS legacy_identity_mappings_target_idx
  ON legacy_identity_mappings (organization_id, target_table, target_id);

CREATE TABLE IF NOT EXISTS firestore_mapping_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  import_job_id uuid REFERENCES import_jobs (id),
  collection text NOT NULL,
  dry_run boolean NOT NULL DEFAULT true,
  documents_seen integer NOT NULL DEFAULT 0 CHECK (documents_seen >= 0),
  products_ready integer NOT NULL DEFAULT 0 CHECK (products_ready >= 0),
  brands_ready integer NOT NULL DEFAULT 0 CHECK (brands_ready >= 0),
  categories_ready integer NOT NULL DEFAULT 0 CHECK (categories_ready >= 0),
  specs_ready integer NOT NULL DEFAULT 0 CHECK (specs_ready >= 0),
  missing_image_references integer NOT NULL DEFAULT 0 CHECK (missing_image_references >= 0),
  unmapped_fields jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(unmapped_fields) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
