BEGIN;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS legal_name text,
  ADD COLUMN IF NOT EXISTS tax_number text;

COMMIT;
