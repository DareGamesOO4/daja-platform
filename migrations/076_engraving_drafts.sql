CREATE TABLE engraving_drafts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  customer_id uuid REFERENCES customers(id),
  guest_token_hash text,
  product_id uuid NOT NULL REFERENCES products(id),
  variant_id uuid NOT NULL REFERENCES product_variants(id),
  version integer NOT NULL DEFAULT 0,
  design jsonb NOT NULL,
  preview text,
  artwork text CHECK (length(artwork) <= 700000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (customer_id IS NOT NULL OR guest_token_hash IS NOT NULL)
);
CREATE INDEX engraving_drafts_customer_idx ON engraving_drafts(organization_id, customer_id, updated_at DESC);
CREATE TABLE engraving_assets (
  id uuid PRIMARY KEY,
  draft_id uuid NOT NULL REFERENCES engraving_drafts(id) ON DELETE CASCADE,
  data_url text NOT NULL CHECK (length(data_url) <= 700000),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE customer_cart_items DROP CONSTRAINT customer_cart_items_pkey;
ALTER TABLE customer_cart_items ADD COLUMN line_id text;
UPDATE customer_cart_items SET line_id = COALESCE(item_snapshot->>'lineId', product_id::text);
ALTER TABLE customer_cart_items ALTER COLUMN line_id SET NOT NULL;
ALTER TABLE customer_cart_items ADD PRIMARY KEY(organization_id, customer_id, line_id);
