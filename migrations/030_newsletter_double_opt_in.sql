ALTER TABLE newsletter_subscribers
  ADD COLUMN IF NOT EXISTS verification_token_hash text,
  ADD COLUMN IF NOT EXISTS verification_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

-- Existing subscribers opted in under the previous flow. Keep them active and
-- treat them as confirmed so this rollout never revokes an existing benefit.
UPDATE newsletter_subscribers
SET confirmed_at = COALESCE(confirmed_at, updated_at, created_at)
WHERE active AND confirmed_at IS NULL;

CREATE INDEX IF NOT EXISTS newsletter_subscribers_pending_token_idx
  ON newsletter_subscribers (organization_id, verification_token_hash)
  WHERE active = false AND verification_token_hash IS NOT NULL;
