ALTER TABLE organization_sales_configuration
  ADD COLUMN IF NOT EXISTS shift_overrides jsonb NOT NULL DEFAULT '[]'::jsonb;
