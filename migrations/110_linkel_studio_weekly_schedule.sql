SELECT pg_advisory_xact_lock(hashtext('supplier-state'));
SELECT pg_advisory_xact_lock(hashtext('supplier-queue:linkel'));

UPDATE supplier_provider_checks
SET cycle_epoch=now(), cycle_seconds=604800, regular_interval_seconds=403, capacity=1500,
    next_request_at=now(),
    probe_requested_at=CASE WHEN paused_until IS NOT NULL THEN now() ELSE probe_requested_at END
WHERE provider_code='linkel';

-- Reuse free weekly slots for links that had a higher position in the old cycle.
WITH overflow AS (
  SELECT id, row_number() OVER (ORDER BY queue_position,id) AS rank
  FROM supplier_product_links WHERE provider_code='linkel' AND queue_position>1500
), free AS (
  SELECT slot, row_number() OVER (ORDER BY slot) AS rank
  FROM generate_series(1,1500) AS slot
  WHERE NOT EXISTS (SELECT 1 FROM supplier_product_links
    WHERE provider_code='linkel' AND queue_position=slot)
)
UPDATE supplier_product_links l SET queue_position=free.slot
FROM overflow JOIN free USING (rank) WHERE l.id=overflow.id;

UPDATE supplier_product_links l
SET next_check_at=supplier_regular_slot(p.cycle_epoch,p.phase_seconds,p.regular_interval_seconds,
  l.queue_position,now()+interval '1 second',p.cycle_seconds)
FROM supplier_provider_checks p
WHERE l.provider_code='linkel' AND p.provider_code=l.provider_code AND l.queue_position IS NOT NULL
  AND l.checks_enabled AND NOT l.removed AND l.last_error IS NULL AND l.confirmation_due_at IS NULL;
