CREATE TABLE IF NOT EXISTS internal_sale_returns (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sale_id uuid NOT NULL REFERENCES internal_sales(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL REFERENCES locations(id),
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS internal_sale_return_lines (
  id uuid PRIMARY KEY,
  return_id uuid NOT NULL REFERENCES internal_sale_returns(id) ON DELETE CASCADE,
  product_variant_id uuid NOT NULL REFERENCES product_variants(id),
  rfid_tag_id uuid REFERENCES rfid_tags(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS internal_sale_service_returns (
  id uuid PRIMARY KEY,
  return_id uuid NOT NULL REFERENCES internal_sale_returns(id) ON DELETE CASCADE,
  service_id text NOT NULL,
  service_name text NOT NULL,
  consumable_product_variant_id uuid REFERENCES product_variants(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS internal_sale_returns_sale_idx ON internal_sale_returns (sale_id, created_at DESC);
