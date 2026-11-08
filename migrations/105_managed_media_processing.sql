BEGIN;
CREATE TABLE media_worker_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  profile jsonb,
  pc_seen_at timestamptz,
  pc_available_at timestamptz,
  render_seen_at timestamptz,
  render_completed_at timestamptz,
  render_error_at timestamptz
);
ALTER TABLE media_derivative_jobs
  ADD COLUMN rendered_at timestamptz,
  ADD COLUMN source_width integer,
  ADD COLUMN source_height integer,
  ADD COLUMN render_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN lease_worker text;
ALTER TABLE media_storage_deletions
  ADD COLUMN media_asset_id uuid,
  ADD COLUMN recheck_at timestamptz;
CREATE INDEX media_storage_deletions_asset ON media_storage_deletions(organization_id,media_asset_id)
  WHERE media_asset_id IS NOT NULL;
CREATE TABLE media_import_cancellations (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  request_id uuid NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
  PRIMARY KEY (organization_id, request_id)
);
CREATE INDEX media_import_cancellations_expiry ON media_import_cancellations(expires_at);
COMMIT;
