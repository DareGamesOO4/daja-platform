BEGIN;

CREATE INDEX IF NOT EXISTS email_feedback_message_idx
  ON email_feedback_events(ses_message_id, event_type, created_at DESC)
  WHERE ses_message_id IS NOT NULL;

-- Delivery acceptance and the recipient server's outcome are separate facts.
-- A delayed, out-of-order event must not overwrite a permanent failure or delivery.
CREATE OR REPLACE VIEW email_delivery_status AS
SELECT d.*, feedback.event_type AS feedback_type, feedback.created_at AS feedback_at,
  (d.status = 'pending' OR (d.status = 'failed' AND d.retryable))
    AND d.payload <> '{}'::jsonb
    AND d.expires_at > now() + d.minimum_validity_seconds * interval '1 second'
    AND NOT EXISTS (SELECT 1 FROM email_suppressions s WHERE s.email = d.recipient)
    AND (d.payload->>'linkTokenHash' IS NULL OR EXISTS (
      SELECT 1 FROM email_active_links l WHERE l.token_hash = d.payload->>'linkTokenHash' AND l.tag = d.tag
        AND l.expires_at > now() + d.minimum_validity_seconds * interval '1 second'))
    AND (d.payload->>'newsletterSubscriberId' IS NULL OR EXISTS (
      SELECT 1 FROM newsletter_subscribers s WHERE s.id::text = d.payload->>'newsletterSubscriberId' AND s.active))
    AND (d.payload->>'productAlertSubscriptionId' IS NULL OR EXISTS (
      SELECT 1 FROM product_alert_subscriptions s WHERE s.id::text = d.payload->>'productAlertSubscriptionId' AND s.revoked_at IS NULL))
    AS can_retry
FROM email_deliveries d
LEFT JOIN LATERAL (
  SELECT e.event_type, e.created_at FROM email_feedback_events e
  WHERE e.ses_message_id = d.ses_message_id AND e.event_type IN
    ('Complaint','Bounce','Reject','Rendering Failure','RenderingFailure','Delivery','DeliveryDelay')
  ORDER BY CASE e.event_type
    WHEN 'Complaint' THEN 80 WHEN 'Bounce' THEN 70 WHEN 'Reject' THEN 60
    WHEN 'Rendering Failure' THEN 60 WHEN 'RenderingFailure' THEN 60
    WHEN 'Delivery' THEN 40 WHEN 'DeliveryDelay' THEN 20 ELSE 0 END DESC,
    e.created_at DESC
  LIMIT 1
) feedback ON true;

COMMIT;
