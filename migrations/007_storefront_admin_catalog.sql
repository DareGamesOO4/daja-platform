BEGIN;

CREATE TABLE spec_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  slug text NOT NULL CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  department text,
  data_type text NOT NULL DEFAULT 'text',
  active boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX spec_keys_active_org_slug_uq
  ON spec_keys (organization_id, slug)
  WHERE deleted_at IS NULL;

CREATE INDEX spec_keys_org_active_idx
  ON spec_keys (organization_id, active, name)
  WHERE deleted_at IS NULL;

COMMIT;
