BEGIN;

WITH older_group AS (
  -- First model in the older children's block created by migration 131.
  SELECT p.organization_id, COALESCE(p.published_at, p.created_at) AS publication_date
  FROM products p
  WHERE p.organization_id = '00000000-0000-4000-8000-000000000101'
    AND p.slug = 'v22a-016vy' AND p.deleted_at IS NULL
), planned AS (
  SELECT p.id, p.organization_id, p.slug, p.published_at AS previous_date,
    older_group.publication_date +
      row_number() OVER (ORDER BY COALESCE(p.published_at, p.created_at), p.id) * interval '1 microsecond'
      AS publication_date
  FROM older_group
  JOIN products p ON p.organization_id = older_group.organization_id
  JOIN departments d ON d.organization_id = p.organization_id AND d.id = p.department_id
  JOIN brands b ON b.organization_id = p.organization_id AND b.id = p.brand_id
  WHERE d.slug = 'satovi' AND lower(trim(b.name)) = 'q&q'
    AND p.deleted_at IS NULL AND p.active AND p.published
    AND d.deleted_at IS NULL AND b.deleted_at IS NULL
    AND COALESCE(p.published_at, p.created_at) >= timestamptz '2026-11-17 19:36:37.321646+00'
    AND COALESCE(p.published_at, p.created_at) <= timestamptz '2026-11-17 21:05:52.979532+00'
    -- Limit the move to the 43 new models seen in the public catalog.
    AND p.slug IN (
      'g38a-001vy', 'g38a-002vy', 'g38a-003vy', 'g38a-004vy',
      'g23a-026vy', 'g23a-027vy', 'g23a-028vy', 'g23a-029vy',
      'g23a-030vy', 'g23a-031vy', 'g23a-032vy', 'g23a-033vy', 'm207j009y',
      'g32a-001vy', 'g32a-002vy', 'g32a-003vy', 'g32a-004vy',
      'g32a-005vy', 'g32a-006vy', 'g32a-007vy',
      'g23a-013vy', 'g23a-015vy', 'g23a-016vy', 'g23a-017vy',
      'g23a-020vy', 'g23a-021vy', 'g23a-022vy',
      'q58a-011py', 'q58a-012py', 'q92b-001py', 'v23a-018vy', 'v23a-020vy',
      'v23a-021vy', 'v26a-003vy', 'v33a-005vy', 'vs66j006y', 'v23a-017vy',
      'v22a-023vy', 'v22a-005vy', 'v22a-006vy', 'v22a-007vy', 'v22a-008vy', 'v22a-009vy'
    )
    AND EXISTS (
      SELECT 1
      FROM product_variants v
      WHERE v.organization_id = p.organization_id AND v.product_id = p.id
        AND v.deleted_at IS NULL AND v.active AND v.published
      HAVING bool_and(COALESCE(lower(trim(v.gender)) = 'dečiji', false))
    )
), moved AS (
  UPDATE products p
  SET published_at = planned.publication_date, updated_at = now(), version = p.version + 1
  FROM planned
  WHERE p.id = planned.id AND p.organization_id = planned.organization_id
    AND p.published_at IS NOT DISTINCT FROM planned.previous_date
  RETURNING p.organization_id, p.id, p.slug, planned.previous_date, p.published_at
)
INSERT INTO audit_events (
  organization_id, aggregate_type, aggregate_id, operation,
  before_payload, after_payload, reason, correlation_id, request_id
)
SELECT organization_id, 'product', id, 'catalog.publication.reposition',
  jsonb_build_object('slug', slug, 'published_at', previous_date),
  jsonb_build_object('slug', slug, 'published_at', published_at),
  'Move newer Q&Q children watches immediately above the older children watches',
  'qq-children-publication-order-135', 'qq-children-publication-order-135'
FROM moved;

COMMIT;
