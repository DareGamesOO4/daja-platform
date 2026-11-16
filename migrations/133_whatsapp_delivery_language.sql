BEGIN;

ALTER TABLE whatsapp_deliveries ADD COLUMN delivery_language text
  CHECK (delivery_language IN ('sr', 'en'));

-- Old queued price arguments can already contain English prices and links.
UPDATE whatsapp_deliveries d
SET state='cancelled',error_code='language_replaced',updated_at=now()
FROM whatsapp_subscriptions s
WHERE s.id=d.subscription_id AND s.language='en' AND s.purpose<>'newsletter'
  AND d.state='queued' AND d.kind='template'
  AND d.template_name<>'daja_price_regular_increase_coupon_v1';

COMMIT;
