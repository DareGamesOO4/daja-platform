ALTER TABLE supplier_product_links
  ADD COLUMN out_of_stock_cycles integer NOT NULL DEFAULT 0 CHECK (out_of_stock_cycles BETWEEN 0 AND 10);

CREATE FUNCTION supplier_reset_out_of_stock_cycles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.url IS DISTINCT FROM OLD.url OR (NEW.checks_enabled AND NOT OLD.checks_enabled) THEN
    NEW.out_of_stock_cycles := 0;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER supplier_reset_out_of_stock_cycles
BEFORE UPDATE ON supplier_product_links
FOR EACH ROW EXECUTE FUNCTION supplier_reset_out_of_stock_cycles();

-- The former automatic rule set negative_count to 2. Manual disables did not.
UPDATE supplier_product_links l
SET checks_enabled = true
FROM products product
WHERE NOT l.checks_enabled AND l.negative_count = 2 AND NOT l.removed AND l.url IS NOT NULL
  AND product.id = l.product_id AND product.organization_id = l.organization_id AND product.deleted_at IS NULL;
