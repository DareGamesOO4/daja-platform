BEGIN;

ALTER TABLE products
  ADD COLUMN marketing_flags jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(marketing_flags) = 'array');

COMMIT;
