BEGIN;

CREATE TABLE IF NOT EXISTS staff_nfc_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  user_id uuid NOT NULL REFERENCES users (id),
  card_id text NOT NULL CHECK (card_id ~ '^daja_[0-9a-f]{32}$'),
  pin_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  failed_pin_attempts smallint NOT NULL DEFAULT 0 CHECK (failed_pin_attempts >= 0),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (card_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_nfc_cards_one_active_per_user
  ON staff_nfc_cards (organization_id, user_id) WHERE active AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS staff_nfc_cards_active_lookup
  ON staff_nfc_cards (card_id) WHERE active AND revoked_at IS NULL;

COMMIT;
