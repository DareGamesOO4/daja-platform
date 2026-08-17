BEGIN;

-- A desktop browser callback carries only an opaque, short-lived grant. The
-- actual staff access and refresh tokens are minted only after server-side
-- exchange and are never placed in a URL.
CREATE TABLE IF NOT EXISTS desktop_google_oauth_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  callback_url text NOT NULL,
  state_hash text NOT NULL,
  provider_state_hash text NOT NULL,
  grant_hash text,
  customer_id uuid REFERENCES customers (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  consumed_at timestamptz,
  CONSTRAINT desktop_google_oauth_grants_callback_loopback_chk CHECK (
    callback_url ~ '^http://127\\.0\\.0\\.1:[1-9][0-9]{0,4}/callback$'
  ),
  CONSTRAINT desktop_google_oauth_grants_expiry_chk CHECK (expires_at > created_at),
  CONSTRAINT desktop_google_oauth_grants_completion_chk CHECK (
    (grant_hash IS NULL AND completed_at IS NULL AND customer_id IS NULL)
    OR (grant_hash IS NOT NULL AND completed_at IS NOT NULL AND customer_id IS NOT NULL)
  ),
  CONSTRAINT desktop_google_oauth_grants_consumption_chk CHECK (
    consumed_at IS NULL OR completed_at IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS desktop_google_oauth_grants_state_hash_uq
  ON desktop_google_oauth_grants (state_hash);

CREATE UNIQUE INDEX IF NOT EXISTS desktop_google_oauth_grants_provider_state_hash_uq
  ON desktop_google_oauth_grants (provider_state_hash);

CREATE UNIQUE INDEX IF NOT EXISTS desktop_google_oauth_grants_grant_hash_uq
  ON desktop_google_oauth_grants (grant_hash)
  WHERE grant_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS desktop_google_oauth_grants_exchange_idx
  ON desktop_google_oauth_grants (organization_id, device_id, expires_at)
  WHERE completed_at IS NOT NULL AND consumed_at IS NULL;

COMMIT;
