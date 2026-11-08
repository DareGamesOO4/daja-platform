BEGIN;

-- One small entry per changed product and transaction. No shared counter row
-- is locked by concurrent catalog, inventory, and media writes.
CREATE TABLE admin_catalog_changes (
  organization_id uuid NOT NULL,
  change_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  product_id uuid NOT NULL,
  owner_id uuid,
  previous_owner_id uuid,
  PRIMARY KEY (organization_id, change_xid, product_id)
);
CREATE INDEX admin_catalog_changes_product_idx
  ON admin_catalog_changes (organization_id, product_id, change_xid DESC);

CREATE FUNCTION admin_catalog_track_product() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO admin_catalog_changes (organization_id, product_id, owner_id)
    VALUES (OLD.organization_id, OLD.id, OLD.created_by_user_id)
    ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO admin_catalog_changes (organization_id, product_id, owner_id, previous_owner_id)
    VALUES (NEW.organization_id, NEW.id, NEW.created_by_user_id,
      CASE WHEN TG_OP = 'UPDATE' AND OLD.created_by_user_id IS DISTINCT FROM NEW.created_by_user_id
        THEN OLD.created_by_user_id END)
    ON CONFLICT (organization_id, change_xid, product_id) DO UPDATE SET
      owner_id = EXCLUDED.owner_id,
      previous_owner_id = COALESCE(admin_catalog_changes.previous_owner_id, EXCLUDED.previous_owner_id);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER admin_catalog_track_products
AFTER INSERT OR UPDATE OR DELETE ON products
FOR EACH ROW EXECUTE FUNCTION admin_catalog_track_product();

CREATE FUNCTION admin_catalog_track_related() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE org uuid; affected_product uuid;
BEGIN
  IF TG_TABLE_NAME = 'server_sync_events' THEN
    -- Use canonical relations, never product IDs supplied by a sync client.
    IF NEW.aggregate_type <> 'product_variant' THEN RETURN NULL; END IF;
    org := NEW.organization_id;
    SELECT product_id INTO affected_product FROM product_variants
      WHERE organization_id = org AND id = NEW.aggregate_id;
  ELSIF TG_TABLE_NAME = 'inventory_balances' THEN
    org := CASE WHEN TG_OP = 'DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
    SELECT product_id INTO affected_product FROM product_variants
      WHERE organization_id = org AND id = CASE WHEN TG_OP = 'DELETE' THEN OLD.variant_id ELSE NEW.variant_id END;
  ELSE
    org := CASE WHEN TG_OP = 'DELETE' THEN OLD.organization_id ELSE NEW.organization_id END;
    affected_product := CASE WHEN TG_OP = 'DELETE' THEN OLD.product_id ELSE NEW.product_id END;
  END IF;
  IF affected_product IS NOT NULL THEN
    INSERT INTO admin_catalog_changes (organization_id, product_id, owner_id)
    SELECT org, affected_product, created_by_user_id FROM products
    WHERE organization_id = org AND id = affected_product
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER admin_catalog_track_variants
AFTER INSERT OR UPDATE OR DELETE ON product_variants
FOR EACH ROW EXECUTE FUNCTION admin_catalog_track_related();

CREATE TRIGGER admin_catalog_track_inventory
AFTER INSERT OR UPDATE OR DELETE ON inventory_balances
FOR EACH ROW EXECUTE FUNCTION admin_catalog_track_related();

CREATE FUNCTION admin_catalog_track_rfid() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE org uuid; variants uuid[] := '{}'; items uuid[] := '{}';
BEGIN
  IF TG_OP <> 'INSERT' THEN
    org := OLD.organization_id;
    variants := array_append(variants, OLD.variant_id);
    items := array_append(items, OLD.inventory_item_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    org := NEW.organization_id;
    variants := array_append(variants, NEW.variant_id);
    items := array_append(items, NEW.inventory_item_id);
  END IF;
  INSERT INTO admin_catalog_changes (organization_id, product_id, owner_id)
  SELECT p.organization_id, p.id, p.created_by_user_id
  FROM product_variants v JOIN products p ON p.id = v.product_id AND p.organization_id = v.organization_id
  WHERE v.organization_id = org AND p.deleted_at IS NULL
    AND (v.id = ANY(variants) OR v.id IN (
      SELECT i.variant_id FROM inventory_items i WHERE i.organization_id = org AND i.id = ANY(items)
    ))
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;

CREATE TRIGGER admin_catalog_track_rfid_tags
AFTER INSERT OR DELETE OR UPDATE OF variant_id, inventory_item_id, epc, tid, status, deleted_at ON rfid_tags
FOR EACH ROW EXECUTE FUNCTION admin_catalog_track_rfid();

CREATE TRIGGER admin_catalog_track_media
AFTER INSERT OR UPDATE OR DELETE ON product_media
FOR EACH ROW EXECUTE FUNCTION admin_catalog_track_related();

CREATE TRIGGER admin_catalog_track_sync
AFTER INSERT ON server_sync_events
FOR EACH ROW WHEN (NEW.aggregate_type = 'product_variant') EXECUTE FUNCTION admin_catalog_track_related();

CREATE INDEX product_media_admin_asset_idx ON product_media (media_asset_id);

CREATE FUNCTION admin_catalog_track_asset() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE asset_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'media_assets' THEN
    asset_id := NEW.id;
  ELSE
    asset_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.media_asset_id ELSE NEW.media_asset_id END;
  END IF;
  INSERT INTO admin_catalog_changes (organization_id, product_id, owner_id)
  SELECT p.organization_id, p.id, p.created_by_user_id
  FROM product_media pm JOIN products p ON p.id = pm.product_id AND p.organization_id = pm.organization_id
  WHERE pm.media_asset_id = asset_id AND p.deleted_at IS NULL
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;

CREATE TRIGGER admin_catalog_track_ready_media
AFTER UPDATE OF status, public_url ON media_assets
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.public_url IS DISTINCT FROM NEW.public_url)
EXECUTE FUNCTION admin_catalog_track_asset();

CREATE TRIGGER admin_catalog_track_media_derivatives
AFTER INSERT OR UPDATE OR DELETE ON media_derivatives
FOR EACH ROW EXECUTE FUNCTION admin_catalog_track_asset();

CREATE FUNCTION admin_catalog_track_label() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO admin_catalog_changes (organization_id, product_id, owner_id)
  SELECT p.organization_id, p.id, p.created_by_user_id
  FROM products p
  WHERE p.organization_id = NEW.organization_id AND p.deleted_at IS NULL AND
    CASE TG_TABLE_NAME
      WHEN 'brands' THEN p.brand_id = NEW.id
      WHEN 'categories' THEN p.primary_category_id = NEW.id
      ELSE p.department_id = NEW.id
    END
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;

CREATE TRIGGER admin_catalog_track_brand_names AFTER UPDATE OF name ON brands
FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name) EXECUTE FUNCTION admin_catalog_track_label();

CREATE TRIGGER admin_catalog_track_category_names AFTER UPDATE OF name ON categories
FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name) EXECUTE FUNCTION admin_catalog_track_label();

CREATE TRIGGER admin_catalog_track_department_slugs AFTER UPDATE OF slug ON departments
FOR EACH ROW WHEN (OLD.slug IS DISTINCT FROM NEW.slug) EXECUTE FUNCTION admin_catalog_track_label();

COMMIT;
