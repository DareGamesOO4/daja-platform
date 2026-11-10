-- Refill the prices cleared by migration 117 through the existing queues.
-- Linkel's bulk queue is paced by Studio; the other providers use manual jobs.
-- Preserve normal cycle slots, disabled links, pauses, and existing requests.
UPDATE supplier_product_links l
SET manual_requested_at = CASE WHEN l.provider_code <> 'linkel' THEN now() ELSE l.manual_requested_at END,
    bulk_requested_at = CASE WHEN l.provider_code = 'linkel' THEN now() ELSE l.bulk_requested_at END
FROM products product
WHERE product.id = l.product_id
  AND product.organization_id = l.organization_id
  AND product.deleted_at IS NULL
  AND l.checks_enabled AND NOT l.removed AND l.url IS NOT NULL
  AND l.provider_code IN ('ekka', 'bultime', 'linkel', 'milano', 'timezone', 'qandq')
  AND (l.price_amount IS NULL OR l.last_good_result->'regularPrice' IS DISTINCT FROM 'true'::jsonb)
  AND l.initial_requested_at IS NULL
  AND l.manual_requested_at IS NULL
  AND l.bulk_requested_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM supplier_check_leases lease
    WHERE lease.link_id = l.id AND lease.expires_at > now()
  );
