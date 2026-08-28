-- Suppliers are shared master data: a desktop-created supplier must be
-- immediately available to every desktop in the same organization.
CREATE TABLE suppliers (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id),
  code text NOT NULL CHECK (length(trim(code)) > 0),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  tax_id text,
  contact_email text,
  active boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX suppliers_active_org_code_uq
  ON suppliers (organization_id, code)
  WHERE deleted_at IS NULL;

CREATE INDEX suppliers_org_active_idx
  ON suppliers (organization_id, active, name)
  WHERE deleted_at IS NULL;
