BEGIN;

-- Existing receipts never imply consent to the newly introduced analytics
-- category. They remain false until the visitor makes a fresh choice.
ALTER TABLE privacy_consent_events
  ADD COLUMN IF NOT EXISTS analytics_allowed boolean NOT NULL DEFAULT false;

COMMIT;
