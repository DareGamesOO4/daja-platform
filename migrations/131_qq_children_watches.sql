BEGIN;

WITH watch_variants AS (
  SELECT v.id, p.id AS product_id, p.organization_id,
    COALESCE(
      age.value,
      (SELECT attr.value
       FROM jsonb_each_text(v.attributes) AS attr(key, value)
       WHERE regexp_replace(lower(trim(attr.key)), '[-_[:space:]]+', '-', 'g') IN ('uzrasna-grupa', 'uzrast')
       ORDER BY (lower(trim(attr.key)) <> 'uzrast') DESC, (attr.key = 'uzrasna-grupa') DESC, attr.key
       LIMIT 1)
    ) AS age_group
  FROM products p
  JOIN departments d ON d.organization_id = p.organization_id AND d.id = p.department_id
  JOIN brands b ON b.organization_id = p.organization_id AND b.id = p.brand_id
  JOIN product_variants v ON v.organization_id = p.organization_id AND v.product_id = p.id
  LEFT JOIN spec_keys k ON k.organization_id = p.organization_id
    AND k.department_id = d.id AND k.slug = 'uzrasna-grupa' AND k.deleted_at IS NULL
  LEFT JOIN variant_specification_values age ON age.organization_id = p.organization_id
    AND age.variant_id = v.id AND age.spec_key_id = k.id
  WHERE d.slug = 'satovi' AND lower(trim(b.name)) = 'q&q'
    AND p.deleted_at IS NULL AND d.deleted_at IS NULL AND b.deleted_at IS NULL
    AND v.deleted_at IS NULL
), children_products AS (
  -- A shared publication date also affects adult variants on mixed products.
  SELECT organization_id, product_id
  FROM watch_variants
  GROUP BY organization_id, product_id
  HAVING bool_and(COALESCE(lower(trim(age_group)) = 'deca', false))
), publication_order AS (
  SELECT p.id, p.organization_id,
    oldest.date - interval '1 day' +
      row_number() OVER (PARTITION BY p.organization_id ORDER BY COALESCE(p.published_at, p.created_at), p.id) * interval '1 microsecond' AS publication_date
  FROM products p
  JOIN children_products c ON c.organization_id = p.organization_id AND c.product_id = p.id
  JOIN (
    SELECT organization_id, min(COALESCE(published_at, created_at)) AS date
    FROM products
    WHERE deleted_at IS NULL
    GROUP BY organization_id
  ) oldest ON oldest.organization_id = p.organization_id
), updated_gender AS (
  UPDATE product_variants v
  SET gender = 'Dečiji', updated_at = now(), version = v.version + 1
  FROM watch_variants w
  WHERE v.id = w.id AND v.organization_id = w.organization_id
    AND lower(trim(w.age_group)) = 'deca' AND v.gender IS DISTINCT FROM 'Dečiji'
)
UPDATE products p
SET published_at = o.publication_date, updated_at = now(), version = p.version + 1
FROM publication_order o
WHERE p.id = o.id AND p.organization_id = o.organization_id;

COMMIT;
