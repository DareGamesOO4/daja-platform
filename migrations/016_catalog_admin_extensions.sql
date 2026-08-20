BEGIN;

CREATE INDEX IF NOT EXISTS variant_prices_variant_validity_idx
  ON variant_prices (organization_id, variant_id, price_type, valid_from, valid_until);

ALTER TABLE product_reviews
  ADD CONSTRAINT product_reviews_status_check
  CHECK (status IN ('pending', 'published', 'rejected'));

CREATE INDEX IF NOT EXISTS product_reviews_moderation_idx
  ON product_reviews (organization_id, product_id, status, created_at DESC)
  WHERE deleted_at IS NULL;

COMMIT;
