BEGIN;

INSERT INTO permissions (id, description) VALUES
  ('privacy.manage', 'Publish privacy-policy versions and policy notices')
ON CONFLICT (id) DO NOTHING;

-- Existing storefront administrators keep access, while the new permission
-- remains independently auditable for future role management.
INSERT INTO role_permissions (role_id, permission_id)
SELECT roles.id, 'privacy.manage'
FROM roles
WHERE lower(roles.name) = 'storefront_admin'
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS privacy_policy_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  version text NOT NULL,
  change_summary text NOT NULL DEFAULT '',
  material boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  published_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  effective_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS privacy_policy_publications_one_active_idx
  ON privacy_policy_publications (organization_id)
  WHERE active;

CREATE TABLE IF NOT EXISTS privacy_consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  receipt_hash text NOT NULL,
  customer_id uuid REFERENCES customers (id) ON DELETE SET NULL,
  policy_version text NOT NULL,
  preferences_allowed boolean NOT NULL DEFAULT false,
  external_google_allowed boolean NOT NULL DEFAULT false,
  action text NOT NULL CHECK (action IN ('granted', 'updated', 'revoked', 'policy_reset')),
  source text NOT NULL DEFAULT 'storefront_web',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  -- Every cookie/privacy decision is kept as proof for five years.
  retain_until timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS privacy_consent_events_receipt_idx
  ON privacy_consent_events (organization_id, receipt_hash, occurred_at DESC);

CREATE INDEX IF NOT EXISTS privacy_consent_events_customer_idx
  ON privacy_consent_events (organization_id, customer_id, occurred_at DESC)
  WHERE customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS product_alert_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  email text NOT NULL,
  normalized_email text GENERATED ALWAYS AS (lower(email)) STORED,
  management_token_hash text NOT NULL UNIQUE,
  terms_accepted_at timestamptz,
  policy_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, normalized_email)
);

ALTER TABLE newsletter_subscribers
  ADD COLUMN IF NOT EXISTS consent_status text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS consent_version text,
  ADD COLUMN IF NOT EXISTS consented_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

ALTER TABLE product_alert_subscriptions
  ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES product_alert_contacts (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS consent_status text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS consent_version text,
  ADD COLUMN IF NOT EXISTS consented_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

CREATE INDEX IF NOT EXISTS product_alert_subscriptions_contact_idx
  ON product_alert_subscriptions (organization_id, contact_id, created_at DESC)
  WHERE contact_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS marketing_consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  subject_email_hash text NOT NULL,
  customer_id uuid REFERENCES customers (id) ON DELETE SET NULL,
  newsletter_subscriber_id uuid REFERENCES newsletter_subscribers (id) ON DELETE SET NULL,
  product_alert_subscription_id uuid REFERENCES product_alert_subscriptions (id) ON DELETE SET NULL,
  purpose text NOT NULL CHECK (purpose IN ('newsletter', 'product_alert')),
  action text NOT NULL CHECK (action IN ('granted', 'renewed', 'revoked', 'legacy')),
  policy_version text,
  source text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  -- Active consent proof is retained while the subscription is active. On
  -- revocation the application sets this to three years after revocation.
  retain_until timestamptz
);

CREATE INDEX IF NOT EXISTS marketing_consent_events_subject_idx
  ON marketing_consent_events (organization_id, subject_email_hash, occurred_at DESC);

CREATE TABLE IF NOT EXISTS policy_notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id uuid NOT NULL REFERENCES privacy_policy_publications (id) ON DELETE CASCADE,
  recipient_email text NOT NULL,
  normalized_email text GENERATED ALWAYS AS (lower(recipient_email)) STORED,
  recipient_kind text NOT NULL CHECK (recipient_kind IN ('customer', 'newsletter')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (publication_id, normalized_email)
);

CREATE INDEX IF NOT EXISTS policy_notification_deliveries_pending_idx
  ON policy_notification_deliveries (status, created_at)
  WHERE status IN ('queued', 'failed');

UPDATE newsletter_subscribers
SET consent_status = CASE WHEN consent_status = '' THEN 'legacy' ELSE consent_status END,
    consented_at = COALESCE(consented_at, confirmed_at, updated_at, created_at)
WHERE active;

UPDATE product_alert_subscriptions
SET consent_status = CASE WHEN consent_status = '' THEN 'legacy' ELSE consent_status END,
    consented_at = COALESCE(consented_at, updated_at, created_at)
WHERE active;

COMMIT;
