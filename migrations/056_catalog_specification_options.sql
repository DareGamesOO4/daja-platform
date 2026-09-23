BEGIN;

ALTER TABLE spec_keys
  ADD COLUMN option_values jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(option_values) = 'array' AND jsonb_array_length(option_values) <= 100);

COMMIT;
