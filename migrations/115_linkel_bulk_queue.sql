ALTER TABLE supplier_provider_checks ADD COLUMN next_bulk_request_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE supplier_product_links ADD COLUMN bulk_requested_at timestamptz;
ALTER TABLE supplier_check_leases DROP CONSTRAINT supplier_check_leases_kind_check;
ALTER TABLE supplier_check_leases ADD CONSTRAINT supplier_check_leases_kind_check
  CHECK (kind IN ('initial','regular','confirmation','health','legacy','preview','manual','bulk'));

-- An edited or removed link must never inherit a request for its previous address.
CREATE FUNCTION clear_stale_linkel_bulk_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider_code='linkel' AND (NOT NEW.checks_enabled OR NEW.removed OR NEW.url IS DISTINCT FROM OLD.url) THEN
    NEW.bulk_requested_at := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER supplier_bulk_request_cleanup BEFORE UPDATE ON supplier_product_links
  FOR EACH ROW EXECUTE FUNCTION clear_stale_linkel_bulk_request();
