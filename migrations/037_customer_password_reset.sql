BEGIN;

CREATE TABLE IF NOT EXISTS customer_password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_password_reset_tokens_customer_idx
  ON customer_password_reset_tokens (organization_id, customer_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS customer_password_reset_tokens_one_active_idx
  ON customer_password_reset_tokens (organization_id, customer_id)
  WHERE used_at IS NULL;

COMMIT;
