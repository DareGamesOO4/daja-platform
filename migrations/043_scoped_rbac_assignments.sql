BEGIN;

ALTER TABLE roles
  ADD COLUMN IF NOT EXISTS code text,
  ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- The original Platform schema stored permission identifiers directly in
-- permissions.id. Add the normalized columns used by the new evaluator while
-- preserving those identifiers and their existing grants.
ALTER TABLE permissions
  ADD COLUMN IF NOT EXISTS code text,
  ADD COLUMN IF NOT EXISTS module text,
  ADD COLUMN IF NOT EXISTS action text,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

UPDATE permissions
SET code = COALESCE(code, id),
    module = COALESCE(module, split_part(id, '.', 1)),
    action = COALESCE(action, NULLIF(substr(id, strpos(id, '.') + 1), ''))
WHERE code IS NULL OR module IS NULL OR action IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS permissions_code_uq
  ON permissions (code) WHERE deleted_at IS NULL;

UPDATE roles
SET code = CASE
  WHEN lower(name) IN ('vlasnik', 'owner') THEN 'owner'
  WHEN lower(name) IN ('administrator sistema', 'system_admin') THEN 'system_admin'
  ELSE NULL
END
WHERE code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS roles_org_code_uq
  ON roles (organization_id, code) WHERE code IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS user_role_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
  scope text NOT NULL CHECK (scope IN ('location', 'all_locations')),
  location_id uuid REFERENCES locations (id) ON DELETE CASCADE,
  is_primary boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK ((scope = 'location' AND location_id IS NOT NULL) OR
         (scope = 'all_locations' AND location_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS user_role_assignments_location_uq
  ON user_role_assignments (organization_id, user_id, role_id, location_id)
  WHERE deleted_at IS NULL AND scope = 'location';

CREATE UNIQUE INDEX IF NOT EXISTS user_role_assignments_global_uq
  ON user_role_assignments (organization_id, user_id, role_id)
  WHERE deleted_at IS NULL AND scope = 'all_locations';

CREATE INDEX IF NOT EXISTS user_role_assignments_user_idx
  ON user_role_assignments (organization_id, user_id)
  WHERE deleted_at IS NULL;

INSERT INTO user_role_assignments (organization_id, user_id, role_id, scope, location_id)
SELECT u.organization_id, ur.user_id, ur.role_id, 'location', ula.location_id
FROM user_roles ur
JOIN users u ON u.id = ur.user_id
JOIN user_location_assignments ula ON ula.user_id = ur.user_id
JOIN roles r ON r.id = ur.role_id AND r.organization_id = u.organization_id
ON CONFLICT DO NOTHING;

INSERT INTO user_role_assignments (organization_id, user_id, role_id, scope)
SELECT u.organization_id, ur.user_id, ur.role_id, 'all_locations'
FROM user_roles ur
JOIN users u ON u.id = ur.user_id
JOIN roles r ON r.id = ur.role_id AND r.organization_id = u.organization_id
WHERE r.code = 'owner'
   OR NOT EXISTS (
     SELECT 1 FROM user_location_assignments existing
     WHERE existing.user_id = ur.user_id
   )
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS organization_access_policies (
  organization_id uuid PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
  policy_version bigint NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO organization_access_policies (organization_id)
SELECT id FROM organizations
ON CONFLICT DO NOTHING;

INSERT INTO permissions (id, description) VALUES
  ('users.view', 'View staff users'),
  ('users.create', 'Create staff users'),
  ('users.update', 'Update staff users and assignments'),
  ('users.delete', 'Deactivate staff users'),
  ('roles.view', 'View roles'),
  ('roles.create', 'Create roles'),
  ('roles.update', 'Update roles'),
  ('roles.delete', 'Delete roles'),
  ('roles.manage_permissions', 'Manage role permissions'),
  ('receipts.create', 'Create goods receipts'),
  ('receipts.update', 'Update goods receipts'),
  ('receipts.confirm', 'Confirm goods receipts'),
  ('warehouse.update', 'Update warehouse locations, zones and shelves'),
  ('reports.export', 'Export reports')
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r CROSS JOIN permissions p
WHERE r.code = 'owner'
ON CONFLICT DO NOTHING;

COMMIT;
