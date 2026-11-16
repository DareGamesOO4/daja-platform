ALTER TABLE email_deliveries
  ADD COLUMN ses_timeout_at timestamptz,
  ADD COLUMN ses_delivered_at timestamptz,
  ADD COLUMN icloud_accepted_at timestamptz;
