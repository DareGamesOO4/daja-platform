CREATE TABLE storefront_checkout_attempts (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  attempt_hash text NOT NULL,
  proof_hash text NOT NULL,
  request_hash text NOT NULL,
  customer_id uuid,
  order_id uuid REFERENCES orders(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, attempt_hash)
);

CREATE UNIQUE INDEX storefront_checkout_attempts_order_idx
  ON storefront_checkout_attempts (order_id) WHERE order_id IS NOT NULL;
