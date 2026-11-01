BEGIN;

-- Trigrams support partial model codes, including the middle of a SKU.
CREATE INDEX product_variants_model_sku_trgm_idx ON product_variants
  USING gin ((regexp_replace(lower(sku), '[^a-z0-9]', '', 'g')) gin_trgm_ops)
  WHERE deleted_at IS NULL AND active AND published;
CREATE INDEX product_variants_model_mpn_trgm_idx ON product_variants
  USING gin ((regexp_replace(lower(mpn), '[^a-z0-9]', '', 'g')) gin_trgm_ops)
  WHERE deleted_at IS NULL AND active AND published;
CREATE INDEX products_model_name_trgm_idx ON products
  USING gin ((regexp_replace(lower(name), '[^a-z0-9]', '', 'g')) gin_trgm_ops)
  WHERE deleted_at IS NULL AND active AND published;

COMMIT;
