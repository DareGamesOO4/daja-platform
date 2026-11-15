BEGIN;

-- PostgreSQL delivers these notifications after commit, including updates
-- written by workers. Identical messages are folded within a transaction.
CREATE FUNCTION notify_public_catalog_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('public_catalog_changed', OLD.organization_id::text);
  ELSE
    PERFORM pg_notify('public_catalog_changed', NEW.organization_id::text);
    IF TG_OP = 'UPDATE' AND OLD.organization_id IS DISTINCT FROM NEW.organization_id THEN
      PERFORM pg_notify('public_catalog_changed', OLD.organization_id::text);
    END IF;
  END IF;
  RETURN NULL;
END $$;

DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY[
    'products', 'product_variants', 'variant_prices', 'inventory_balances',
    'product_media', 'media_assets', 'media_derivatives', 'brands', 'categories', 'departments'
  ]
  LOOP
    EXECUTE format('CREATE TRIGGER notify_public_catalog_change
      AFTER INSERT OR UPDATE OR DELETE ON %I
      FOR EACH ROW EXECUTE FUNCTION notify_public_catalog_change()', relation);
  END LOOP;
END $$;

CREATE TRIGGER notify_public_catalog_filter_publication
AFTER UPDATE OF published ON catalog_filter_configurations
FOR EACH ROW WHEN (OLD.published IS DISTINCT FROM NEW.published)
EXECUTE FUNCTION notify_public_catalog_change();

CREATE TRIGGER notify_public_catalog_filter_lifecycle
AFTER INSERT OR DELETE ON catalog_filter_configurations
FOR EACH ROW EXECUTE FUNCTION notify_public_catalog_change();

-- Match the public snapshot's per-product variant lookup and its LIMIT 1.
CREATE INDEX product_variants_public_snapshot_idx
  ON product_variants (organization_id, product_id, current_price_amount DESC, id)
  WHERE deleted_at IS NULL AND active AND published;

CREATE INDEX variant_prices_scheduled_sale_idx
  ON variant_prices (organization_id, valid_from)
  WHERE price_type = 'sale' AND cancelled_at IS NULL;

COMMIT;
