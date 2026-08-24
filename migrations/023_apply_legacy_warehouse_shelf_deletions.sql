BEGIN;

-- Migration 022 restores legacy shelf upserts. Apply the last deletion too,
-- because those old deletes were likewise stored only in server_sync_events.
WITH latest_shelf_event AS (
  SELECT DISTINCT ON (event.organization_id, event.aggregate_id)
    event.organization_id,
    event.aggregate_id,
    event.payload -> 'command' ->> 'kind' AS command_kind
  FROM server_sync_events AS event
  WHERE event.aggregate_type = 'warehouse_bin'
    AND event.payload -> 'command' ->> 'kind' IN ('warehouse.bin.upsert', 'warehouse.bin.delete')
  ORDER BY event.organization_id, event.aggregate_id, event.revision DESC
)
UPDATE warehouse_bins AS bin
SET active = false,
    status = 'inactive',
    deleted_at = COALESCE(bin.deleted_at, now()),
    updated_at = now(),
    version = bin.version + 1
FROM latest_shelf_event AS event
WHERE bin.organization_id = event.organization_id
  AND bin.id = event.aggregate_id
  AND event.command_kind = 'warehouse.bin.delete'
  AND bin.deleted_at IS NULL;

COMMIT;
