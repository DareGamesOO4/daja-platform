import type { Database } from '@daja/database';

// Ignore transport/inventory metadata and empty values when assessing specs.
export const meaningfulSpecsSql = `(SELECT count(*) FROM jsonb_each_text(COALESCE(v.attributes, '{}'::jsonb)) a
 WHERE btrim(COALESCE(a.value, '')) NOT IN ('', 'null', '[]', '{}')
 AND a.key NOT IN ('additional_barcodes', '_additionalBarcodes', 'additionalbarcodes', 'rfid_piece_placements', '_rfidPiecePlacements', 'rfidpieceplacements')
 AND left(a.key, 1) <> '_')`;

// Personal category > personal department > personal flat > global category
// > global department > global flat. Zero is an explicit, valid override.
export const effectiveRateSql = (alias: string) => `COALESCE(
 (SELECT r.rate_minor FROM catalog_contributor_rate_rules r WHERE r.organization_id = ${alias}.organization_id
   AND r.user_id = ${alias}.created_by_user_id AND r.department_id = ${alias}.department_id
   AND (r.category_id IS NULL OR r.category_id = ${alias}.primary_category_id)
   ORDER BY (r.category_id IS NOT NULL) DESC LIMIT 1),
 (SELECT r.rate_minor FROM catalog_contributor_rates r WHERE r.organization_id = ${alias}.organization_id AND r.user_id = ${alias}.created_by_user_id),
 (SELECT r.rate_minor FROM catalog_contributor_rate_rules r WHERE r.organization_id = ${alias}.organization_id
   AND r.user_id IS NULL AND r.department_id = ${alias}.department_id
   AND (r.category_id IS NULL OR r.category_id = ${alias}.primary_category_id)
   ORDER BY (r.category_id IS NOT NULL) DESC LIMIT 1),
 (SELECT s.default_rate_minor FROM catalog_contributor_settings s WHERE s.organization_id = ${alias}.organization_id), 0)`;

export async function workforceSummary(
  db: Pick<Database['pool'], 'query'>,
  organizationId: string,
  start: string,
  end: string
) {
  return (
    await db.query(
      `
 WITH bounds AS (SELECT (now() AT TIME ZONE 'Europe/Belgrade')::date AS today),
 authored AS (
  SELECT p.*, (p.created_at AT TIME ZONE 'Europe/Belgrade')::date AS day,
   (COALESCE(btrim(p.name),'') = '' OR p.department_id IS NULL OR p.brand_id IS NULL OR p.primary_category_id IS NULL
    OR COALESCE(btrim(p.description),'') = '' OR COALESCE(btrim(v.barcode),'') = '' OR COALESCE(v.current_price_amount,0) <= 0
    OR COALESCE(btrim(v.gender),'') = '' OR ${meaningfulSpecsSql} < 5 OR jsonb_array_length(p.features) < 3
    OR NOT EXISTS (SELECT 1 FROM inventory_balances ib WHERE ib.organization_id = p.organization_id AND ib.variant_id = v.id
      AND ib.location_id IS NOT NULL AND ib.quantity > 0)
    OR NOT EXISTS (SELECT 1 FROM product_media pm JOIN media_assets ma ON ma.id = pm.media_asset_id AND ma.status = 'ready'
      WHERE pm.organization_id = p.organization_id AND pm.product_id = p.id)) AS incomplete
  FROM products p LEFT JOIN LATERAL (SELECT * FROM product_variants WHERE organization_id = p.organization_id
    AND product_id = p.id AND deleted_at IS NULL ORDER BY created_at LIMIT 1) v ON true
  WHERE p.organization_id = $1
 )
 SELECT u.id, COALESCE(u.display_name,u.email) AS name, u.email,
  COALESCE(s.total,0)::int AS "createdTotal", COALESCE(s.period,0)::int AS "createdInPeriod",
  COALESCE(s.today,0)::int AS "createdToday", COALESCE(s.yesterday,0)::int AS "createdYesterday",
  COALESCE(s.approved,0)::int AS "approvedCount", COALESCE(s.pending,0)::int AS "pendingCount",
  COALESCE(s.returned,0)::int AS "changesRequestedCount", COALESCE(s.incomplete,0)::int AS "incompleteCount",
  COALESCE(s.deleted,0)::int AS "deletedCount", COALESCE(s.amount,0) AS "approvedAmountMinor",
  COALESCE(s.credited,0)::int AS "creditedCount", s.last_added AS "lastProductAt",
  COALESCE(rate.rate_minor,settings.default_rate_minor,0)::int AS "rateMinor", rate.rate_minor AS "personalRateMinor",
  COALESCE(returns.total,0)::int AS "returnedTotal", COALESCE(returns.distinct_products,0)::int AS "returnedProductsCount",
  COALESCE(hours.data,'{}'::jsonb) AS hourly, COALESCE(days.data,'[]'::jsonb) AS daily
 FROM users u CROSS JOIN bounds b
 LEFT JOIN LATERAL (
  SELECT count(*) AS total, count(*) FILTER (WHERE created_at BETWEEN $2::timestamptz AND $3::timestamptz) AS period,
   count(*) FILTER (WHERE day = b.today) AS today, count(*) FILTER (WHERE day = b.today - 1) AS yesterday,
   count(*) FILTER (WHERE deleted_at IS NULL AND quality_review_status='approved') AS approved,
   count(*) FILTER (WHERE deleted_at IS NULL AND quality_review_status='pending') AS pending,
   count(*) FILTER (WHERE deleted_at IS NULL AND quality_review_status='changes_requested') AS returned,
   count(*) FILTER (WHERE deleted_at IS NULL AND incomplete) AS incomplete,
   count(*) FILTER (WHERE deleted_at IS NOT NULL) AS deleted,
   count(*) FILTER (WHERE compensation_approved_at IS NOT NULL) AS credited,
   sum(compensation_amount_minor) FILTER (WHERE compensation_approved_at IS NOT NULL) AS amount, max(created_at) AS last_added
  FROM authored WHERE created_by_user_id = u.id
 ) s ON true
 LEFT JOIN LATERAL (SELECT count(*) AS total, count(DISTINCT a.aggregate_id) AS distinct_products
   FROM audit_events a JOIN authored p ON p.id = a.aggregate_id
   WHERE a.organization_id = $1 AND p.created_by_user_id = u.id AND a.aggregate_type='product'
   AND a.operation='quality_changes_requested') returns ON true
 LEFT JOIN LATERAL (SELECT jsonb_object_agg(hour, total) AS data FROM (
   SELECT to_char(created_at AT TIME ZONE 'Europe/Belgrade','HH24') AS hour, count(*)::int AS total
   FROM authored WHERE created_by_user_id=u.id AND day=b.today GROUP BY 1) h) hours ON true
 LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('date',d.day,'count',d.total) ORDER BY d.day) AS data FROM (
   SELECT g.day::date AS day, count(p.id)::int AS total FROM generate_series((b.today-29)::timestamp,b.today::timestamp,interval '1 day') g(day)
   LEFT JOIN authored p ON p.created_by_user_id=u.id AND p.day=g.day::date GROUP BY g.day) d) days ON true
 LEFT JOIN catalog_contributor_rates rate ON rate.organization_id=u.organization_id AND rate.user_id=u.id
 LEFT JOIN catalog_contributor_settings settings ON settings.organization_id=u.organization_id
 WHERE u.organization_id=$1 AND (s.total > 0 OR EXISTS (
   SELECT 1 FROM user_role_assignments ura JOIN roles r ON r.id=ura.role_id AND r.organization_id=u.organization_id
   WHERE ura.user_id=u.id AND ura.organization_id=u.organization_id AND ura.deleted_at IS NULL AND r.deleted_at IS NULL AND r.code='catalog_contributor'))
 ORDER BY "createdToday" DESC, name`,
      [organizationId, start, end]
    )
  ).rows;
}
