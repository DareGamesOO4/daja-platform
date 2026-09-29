ALTER TABLE supplier_product_links
  ADD COLUMN stock_status text CHECK (stock_status IN ('in_stock', 'out_of_stock'));

INSERT INTO supplier_provider_checks (provider_code)
VALUES ('bultime')
ON CONFLICT (provider_code) DO NOTHING;
