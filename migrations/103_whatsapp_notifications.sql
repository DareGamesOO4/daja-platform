BEGIN;
CREATE TABLE whatsapp_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  phone text NOT NULL CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  purpose text NOT NULL CHECK (purpose IN ('newsletter','price_change','back_in_stock')),
  language text NOT NULL DEFAULT 'sr' CHECK(language IN ('sr','en')),
  product_id uuid,
  variant_id uuid,
  policy_version text NOT NULL,
  source text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  revoked_at timestamptz,
  active boolean NOT NULL DEFAULT false,
  last_price bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((purpose='newsletter' AND product_id IS NULL AND variant_id IS NULL) OR
    (purpose<>'newsletter' AND product_id IS NOT NULL AND variant_id IS NOT NULL))
);
CREATE INDEX whatsapp_subscriptions_active_idx ON whatsapp_subscriptions(organization_id, purpose, variant_id) WHERE active;
CREATE INDEX whatsapp_subscriptions_phone_idx ON whatsapp_subscriptions(organization_id, phone);
CREATE TABLE whatsapp_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES whatsapp_subscriptions(id),
  dedupe_key text NOT NULL UNIQUE,
  template_name text NOT NULL,
  kind text NOT NULL DEFAULT 'template' CHECK(kind IN ('template','text')),
  parameters jsonb NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','accepted','sent','delivered','read','failed','unknown','cancelled')),
  provider_id text UNIQUE,
  error_code text,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '23 hours',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_deliveries_queue_idx ON whatsapp_deliveries(created_at) WHERE state='queued';
CREATE TABLE whatsapp_webhook_receipts (
  message_id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE whatsapp_delivery_statuses (
  provider_id text PRIMARY KEY,
  state text NOT NULL CHECK(state IN ('sent','delivered','read','failed')),
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE whatsapp_campaigns (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  id uuid NOT NULL,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,id)
);
COMMIT;
