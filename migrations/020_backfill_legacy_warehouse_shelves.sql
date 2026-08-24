BEGIN;

-- Before warehouse commands received a domain projector, the desktop outbox
-- was accepted into server_sync_events but its shelves were not materialized.
-- Rebuild only the latest non-deleted shelf record when its parent zone now
-- exists.  This preserves user data without inventing a relationship for
-- obsolete zones that were deleted before the hierarchy was introduced.
WITH latest_shelf_event AS (
  SELECT DISTINCT ON (event.organization_id, event.aggregate_id)
    event.organization_id,
    event.aggregate_id,
    event.payload -> 'command' -> 'payload' AS command_payload
  FROM server_sync_events AS event
  WHERE event.aggregate_type = 'warehouse_bin'
    AND event.payload -> 'command' ->> 'kind' IN ('warehouse.bin.upsert', 'warehouse.bin.delete')
  ORDER BY event.organization_id, event.aggregate_id, event.revision DESC
),
legacy_shelf AS (
  SELECT
    event.organization_id,
    event.aggregate_id AS id,
    event.command_payload ->> 'zoneId' AS zone_id,
    upper(trim(event.command_payload ->> 'code')) AS code,
    trim(event.command_payload ->> 'name') AS name,
    CASE
      WHEN event.command_payload ->> 'capacity' ~ '^[0-9]+$'
        THEN (event.command_payload ->> 'capacity')::integer
      ELSE NULL
    END AS capacity,
    CASE
      WHEN event.command_payload ->> 'lowStockThreshold' ~ '^[0-9]+$'
        THEN (event.command_payload ->> 'lowStockThreshold')::integer
      ELSE NULL
    END AS low_stock_threshold,
    CASE
      WHEN event.command_payload ->> 'displayOrder' ~ '^[0-9]+$'
        THEN (event.command_payload ->> 'displayOrder')::integer
      ELSE 0
    END AS display_order,
    CASE
      WHEN event.command_payload ->> 'status' IN ('active', 'blocked', 'critical', 'inactive')
        THEN event.command_payload ->> 'status'
      ELSE 'active'
    END AS status
  FROM latest_shelf_event AS event
  WHERE event.command_payload ->> 'zoneId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND nullif(trim(event.command_payload ->> 'code'), '') IS NOT NULL
    AND nullif(trim(event.command_payload ->> 'name'), '') IS NOT NULL
)
INSERT INTO warehouse_bins (
  id, organization_id, zone_id, code, name, capacity, low_stock_threshold,
  display_order, active, status
)
SELECT
  shelf.id,
  shelf.organization_id,
  shelf.zone_id::uuid,
  shelf.code,
  shelf.name,
  shelf.capacity,
  shelf.low_stock_threshold,
  shelf.display_order,
  shelf.status <> 'inactive',
  shelf.status
FROM legacy_shelf AS shelf
JOIN warehouse_zones AS zone
  ON zone.organization_id = shelf.organization_id
 AND zone.id = shelf.zone_id::uuid
 AND zone.deleted_at IS NULL
ON CONFLICT DO NOTHING;

COMMIT;
