-- Old samples included out-of-stock and parser errors. Start a clean access-only window.
SELECT pg_advisory_xact_lock(hashtext('supplier-state'));

UPDATE supplier_product_links
SET window_observed_at = NULL, window_bad = NULL
WHERE window_observed_at IS NOT NULL OR window_bad IS NOT NULL;
