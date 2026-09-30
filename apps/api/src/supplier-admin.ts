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
  input: { ids: string[]; action: 'check' | 'disable' | 'reactivate'; reason?: string | undefined }
) {
  return supplierTransaction(pool, async (client) => {
    const items = [];
    for (const id of [...new Set(input.ids)]) {
      const found = await client.query(
        `SELECT l.*,EXISTS(SELECT 1 FROM supplier_check_leases WHERE link_id=l.id AND expires_at>now()) AS running
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
        } else if (link.running || link.manual_requested_at || link.initial_requested_at) {
          status = 'already_queued';
          reason = 'Provera već radi ili čeka';
        } else
          await client.query(
            'UPDATE supplier_product_links SET manual_requested_at=now() WHERE id=$1',
            [id]
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
            `UPDATE supplier_product_links SET checks_enabled=true WHERE id=$1 RETURNING checks_enabled`,
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

const LINK_VIEW = `WITH links AS (${STATE_SELECT.replace('SELECT l.id,', 'SELECT product.name AS "productName", product.slug AS "productSlug", l.id,')}
 JOIN products product ON product.id=l.product_id AND product.organization_id=l.organization_id AND product.deleted_at IS NULL
 WHERE l.organization_id=$1 AND NOT l.removed AND l.url IS NOT NULL)
 SELECT * FROM links WHERE ($2::text IS NULL OR "providerCode"=$2)
 AND ($3::text IS NULL OR status=$3)
 AND ($4::text IS NULL OR "productName" ILIKE '%'||$4||'%' OR url ILIKE '%'||$4||'%')
 AND (NOT $5::boolean OR status IN ('disabled','waiting_confirmation','unverified','missing') OR "lastError" IS NOT NULL)`;
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
    !!filters.attention
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
  const count = await pool.query(
    `SELECT count(*)::integer AS total FROM (${LINK_VIEW}) filtered`,
    values
  );
  const items = await pool.query(
    LINK_VIEW + ` ORDER BY ${order} ${direction} NULLS LAST,id LIMIT 50 OFFSET $6`,
    [...values, ((filters.page || 1) - 1) * 50]
  );
  return { items: items.rows, total: count.rows[0].total, page: filters.page || 1 };
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
