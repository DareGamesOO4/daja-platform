BEGIN;

ALTER TABLE whatsapp_deliveries ADD COLUMN alert_price_amount bigint;
ALTER TABLE whatsapp_deliveries ADD COLUMN alert_sale_id uuid;
ALTER TABLE whatsapp_deliveries ADD COLUMN attempted_at timestamptz;
ALTER TABLE whatsapp_deliveries ADD COLUMN send_after timestamptz NOT NULL DEFAULT now();

-- Use historical send states when enforcing a limit immediately after rollout.
UPDATE whatsapp_deliveries SET attempted_at = updated_at
WHERE kind = 'template' AND state IN ('sending','accepted','sent','delivered','read','failed','unknown');

-- Legacy queued price messages have no structured amount for a freshness check.
UPDATE whatsapp_deliveries SET state='cancelled',error_code='legacy_price_snapshot',updated_at=now()
WHERE state='queued' AND template_name IN ('daja_price_change_v2','daja_price_regular_decrease_v1');

CREATE INDEX whatsapp_deliveries_recent_attempt_idx
  ON whatsapp_deliveries(subscription_id, attempted_at DESC)
  WHERE kind = 'template' AND attempted_at IS NOT NULL;

CREATE INDEX product_regular_price_alert_events_whatsapp_idx
  ON product_regular_price_alert_events(organization_id, variant_id, created_at DESC)
  WHERE superseded_at IS NULL;

COMMIT;
