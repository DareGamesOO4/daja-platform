BEGIN;

-- Keep periodic expiry scans separate from customer and catalogue queries.
CREATE INDEX IF NOT EXISTS privacy_consent_events_retention_idx
  ON privacy_consent_events (retain_until);
CREATE INDEX IF NOT EXISTS marketing_consent_events_retention_idx
  ON marketing_consent_events (retain_until) WHERE retain_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS marketing_consent_events_revocations_idx
  ON marketing_consent_events (organization_id, subject_email_hash, purpose, occurred_at)
  WHERE action = 'revoked';

COMMIT;
