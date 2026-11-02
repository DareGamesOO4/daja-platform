BEGIN;
CREATE TABLE IF NOT EXISTS media_storage_deletions (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  storage_key text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, storage_key)
);
CREATE INDEX IF NOT EXISTS media_storage_deletions_due ON media_storage_deletions(available_at);
COMMIT;
