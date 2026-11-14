BEGIN;

ALTER TABLE products ADD COLUMN published_at timestamptz;

-- Recover the first publication for products with an audited creation.
-- Older imports without that history use created_at in the public catalog.
WITH audited_publications AS (
  SELECT p.id, p.organization_id,
         CASE
           WHEN creation.after_payload @> '{"active":true,"published":true}' THEN p.created_at
           ELSE publication.occurred_at
         END AS published_at
  FROM products p
  JOIN LATERAL (
    SELECT after_payload, occurred_at
    FROM audit_events
    WHERE organization_id=p.organization_id AND aggregate_type='product'
      AND aggregate_id=p.id AND operation='create'
      AND after_payload ?& ARRAY['active', 'published']
    ORDER BY occurred_at, id LIMIT 1
  ) creation ON true
  LEFT JOIN LATERAL (
    SELECT occurred_at
    FROM audit_events
    WHERE organization_id=p.organization_id AND aggregate_type='product'
      AND aggregate_id=p.id AND operation IN ('publish', 'update')
      AND occurred_at >= creation.occurred_at
      AND (before_payload @> '{"active":false}' OR before_payload @> '{"published":false}')
      AND after_payload @> '{"active":true,"published":true}'
    ORDER BY occurred_at, id LIMIT 1
  ) publication ON NOT (creation.after_payload @> '{"active":true,"published":true}')
  WHERE p.deleted_at IS NULL
)
UPDATE products p
SET published_at = history.published_at
FROM audited_publications history
WHERE p.id=history.id AND p.organization_id=history.organization_id
  AND history.published_at IS NOT NULL
  AND (history.published_at <> p.created_at OR NOT (p.active AND p.published));

CREATE FUNCTION record_product_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.published_at IS NOT NULL THEN
      NEW.published_at := OLD.published_at;
    ELSIF OLD.active AND OLD.published AND OLD.deleted_at IS NULL THEN
      -- Keep the legacy fallback if an existing public product is hidden.
      NEW.published_at := OLD.created_at;
    END IF;
  END IF;

  IF NEW.published_at IS NULL AND NEW.active AND NEW.published AND NEW.deleted_at IS NULL THEN
    NEW.published_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER record_product_publication
BEFORE INSERT OR UPDATE OF active, published, deleted_at ON products
FOR EACH ROW EXECUTE FUNCTION record_product_publication();

COMMIT;
