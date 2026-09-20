BEGIN;

ALTER TABLE products
  ALTER COLUMN published SET DEFAULT true;

ALTER TABLE product_variants
  ALTER COLUMN published SET DEFAULT true;

COMMIT;
