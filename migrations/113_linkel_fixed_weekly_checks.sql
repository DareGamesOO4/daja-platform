SELECT pg_advisory_xact_lock(hashtext('supplier-state'));
SELECT pg_advisory_xact_lock(hashtext('supplier-queue:linkel'));

-- Keep the existing weekly epoch and positions. End the accelerated sweep.
UPDATE supplier_provider_checks
SET cycle_seconds=604800, rapid_check_started_at=NULL,
    next_request_at=GREATEST(next_request_at,now()+interval '390 seconds'),
    updated_at=now()
WHERE provider_code='linkel';

UPDATE supplier_product_links
SET rapid_requested_at=NULL
WHERE provider_code='linkel' AND rapid_requested_at IS NOT NULL;

-- Put previously disabled links back into the schedule if the product still exists.
UPDATE supplier_product_links l
SET checks_enabled=true,negative_count=0
FROM products product
WHERE l.provider_code='linkel' AND NOT l.removed AND NOT l.checks_enabled AND l.url IS NOT NULL
  AND product.id=l.product_id AND product.organization_id=l.organization_id AND product.deleted_at IS NULL;

-- Repair only timestamps that were moved off their assigned weekly slots by retries.
UPDATE supplier_product_links l
SET next_check_at=supplier_regular_slot(p.cycle_epoch,p.phase_seconds,p.regular_interval_seconds,
  l.queue_position,now()+interval '1 second',p.cycle_seconds)
FROM supplier_provider_checks p
WHERE l.provider_code='linkel' AND p.provider_code=l.provider_code
  AND l.queue_position IS NOT NULL AND l.checks_enabled AND NOT l.removed
  AND l.next_check_at IS DISTINCT FROM supplier_regular_slot(p.cycle_epoch,p.phase_seconds,p.regular_interval_seconds,
    l.queue_position,l.next_check_at,p.cycle_seconds);
