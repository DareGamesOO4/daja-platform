BEGIN;

-- The earliest desktop layout command created the Platform default ZONA-1
-- with a server UUID, while later local shelf commands still referenced the
-- desktop-only UUID.  Those commands were accepted into the sync log before
-- a warehouse projector existed, but migration 020 correctly skipped them
-- because their parent UUID was absent.  Attach that one legacy default-zone
-- stream to the canonical ZONA-1 of the same warehouse.
WITH latest_shelf_event AS (
  SELECT DISTINCT ON (event.organization_id, event.aggregate_id)
    event.organization_id,
    event.aggregate_id,
    event.payload -> 'command' -> 'payload' AS command_payload
  FROM server_sync_events AS event
  WHERE event.aggregate_type = 'warehouse_bin'
    AND event.payload -> 'command' ->> 'kind' = 'warehouse.bin.upsert'
  ORDER BY event.organization_id, event.aggregate_id, event.revision DESC
),
legacy_default_shelf AS (
  SELECT
    event.organization_id,
    event.aggregate_id AS id,
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
    END AS status,
    warehouse.id AS warehouse_id
  FROM latest_shelf_event AS event
  JOIN warehouses AS warehouse
    ON warehouse.organization_id = event.organization_id
   AND warehouse.id = (event.command_payload ->> 'warehouseId')::uuid
   AND warehouse.deleted_at IS NULL
  JOIN warehouse_zones AS default_zone
    ON default_zone.organization_id = warehouse.organization_id
   AND default_zone.warehouse_id = warehouse.id
   AND default_zone.code = 'ZONA-1'
   AND default_zone.deleted_at IS NULL
  LEFT JOIN warehouse_zones AS requested_zone
    ON requested_zone.organization_id = event.organization_id
   AND requested_zone.id = (event.command_payload ->> 'zoneId')::uuid
   AND requested_zone.deleted_at IS NULL
  WHERE event.command_payload ->> 'warehouseId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND event.command_payload ->> 'zoneId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND requested_zone.id IS NULL
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
  default_zone.id,
  shelf.code,
  shelf.name,
  shelf.capacity,
  shelf.low_stock_threshold,
  shelf.display_order,
  shelf.status <> 'inactive',
  shelf.status
FROM legacy_default_shelf AS shelf
JOIN warehouse_zones AS default_zone
  ON default_zone.organization_id = shelf.organization_id
 AND default_zone.warehouse_id = shelf.warehouse_id
 AND default_zone.code = 'ZONA-1'
 AND default_zone.deleted_at IS NULL
ON CONFLICT DO NOTHING;

COMMIT;
