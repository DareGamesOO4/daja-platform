BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  slug text NOT NULL CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  status text NOT NULL CHECK (status IN ('active', 'suspended', 'archived')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX organizations_active_slug_uq ON organizations (slug) WHERE deleted_at IS NULL;

CREATE TABLE locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  code text NOT NULL CHECK (length(trim(code)) > 0),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  type text NOT NULL CHECK (type IN ('warehouse', 'store', 'office', 'virtual')),
  timezone text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX locations_active_org_code_uq ON locations (organization_id, code) WHERE deleted_at IS NULL;
CREATE INDEX locations_org_active_idx ON locations (organization_id, active) WHERE deleted_at IS NULL;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  email text NOT NULL,
  normalized_email text GENERATED ALWAYS AS (lower(email)) STORED,
  display_name text NOT NULL,
  password_hash text,
  active boolean NOT NULL DEFAULT true,
  two_factor_enabled boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_org_email_uq ON users (organization_id, normalized_email);
CREATE INDEX users_org_active_idx ON users (organization_id, active);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  name text NOT NULL,
  description text,
  system_role boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX roles_org_name_uq ON roles (organization_id, lower(name));

CREATE TABLE permissions (
  id text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO permissions (id, description) VALUES
  ('catalog.read', 'Read catalog data'),
  ('catalog.write', 'Create and update catalog data'),
  ('media.upload', 'Upload media assets'),
  ('rfid.read', 'Read RFID data'),
  ('rfid.assign', 'Assign RFID tags'),
  ('inventory.read', 'Read inventory data'),
  ('inventory.adjust', 'Adjust inventory quantities'),
  ('admin.users', 'Manage staff users');

CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  permission_id text NOT NULL REFERENCES permissions (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);

CREATE INDEX role_permissions_permission_idx ON role_permissions (permission_id);

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX user_roles_role_idx ON user_roles (role_id);

CREATE TABLE user_location_assignments (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, location_id)
);

CREATE INDEX user_location_assignments_location_idx ON user_location_assignments (location_id);

CREATE TABLE idempotency_records (
  organization_id uuid NOT NULL REFERENCES organizations (id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  response_status integer,
  response_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (organization_id, idempotency_key)
);

CREATE INDEX idempotency_records_expiry_idx ON idempotency_records (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  location_id uuid REFERENCES locations (id),
  actor_user_id uuid REFERENCES users (id),
  device_id text,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  operation text NOT NULL,
  before_payload jsonb,
  after_payload jsonb,
  reason text,
  correlation_id text NOT NULL,
  request_id text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_org_aggregate_idx ON audit_events (organization_id, aggregate_type, aggregate_id, occurred_at DESC);
CREATE INDEX audit_events_org_time_idx ON audit_events (organization_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION reject_audit_events_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = '45000';
END;
$$;

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_audit_events_mutation();

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_audit_events_mutation();

COMMIT;
