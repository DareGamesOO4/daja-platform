BEGIN;

-- Price records are append-only, so a cancelled promotion keeps its original
-- dates for the audit trail instead of trying to rewrite or delete the row.
ALTER TABLE variant_prices
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

CREATE OR REPLACE FUNCTION allow_only_variant_price_close()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- A sale can be cancelled once, including one that already has a planned
  -- end date. All price facts and the original schedule remain immutable.
  IF OLD.cancelled_at IS NULL
     AND NEW.cancelled_at IS NOT NULL
     AND NEW.id = OLD.id
     AND NEW.organization_id = OLD.organization_id
     AND NEW.variant_id = OLD.variant_id
     AND NEW.amount_minor = OLD.amount_minor
     AND NEW.currency = OLD.currency
     AND NEW.price_type = OLD.price_type
     AND NEW.valid_from = OLD.valid_from
     AND NEW.valid_until IS NOT DISTINCT FROM OLD.valid_until
     AND NEW.created_at = OLD.created_at
     AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by THEN
    RETURN NEW;
  END IF;

  -- Preserve the original behavior for open-ended prices.
  IF OLD.valid_until IS NULL
     AND NEW.valid_until IS NOT NULL
     AND NEW.cancelled_at IS NOT DISTINCT FROM OLD.cancelled_at
     AND NEW.id = OLD.id
     AND NEW.organization_id = OLD.organization_id
     AND NEW.variant_id = OLD.variant_id
     AND NEW.amount_minor = OLD.amount_minor
     AND NEW.currency = OLD.currency
     AND NEW.price_type = OLD.price_type
     AND NEW.valid_from = OLD.valid_from
     AND NEW.created_at = OLD.created_at
     AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'variant_prices is immutable except closing or cancelling once' USING ERRCODE = '45000';
END;
$$;

COMMIT;
