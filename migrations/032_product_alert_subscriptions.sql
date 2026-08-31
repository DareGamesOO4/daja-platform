BEGIN;

CREATE TABLE IF NOT EXISTS product_alert_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES product_variants (id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers (id) ON DELETE SET NULL,
  email text NOT NULL,
  normalized_email text GENERATED ALWAYS AS (lower(email)) STORED,
  alert_type text NOT NULL CHECK (alert_type IN ('back_in_stock', 'price_change')),
  active boolean NOT NULL DEFAULT true,
  requested_price_amount integer,
  notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, variant_id, normalized_email, alert_type)
);

CREATE INDEX IF NOT EXISTS product_alert_subscriptions_pending_variant_idx
  ON product_alert_subscriptions (organization_id, variant_id, alert_type, created_at)
  WHERE active;

CREATE INDEX IF NOT EXISTS product_alert_subscriptions_customer_idx
  ON product_alert_subscriptions (organization_id, customer_id, created_at DESC)
  WHERE customer_id IS NOT NULL;

COMMIT;
