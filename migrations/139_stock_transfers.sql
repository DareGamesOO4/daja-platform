CREATE TABLE stock_transfers (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  source_location_id uuid NOT NULL REFERENCES locations(id),
  destination_location_id uuid NOT NULL REFERENCES locations(id),
  version integer NOT NULL CHECK (version > 0),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  CHECK (source_location_id <> destination_location_id)
);
