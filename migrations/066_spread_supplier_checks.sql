-- Distribute already verified, healthy links over one weekly cycle.
-- New/unverified links retain next_check_at = now() for their first check.
WITH slots AS (
  SELECT link.id,
         row_number() OVER (ORDER BY link.next_check_at, link.id) AS position,
         count(*) OVER () AS total
  FROM supplier_product_links link
  JOIN products product ON product.id = link.product_id AND product.organization_id = link.organization_id
  WHERE link.check_status = 'available' AND link.missing_count = 0
    AND link.last_checked_at IS NOT NULL AND link.last_error IS NULL
    AND link.next_check_at > now() AND product.deleted_at IS NULL
)
UPDATE supplier_product_links link
SET next_check_at = now() + interval '7 days' * (slots.position::double precision / slots.total),
    updated_at = now()
FROM slots
WHERE link.id = slots.id;
