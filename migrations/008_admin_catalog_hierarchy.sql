BEGIN;

CREATE TABLE departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  slug text NOT NULL CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (organization_id, slug)
);

INSERT INTO departments (organization_id, name, slug, sort_order)
SELECT o.id, seed.name, seed.slug, seed.sort_order
FROM organizations o
CROSS JOIN (VALUES
  ('Satovi', 'satovi', 10),
  ('Naočare', 'naocare', 20),
  ('Daljinski', 'daljinski', 30),
  ('Baterije', 'baterije', 40)
) AS seed(name, slug, sort_order)
ON CONFLICT (organization_id, slug) DO NOTHING;

ALTER TABLE brands ADD COLUMN department_id uuid REFERENCES departments (id);
ALTER TABLE categories ADD COLUMN department_id uuid REFERENCES departments (id);
ALTER TABLE categories ADD COLUMN brand_id uuid REFERENCES brands (id);
ALTER TABLE products ADD COLUMN department_id uuid REFERENCES departments (id);
ALTER TABLE products ADD COLUMN seo jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(seo) = 'object');
ALTER TABLE products ADD COLUMN features jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(features) = 'array');
ALTER TABLE products ADD COLUMN model_3d_url text;
ALTER TABLE spec_keys ADD COLUMN department_id uuid REFERENCES departments (id);
ALTER TABLE spec_keys ADD COLUMN unit text;

-- Existing catalogue records deliberately stay unassigned.  Assigning every
-- legacy record to "satovi" hides incomplete data and makes later clean-up
-- impossible.  Staff can assign a department before publishing a product.
UPDATE spec_keys s SET department_id = d.id
FROM departments d
WHERE d.organization_id = s.organization_id AND d.slug = COALESCE(s.department, 'satovi') AND s.department_id IS NULL;

CREATE INDEX brands_department_idx ON brands (organization_id, department_id) WHERE deleted_at IS NULL;
CREATE INDEX categories_department_brand_idx ON categories (organization_id, department_id, brand_id) WHERE deleted_at IS NULL;
CREATE INDEX products_department_idx ON products (organization_id, department_id) WHERE deleted_at IS NULL;
CREATE INDEX spec_keys_department_idx ON spec_keys (organization_id, department_id) WHERE deleted_at IS NULL;

CREATE TABLE variant_specification_values (
  organization_id uuid NOT NULL REFERENCES organizations (id),
  variant_id uuid NOT NULL REFERENCES product_variants (id) ON DELETE CASCADE,
  spec_key_id uuid NOT NULL REFERENCES spec_keys (id),
  value text NOT NULL CHECK (length(trim(value)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (variant_id, spec_key_id)
);
CREATE INDEX variant_specification_values_org_variant_idx ON variant_specification_values (organization_id, variant_id);

COMMIT;
