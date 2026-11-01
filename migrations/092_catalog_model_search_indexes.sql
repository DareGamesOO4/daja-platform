BEGIN;

-- Match the search expression exactly; punctuation does not distinguish model codes.
CREATE INDEX product_variants_model_sku_idx ON product_variants
  (organization_id, (regexp_replace(lower(sku), '[^a-z0-9]', '', 'g')))
  WHERE deleted_at IS NULL AND active AND published;
CREATE INDEX product_variants_model_mpn_idx ON product_variants
  (organization_id, (regexp_replace(lower(mpn), '[^a-z0-9]', '', 'g')))
  WHERE deleted_at IS NULL AND active AND published;
CREATE INDEX products_model_name_idx ON products
  (organization_id, (regexp_replace(lower(name), '[^a-z0-9]', '', 'g')))
  WHERE deleted_at IS NULL AND active AND published;

COMMIT;
