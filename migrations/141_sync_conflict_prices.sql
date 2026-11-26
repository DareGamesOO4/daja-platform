BEGIN;

ALTER TABLE sync_conflicts
  ADD COLUMN details jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN location_id uuid REFERENCES locations(id);

CREATE UNIQUE INDEX sync_conflicts_event_identity
  ON sync_conflicts (organization_id, event_id) WHERE event_id IS NOT NULL;

CREATE TABLE variant_price_edit_clocks (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  variant_id uuid NOT NULL REFERENCES product_variants(id),
  kind text NOT NULL CHECK (kind IN ('regular', 'promotion')),
  saved_at timestamptz NOT NULL,
  device_id uuid,
  user_id uuid,
  PRIMARY KEY (organization_id, variant_id, kind)
);

CREATE FUNCTION record_variant_price_edit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  price_kind text;
  org_id uuid;
  item_id uuid;
  actor_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'product_variants' THEN
    IF OLD.current_price_amount IS NOT DISTINCT FROM NEW.current_price_amount
       AND OLD.currency IS NOT DISTINCT FROM NEW.currency THEN RETURN NEW; END IF;
    price_kind := 'regular';
    org_id := NEW.organization_id;
    item_id := NEW.id;
  ELSE
    IF TG_OP = 'DELETE' THEN
      IF OLD.price_type <> 'sale' THEN RETURN NULL; END IF;
      org_id := OLD.organization_id;
      item_id := OLD.variant_id;
    ELSE
      IF NEW.price_type <> 'sale' THEN RETURN NULL; END IF;
      org_id := NEW.organization_id;
      item_id := NEW.variant_id;
      IF TG_OP = 'INSERT' THEN actor_id := NEW.created_by; END IF;
    END IF;
    IF TG_OP = 'UPDATE' AND ROW(OLD.amount_minor, OLD.currency, OLD.valid_from, OLD.valid_until, OLD.cancelled_at)
        IS NOT DISTINCT FROM ROW(NEW.amount_minor, NEW.currency, NEW.valid_from, NEW.valid_until, NEW.cancelled_at)
        THEN RETURN NEW; END IF;
    price_kind := 'promotion';
  END IF;

  INSERT INTO variant_price_edit_clocks (organization_id, variant_id, kind, saved_at, device_id, user_id)
  VALUES (org_id, item_id, price_kind,
          COALESCE(NULLIF(current_setting('daja.price_saved_at', true), '')::timestamptz, clock_timestamp()),
          NULLIF(current_setting('daja.price_device_id', true), '')::uuid,
          COALESCE(NULLIF(current_setting('daja.price_user_id', true), '')::uuid, actor_id))
  ON CONFLICT (organization_id, variant_id, kind) DO UPDATE
  SET saved_at = EXCLUDED.saved_at, device_id = EXCLUDED.device_id, user_id = EXCLUDED.user_id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER sync_regular_price_clock
AFTER UPDATE OF current_price_amount, currency ON product_variants
FOR EACH ROW EXECUTE FUNCTION record_variant_price_edit();

CREATE TRIGGER sync_promotion_price_clock
AFTER INSERT OR UPDATE OF amount_minor, currency, valid_from, valid_until, cancelled_at OR DELETE ON variant_prices
FOR EACH ROW EXECUTE FUNCTION record_variant_price_edit();

COMMIT;
