import type pg from 'pg';
import { ValidationFailedError } from '@daja/security';
import {
  supplierTransaction,
  ALL_PROVIDERS,
  rollMissedSlots,
  STATE_SELECT
} from './supplier-queue.js';

export type SupplierFilters = {
  provider?: string | undefined;
  status?: string | undefined;
  search?: string | undefined;
  attention?: boolean;
  brandId?: string | undefined;
  departmentId?: string | undefined;
  stock?: string | undefined;
  visibility?: string | undefined;
  alternative?: boolean;
  sort?: string | undefined;
  direction?: string | undefined;
  page?: number;
};
export async function pauseSuppliers(
  pool: pg.Pool,
  input: {
    providers: string[];
    mode: 'all' | 'schedule';
    until: string | null;
    reason?: string | undefined;
  },
  actor: string
) {
  if (input.until && Date.parse(input.until) <= Date.now())
    throw new ValidationFailedError('Kraj pauze mora biti u budućnosti');
  await supplierTransaction(pool, async (client) => {
    const user = await client.query<{ display_name: string }>(
      'SELECT display_name FROM users WHERE id=$1',
      [actor]
    );
    await client.query(
      `UPDATE supplier_provider_checks SET manual_pause_mode=$2,manual_pause_until=$3,manual_pause_reason=$4,
      manual_pause_by=$5,manual_pause_at=now(),updated_at=now() WHERE provider_code=ANY($1::text[])`,
      [
        input.providers,
        input.mode,
        input.until,
        input.reason || null,
        user.rows[0]?.display_name || actor
      ]
    );
  });
}
export async function resumeSuppliers(pool: pg.Pool, providers: string[]) {
  await supplierTransaction(pool, async (client) => {
    await rollMissedSlots(client, providers);
    await client.query(
      `UPDATE supplier_product_links l SET confirmation_due_at=NULL,
      next_regular_at=p.cycle_epoch+(floor(extract(epoch FROM now()-p.cycle_epoch)/864000)::integer+1)*interval '240 hours'
      +make_interval(secs=>p.phase_seconds+(l.queue_position-1)*p.interval_seconds)
      FROM supplier_provider_checks p WHERE l.provider_code=p.provider_code AND p.provider_code=ANY($1::text[])
      AND l.provider_code<>'linkel'
      AND p.manual_pause_mode IS NOT NULL AND l.confirmation_due_at<=LEAST(now(),COALESCE(p.manual_pause_until,now()))`,
      [providers]
    );
    await client.query(
      `UPDATE supplier_provider_checks SET manual_pause_mode=NULL,manual_pause_until=NULL,manual_pause_reason=NULL,
      manual_pause_by=NULL,manual_pause_at=NULL,updated_at=now() WHERE provider_code=ANY($1::text[])`,
      [providers]
    );
  });
}
export async function supplierLinkActions(
  pool: pg.Pool,
  organizationId: string,
  input: { ids: string[]; action: 'check' | 'disable' | 'reactivate'; reason?: string | undefined; bulk?: boolean | undefined }
) {
  return supplierTransaction(pool, async (client) => {
    const items = [];
    for (const id of [...new Set(input.ids)]) {
      const found = await client.query(
        `SELECT l.*, (l.last_checked_at>now()-interval '1 hour') AS recently_checked, EXISTS(SELECT 1 FROM supplier_check_leases WHERE link_id=l.id AND expires_at>now()) AS running
        FROM supplier_product_links l JOIN products p ON p.id=l.product_id WHERE l.id=$1 AND l.organization_id=$2
        AND p.organization_id=l.organization_id AND p.deleted_at IS NULL AND NOT l.removed AND l.url IS NOT NULL AND l.provider_code=ANY($3::text[]) FOR UPDATE OF l`,
        [id, organizationId, ALL_PROVIDERS]
      );
      const link = found.rows[0];
      let status = 'accepted',
        reason: string | undefined;
      if (!link) {
        status = 'skipped';
        reason = 'Link nije dostupan u ovoj firmi';
      } else if (input.action === 'check') {
        if (!link.checks_enabled) {
          status = 'skipped';
          reason = 'Prvo vrati link u proveru';
        } else if (link.running || link.manual_requested_at || link.bulk_requested_at || link.initial_requested_at) {
          status = 'already_queued';
          reason = 'Provera već radi ili čeka';
        } else if (link.provider_code === 'linkel' && link.recently_checked && !link.last_error) {
          status = 'skipped';
          reason = 'Linkel je već proveren u poslednjih sat vremena';
        } else
          await client.query(
            `UPDATE supplier_product_links SET manual_requested_at=CASE WHEN NOT $2 THEN now() END,
              bulk_requested_at=CASE WHEN $2 THEN now() END WHERE id=$1`,
            [id, link.provider_code === 'linkel' && input.bulk === true]
          );
      } else if (input.action === 'disable') {
        if (!link.checks_enabled) {
          status = 'skipped';
          reason = 'Link je već isključen';
        } else
          await client.query(
            `UPDATE supplier_product_links SET checks_enabled=false,disabled_at=now(),disabled_reason=$2 WHERE id=$1`,
            [id, input.reason || 'Ručno isključen']
          );
      } else {
        if (link.checks_enabled) {
          status = 'skipped';
          reason = 'Link je već uključen';
        } else {
          const updated = await client.query(
            `UPDATE supplier_product_links l SET checks_enabled=true,disabled_at=NULL,disabled_reason=NULL,
            check_status='unverified',stock_status=NULL,last_error=NULL,negative_count=0,missing_count=0,
            first_problem_at=NULL,first_problem_reason=NULL,confirmation_due_at=NULL,manual_requested_at=now(),
            next_regular_at=CASE WHEN p.interval_seconds IS NOT NULL
              THEN supplier_regular_slot(p.cycle_epoch,p.phase_seconds,p.interval_seconds,
                l.queue_position,now()+interval '1 second',p.cycle_seconds)
              ELSE l.next_regular_at END
            FROM supplier_provider_checks p WHERE l.id=$1 AND p.provider_code=l.provider_code
            RETURNING l.checks_enabled`,
            [id]
          );
          if (!updated.rows[0].checks_enabled) {
            status = 'skipped';
            reason = 'Red dobavljača je popunjen';
          }
        }
      }
      items.push({ id, status, reason });
    }
    return { items };
  });
}

const LINK_SOURCE = `${STATE_SELECT.replace('SELECT l.id,', `SELECT product.name AS "productName", product.slug AS "productSlug",
 product.active AS "productActive", product.published AS "productPublished",
 product.brand_id AS "brandId", product.department_id AS "departmentId", l.id,`)}
 JOIN products product ON product.id=l.product_id AND product.organization_id=l.organization_id AND product.deleted_at IS NULL
 WHERE l.organization_id=$1 AND NOT l.removed AND l.url IS NOT NULL`;
const STOCK = `CASE WHEN "stockConfirmationPending" OR "lastError" IS NOT NULL
  THEN 'unknown' ELSE COALESCE("stockStatus",'unknown') END`;
const VISIBILITY = `CASE WHEN "productActive" AND "productPublished" THEN 'visible' ELSE 'hidden' END`;
const FACETS = [
  { key: 'provider', value: '"providerCode"', parameter: '$2::text' },
  { key: 'status', value: 'status', parameter: '$3::text' },
  { key: 'brandId', value: '"brandId"', parameter: '$6::uuid' },
  { key: 'departmentId', value: '"departmentId"', parameter: '$7::uuid' },
  { key: 'stock', value: STOCK, parameter: '$8::text' },
  { key: 'visibility', value: VISIBILITY, parameter: '$9::text' }
] as const;
const FACET_MATCHES = FACETS.map(({ value, parameter }) => `(${parameter} IS NULL OR (${value})=${parameter})`);
const SHARED_FILTERS = `($4::text IS NULL OR "productName" ILIKE '%'||$4||'%' OR url ILIKE '%'||$4||'%')
 AND (NOT $5::boolean OR status IN ('disabled','waiting_confirmation','unverified','missing') OR "lastError" IS NOT NULL OR "stockStatus"='out_of_stock')
 AND (NOT $10::boolean OR EXISTS (
   SELECT 1 FROM supplier_product_links alternative
   WHERE alternative.organization_id=$1 AND alternative.product_id=links."productId"
     AND alternative.id<>links.id AND NOT alternative.removed AND alternative.url IS NOT NULL
     AND alternative.stock_status='in_stock' AND alternative.last_error IS NULL AND alternative.negative_count=0
 ))`;
const LINK_VIEW = `WITH links AS (${LINK_SOURCE})
 SELECT * FROM links WHERE ${FACET_MATCHES.join(' AND ')} AND ${SHARED_FILTERS}`;

// Each menu excludes its own selection and uses the other filters across all pages.
const FACET_COLUMNS = FACETS.map(({ key, value }, index) => {
  const otherMatches = FACET_MATCHES.filter((_, position) => position !== index).join(' AND ');
  return `COALESCE(array_agg(DISTINCT (${value})) FILTER (WHERE (${value}) IS NOT NULL AND ${otherMatches}), '{}') AS "${key}"`;
});
export async function supplierLinksList(
  pool: pg.Pool,
  organizationId: string,
  filters: SupplierFilters,
  exporting = false
) {
  const values: unknown[] = [
    organizationId,
    filters.provider || null,
    filters.status || null,
    filters.search || null,
    !!filters.attention,
    filters.brandId || null,
    filters.departmentId || null,
    filters.stock || null,
    filters.visibility || null,
    !!filters.alternative
  ];
  const order =
    (
      {
        name: '"productName"',
        number: '"queuePosition"',
        last: '"lastCheckedAt"',
        next: '"nextCheckAt"'
      } as Record<string, string>
    )[filters.sort || 'next'] || '"nextCheckAt"';
  const direction = filters.direction === 'desc' ? 'DESC' : 'ASC';
  if (exporting)
    return {
      items: (await pool.query(LINK_VIEW + ` ORDER BY ${order} ${direction} NULLS LAST,id`, values))
        .rows
    };
  const summary = await pool.query<{ total: number } & Record<(typeof FACETS)[number]['key'], string[]>>(
    `WITH links AS (${LINK_SOURCE})
     SELECT count(*) FILTER (WHERE ${FACET_MATCHES.join(' AND ')})::integer AS total,
       ${FACET_COLUMNS.join(',\n')}
     FROM links WHERE ${SHARED_FILTERS}`,
    values
  );
  const items = await pool.query(
    `SELECT page.*, COALESCE(siblings.items,'[]'::jsonb) AS "supplierLinks"
     FROM (${LINK_VIEW} ORDER BY ${order} ${direction} NULLS LAST,id LIMIT 50 OFFSET $11) page
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object('id', l.id, 'providerCode', l.provider_code, 'url', l.url,
         'stockStatus', l.stock_status, 'checksEnabled', l.checks_enabled, 'checkStatus', l.check_status,
         'lastCheckedAt', l.last_checked_at, 'lastError', l.last_error, 'stockConfirmationPending', l.negative_count>0)
         ORDER BY l.provider_code) AS items
       FROM supplier_product_links l
       WHERE l.organization_id=$1 AND l.product_id=page."productId" AND NOT l.removed AND l.url IS NOT NULL
     ) siblings ON true
     ORDER BY page.${order} ${direction} NULLS LAST,page.id`,
    [...values, ((filters.page || 1) - 1) * 50]
  );
  const { total, ...facets } = summary.rows[0]!;
  return { items: items.rows, total, facets, page: filters.page || 1 };
}
export async function supplierStatistics(
  pool: pg.Pool,
  organizationId: string,
  code: string,
  period: string
) {
  const hours = period === '30d' ? 720 : period === '7d' ? 168 : 24;
  const rows = await pool.query(
    `SELECT hour_at AS "hourAt",SUM(completed)::float AS completed,SUM(available)::float AS available,
    SUM(missing)::float AS missing,SUM(out_of_stock)::float AS "outOfStock",SUM(errors)::float AS errors,
    SUM(duration_ms)::float AS "durationMs",MAX(max_duration_ms)::float AS "maxDurationMs",SUM(skipped)::float AS skipped,SUM(disabled)::float AS disabled
    FROM supplier_hourly_statistics WHERE scope_id=$1 AND ($2='all' OR provider_code=$2)
    AND hour_at>=date_trunc('hour',now())-make_interval(hours=>$3-1) GROUP BY hour_at ORDER BY hour_at`,
    [organizationId, code, hours]
  );
  const health = await pool.query(
    `SELECT SUM(completed)::float AS completed,SUM(available)::float AS available,SUM(errors)::float AS errors
    FROM supplier_hourly_statistics WHERE scope_id='site' AND ($1='all' OR provider_code=$1) AND hour_at>=now()-make_interval(hours=>$2)`,
    [code, hours]
  );
  const started = await pool.query(
    `SELECT min(statistics_started_at) AS "startedAt" FROM supplier_provider_checks WHERE $1='all' OR provider_code=$1`,
    [code]
  );
  return { items: rows.rows, health: health.rows[0], startedAt: started.rows[0].startedAt, hours };
}
export async function supplierTimeline(pool: pg.Pool, organizationId: string, minutes: number) {
  const result = await pool.query(
    `SELECT links.*,product.name AS "productName" FROM (${STATE_SELECT} WHERE l.organization_id=$1) links JOIN products product ON product.id=links."productId" WHERE product.organization_id=$1 AND product.deleted_at IS NULL
    AND "checksEnabled" AND NOT removed AND status NOT IN ('paused','disabled') AND NOT EXISTS(SELECT 1 FROM supplier_check_leases lease WHERE lease.link_id=links.id AND lease.expires_at>now()) AND "nextCheckAt"<date_trunc('minute',now())+make_interval(mins=>$2)
    ORDER BY "nextCheckAt",id`,
    [organizationId, minutes]
  );
  return {
    now: new Date().toISOString(),
    minutes,
    items: result.rows.map(
      ({ id, productId, providerCode, queuePosition, nextCheckAt, status, productName }) => ({
        id,
        productId,
        providerCode,
        queuePosition,
        nextCheckAt,
        status,
        productName
      })
    )
  };
}
export function supplierCsv(items: Record<string, unknown>[]) {
  const fields = [
    'productName',
    'providerCode',
    'url',
    'queuePosition',
    'status',
    'stockStatus',
    'lastCheckedAt',
    'nextCheckAt',
    'firstProblemAt',
    'confirmationDueAt',
    'disabledReason',
    'manualRequestedAt'
  ];
  const escape = (value: unknown) => {
    let s = value instanceof Date ? value.toISOString() : String(value ?? '');
    if (/^[=+@-]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  return (
    '\uFEFF' +
    fields.map(escape).join(';') +
    '\r\n' +
    items.map((row) => fields.map((key) => escape(row[key])).join(';')).join('\r\n')
  );
}
