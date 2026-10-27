import type { Database } from '@daja/database';

// Ignore transport/inventory metadata and empty values when assessing specs.
export const meaningfulSpecsSql = `(SELECT count(*) FROM jsonb_each_text(COALESCE(v.attributes, '{}'::jsonb)) a
 WHERE btrim(COALESCE(a.value, '')) NOT IN ('', 'null', '[]', '{}')
 AND a.key NOT IN ('additional_barcodes', '_additionalBarcodes', 'additionalbarcodes', 'rfid_piece_placements', '_rfidPiecePlacements', 'rfidpieceplacements')
 AND left(a.key, 1) <> '_')`;

// Personal brand > personal department > personal flat > global brand
// > global department > global flat. Zero is an explicit, valid override.
export const effectiveRateSql = (alias: string) => `COALESCE(
 (SELECT r.rate_minor FROM catalog_contributor_rate_rules r WHERE r.organization_id = ${alias}.organization_id
   AND r.user_id = ${alias}.created_by_user_id AND r.department_id = ${alias}.department_id
   AND r.category_id IS NULL AND (r.brand_id IS NULL OR r.brand_id = ${alias}.brand_id)
   ORDER BY (r.brand_id IS NOT NULL) DESC LIMIT 1),
 (SELECT r.rate_minor FROM catalog_contributor_rates r WHERE r.organization_id = ${alias}.organization_id AND r.user_id = ${alias}.created_by_user_id),
 (SELECT r.rate_minor FROM catalog_contributor_rate_rules r WHERE r.organization_id = ${alias}.organization_id
   AND r.user_id IS NULL AND r.department_id = ${alias}.department_id
   AND r.category_id IS NULL AND (r.brand_id IS NULL OR r.brand_id = ${alias}.brand_id)
   ORDER BY (r.brand_id IS NOT NULL) DESC LIMIT 1),
 (SELECT s.default_rate_minor FROM catalog_contributor_settings s WHERE s.organization_id = ${alias}.organization_id), 0)`;

export async function workforceSummary(
  db: Pick<Database['pool'], 'query'>,
  organizationId: string,
  start: string,
  end: string,
  userId: string | null = null
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
  WHERE p.organization_id = $1 AND ($4::uuid IS NULL OR p.created_by_user_id = $4)
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
 WHERE u.organization_id=$1 AND ($4::uuid IS NULL OR u.id=$4) AND (s.total > 0 OR EXISTS (
   SELECT 1 FROM user_role_assignments ura JOIN roles r ON r.id=ura.role_id AND r.organization_id=u.organization_id
   WHERE ura.user_id=u.id AND ura.organization_id=u.organization_id AND ura.deleted_at IS NULL AND r.deleted_at IS NULL AND r.code='catalog_contributor'))
 ORDER BY "createdToday" DESC, name`,
      [organizationId, start, end, userId]
    )
  ).rows;
}

// The workforce view needs one row per product, without supplier/RFID data.
// Calculate the checklist in the same query, rather than one round trip per item.
export async function workforceProducts(db: Pick<Database['pool'], 'query'>, organizationId: string, userId: string) {
  const { rows } = await db.query(`SELECT p.id, p.name, p.slug, p.created_at AS "createdAt", p.updated_at AS "updatedAt",
    p.deleted_at AS "deletedAt", p.quality_review_status AS "qualityReviewStatus", p.quality_review_note AS "qualityReviewNote",
    p.compensation_amount_minor AS "compensationAmountMinor", p.compensation_approved_at AS "compensationApprovedAt",
    p.department_id, p.brand_id, p.primary_category_id, p.description,
    d.name AS department, b.name AS brand, c.name AS category, v.sku, v.barcode, v.gender, v.current_price_amount,
    ${meaningfulSpecsSql}::int AS specs_count,
    jsonb_array_length(p.features)::int AS features_count,
    inventory.location_id, inventory.quantity,
    (SELECT count(*)::int FROM product_media pm JOIN media_assets ma ON ma.id=pm.media_asset_id AND ma.status='ready'
      WHERE pm.organization_id=p.organization_id AND pm.product_id=p.id) AS media_count,
    media.public_url AS "primaryImageUrl", media.thumbnail_url AS "thumbnailUrl",
    (SELECT max(a.occurred_at) FROM audit_events a WHERE a.organization_id=p.organization_id
      AND a.aggregate_type='product' AND a.aggregate_id=p.id AND a.operation='quality_changes_requested') AS "lastReturnedAt",
    ${effectiveRateSql('p')} AS "effectiveRateMinor"
    FROM products p
    LEFT JOIN departments d ON d.organization_id=p.organization_id AND d.id=p.department_id
    LEFT JOIN brands b ON b.organization_id=p.organization_id AND b.id=p.brand_id
    LEFT JOIN categories c ON c.organization_id=p.organization_id AND c.id=p.primary_category_id
    LEFT JOIN LATERAL (SELECT * FROM product_variants WHERE organization_id=p.organization_id
      AND product_id=p.id AND deleted_at IS NULL ORDER BY created_at,id LIMIT 1) v ON true
    LEFT JOIN LATERAL (SELECT location_id,quantity FROM inventory_balances WHERE organization_id=p.organization_id
      AND variant_id=v.id ORDER BY updated_at DESC LIMIT 1) inventory ON true
    LEFT JOIN LATERAL (SELECT ma.public_url, md.public_url AS thumbnail_url FROM product_media pm
      JOIN media_assets ma ON ma.id=pm.media_asset_id AND ma.status='ready'
      LEFT JOIN LATERAL (SELECT public_url FROM media_derivatives WHERE media_asset_id=ma.id ORDER BY width LIMIT 1) md ON true
      WHERE pm.organization_id=p.organization_id AND pm.product_id=p.id ORDER BY pm.is_primary DESC,pm.position,pm.id LIMIT 1) media ON true
    WHERE p.organization_id=$1 AND p.created_by_user_id=$2 ORDER BY p.created_at DESC,p.id`, [organizationId, userId]);
  return rows.map(({ department_id, brand_id, primary_category_id, description, barcode, gender, current_price_amount,
    specs_count, features_count, location_id, quantity, media_count, ...product }) => {
    const checks = product.deletedAt ? [] : [
      { label: 'Naziv', complete: Boolean(product.name?.trim()) },
      { label: 'Cena', complete: Number(current_price_amount) > 0 },
      { label: 'GTIN proizvoda', complete: Boolean(barcode?.trim()) },
      { label: 'Opis', complete: Boolean(description?.trim()) },
      { label: 'Odeljenje', complete: Boolean(department_id) },
      { label: 'Brend', complete: Boolean(brand_id) },
      { label: 'Kategorija', complete: Boolean(primary_category_id) },
      { label: 'Pol', complete: Boolean(gender?.trim()) },
      { label: 'Glavna lokacija', complete: Boolean(location_id) },
      { label: 'Količina', complete: Number(quantity) > 0 },
      { label: `Istaknute kartice (${Number(features_count)}/3)`, complete: Number(features_count) >= 3 },
      { label: `Specifikacije (${Number(specs_count)}/5)`, complete: Number(specs_count) >= 5 },
      { label: `Slike (${Number(media_count)}/1)`, complete: Number(media_count) >= 1 }
    ];
    return { ...product, qualityChecks: checks, qualityMissing: checks.filter(check => !check.complete).map(check => check.label) };
  });
}

export async function workforceTimelineEntries(db: Pick<Database['pool'], 'query'>, organizationId: string, userId: string, date: string) {
  return (await db.query(`WITH bounds AS (
      SELECT $3::date::timestamp AT TIME ZONE 'Europe/Belgrade' AS start,
        ($3::date + 1)::timestamp AT TIME ZONE 'Europe/Belgrade' AS finish
    ), actions AS (
      SELECT a.id, a.operation, a.aggregate_type, p.id AS product_id,
        COALESCE(p.name,a.after_payload->>'name',a.before_payload->>'name','Artikal') AS product_name,
        a.occurred_at,p.deleted_at,p.created_by_user_id,
        row_number() OVER (PARTITION BY COALESCE(NULLIF(a.request_id,''),a.id::text),COALESCE(p.id,a.aggregate_id)
          ORDER BY CASE WHEN a.operation IN ('quality_approved','quality_changes_requested') THEN 0
            WHEN a.aggregate_type='product' THEN 1 WHEN a.aggregate_type='variant' THEN 2 ELSE 3 END,a.occurred_at,a.id) AS event_rank
      FROM audit_events a CROSS JOIN bounds b
      LEFT JOIN product_variants v ON a.aggregate_type IN ('variant','inventory_balance') AND v.id=a.aggregate_id AND v.organization_id=$1
      LEFT JOIN products p ON p.organization_id=$1 AND p.id=CASE WHEN a.aggregate_type='product' THEN a.aggregate_id ELSE v.product_id END
      WHERE a.organization_id=$1 AND a.actor_user_id=$2 AND a.aggregate_type IN ('product','variant','inventory_balance')
        AND a.occurred_at>=b.start AND a.occurred_at<b.finish
    )
    SELECT 'product:' || p.id::text AS id,'created' AS operation,'product' AS "aggregateType",
      p.id AS "productId",p.name AS "productName",p.created_at AS "occurredAt",p.deleted_at AS "deletedAt"
    FROM products p CROSS JOIN bounds b
    WHERE p.organization_id=$1 AND p.created_by_user_id=$2 AND p.created_at>=b.start AND p.created_at<b.finish
    UNION ALL
    SELECT 'audit:' || id::text,operation,aggregate_type,product_id,product_name,occurred_at,deleted_at
    FROM actions WHERE event_rank=1 AND NOT (aggregate_type='product' AND operation IN ('create','created') AND COALESCE(created_by_user_id=$2,false))
    ORDER BY "occurredAt",id`, [organizationId,userId,date])).rows;
}
