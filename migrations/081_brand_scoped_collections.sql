-- Collections with identical names/slugs are independent across brands and departments.
-- Keep duplicate protection within the same brand and hierarchy level.
CREATE UNIQUE INDEX categories_active_org_department_brand_parent_slug_uq
  ON categories (
    organization_id,
    COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(brand_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    slug
  ) WHERE deleted_at IS NULL;

DROP INDEX categories_active_org_parent_slug_uq;
