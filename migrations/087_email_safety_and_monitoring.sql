BEGIN;

ALTER TABLE product_alert_contacts ADD COLUMN IF NOT EXISTS verified_at timestamptz;

-- A public request never changes the owner's management key or active alerts.
CREATE TABLE IF NOT EXISTS product_alert_confirmations (
  token_hash text PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  email text NOT NULL,
  intent jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS product_alert_confirmations_contact_idx
  ON product_alert_confirmations(organization_id, email, created_at DESC);

ALTER TABLE newsletter_subscribers ADD COLUMN IF NOT EXISTS last_confirmation_hash text;
CREATE INDEX IF NOT EXISTS newsletter_last_confirmation_idx
  ON newsletter_subscribers(last_confirmation_hash) WHERE last_confirmation_hash IS NOT NULL;

ALTER TABLE email_deliveries ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 10;
ALTER TABLE email_deliveries ADD COLUMN IF NOT EXISTS minimum_validity_seconds integer NOT NULL DEFAULT 0;
ALTER TABLE email_deliveries ADD COLUMN IF NOT EXISTS retryable boolean NOT NULL DEFAULT false;
ALTER TABLE email_deliveries ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES organizations(id);
ALTER TABLE email_deliveries ADD COLUMN IF NOT EXISTS tag text;
UPDATE email_deliveries SET tag = payload->>'tag';
UPDATE email_deliveries SET priority = CASE
  WHEN payload->>'tag' IN ('potvrda-email-adrese','promena-lozinke','novosti-potvrda','product-alert-confirmation') THEN 0
  WHEN payload->>'tag' LIKE 'product-%' OR payload->>'tag' = 'poruka-dobrodoslice' THEN 20
  ELSE 10 END;
UPDATE email_deliveries SET minimum_validity_seconds = 120 WHERE priority = 0;
CREATE INDEX IF NOT EXISTS email_deliveries_priority_idx
  ON email_deliveries(priority, created_at) WHERE status IN ('pending','sending');

CREATE TABLE IF NOT EXISTS email_worker_health (
  region text PRIMARY KEY,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  sender_configured boolean NOT NULL,
  feedback_configured boolean NOT NULL,
  product_alerts_configured boolean NOT NULL,
  feedback_checked_at timestamptz,
  feedback_error_at timestamptz
);

UPDATE email_deliveries d SET organization_id = s.organization_id
FROM newsletter_subscribers s WHERE d.payload->>'newsletterSubscriberId' = s.id::text;
UPDATE email_deliveries d SET organization_id = s.organization_id
FROM product_alert_subscriptions s WHERE d.payload->>'productAlertSubscriptionId' = s.id::text;
UPDATE email_deliveries d SET organization_id = p.organization_id
FROM policy_notification_deliveries n JOIN privacy_policy_publications p ON p.id = n.publication_id
WHERE d.payload->>'policyDeliveryId' = n.id::text;
UPDATE email_deliveries SET organization_id = (SELECT id FROM organizations LIMIT 1)
WHERE organization_id IS NULL AND (SELECT count(*) FROM organizations) = 1;
CREATE INDEX IF NOT EXISTS email_deliveries_organization_idx ON email_deliveries(organization_id, created_at DESC);

CREATE OR REPLACE VIEW email_active_links AS
SELECT t.token_hash, 'potvrda-email-adrese'::text AS tag, t.expires_at
FROM customer_email_verification_tokens t JOIN customers c ON c.id = t.customer_id AND c.organization_id = t.organization_id
WHERE t.used_at IS NULL AND c.active AND c.deleted_at IS NULL
UNION ALL
SELECT t.token_hash, 'promena-lozinke', t.expires_at
FROM customer_password_reset_tokens t JOIN customers c ON c.id = t.customer_id AND c.organization_id = t.organization_id
WHERE t.used_at IS NULL AND c.active AND c.deleted_at IS NULL
UNION ALL
SELECT confirmation_token_hash, 'novosti-potvrda', confirmation_expires_at
FROM newsletter_subscribers WHERE confirmation_token_hash IS NOT NULL AND NOT active
UNION ALL
SELECT token_hash, 'product-alert-confirmation', expires_at FROM product_alert_confirmations WHERE used_at IS NULL;

-- Existing guest keys were issued without proof. Require a new confirmation.
UPDATE product_alert_subscriptions s SET active = false, revoked_at = COALESCE(revoked_at, now()), updated_at = now()
WHERE s.delivery_channel = 'email' AND s.active AND (
  (s.customer_id IS NULL AND NOT EXISTS (SELECT 1 FROM product_alert_contacts c WHERE c.id = s.contact_id AND c.verified_at IS NOT NULL))
  OR (s.customer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = s.customer_id AND c.email_verified))
);

COMMIT;
