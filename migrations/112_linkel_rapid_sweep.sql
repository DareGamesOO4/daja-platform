ALTER TABLE supplier_provider_checks
  ADD COLUMN rapid_check_started_at timestamptz,
  ADD COLUMN rapid_check_last_started_at timestamptz;

ALTER TABLE supplier_product_links
  ADD COLUMN rapid_requested_at timestamptz;

CREATE INDEX supplier_linkel_rapid_requested_idx
  ON supplier_product_links (provider_code, rapid_requested_at, id)
  WHERE rapid_requested_at IS NOT NULL;

-- Start this one-off sweep as soon as this migration is applied. Normal
-- seven-day scheduling resumes automatically after every eligible link is checked.
UPDATE supplier_product_links l
SET rapid_requested_at = now()
FROM products p
WHERE l.organization_id = p.organization_id
  AND l.product_id = p.id
  AND l.provider_code = 'linkel'
  AND l.checks_enabled
  AND NOT l.removed
  AND l.url IS NOT NULL
  AND p.deleted_at IS NULL;

UPDATE supplier_provider_checks
SET rapid_check_started_at = now(),
    rapid_check_last_started_at = now(),
    next_request_at = now(),
    updated_at = now()
WHERE provider_code = 'linkel'
  AND EXISTS (
    SELECT 1 FROM supplier_product_links
    WHERE provider_code = 'linkel' AND rapid_requested_at IS NOT NULL
  );
