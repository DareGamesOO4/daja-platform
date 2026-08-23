BEGIN;

CREATE TABLE device_plugin_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id text NOT NULL CHECK (plugin_id ~ '^[a-z][a-z0-9-]{1,79}$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  vendor text NOT NULL CHECK (length(trim(vendor)) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('rfid_reader', 'barcode_scanner', 'printer', 'gateway', 'integration')),
  version text NOT NULL CHECK (version ~ '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$'),
  summary text NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 240),
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 2000),
  models jsonb NOT NULL CHECK (jsonb_typeof(models) = 'array' AND jsonb_array_length(models) BETWEEN 1 AND 30),
  platforms jsonb NOT NULL CHECK (jsonb_typeof(platforms) = 'array' AND jsonb_array_length(platforms) >= 1),
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(capabilities) = 'array' AND jsonb_array_length(capabilities) <= 30),
  min_app_version text,
  release_notes text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'unpublished')),
  package_storage_key text NOT NULL UNIQUE,
  package_size_bytes bigint NOT NULL CHECK (package_size_bytes BETWEEN 1 AND 524288000),
  package_checksum_sha256 text NOT NULL CHECK (package_checksum_sha256 ~ '^[a-f0-9]{64}$'),
  created_by_organization_id uuid NOT NULL REFERENCES organizations (id),
  created_by_user_id uuid NOT NULL REFERENCES users (id),
  published_at timestamptz,
  unpublished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'draft' AND published_at IS NULL)
    OR (status IN ('published', 'unpublished') AND published_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX device_plugin_releases_plugin_version_uq
  ON device_plugin_releases (plugin_id, version);
CREATE INDEX device_plugin_releases_published_idx
  ON device_plugin_releases (status, name, version DESC)
  WHERE status = 'published';

COMMIT;
