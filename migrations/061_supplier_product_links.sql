CREATE TABLE supplier_product_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  product_id uuid NOT NULL REFERENCES products (id),
  provider_code text NOT NULL,
  url text NOT NULL,
  external_reference text,
  check_status text NOT NULL DEFAULT 'unverified' CHECK (check_status IN ('unverified', 'available', 'missing')),
  missing_count integer NOT NULL DEFAULT 0 CHECK (missing_count BETWEEN 0 AND 3),
  last_checked_at timestamptz,
  last_seen_at timestamptz,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, product_id, provider_code)
);
CREATE INDEX supplier_product_links_due_idx ON supplier_product_links (provider_code, next_check_at);

CREATE TABLE supplier_provider_checks (
  provider_code text PRIMARY KEY,
  next_request_at timestamptz NOT NULL DEFAULT now(),
  paused_until timestamptz,
  consecutive_errors integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO supplier_provider_checks (provider_code) VALUES ('ekka');
