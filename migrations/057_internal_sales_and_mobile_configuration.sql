CREATE TABLE IF NOT EXISTS organization_sales_configuration (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  services jsonb NOT NULL DEFAULT '[]'::jsonb,
  staff jsonb NOT NULL DEFAULT '[]'::jsonb,
  shifts jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS internal_sales (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations(id),
  seller_name text,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  payment_method text NOT NULL CHECK (payment_method IN ('cash', 'card', 'mixed')),
  total_minor integer NOT NULL CHECK (total_minor >= 0),
  cash_paid_minor integer NOT NULL DEFAULT 0 CHECK (cash_paid_minor >= 0),
  cash_tendered_minor integer NOT NULL DEFAULT 0 CHECK (cash_tendered_minor >= 0),
  card_paid_minor integer NOT NULL DEFAULT 0 CHECK (card_paid_minor >= 0),
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'partially_returned', 'returned')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS internal_sales_organization_created_idx ON internal_sales (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS internal_sales_location_created_idx ON internal_sales (organization_id, location_id, created_at DESC);

CREATE TABLE IF NOT EXISTS internal_sale_lines (
  id uuid PRIMARY KEY,
  sale_id uuid NOT NULL REFERENCES internal_sales(id) ON DELETE CASCADE,
  product_variant_id uuid NOT NULL REFERENCES product_variants(id),
  rfid_tag_id uuid REFERENCES rfid_tags(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_minor integer NOT NULL CHECK (unit_price_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS internal_sale_service_lines (
  id uuid PRIMARY KEY,
  sale_id uuid NOT NULL REFERENCES internal_sales(id) ON DELETE CASCADE,
  service_id text NOT NULL,
  service_name text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_minor integer NOT NULL CHECK (unit_price_minor >= 0),
  consumable_product_variant_id uuid REFERENCES product_variants(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS internal_sale_shortages (
  id uuid PRIMARY KEY,
  sale_id uuid NOT NULL REFERENCES internal_sales(id) ON DELETE CASCADE,
  product_variant_id uuid NOT NULL REFERENCES product_variants(id),
  requested_quantity integer NOT NULL CHECK (requested_quantity > 0),
  available_quantity integer NOT NULL CHECK (available_quantity >= 0),
  missing_quantity integer NOT NULL CHECK (missing_quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS internal_sale_payment_parts (
  id uuid PRIMARY KEY,
  sale_id uuid NOT NULL REFERENCES internal_sales(id) ON DELETE CASCADE,
  method text NOT NULL CHECK (method IN ('cash', 'card', 'cheque')),
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  cheque_count integer,
  cheque_nominal_minor integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((method <> 'cheque') OR (cheque_count IS NOT NULL AND cheque_count > 0 AND cheque_nominal_minor IS NOT NULL AND cheque_nominal_minor >= 0))
);

CREATE INDEX IF NOT EXISTS internal_sale_payment_parts_sale_idx ON internal_sale_payment_parts (sale_id);
