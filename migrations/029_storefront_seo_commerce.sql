ALTER TABLE products
  ADD COLUMN IF NOT EXISTS item_condition text NOT NULL DEFAULT 'new'
    CHECK (item_condition IN ('new', 'used', 'refurbished'));

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS mpn text;

ALTER TABLE product_media
  ADD COLUMN IF NOT EXISTS alt_text text;

CREATE TABLE IF NOT EXISTS product_slug_redirects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  product_id uuid NOT NULL REFERENCES products (id),
  old_slug text NOT NULL CHECK (old_slug = lower(old_slug) AND old_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, old_slug)
);

CREATE INDEX IF NOT EXISTS product_slug_redirects_product_idx
  ON product_slug_redirects (organization_id, product_id);
