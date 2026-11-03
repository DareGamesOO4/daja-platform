BEGIN;
CREATE TABLE media_derivative_jobs (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  media_asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  source_key text NOT NULL,
  source_checksum text NOT NULL,
  avif_main_key text NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token uuid,
  attempts integer NOT NULL DEFAULT 0,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, media_asset_id)
);
CREATE INDEX media_derivative_jobs_due ON media_derivative_jobs(available_at, created_at);
COMMIT;
