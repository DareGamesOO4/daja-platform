BEGIN;

CREATE TABLE email_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient text NOT NULL,
  payload jsonb NOT NULL,
  deduplication_key text UNIQUE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'suppressed', 'expired')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  ses_message_id text,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_delivery_pending ON email_deliveries (available_at, created_at)
  WHERE status IN ('pending', 'sending');
CREATE INDEX email_delivery_ses_id ON email_deliveries (ses_message_id)
  WHERE ses_message_id IS NOT NULL;

CREATE TABLE email_suppressions (
  email text PRIMARY KEY,
  reason text NOT NULL CHECK (reason IN ('BOUNCE', 'COMPLAINT')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE email_feedback_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  ses_message_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE email_sender_limits (
  region text PRIMARY KEY,
  next_attempt_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE newsletter_subscribers
  ADD COLUMN confirmation_token_hash text,
  ADD COLUMN confirmation_expires_at timestamptz,
  ADD COLUMN confirmed_at timestamptz,
  ADD COLUMN welcome_queued_at timestamptz;
-- Preserve existing subscriptions and their welcome-offer history.
UPDATE newsletter_subscribers SET confirmed_at = CASE WHEN active THEN COALESCE(consented_at, now()) ELSE NULL END,
  welcome_queued_at = created_at;
CREATE UNIQUE INDEX newsletter_confirmation_token
  ON newsletter_subscribers (confirmation_token_hash)
  WHERE confirmation_token_hash IS NOT NULL;

COMMIT;
