-- Price changes are often saved more than once while an admin corrects a
-- product. Keep one pending event per variant and wait for the catalog to
-- settle before notifying customers.
ALTER TABLE product_regular_price_alert_events
  ADD COLUMN IF NOT EXISTS available_at timestamptz;

ALTER TABLE product_regular_price_alert_events
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

-- Do not send any legacy, already-pending event after this migration. The next
-- actual price change creates a fresh debounced event with the final value.
UPDATE product_regular_price_alert_events
SET superseded_at = now()
WHERE sent_at IS NULL
  AND superseded_at IS NULL;

UPDATE product_regular_price_alert_events
SET available_at = COALESCE(available_at, created_at)
WHERE available_at IS NULL;

ALTER TABLE product_regular_price_alert_events
  ALTER COLUMN available_at SET DEFAULT (now() + interval '10 minutes');

ALTER TABLE product_regular_price_alert_events
  ALTER COLUMN available_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS product_regular_price_alert_events_ready_idx
  ON product_regular_price_alert_events (available_at, created_at)
  WHERE sent_at IS NULL AND superseded_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS product_regular_price_alert_events_one_pending_variant_idx
  ON product_regular_price_alert_events (organization_id, variant_id)
  WHERE sent_at IS NULL AND superseded_at IS NULL;

CREATE OR REPLACE FUNCTION queue_product_regular_price_alert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.current_price_amount IS DISTINCT FROM NEW.current_price_amount THEN
    INSERT INTO product_regular_price_alert_events (
      organization_id,
      variant_id,
      previous_price_amount,
      current_price_amount,
      available_at
    ) VALUES (
      NEW.organization_id,
      NEW.id,
      OLD.current_price_amount,
      NEW.current_price_amount,
      now() + interval '10 minutes'
    )
    ON CONFLICT (organization_id, variant_id)
      WHERE sent_at IS NULL AND superseded_at IS NULL
    DO UPDATE SET
      current_price_amount = EXCLUDED.current_price_amount,
      available_at = EXCLUDED.available_at,
      created_at = now();
  END IF;
  RETURN NEW;
END;
$$;
