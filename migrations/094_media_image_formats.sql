-- Several formats (and small sources with identical dimensions) need distinct object keys.
-- Older flat thumbnail paths could leave several width rows pointing to one object.
-- Preserve their original metadata privately before consolidating duplicate references.
WITH duplicate_keys AS (
  SELECT media_asset_id, storage_key FROM media_derivatives
  GROUP BY media_asset_id, storage_key HAVING count(*) > 1
), saved AS (
  SELECT d.media_asset_id, jsonb_agg(to_jsonb(d) ORDER BY d.width, d.id) AS rows
  FROM media_derivatives d JOIN duplicate_keys k
    ON k.media_asset_id=d.media_asset_id AND k.storage_key=d.storage_key
  GROUP BY d.media_asset_id
)
UPDATE media_assets a SET metadata=COALESCE(a.metadata,'{}'::jsonb)
  || jsonb_build_object('_migration094_derivativeRows', saved.rows)
FROM saved WHERE a.id=saved.media_asset_id;

DELETE FROM media_derivatives d USING media_derivatives kept
WHERE d.media_asset_id=kept.media_asset_id AND d.storage_key=kept.storage_key
  AND (d.width,d.created_at,d.id) < (kept.width,kept.created_at,kept.id);

DROP INDEX media_derivatives_asset_width_uq;
CREATE UNIQUE INDEX media_derivatives_asset_key_uq ON media_derivatives (media_asset_id, storage_key);
CREATE INDEX media_derivatives_asset_width_idx ON media_derivatives (media_asset_id, width);
