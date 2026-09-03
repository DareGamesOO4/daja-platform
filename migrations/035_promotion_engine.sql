BEGIN;

INSERT INTO permissions (id, description) VALUES
  ('promotions.read', 'Read storefront promotion codes'),
  ('promotions.write', 'Create and manage storefront promotion codes')
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT roles.id, permissions.id
FROM roles
CROSS JOIN (VALUES ('promotions.read'), ('promotions.write')) AS permissions(id)
WHERE lower(roles.name) = 'storefront_admin'
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  code text NOT NULL CHECK (code = upper(code) AND code ~ '^[A-Z0-9][A-Z0-9_-]{2,39}$'),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  description text NOT NULL DEFAULT '',
  internal_note text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  discount_type text NOT NULL CHECK (discount_type IN ('percentage', 'fixed', 'free_shipping')),
  discount_value integer NOT NULL DEFAULT 0 CHECK (discount_value >= 0),
  max_discount_amount integer CHECK (max_discount_amount IS NULL OR max_discount_amount >= 0),
  applies_to text NOT NULL DEFAULT 'eligible_items' CHECK (applies_to IN ('eligible_items', 'order')),
  min_order_amount integer NOT NULL DEFAULT 0 CHECK (min_order_amount >= 0),
  min_eligible_quantity integer NOT NULL DEFAULT 1 CHECK (min_eligible_quantity > 0),
  starts_at timestamptz,
  ends_at timestamptz,
  total_usage_limit integer CHECK (total_usage_limit IS NULL OR total_usage_limit > 0),
  uses_count integer NOT NULL DEFAULT 0 CHECK (uses_count >= 0),
  per_customer_usage_limit integer CHECK (per_customer_usage_limit IS NULL OR per_customer_usage_limit > 0),
  login_requirement text NOT NULL DEFAULT 'any' CHECK (login_requirement IN ('any', 'authenticated', 'guest')),
  requires_verified_email boolean NOT NULL DEFAULT false,
  requires_newsletter boolean NOT NULL DEFAULT false,
  first_order_only boolean NOT NULL DEFAULT false,
  min_customer_order_count integer CHECK (min_customer_order_count IS NULL OR min_customer_order_count >= 0),
  max_customer_order_count integer CHECK (max_customer_order_count IS NULL OR max_customer_order_count >= 0),
  min_customer_lifetime_spend integer CHECK (min_customer_lifetime_spend IS NULL OR min_customer_lifetime_spend >= 0),
  allowed_shipping_methods jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(allowed_shipping_methods) = 'array'),
  allowed_payment_methods jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(allowed_payment_methods) = 'array'),
  product_rules jsonb NOT NULL DEFAULT '{"include": {}, "exclude": {}}'::jsonb CHECK (jsonb_typeof(product_rules) = 'object'),
  created_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
  CHECK (discount_type <> 'percentage' OR (discount_value > 0 AND discount_value <= 100)),
  CHECK (discount_type <> 'fixed' OR discount_value > 0),
  CHECK (discount_type <> 'free_shipping' OR discount_value = 0),
  CHECK (max_customer_order_count IS NULL OR min_customer_order_count IS NULL OR max_customer_order_count >= min_customer_order_count)
);

CREATE UNIQUE INDEX IF NOT EXISTS promotions_org_code_uq
  ON promotions (organization_id, code)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS promotions_org_active_schedule_idx
  ON promotions (organization_id, active, starts_at, ends_at)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS promotion_customer_targets (
  promotion_id uuid NOT NULL REFERENCES promotions (id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('include', 'exclude')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (promotion_id, customer_id)
);

CREATE INDEX IF NOT EXISTS promotion_customer_targets_customer_idx
  ON promotion_customer_targets (customer_id, promotion_id);

CREATE TABLE IF NOT EXISTS promotion_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  promotion_id uuid NOT NULL REFERENCES promotions (id),
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers (id) ON DELETE SET NULL,
  code text NOT NULL,
  discount_amount integer NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  free_shipping boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id)
);

CREATE INDEX IF NOT EXISTS promotion_redemptions_customer_idx
  ON promotion_redemptions (organization_id, promotion_id, customer_id, created_at DESC)
  WHERE customer_id IS NOT NULL;

-- Preserve the newsletter welcome-code behaviour while moving it from
-- hardcoded application logic into the configurable promotion engine.
INSERT INTO promotions (
  organization_id, code, name, description, discount_type, discount_value,
  applies_to, login_requirement, requires_newsletter, first_order_only,
  created_at, updated_at
)
SELECT
  id, 'DOBRODOSLI10', 'Newsletter dobrodošlice',
  '10% popusta na prvu porudžbinu za aktivne newsletter pretplatnike.',
  'percentage', 10, 'order', 'authenticated', true, true, now(), now()
FROM organizations
ON CONFLICT (organization_id, code) WHERE deleted_at IS NULL DO NOTHING;

COMMIT;
