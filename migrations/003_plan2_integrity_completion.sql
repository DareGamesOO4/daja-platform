BEGIN;

CREATE OR REPLACE FUNCTION reject_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '45000';
END;
$$;

CREATE OR REPLACE FUNCTION allow_only_variant_price_close()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.valid_until IS NULL
     AND NEW.valid_until IS NOT NULL
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
  RAISE EXCEPTION 'variant_prices is immutable except closing valid_until once' USING ERRCODE = '45000';
END;
$$;

CREATE TRIGGER variant_prices_only_close
BEFORE UPDATE ON variant_prices
FOR EACH ROW EXECUTE FUNCTION allow_only_variant_price_close();

CREATE TRIGGER variant_prices_no_delete
BEFORE DELETE ON variant_prices
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER rfid_tag_events_no_update
BEFORE UPDATE ON rfid_tag_events
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER rfid_tag_events_no_delete
BEFORE DELETE ON rfid_tag_events
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER inventory_events_no_update
BEFORE UPDATE ON inventory_events
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER inventory_events_no_delete
BEFORE DELETE ON inventory_events
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE OR REPLACE FUNCTION enforce_category_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_org uuid;
  cycle_found boolean;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT organization_id INTO parent_org
  FROM categories
  WHERE id = NEW.parent_id AND deleted_at IS NULL;

  IF parent_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'category parent must belong to the same organization' USING ERRCODE = '23514';
  END IF;

  WITH RECURSIVE ancestors AS (
    SELECT parent_id
    FROM categories
    WHERE id = NEW.parent_id
    UNION ALL
    SELECT c.parent_id
    FROM categories c
    JOIN ancestors a ON c.id = a.parent_id
    WHERE c.parent_id IS NOT NULL
  )
  SELECT EXISTS (SELECT 1 FROM ancestors WHERE parent_id = NEW.id) INTO cycle_found;

  IF cycle_found THEN
    RAISE EXCEPTION 'category hierarchy cycle rejected' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER categories_integrity
BEFORE INSERT OR UPDATE OF organization_id, parent_id ON categories
FOR EACH ROW EXECUTE FUNCTION enforce_category_integrity();

CREATE OR REPLACE FUNCTION enforce_plan2_tenant_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  ref_org uuid;
  item_variant uuid;
BEGIN
  IF TG_TABLE_NAME = 'products' THEN
    IF NEW.brand_id IS NOT NULL THEN
      SELECT organization_id INTO ref_org FROM brands WHERE id = NEW.brand_id AND deleted_at IS NULL;
      IF ref_org IS DISTINCT FROM NEW.organization_id THEN
        RAISE EXCEPTION 'brand must belong to product organization' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.primary_category_id IS NOT NULL THEN
      SELECT organization_id INTO ref_org FROM categories WHERE id = NEW.primary_category_id AND deleted_at IS NULL;
      IF ref_org IS DISTINCT FROM NEW.organization_id THEN
        RAISE EXCEPTION 'category must belong to product organization' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'product_variants' THEN
    SELECT organization_id INTO ref_org FROM products WHERE id = NEW.product_id AND deleted_at IS NULL;
    IF ref_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'product must belong to variant organization' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'product_media' THEN
    SELECT organization_id INTO ref_org FROM products WHERE id = NEW.product_id AND deleted_at IS NULL;
    IF ref_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'product media product organization mismatch' USING ERRCODE = '23514';
    END IF;
    SELECT organization_id INTO ref_org FROM media_assets WHERE id = NEW.media_asset_id AND deleted_at IS NULL;
    IF ref_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'product media asset organization mismatch' USING ERRCODE = '23514';
    END IF;
    IF NEW.variant_id IS NOT NULL THEN
      SELECT organization_id INTO ref_org FROM product_variants WHERE id = NEW.variant_id AND deleted_at IS NULL;
      IF ref_org IS DISTINCT FROM NEW.organization_id THEN
        RAISE EXCEPTION 'product media variant organization mismatch' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'warehouses' THEN
    SELECT organization_id INTO ref_org FROM locations WHERE id = NEW.location_id AND deleted_at IS NULL;
    IF ref_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'warehouse location organization mismatch' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'warehouse_zones' THEN
    SELECT organization_id INTO ref_org FROM warehouses WHERE id = NEW.warehouse_id AND deleted_at IS NULL;
    IF ref_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'warehouse zone organization mismatch' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'warehouse_bins' THEN
    SELECT organization_id INTO ref_org
    FROM warehouse_zones
    WHERE id = NEW.zone_id AND deleted_at IS NULL;
    IF ref_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'warehouse bin organization mismatch' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'inventory_items' THEN
    SELECT organization_id INTO ref_org FROM product_variants WHERE id = NEW.variant_id AND deleted_at IS NULL;
    IF ref_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'inventory item variant organization mismatch' USING ERRCODE = '23514';
    END IF;
    IF NEW.current_location_id IS NOT NULL THEN
      SELECT organization_id INTO ref_org FROM locations WHERE id = NEW.current_location_id AND deleted_at IS NULL;
      IF ref_org IS DISTINCT FROM NEW.organization_id THEN
        RAISE EXCEPTION 'inventory item location organization mismatch' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'rfid_tags' THEN
    IF NEW.inventory_item_id IS NOT NULL THEN
      SELECT organization_id, variant_id INTO ref_org, item_variant
      FROM inventory_items
      WHERE id = NEW.inventory_item_id AND deleted_at IS NULL;
      IF ref_org IS DISTINCT FROM NEW.organization_id THEN
        RAISE EXCEPTION 'rfid inventory item organization mismatch' USING ERRCODE = '23514';
      END IF;
      IF NEW.variant_id IS NOT NULL AND NEW.variant_id <> item_variant THEN
        RAISE EXCEPTION 'rfid inventory item and variant contradict each other' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.variant_id IS NOT NULL THEN
      SELECT organization_id INTO ref_org FROM product_variants WHERE id = NEW.variant_id AND deleted_at IS NULL;
      IF ref_org IS DISTINCT FROM NEW.organization_id THEN
        RAISE EXCEPTION 'rfid variant organization mismatch' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER products_tenant_integrity
BEFORE INSERT OR UPDATE OF organization_id, brand_id, primary_category_id ON products
FOR EACH ROW EXECUTE FUNCTION enforce_plan2_tenant_integrity();

CREATE TRIGGER product_variants_tenant_integrity
BEFORE INSERT OR UPDATE OF organization_id, product_id ON product_variants
FOR EACH ROW EXECUTE FUNCTION enforce_plan2_tenant_integrity();

CREATE TRIGGER product_media_tenant_integrity
BEFORE INSERT OR UPDATE OF organization_id, product_id, variant_id, media_asset_id ON product_media
FOR EACH ROW EXECUTE FUNCTION enforce_plan2_tenant_integrity();

CREATE TRIGGER warehouses_tenant_integrity
BEFORE INSERT OR UPDATE OF organization_id, location_id ON warehouses
FOR EACH ROW EXECUTE FUNCTION enforce_plan2_tenant_integrity();

CREATE TRIGGER warehouse_zones_tenant_integrity
BEFORE INSERT OR UPDATE OF organization_id, warehouse_id ON warehouse_zones
FOR EACH ROW EXECUTE FUNCTION enforce_plan2_tenant_integrity();

CREATE TRIGGER warehouse_bins_tenant_integrity
BEFORE INSERT OR UPDATE OF organization_id, zone_id ON warehouse_bins
FOR EACH ROW EXECUTE FUNCTION enforce_plan2_tenant_integrity();

CREATE TRIGGER inventory_items_tenant_integrity
BEFORE INSERT OR UPDATE OF organization_id, variant_id, current_location_id ON inventory_items
FOR EACH ROW EXECUTE FUNCTION enforce_plan2_tenant_integrity();

CREATE TRIGGER rfid_tags_tenant_integrity
BEFORE INSERT OR UPDATE OF organization_id, inventory_item_id, variant_id ON rfid_tags
FOR EACH ROW EXECUTE FUNCTION enforce_plan2_tenant_integrity();

COMMIT;
