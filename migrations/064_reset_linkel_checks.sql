UPDATE supplier_product_links
SET check_status = 'unverified',
    missing_count = 0,
    last_error = NULL,
    next_check_at = now(),
    updated_at = now()
WHERE provider_code = 'linkel';

UPDATE supplier_provider_checks
SET paused_until = NULL,
    consecutive_errors = 0,
    next_request_at = now(),
    updated_at = now()
WHERE provider_code = 'linkel';
