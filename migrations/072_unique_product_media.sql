-- Remove repeated links, preserving primary and the first attachment. Assets
-- and R2 originals/thumbnails remain intact; variant/role scopes stay separate.
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY organization_id, product_id, media_asset_id, role, variant_id
    ORDER BY is_primary DESC, created_at, id
  ) AS duplicate_number FROM product_media
)
DELETE FROM product_media WHERE id IN (SELECT id FROM ranked WHERE duplicate_number > 1);

CREATE UNIQUE INDEX product_media_asset_scope_uq ON product_media (
  organization_id, product_id, media_asset_id, role,
  (COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
);
