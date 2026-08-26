-- Variant UUIDs are the system identities. SKU is an optional business field
-- and must not be manufactured from a product name or slug.
ALTER TABLE product_variants
  DROP CONSTRAINT IF EXISTS product_variants_sku_check;

ALTER TABLE product_variants
  ALTER COLUMN sku DROP NOT NULL;
