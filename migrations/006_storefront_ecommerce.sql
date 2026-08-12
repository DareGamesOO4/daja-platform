BEGIN;

INSERT INTO permissions (id, description) VALUES
  ('orders.read', 'Read storefront orders'),
  ('orders.write', 'Update storefront orders'),
  ('reviews.moderate', 'Moderate product reviews'),
  ('customers.read', 'Read storefront customers')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  email text,
  normalized_email text GENERATED ALWAYS AS (lower(email)) STORED,
  phone text,
  normalized_phone text GENERATED ALWAYS AS (regexp_replace(COALESCE(phone, ''), '[^0-9+]', '', 'g')) STORED,
  display_name text NOT NULL,
  first_name text,
  last_name text,
  photo_url text,
  active boolean NOT NULL DEFAULT true,
  email_verified boolean NOT NULL DEFAULT false,
  phone_verified boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS customers_org_email_uq
  ON customers (organization_id, normalized_email)
  WHERE normalized_email IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS customers_org_phone_uq
  ON customers (organization_id, normalized_phone)
  WHERE normalized_phone <> '' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS customers_org_created_idx
  ON customers (organization_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS customer_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('password', 'phone', 'google', 'facebook', 'passkey')),
  provider_subject text NOT NULL,
  password_hash text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider, provider_subject)
);

CREATE TABLE IF NOT EXISTS customer_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  family_id uuid NOT NULL,
  refresh_token_hash text NOT NULL,
  refresh_jti text NOT NULL,
  ip_hash text,
  user_agent_hash text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  replaced_by_session_id uuid REFERENCES customer_sessions (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_sessions_refresh_hash_uq
  ON customer_sessions (refresh_token_hash);
CREATE INDEX IF NOT EXISTS customer_sessions_family_active_idx
  ON customer_sessions (organization_id, customer_id, family_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS customer_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT 'Kuća',
  icon text NOT NULL DEFAULT 'home',
  name text NOT NULL,
  phone text NOT NULL,
  address text NOT NULL,
  city text NOT NULL,
  zip text,
  country_code char(2) NOT NULL DEFAULT 'RS',
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS customer_addresses_customer_idx
  ON customer_addresses (organization_id, customer_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS customer_cart_items (
  organization_id uuid NOT NULL REFERENCES organizations (id),
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products (id),
  variant_id uuid REFERENCES product_variants (id),
  quantity integer NOT NULL CHECK (quantity > 0),
  item_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(item_snapshot) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, customer_id, product_id)
);

CREATE TABLE IF NOT EXISTS customer_wishlist_items (
  organization_id uuid NOT NULL REFERENCES organizations (id),
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products (id),
  item_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(item_snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, customer_id, product_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  display_id text NOT NULL,
  customer_id uuid REFERENCES customers (id),
  customer_email text,
  customer_phone text,
  customer_payload jsonb NOT NULL CHECK (jsonb_typeof(customer_payload) = 'object'),
  shipping_payload jsonb NOT NULL CHECK (jsonb_typeof(shipping_payload) = 'object'),
  items_payload jsonb NOT NULL CHECK (jsonb_typeof(items_payload) = 'array'),
  subtotal_amount integer NOT NULL CHECK (subtotal_amount >= 0),
  discount_amount integer NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  shipping_amount integer NOT NULL DEFAULT 0 CHECK (shipping_amount >= 0),
  total_amount integer NOT NULL CHECK (total_amount >= 0),
  currency char(3) NOT NULL DEFAULT 'RSD',
  promo_code text,
  shipping_method text NOT NULL CHECK (shipping_method IN ('courier', 'pickup')),
  payment_method text NOT NULL CHECK (payment_method IN ('cod', 'pickup')),
  status text NOT NULL,
  is_read boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS orders_org_display_uq
  ON orders (organization_id, display_id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS orders_org_created_idx
  ON orders (organization_id, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS orders_customer_idx
  ON orders (organization_id, customer_id, created_at DESC)
  WHERE customer_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS orders_customer_email_idx
  ON orders (organization_id, lower(customer_email), created_at DESC)
  WHERE customer_email IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id uuid REFERENCES products (id),
  variant_id uuid REFERENCES product_variants (id),
  name text NOT NULL,
  brand text,
  slug text,
  image_url text,
  unit_amount integer NOT NULL CHECK (unit_amount >= 0),
  quantity integer NOT NULL CHECK (quantity > 0),
  total_amount integer NOT NULL CHECK (total_amount >= 0),
  item_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(item_snapshot) = 'object')
);

CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (organization_id, order_id);

CREATE TABLE IF NOT EXISTS order_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  status text NOT NULL,
  changed_by_user_id uuid REFERENCES users (id),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_status_history_order_idx
  ON order_status_history (organization_id, order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS product_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  product_id uuid NOT NULL REFERENCES products (id),
  customer_id uuid REFERENCES customers (id),
  user_name text NOT NULL,
  rating integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text NOT NULL CHECK (length(trim(comment)) > 0),
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('pending', 'published', 'hidden')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS product_reviews_product_idx
  ON product_reviews (organization_id, product_id, created_at DESC)
  WHERE deleted_at IS NULL AND status = 'published';

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  email text NOT NULL,
  normalized_email text GENERATED ALWAYS AS (lower(email)) STORED,
  active boolean NOT NULL DEFAULT true,
  source text NOT NULL DEFAULT 'site',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, normalized_email)
);

CREATE TABLE IF NOT EXISTS otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  phone text NOT NULL,
  code_hash text NOT NULL,
  purpose text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  credential_id text NOT NULL,
  public_key text NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  UNIQUE (organization_id, credential_id)
);

CREATE TABLE IF NOT EXISTS oauth_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google', 'facebook')),
  provider_subject text NOT NULL,
  email text,
  profile jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(profile) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider, provider_subject)
);

COMMIT;
