BEGIN;

ALTER TABLE product_alert_subscriptions
  ALTER COLUMN email DROP NOT NULL;

ALTER TABLE product_alert_subscriptions
  ADD COLUMN IF NOT EXISTS delivery_channel text NOT NULL DEFAULT 'email'
    CHECK (delivery_channel IN ('email', 'sms')),
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS normalized_phone text
    GENERATED ALWAYS AS (regexp_replace(phone, '[^0-9+]', '', 'g')) STORED,
  ADD COLUMN IF NOT EXISTS contact_key text
    GENERATED ALWAYS AS (
      CASE
        WHEN delivery_channel = 'sms' THEN regexp_replace(phone, '[^0-9+]', '', 'g')
        ELSE lower(email)
      END
    ) STORED;

ALTER TABLE product_alert_subscriptions
  DROP CONSTRAINT IF EXISTS product_alert_subscriptions_organization_id_variant_id_normalized_email_alert_type_key;

ALTER TABLE product_alert_subscriptions
  ADD CONSTRAINT product_alert_subscriptions_channel_contact_unique
    UNIQUE (organization_id, variant_id, delivery_channel, contact_key, alert_type);

CREATE INDEX IF NOT EXISTS product_alert_subscriptions_phone_idx
  ON product_alert_subscriptions (organization_id, normalized_phone, created_at DESC)
  WHERE normalized_phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS sms_marketing_subscribers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  customer_id uuid REFERENCES customers (id) ON DELETE SET NULL,
  phone text NOT NULL,
  normalized_phone text GENERATED ALWAYS AS (regexp_replace(phone, '[^0-9+]', '', 'g')) STORED,
  active boolean NOT NULL DEFAULT true,
  consent_version text,
  consented_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, normalized_phone)
);

CREATE INDEX IF NOT EXISTS sms_marketing_subscribers_customer_idx
  ON sms_marketing_subscribers (organization_id, customer_id, created_at DESC)
  WHERE customer_id IS NOT NULL;

COMMIT;
