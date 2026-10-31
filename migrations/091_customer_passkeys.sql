BEGIN;

ALTER TABLE webauthn_credentials
  ADD COLUMN rp_id text,
  ADD COLUMN user_handle text,
  ADD COLUMN transports text[] NOT NULL DEFAULT '{}',
  ADD COLUMN device_type text,
  ADD COLUMN backed_up boolean NOT NULL DEFAULT false;

-- Legacy rows were never verified by an implemented WebAuthn registration flow.
-- Only new, verified rows with an explicit RP ID may authenticate.
CREATE UNIQUE INDEX webauthn_credentials_rp_id_credential_uq
  ON webauthn_credentials (rp_id, credential_id) WHERE rp_id IS NOT NULL;
CREATE INDEX webauthn_credentials_customer_idx
  ON webauthn_credentials (organization_id, customer_id) WHERE rp_id IS NOT NULL;

-- Remove the retired provider without deleting customer accounts or orders.
UPDATE customer_sessions SET revoked_at=now(),revoked_reason='retired_identity_provider'
 WHERE revoked_at IS NULL AND (organization_id,customer_id) IN (
   SELECT organization_id,customer_id FROM customer_identities WHERE provider='facebook'
   UNION SELECT organization_id,customer_id FROM oauth_accounts WHERE provider='facebook'
 );
DELETE FROM oauth_accounts WHERE provider = 'facebook';
DELETE FROM customer_identities WHERE provider = 'facebook';
ALTER TABLE oauth_accounts DROP CONSTRAINT oauth_accounts_provider_check;
ALTER TABLE oauth_accounts ADD CONSTRAINT oauth_accounts_provider_check CHECK (provider = 'google');
ALTER TABLE customer_identities DROP CONSTRAINT customer_identities_provider_check;
ALTER TABLE customer_identities ADD CONSTRAINT customer_identities_provider_check
  CHECK (provider IN ('password', 'phone', 'google', 'passkey'));

COMMIT;
