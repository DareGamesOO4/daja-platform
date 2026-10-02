BEGIN;

CREATE TABLE catalog_variant_group_versions (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  revision integer NOT NULL DEFAULT 0
);
CREATE TABLE catalog_variant_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK (kind IN ('automatic', 'custom')),
  source_prefix text,
  internal_name text,
  follow_auto boolean NOT NULL DEFAULT false,
  customized boolean NOT NULL DEFAULT false,
  created_by_user_id uuid REFERENCES users(id),
  updated_by_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, source_prefix),
  CHECK ((kind = 'automatic' AND source_prefix IS NOT NULL) OR
         (kind = 'custom' AND source_prefix IS NULL AND NOT follow_auto))
);
CREATE TABLE catalog_variant_group_products (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  product_id uuid NOT NULL REFERENCES products(id),
  group_id uuid,
  origin_group_id uuid REFERENCES catalog_variant_groups(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('manual', 'snapshot', 'detached')),
  PRIMARY KEY (organization_id, product_id),
  FOREIGN KEY (organization_id, group_id) REFERENCES catalog_variant_groups(organization_id, id),
  CHECK ((kind = 'detached' AND group_id IS NULL) OR (kind <> 'detached' AND group_id IS NOT NULL))
);
CREATE INDEX catalog_variant_group_members ON catalog_variant_group_products(organization_id, group_id);
INSERT INTO permissions(id, description)
VALUES ('catalog.variant_groups.manage', 'Manage storefront variant groups') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id, permission_id)
SELECT id, 'catalog.variant_groups.manage' FROM roles
WHERE code IN ('owner', 'system_admin') OR lower(name) = 'storefront_admin'
ON CONFLICT DO NOTHING;
INSERT INTO roles(organization_id,name,description,code,system_role,is_system)
SELECT id, 'Upravljač grupa varijanti', 'Dodatna dozvola za ručno povezivanje proizvoda.', 'variant_groups_manager', true, true
FROM organizations
ON CONFLICT (organization_id,code) WHERE code IS NOT NULL AND deleted_at IS NULL DO NOTHING;
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,p.id FROM roles r JOIN permissions p ON p.id IN ('catalog.variant_groups.manage','catalog.read','realtime.read')
WHERE r.code='variant_groups_manager' ON CONFLICT DO NOTHING;

COMMIT;
