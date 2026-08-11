BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  normalized_name text GENERATED ALWAYS AS (lower(trim(name))) STORED,
  slug text NOT NULL CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  logo_media_id uuid,
  active boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX brands_active_org_slug_uq ON brands (organization_id, slug) WHERE deleted_at IS NULL;
CREATE INDEX brands_org_normalized_name_idx ON brands (organization_id, normalized_name) WHERE deleted_at IS NULL;

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  parent_id uuid REFERENCES categories (id),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  slug text NOT NULL CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE UNIQUE INDEX categories_active_org_parent_slug_uq ON categories (organization_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), slug) WHERE deleted_at IS NULL;
CREATE INDEX categories_org_parent_idx ON categories (organization_id, parent_id, sort_order) WHERE deleted_at IS NULL;

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  normalized_name text GENERATED ALWAYS AS (lower(trim(name))) STORED,
  slug text NOT NULL CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  description text,
  brand_id uuid REFERENCES brands (id),
  primary_category_id uuid REFERENCES categories (id),
  active boolean NOT NULL DEFAULT true,
  published boolean NOT NULL DEFAULT false,
  legacy_firestore_id text,
  external_id text,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX products_active_org_slug_uq ON products (organization_id, slug) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX products_active_org_legacy_firestore_uq ON products (organization_id, legacy_firestore_id) WHERE legacy_firestore_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX products_active_org_external_uq ON products (organization_id, external_id) WHERE external_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX products_org_brand_idx ON products (organization_id, brand_id) WHERE deleted_at IS NULL;
CREATE INDEX products_org_category_idx ON products (organization_id, primary_category_id) WHERE deleted_at IS NULL;
CREATE INDEX products_org_updated_idx ON products (organization_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX products_search_trgm_idx ON products USING gin ((normalized_name || ' ' || slug) gin_trgm_ops) WHERE deleted_at IS NULL;

CREATE TABLE product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  product_id uuid NOT NULL REFERENCES products (id),
  sku text NOT NULL CHECK (length(trim(sku)) > 0),
  normalized_sku text GENERATED ALWAYS AS (upper(trim(sku))) STORED,
  barcode text,
  name text,
  gender text,
  current_price_amount integer NOT NULL CHECK (current_price_amount >= 0),
  currency char(3) NOT NULL CHECK (currency = upper(currency)),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object' AND octet_length(attributes::text) <= 32768),
  active boolean NOT NULL DEFAULT true,
  published boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX product_variants_active_org_sku_uq ON product_variants (organization_id, normalized_sku) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX product_variants_active_org_barcode_uq ON product_variants (organization_id, barcode) WHERE barcode IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX product_variants_org_product_idx ON product_variants (organization_id, product_id) WHERE deleted_at IS NULL;
CREATE INDEX product_variants_search_trgm_idx ON product_variants USING gin ((normalized_sku || ' ' || COALESCE(barcode, '')) gin_trgm_ops) WHERE deleted_at IS NULL;

CREATE TABLE variant_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  variant_id uuid NOT NULL REFERENCES product_variants (id),
  amount_minor integer NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL CHECK (currency = upper(currency)),
  price_type text NOT NULL CHECK (price_type IN ('sell', 'sale', 'compare_at', 'cost')),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users (id),
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);
CREATE INDEX variant_prices_variant_time_idx ON variant_prices (organization_id, variant_id, valid_from DESC);

CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  storage_provider text NOT NULL CHECK (storage_provider IN ('r2', 's3-compatible', 'external-url')),
  storage_bucket text NOT NULL,
  storage_key text NOT NULL,
  public_url text,
  mime_type text NOT NULL,
  width integer CHECK (width IS NULL OR width > 0),
  height integer CHECK (height IS NULL OR height > 0),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  checksum_sha256 text,
  status text NOT NULL CHECK (status IN ('pending_upload', 'uploaded', 'processing', 'ready', 'failed', 'deleted')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX media_assets_org_storage_key_uq ON media_assets (organization_id, storage_bucket, storage_key) WHERE deleted_at IS NULL;
CREATE INDEX media_assets_org_status_idx ON media_assets (organization_id, status) WHERE deleted_at IS NULL;
ALTER TABLE brands ADD CONSTRAINT brands_logo_media_fk FOREIGN KEY (logo_media_id) REFERENCES media_assets (id);

CREATE TABLE product_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  product_id uuid NOT NULL REFERENCES products (id),
  variant_id uuid REFERENCES product_variants (id),
  media_asset_id uuid NOT NULL REFERENCES media_assets (id),
  role text NOT NULL CHECK (role IN ('gallery', 'thumbnail', 'hero', 'manual', 'document')),
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX product_media_product_order_idx ON product_media (organization_id, product_id, position, id);
CREATE UNIQUE INDEX product_media_one_primary_uq ON product_media (organization_id, product_id) WHERE is_primary;

CREATE TABLE warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  location_id uuid NOT NULL REFERENCES locations (id),
  code text NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX warehouses_org_code_uq ON warehouses (organization_id, code) WHERE deleted_at IS NULL;

CREATE TABLE warehouse_zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  warehouse_id uuid NOT NULL REFERENCES warehouses (id),
  code text NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX warehouse_zones_org_warehouse_code_uq ON warehouse_zones (organization_id, warehouse_id, code) WHERE deleted_at IS NULL;

CREATE TABLE warehouse_bins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  zone_id uuid NOT NULL REFERENCES warehouse_zones (id),
  code text NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE UNIQUE INDEX warehouse_bins_org_zone_code_uq ON warehouse_bins (organization_id, zone_id, code) WHERE deleted_at IS NULL;

CREATE TABLE inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  variant_id uuid NOT NULL REFERENCES product_variants (id),
  serial_number text,
  status text NOT NULL CHECK (status IN ('in_stock', 'reserved', 'sold', 'returned', 'transferred', 'lost', 'damaged', 'retired')),
  current_location_id uuid REFERENCES locations (id),
  current_zone_id uuid REFERENCES warehouse_zones (id),
  current_bin_id uuid REFERENCES warehouse_bins (id),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX inventory_items_org_variant_status_idx ON inventory_items (organization_id, variant_id, status) WHERE deleted_at IS NULL;

CREATE TABLE rfid_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  epc text NOT NULL CHECK (epc = upper(epc) AND epc ~ '^[0-9A-F]{8,64}$'),
  tid text CHECK (tid IS NULL OR (tid = upper(tid) AND tid ~ '^[0-9A-F]{8,128}$')),
  chip_type text,
  protocol text,
  status text NOT NULL CHECK (status IN ('unassigned', 'assigned', 'in_stock', 'reserved', 'sold', 'returned', 'transferred', 'lost', 'damaged', 'retired')),
  inventory_item_id uuid REFERENCES inventory_items (id),
  variant_id uuid REFERENCES product_variants (id),
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK ((inventory_item_id IS NULL) OR (variant_id IS NULL))
);
CREATE UNIQUE INDEX rfid_tags_active_org_epc_uq ON rfid_tags (organization_id, epc) WHERE deleted_at IS NULL;
CREATE INDEX rfid_tags_org_tid_idx ON rfid_tags (organization_id, tid) WHERE tid IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX rfid_tags_inventory_item_idx ON rfid_tags (organization_id, inventory_item_id) WHERE inventory_item_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX rfid_tags_variant_idx ON rfid_tags (organization_id, variant_id) WHERE variant_id IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE rfid_tag_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  tag_id uuid NOT NULL REFERENCES rfid_tags (id),
  inventory_item_id uuid REFERENCES inventory_items (id),
  reader_id uuid,
  antenna_id uuid,
  location_id uuid REFERENCES locations (id),
  event_type text NOT NULL CHECK (event_type IN ('assigned', 'unassigned', 'status_changed', 'seen', 'moved', 'sold', 'returned')),
  rssi integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rfid_tag_events_tag_time_idx ON rfid_tag_events (organization_id, tag_id, occurred_at DESC);

CREATE TABLE rfid_readers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  location_id uuid NOT NULL REFERENCES locations (id),
  vendor text NOT NULL,
  model text NOT NULL,
  serial_number text NOT NULL,
  firmware text,
  region text,
  status text NOT NULL CHECK (status IN ('active', 'inactive', 'maintenance', 'retired')),
  last_seen_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX rfid_readers_org_serial_uq ON rfid_readers (organization_id, serial_number);
ALTER TABLE rfid_tag_events ADD CONSTRAINT rfid_tag_events_reader_fk FOREIGN KEY (reader_id) REFERENCES rfid_readers (id);

CREATE TABLE rfid_antennas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  reader_id uuid NOT NULL REFERENCES rfid_readers (id),
  port integer NOT NULL CHECK (port > 0),
  name text NOT NULL,
  zone_id uuid REFERENCES warehouse_zones (id),
  active boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX rfid_antennas_reader_port_uq ON rfid_antennas (reader_id, port);
ALTER TABLE rfid_tag_events ADD CONSTRAINT rfid_tag_events_antenna_fk FOREIGN KEY (antenna_id) REFERENCES rfid_antennas (id);

CREATE TABLE inventory_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  variant_id uuid NOT NULL REFERENCES product_variants (id),
  inventory_item_id uuid REFERENCES inventory_items (id),
  event_type text NOT NULL CHECK (event_type IN ('adjusted', 'moved', 'reserved', 'released', 'sold', 'returned', 'lost', 'damaged')),
  quantity_delta integer NOT NULL,
  from_location_id uuid REFERENCES locations (id),
  to_location_id uuid REFERENCES locations (id),
  source_type text NOT NULL,
  source_id uuid,
  actor_user_id uuid REFERENCES users (id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX inventory_events_org_variant_time_idx ON inventory_events (organization_id, variant_id, occurred_at DESC);

CREATE TABLE inventory_balances (
  organization_id uuid NOT NULL REFERENCES organizations (id),
  location_id uuid NOT NULL REFERENCES locations (id),
  variant_id uuid NOT NULL REFERENCES product_variants (id),
  quantity integer NOT NULL CHECK (quantity >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, location_id, variant_id)
);

CREATE TABLE domain_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error text
);
CREATE INDEX domain_outbox_unprocessed_idx ON domain_outbox (occurred_at, id) WHERE processed_at IS NULL;

CREATE TABLE media_derivatives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  media_asset_id uuid NOT NULL REFERENCES media_assets (id),
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  mime_type text NOT NULL,
  storage_key text NOT NULL,
  public_url text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  checksum_sha256 text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX media_derivatives_asset_width_uq ON media_derivatives (media_asset_id, width);

CREATE TABLE import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  source_type text NOT NULL CHECK (source_type IN ('xlsx', 'firestore')),
  status text NOT NULL CHECK (status IN ('uploaded', 'parsed', 'validated', 'dry_run', 'executing', 'completed', 'failed')),
  dry_run boolean NOT NULL DEFAULT true,
  source_name text,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checkpoint) = 'object'),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX import_jobs_org_status_idx ON import_jobs (organization_id, status, created_at DESC);

CREATE TABLE import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id),
  import_job_id uuid NOT NULL REFERENCES import_jobs (id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  source_id text,
  status text NOT NULL CHECK (status IN ('pending', 'valid', 'invalid', 'skipped', 'imported')),
  raw_payload jsonb NOT NULL CHECK (jsonb_typeof(raw_payload) = 'object'),
  normalized_payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(normalized_payload) = 'object'),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(warnings) = 'array'),
  errors jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(errors) = 'array'),
  target_product_id uuid,
  target_variant_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX import_rows_job_row_uq ON import_rows (import_job_id, row_number);
CREATE INDEX import_rows_job_status_idx ON import_rows (import_job_id, status);

COMMIT;
