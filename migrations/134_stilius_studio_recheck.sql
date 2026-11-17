-- The redesign was treated as a missing page. Keep the protection pause
-- until Studio confirms a live product, then retry the affected links.
UPDATE supplier_provider_checks
SET dispatcher_seen_at=NULL,
    next_request_at=now(),
    probe_requested_at=CASE WHEN paused_until IS NOT NULL AND manual_pause_mode IS DISTINCT FROM 'all'
      THEN COALESCE(probe_requested_at,now()) ELSE probe_requested_at END
WHERE provider_code='qandq';

UPDATE supplier_product_links l
SET manual_requested_at=now()
FROM products p
WHERE l.provider_code='qandq' AND l.product_id=p.id AND l.organization_id=p.organization_id
  AND p.deleted_at IS NULL AND l.checks_enabled AND NOT l.removed AND l.url IS NOT NULL
  AND (l.first_problem_at IS NOT NULL OR l.last_checked_at IS NULL OR l.price_amount IS NULL)
  AND l.initial_requested_at IS NULL AND l.manual_requested_at IS NULL;
