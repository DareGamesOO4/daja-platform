BEGIN;

WITH planned AS (
  SELECT p.id, p.organization_id, p.slug, p.published_at AS previous_date,
    -- Leave room above the microsecond-spaced block from migration 135.
    COALESCE(older.published_at, older.created_at) + interval '1 millisecond' AS publication_date
  FROM products p
  JOIN products older ON older.organization_id = p.organization_id
    AND older.id = '5d9cdeeb-a5e0-4be3-8dc0-4bc4623ee419' AND older.deleted_at IS NULL
  WHERE p.organization_id = '00000000-0000-4000-8000-000000000101'
    AND p.id = '031190b0-d7c7-432d-a69a-d72e1706294d'
    AND p.slug = 'v22a-011vy' AND p.deleted_at IS NULL
  FOR UPDATE OF p
), moved AS (
  UPDATE products p
  SET published_at = planned.publication_date, updated_at = now(), version = p.version + 1
  FROM planned
  WHERE p.id = planned.id AND p.organization_id = planned.organization_id
    AND COALESCE(p.published_at, p.created_at) > planned.publication_date
  RETURNING p.organization_id, p.id, p.slug, planned.previous_date, p.published_at
)
INSERT INTO audit_events (
  organization_id, aggregate_type, aggregate_id, operation,
  before_payload, after_payload, reason, correlation_id, request_id
)
SELECT organization_id, 'product', id, 'catalog.publication.reposition',
  jsonb_build_object('slug', slug, 'published_at', previous_date),
  jsonb_build_object('slug', slug, 'published_at', published_at),
  'Move V22A-011VY into the newer Q&Q children watches block',
  'v22a-011vy-publication-order-136', 'v22a-011vy-publication-order-136'
FROM moved;

COMMIT;
