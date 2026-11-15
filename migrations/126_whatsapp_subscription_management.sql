BEGIN;

CREATE SEQUENCE whatsapp_watch_code_seq AS bigint START WITH 1001;
ALTER TABLE whatsapp_subscriptions ADD COLUMN watch_code bigint;
ALTER TABLE whatsapp_subscriptions ADD COLUMN notice_version text;
ALTER TABLE whatsapp_subscriptions ADD COLUMN revoked_via text;
ALTER SEQUENCE whatsapp_watch_code_seq OWNED BY whatsapp_subscriptions.watch_code;
UPDATE whatsapp_subscriptions SET watch_code=nextval('whatsapp_watch_code_seq')
  WHERE purpose='price_change' AND revoked_at IS NULL;
CREATE UNIQUE INDEX whatsapp_subscriptions_watch_code_uq ON whatsapp_subscriptions(watch_code)
  WHERE watch_code IS NOT NULL;

CREATE TABLE whatsapp_service_replies (
  message_id text PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  phone text NOT NULL,
  message text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX whatsapp_service_replies_expiry_idx ON whatsapp_service_replies(organization_id, expires_at);
CREATE INDEX whatsapp_service_replies_phone_idx ON whatsapp_service_replies(organization_id, phone);

CREATE TABLE whatsapp_consent_evidence (
  subscription_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  phone_digest text NOT NULL,
  purpose text NOT NULL,
  policy_version text NOT NULL,
  notice_version text,
  source text NOT NULL,
  confirmed_at timestamptz NOT NULL,
  revoked_at timestamptz NOT NULL,
  revoked_via text
);
CREATE INDEX whatsapp_consent_evidence_expiry_idx ON whatsapp_consent_evidence(organization_id,revoked_at);

UPDATE whatsapp_deliveries SET state='cancelled',error_code='template_replaced',updated_at=now()
  WHERE state='queued' AND template_name IN ('daja_newsletter_v1','daja_price_change_v1','session_confirmation');

COMMIT;
