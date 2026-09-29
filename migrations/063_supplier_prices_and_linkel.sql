ALTER TABLE supplier_product_links
  ADD COLUMN price_amount numeric(12, 2),
  ADD COLUMN price_currency text,
  ADD CONSTRAINT supplier_product_links_price_pair CHECK (
    (price_amount IS NULL AND price_currency IS NULL)
    OR (price_amount >= 0 AND price_currency IN ('RSD', 'EUR', 'BGN'))
  );

INSERT INTO supplier_provider_checks (provider_code)
VALUES ('linkel')
ON CONFLICT (provider_code) DO NOTHING;
