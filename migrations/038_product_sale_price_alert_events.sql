CREATE TABLE IF NOT EXISTS product_sale_price_alert_events (
  variant_price_id uuid NOT NULL REFERENCES variant_prices (id),
  event_type text NOT NULL CHECK (event_type IN ('sale_started')),
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (variant_price_id, event_type)
);

CREATE INDEX IF NOT EXISTS product_sale_price_alert_events_sent_at_idx
  ON product_sale_price_alert_events (sent_at DESC);

CREATE TABLE IF NOT EXISTS product_regular_price_alert_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  variant_id uuid NOT NULL REFERENCES product_variants (id),
  previous_price_amount integer NOT NULL CHECK (previous_price_amount >= 0),
  current_price_amount integer NOT NULL CHECK (current_price_amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE INDEX IF NOT EXISTS product_regular_price_alert_events_pending_idx
  ON product_regular_price_alert_events (created_at)
  WHERE sent_at IS NULL;

CREATE OR REPLACE FUNCTION queue_product_regular_price_alert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.current_price_amount IS DISTINCT FROM NEW.current_price_amount THEN
    INSERT INTO product_regular_price_alert_events (
      organization_id, variant_id, previous_price_amount, current_price_amount
    ) VALUES (
      NEW.organization_id, NEW.id, OLD.current_price_amount, NEW.current_price_amount
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS product_regular_price_alert_queue ON product_variants;
CREATE TRIGGER product_regular_price_alert_queue
AFTER UPDATE OF current_price_amount ON product_variants
FOR EACH ROW EXECUTE FUNCTION queue_product_regular_price_alert();
