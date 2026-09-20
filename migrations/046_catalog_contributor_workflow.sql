BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES users (id),
  ADD COLUMN IF NOT EXISTS quality_review_status text NOT NULL DEFAULT 'pending'
    CHECK (quality_review_status IN ('pending', 'approved', 'changes_requested')),
  ADD COLUMN IF NOT EXISTS quality_review_note text,
  ADD COLUMN IF NOT EXISTS quality_reviewed_by_user_id uuid REFERENCES users (id),
  ADD COLUMN IF NOT EXISTS quality_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS compensation_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS compensation_amount_minor integer;

CREATE INDEX IF NOT EXISTS products_contributor_workflow_idx
  ON products (organization_id, created_by_user_id, quality_review_status, created_at DESC);

CREATE TABLE IF NOT EXISTS catalog_contributor_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
  default_rate_minor integer NOT NULL DEFAULT 0 CHECK (default_rate_minor >= 0),
  currency text NOT NULL DEFAULT 'RSD',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id uuid REFERENCES users (id)
);

CREATE TABLE IF NOT EXISTS catalog_contributor_rates (
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  rate_minor integer NOT NULL CHECK (rate_minor >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id uuid REFERENCES users (id),
  PRIMARY KEY (organization_id, user_id)
);

INSERT INTO catalog_contributor_settings (organization_id)
SELECT id FROM organizations ON CONFLICT DO NOTHING;

INSERT INTO permissions (id, description) VALUES
  ('catalog.contributor', 'Create and edit own catalog products'),
  ('catalog.workforce.manage', 'Review contributor work and compensation')
ON CONFLICT (id) DO NOTHING;

INSERT INTO roles (organization_id, name, description, code, system_role, is_system)
SELECT id, 'Unosilac kataloga', 'Može da unosi i uređuje samo svoje proizvode.', 'catalog_contributor', true, true
FROM organizations
ON CONFLICT (organization_id, code) WHERE code IS NOT NULL AND deleted_at IS NULL DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.id IN ('catalog.read', 'catalog.write', 'catalog.contributor', 'media.upload')
WHERE r.code = 'catalog_contributor'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r JOIN permissions p ON p.id = 'catalog.workforce.manage'
WHERE r.code IN ('owner', 'system_admin') OR lower(r.name) = 'storefront_admin'
ON CONFLICT DO NOTHING;

COMMIT;
