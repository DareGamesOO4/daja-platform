import type pg from 'pg';
import { SyncRepository, type Database } from '@daja/database';
import { randomUUID } from 'node:crypto';
import { recordSupplierStatistics } from './supplier-metrics.js';
import type { Logger } from '@daja/observability';
import { ValidationFailedError } from '@daja/security';

export const NUMBERED_PROVIDERS = ['ekka', 'bultime', 'timezone', 'qandq'] as const;
export const ALL_PROVIDERS = [...NUMBERED_PROVIDERS, 'linkel', 'milano'] as const;
export type NumberedProvider = (typeof NUMBERED_PROVIDERS)[number];
export type SupplierOutcome =
  | {
      status: 'available';
      stockStatus: 'in_stock' | 'out_of_stock' | null;
      priceAmount?: number | null;
      priceCurrency?: string | null;
    }
  | { status: 'missing' | 'error'; message?: string };
type QueryClient = Pick<pg.PoolClient, 'query'>;
type QueueLink = {
  id: string;
  organization_id: string;
  product_id: string;
  provider_code: string;
  url: string;
  generation: number;
  negative_count: number;
  first_problem_at: Date | null;
  initial_requested_at: Date | null;
  next_regular_at: Date | null;
  confirmation_due_at: Date | null;
  checks_enabled: boolean;
  manual_requested_at: Date | null;
  next_check_at: Date;
  last_checked_at: Date | null;
  missing_count: number;
  legacy_due?: boolean;
};
type Lease = {
  token: string;
  provider_code: string;
  link_id: string | null;
  generation: number | null;
  kind: string;
};
type Adapters = {
  page(provider: string, url: string, signal: AbortSignal): Promise<SupplierOutcome>;
  home(provider: string, signal: AbortSignal): Promise<boolean>;
};

export async function supplierTransaction<T>(
  pool: pg.Pool,
  action: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('supplier-state'))`);
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function saveNumberedLink(
  client: QueryClient,
  organizationId: string,
  productId: string,
  provider: NumberedProvider,
  url: string | null
): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('supplier-state'))`);
  if (!url) {
    await client.query(
      `UPDATE supplier_product_links SET url = NULL, removed = true, checks_enabled = false
      WHERE organization_id = $1 AND product_id = $2 AND provider_code = $3 AND NOT removed`,
      [organizationId, productId, provider]
    );
    return;
  }
  const existing = await client.query<{ id: string; url: string | null; removed: boolean }>(
    `SELECT id,url,removed FROM supplier_product_links
    WHERE organization_id=$1 AND product_id=$2 AND provider_code=$3 FOR UPDATE`,
    [organizationId, productId, provider]
  );
  const row = existing.rows[0];
  if (!row)
    await client.query(
      `INSERT INTO supplier_product_links(organization_id,product_id,provider_code,url) VALUES ($1,$2,$3,$4)`,
      [organizationId, productId, provider, url]
    );
  else if (row.url !== url || row.removed)
    await client.query(`UPDATE supplier_product_links SET url=$2,removed=false WHERE id=$1`, [
      row.id,
      url
    ]);
}

async function expireSupplierLeases(client: QueryClient): Promise<void> {
  const expired = await client.query<Lease>(
    `DELETE FROM supplier_check_leases WHERE expires_at<=now() RETURNING *`
  );
  for (const lease of expired.rows)
    if (lease.link_id) {
      await client.query(
        `UPDATE supplier_product_links SET initial_requested_at=CASE WHEN $3='initial' THEN now() ELSE initial_requested_at END, manual_requested_at=CASE WHEN $3='manual' THEN now() ELSE manual_requested_at END,
      updated_at=now() WHERE id=$1 AND generation=$2 AND NOT removed AND checks_enabled`,
        [lease.link_id, lease.generation, lease.kind]
      );
    }
}

export async function acquireSupplierLease(
  pool: pg.Pool,
  provider: string,
  kind: 'legacy' | 'preview'
): Promise<string | null> {
  return supplierTransaction(pool, async (client) => {
    await expireSupplierLeases(client);
    const blocked = await client.query(
      `SELECT 1 FROM supplier_provider_checks WHERE provider_code=$1 AND manual_pause_mode='all' AND (manual_pause_until IS NULL OR manual_pause_until>now())`,
      [provider]
    );
    if (blocked.rowCount) return null;
    const count = await client.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM supplier_check_leases`
    );
    if ((count.rows[0]?.count ?? 0) >= 20) return null;
    const lease = await client.query<{ token: string }>(
      `INSERT INTO supplier_check_leases(provider_code,kind) VALUES ($1,$2) RETURNING token`,
      [provider, kind]
    );
    return lease.rows[0]!.token;
  });
}

export function supplierStateFields(state: Record<string, unknown>): Record<string, unknown> {
  const prefix = state.providerCode === 'ekka' ? 'supplier' : String(state.providerCode);
  const fields: Record<string, unknown> = {};
  for (const name of [
    'url',
    'status',
    'stockStatus',
    'priceAmount',
    'priceCurrency',
    'lastCheckedAt',
    'nextCheckAt',
    'queuePosition',
    'checksEnabled',
    'disabledReason',
    'disabledAt',
    'lastGoodResult',
    'confirmationDueAt',
    'nextRegularAt',
    'pausedUntil',
    'pauseReason',
    'firstProblemAt',
    'firstProblemReason',
    'manualRequestedAt',
    'manualPaused',
    'manualPauseMode',
    'manualPauseUntil'
  ]) {
    fields[prefix + name[0]!.toUpperCase() + name.slice(1)] = state.removed
      ? null
      : (state[name] ?? null);
  }
  fields[prefix + 'LinkId'] = state.id;
  return fields;
}

export async function reactivateSupplierLink(
  pool: pg.Pool,
  organizationId: string,
  id: string
): Promise<void> {
  await supplierTransaction(pool, async (client) => {
    const result = await client.query(
      `UPDATE supplier_product_links l SET checks_enabled = true
      FROM products p WHERE l.id = $1 AND l.organization_id = $2 AND l.product_id = p.id AND p.deleted_at IS NULL
        AND l.provider_code = ANY($3::text[]) AND l.url IS NOT NULL AND NOT l.removed AND NOT l.checks_enabled
      RETURNING l.id`,
      [id, organizationId, ALL_PROVIDERS]
    );
    if (!result.rowCount) {
      const exists = await client.query(
        `SELECT l.id FROM supplier_product_links l JOIN products p ON p.id=l.product_id
        WHERE l.id=$1 AND l.organization_id=$2 AND l.provider_code=ANY($3::text[]) AND NOT l.removed AND l.url IS NOT NULL AND p.deleted_at IS NULL`,
        [id, organizationId, ALL_PROVIDERS]
      );
      if (!exists.rowCount)
        throw new ValidationFailedError('Link nije dostupan za vraćanje u proveru');
    }
  });
}

export const STATE_SELECT = `SELECT l.id, l.product_id AS "productId", l.provider_code AS "providerCode", l.url,
  l.removed, l.checks_enabled AS "checksEnabled", l.queue_position AS "queuePosition", l.state_revision::text AS revision,
  CASE WHEN l.removed THEN 'removed' WHEN NOT l.checks_enabled THEN 'disabled'
    WHEN EXISTS (SELECT 1 FROM supplier_check_leases lease WHERE lease.link_id=l.id AND lease.expires_at>now()) THEN 'checking'
    WHEN p.manual_pause_mode IS NOT NULL AND (p.manual_pause_until IS NULL OR p.manual_pause_until>now())
      AND (p.manual_pause_mode='all' OR l.initial_requested_at IS NULL) THEN 'paused'
    WHEN p.paused_until IS NOT NULL AND (p.interval_seconds IS NOT NULL OR p.paused_until>now()) AND l.initial_requested_at IS NULL THEN 'paused'
    WHEN l.initial_requested_at IS NOT NULL OR l.manual_requested_at IS NOT NULL THEN 'checking'
    WHEN l.negative_count>0 OR (l.missing_count>0 AND l.check_status<>'missing') THEN 'waiting_confirmation' ELSE l.check_status END AS status,
  l.stock_status AS "stockStatus", l.price_amount AS "priceAmount", l.price_currency AS "priceCurrency",
  l.last_checked_at AS "lastCheckedAt", l.last_good_result AS "lastGoodResult", l.last_error AS "lastError",
  l.disabled_reason AS "disabledReason", l.disabled_at AS "disabledAt", l.first_problem_at AS "firstProblemAt",
  l.first_problem_reason AS "firstProblemReason", l.confirmation_due_at AS "confirmationDueAt",
  l.next_regular_at AS "nextRegularAt", COALESCE(p.manual_pause_until,p.paused_until) AS "pausedUntil",
  COALESCE(p.manual_pause_reason,p.pause_reason) AS "pauseReason", l.manual_requested_at AS "manualRequestedAt",
  p.manual_pause_mode AS "manualPauseMode",p.manual_pause_until AS "manualPauseUntil",
  CASE WHEN p.manual_pause_mode IS NOT NULL AND (p.manual_pause_until IS NULL OR p.manual_pause_until>now()) THEN true ELSE false END AS "manualPaused",
  CASE WHEN NOT l.checks_enabled OR l.removed THEN NULL WHEN l.initial_requested_at IS NOT NULL THEN l.initial_requested_at
    WHEN l.manual_requested_at IS NOT NULL THEN l.manual_requested_at ELSE LEAST(CASE WHEN l.next_regular_at<l.first_problem_at+interval '24 hours' THEN NULL ELSE COALESCE(l.next_regular_at,l.next_check_at) END,l.confirmation_due_at) END AS "nextCheckAt"
  FROM supplier_product_links l JOIN supplier_provider_checks p ON p.provider_code=l.provider_code`;

export async function supplierStates(
  pool: pg.Pool,
  organizationId: string,
  afterRevision: number,
  limit: number,
  includeLegacy = false
) {
  // Read counter first: a concurrent newer update will be delivered on this or the next page.
  const counter = await pool.query<{ revision: string }>(
    `SELECT revision::text FROM supplier_state_revisions WHERE organization_id=$1`,
    [organizationId]
  );
  const highWater = Number(counter.rows[0]?.revision ?? 0);
  const result = await pool.query(
    STATE_SELECT +
      ` WHERE l.organization_id=$1 AND l.provider_code=ANY($2::text[]) AND l.state_revision>$3
    ORDER BY l.state_revision LIMIT $4`,
    [organizationId, includeLegacy ? ALL_PROVIDERS : NUMBERED_PROVIDERS, afterRevision, limit + 1]
  );
  const items = result.rows.slice(0, limit);
  const hasMore = result.rows.length > limit;
  return {
    items,
    hasMore,
    nextRevision: hasMore
      ? Number(items.at(-1)?.revision ?? afterRevision)
      : Math.max(highWater, Number(items.at(-1)?.revision ?? afterRevision), afterRevision)
  };
}

export async function supplierStatesForProducts(
  pool: pg.Pool,
  organizationId: string,
  productIds: string[]
) {
  if (!productIds.length) return [];
  return (
    await pool.query(
      STATE_SELECT +
        ` WHERE l.organization_id=$1 AND l.provider_code=ANY($2::text[]) AND l.product_id=ANY($3::uuid[])`,
      [organizationId, ALL_PROVIDERS, productIds]
    )
  ).rows;
}

export async function supplierProviderSummary(pool: pg.Pool, organizationId: string) {
  return (
    await pool.query(
      `SELECT p.provider_code AS "providerCode", p.interval_seconds AS "intervalSeconds", p.capacity,
    p.regular_interval_seconds AS "regularIntervalSeconds",
    p.cycle_seconds / 86400 AS "cycleDays",
    p.cycle_epoch AS "cycleEpoch", p.paused_until AS "pausedUntil", p.pause_reason AS "pauseReason",
    p.manual_pause_mode AS "manualPauseMode",p.manual_pause_until AS "manualPauseUntil",p.manual_pause_at AS "manualPauseAt",
    p.manual_pause_reason AS "manualPauseReason",p.manual_pause_by AS "manualPauseBy",
    (p.manual_pause_mode IS NOT NULL AND (p.manual_pause_until IS NULL OR p.manual_pause_until>now())) AS "manualPaused",
    p.statistics_started_at AS "statisticsStartedAt",
    (SELECT count(*)::integer FROM supplier_check_leases WHERE expires_at>now()) AS "systemActive",
    (SELECT count(*)::integer FROM supplier_check_leases WHERE provider_code=p.provider_code AND expires_at>now()) AS "running",
    (SELECT max(l.last_checked_at) FROM supplier_product_links l WHERE l.provider_code=p.provider_code AND l.organization_id=$1 AND NOT l.removed) AS "lastCheckedAt",
    (SELECT min(LEAST(l.initial_requested_at,l.manual_requested_at,CASE WHEN l.next_regular_at<l.first_problem_at+interval '24 hours' THEN NULL ELSE COALESCE(l.next_regular_at,l.next_check_at) END,l.confirmation_due_at)) FROM supplier_product_links l JOIN products product ON product.id=l.product_id
      WHERE l.provider_code=p.provider_code AND l.organization_id=$1 AND l.checks_enabled AND NOT l.removed AND product.deleted_at IS NULL) AS "nextCheckAt",
    (SELECT count(*)::integer FROM supplier_product_links l WHERE l.provider_code=p.provider_code AND l.organization_id=$1 AND NOT l.removed AND l.check_status='unverified') AS "unverified",
    (SELECT count(*)::integer FROM supplier_product_links l WHERE l.provider_code=p.provider_code AND l.organization_id=$1 AND NOT l.removed AND (l.last_error IS NOT NULL OR l.negative_count>0 OR l.missing_count>0)) AS "problems",
    (SELECT count(*)::integer FROM supplier_product_links l WHERE l.provider_code=p.provider_code AND l.organization_id=$1 AND NOT l.removed AND (l.negative_count>0 OR l.missing_count BETWEEN 1 AND 2)) AS "confirmations",
    (SELECT count(*)::integer FROM supplier_product_links l WHERE l.provider_code=p.provider_code AND l.organization_id=$1 AND NOT l.removed AND l.initial_requested_at IS NOT NULL) AS "initialPending",
    p.health_checked_at AS "healthCheckedAt", p.health_ok AS "healthOk", p.probe_requested_at AS "probeRequestedAt",
    CASE WHEN p.cycle_epoch>now() THEN p.cycle_epoch ELSE p.cycle_epoch + (floor(extract(epoch FROM now()-p.cycle_epoch)/p.cycle_seconds)::integer+1)*make_interval(secs => p.cycle_seconds) END AS "nextCycleAt",
    (SELECT count(*)::integer FROM supplier_product_links l WHERE l.provider_code=p.provider_code AND l.queue_position IS NOT NULL) AS occupied,
    (SELECT count(*)::integer FROM supplier_product_links l WHERE l.provider_code=p.provider_code AND l.organization_id=$1 AND l.checks_enabled AND NOT l.removed AND EXISTS(SELECT 1 FROM products product WHERE product.id=l.product_id AND product.deleted_at IS NULL)) AS "ownActive",
    (SELECT count(*)::integer FROM supplier_product_links l WHERE l.provider_code=p.provider_code AND l.organization_id=$1 AND NOT l.checks_enabled AND NOT l.removed) AS "ownDisabled",
    samples.total AS "sampleCount", samples.bad AS "badCount"
    FROM supplier_provider_checks p LEFT JOIN LATERAL (
      SELECT count(*)::integer AS total, count(*) FILTER (WHERE recent.window_bad)::integer AS bad FROM (
        SELECT DISTINCT ON (url) window_bad FROM supplier_product_links
        WHERE provider_code=p.provider_code AND NOT removed AND window_observed_at>now()-interval '2 hours'
        ORDER BY url,window_observed_at DESC
      ) recent
    ) samples ON true WHERE p.provider_code=ANY($2::text[]) ORDER BY p.phase_seconds NULLS LAST,p.provider_code`,
      [organizationId, ALL_PROVIDERS]
    )
  ).rows;
}

export async function requestSupplierProbe(pool: pg.Pool, provider: string) {
  if (!ALL_PROVIDERS.includes(provider as (typeof ALL_PROVIDERS)[number]))
    throw new ValidationFailedError('Nepoznat dobavljač');
  await supplierTransaction(pool, async (client) => {
    await client.query(
      `UPDATE supplier_provider_checks SET probe_requested_at=COALESCE(probe_requested_at,now()) WHERE provider_code=$1`,
      [provider]
    );
  });
}

async function deferExpiredConfirmations(
  client: QueryClient,
  provider: string | null = null
): Promise<void> {
  await client.query(
    `UPDATE supplier_product_links l SET confirmation_due_at=NULL,
    next_regular_at=GREATEST(l.next_regular_at,p.cycle_epoch
      +(floor(extract(epoch FROM l.confirmation_due_at-p.cycle_epoch)/864000)::integer+1)*interval '240 hours'
      +make_interval(secs => p.phase_seconds+(l.queue_position-1)*p.interval_seconds))
    FROM supplier_provider_checks p WHERE l.provider_code=p.provider_code
      AND l.provider_code=ANY($1::text[]) AND ($2::text IS NULL OR l.provider_code=$2)
      AND l.confirmation_due_at<=now() AND (p.paused_until IS NOT NULL OR p.manual_pause_mode IS NOT NULL OR p.dispatcher_seen_at IS NULL
        OR (p.dispatcher_seen_at<now()-interval '2 seconds' AND l.confirmation_due_at>=p.dispatcher_seen_at))`,
    [NUMBERED_PROVIDERS, provider]
  );
}

async function pauseProvider(client: QueryClient, provider: string, reason: string) {
  await client.query(
    `UPDATE supplier_provider_checks SET paused_until=now()+CASE WHEN interval_seconds IS NULL THEN interval '12 hours' ELSE interval '24 hours' END, pause_reason=$2,
    health_ok=false, health_checked_at=now(), probe_requested_at=NULL, updated_at=now() WHERE provider_code=$1`,
    [provider, reason]
  );
  await deferExpiredConfirmations(client, provider);
}

async function healthProbe(
  database: Database,
  adapters: Adapters,
  provider: string,
  signal: AbortSignal,
  excludeId?: string
): Promise<boolean> {
  if (!(await adapters.home(provider, signal))) return false;
  const controls = await database.pool.query<{ url: string }>(
    `SELECT DISTINCT url FROM supplier_product_links
    WHERE provider_code=$1 AND NOT removed AND url IS NOT NULL AND last_good_result IS NOT NULL
      AND ($2::uuid IS NULL OR id<>$2) AND (disabled_reason IS NULL OR check_status<>'missing') LIMIT 2`,
    [provider, excludeId ?? null]
  );
  for (const control of controls.rows) {
    if ((await adapters.page(provider, control.url, signal)).status !== 'available') return false;
  }
  return true;
}

async function finishLink(
  database: Database,
  adapters: Adapters,
  lease: Lease,
  link: QueueLink,
  outcome: SupplierOutcome,
  signal: AbortSignal,
  duration: number
) {
  const started = Date.now() - duration;
  let probed = false;
  const bad = outcome.status !== 'available' || outcome.stockStatus === 'out_of_stock';
  const reason =
    outcome.status === 'missing'
      ? 'Stranica proizvoda ne postoji'
      : outcome.status === 'error'
        ? outcome.message || 'Pristup sajtu ili čitanje proizvoda nije uspelo'
        : 'Artikal nije na stanju kod dobavljača';
  let health: boolean | null = null;
  if (bad && link.negative_count > 0 && link.first_problem_at) {
    const cached = await database.pool.query<{
      health_ok: boolean;
      health_checked_at: Date | null;
      paused_until: Date | null;
      manual_pause_mode: string | null;
      database_now: Date;
    }>(
      `SELECT health_ok,health_checked_at,paused_until,manual_pause_mode,now() AS database_now FROM supplier_provider_checks WHERE provider_code=$1`,
      [link.provider_code]
    );
    const p = cached.rows[0];
    if (
      p &&
      !p.paused_until &&
      !p.manual_pause_mode &&
      p.database_now.getTime() - new Date(link.first_problem_at).getTime() >= 86_400_000
    ) {
      try {
        health =
          p?.health_checked_at && p.database_now.getTime() - p.health_checked_at.getTime() < 300_000
            ? p.health_ok
            : await (async () => {
                probed = true;
                return healthProbe(database, adapters, link.provider_code, signal, link.id);
              })();
      } catch {
        health = false;
      }
    }
  }
  await supplierTransaction(database.pool, async (client) => {
    const current = await client.query<QueueLink & { second_due: boolean }>(
      `SELECT *,first_problem_at<=now()-interval '24 hours' AS second_due FROM supplier_product_links WHERE id=$1 AND generation=$2 AND NOT removed AND EXISTS (SELECT 1 FROM supplier_check_leases WHERE token=$3 AND expires_at>now()) FOR UPDATE`,
      [link.id, lease.generation, lease.token]
    );
    const row = current.rows[0];
    if (!row) return;
    await client.query(`DELETE FROM supplier_check_leases WHERE token=$1`, [lease.token]);
    await recordSupplierStatistics(client, row.organization_id, row.provider_code, {
      outcome:
        outcome.status === 'available'
          ? outcome.stockStatus === 'out_of_stock'
            ? 'out_of_stock'
            : 'available'
          : outcome.status,
      duration: Date.now() - started
    });
    if (probed)
      await recordSupplierStatistics(client, 'site', row.provider_code, {
        outcome: health ? 'available' : 'error',
        duration: Date.now() - started - duration
      });
    await client.query(
      `UPDATE supplier_product_links SET window_observed_at=now(), window_bad=$2 WHERE id=$1`,
      [row.id, bad]
    );
    const samples = await client.query<{ total: number; bad: number }>(
      `SELECT count(*)::integer AS total,count(*) FILTER (WHERE window_bad)::integer AS bad FROM (
      SELECT DISTINCT ON (url) window_bad FROM supplier_product_links WHERE provider_code=$1 AND NOT removed
        AND window_observed_at>now()-interval '2 hours' ORDER BY url,window_observed_at DESC) recent`,
      [row.provider_code]
    );
    const provider = await client.query<{
      paused_until: Date | null;
      manual_pause_mode: string | null;
    }>(
      `SELECT paused_until,manual_pause_mode FROM supplier_provider_checks WHERE provider_code=$1`,
      [row.provider_code]
    );
    let paused = provider.rows[0]?.paused_until != null;
    const manuallyPaused = provider.rows[0]?.manual_pause_mode != null;
    const sample = samples.rows[0];
    if (!paused && sample && sample.total >= 6 && sample.bad * 2 >= sample.total) {
      await pauseProvider(
        client,
        row.provider_code,
        'Najmanje 50% od najmanje 6 proverenih linkova ima problem u poslednja 2 sata'
      );
      paused = true;
    }
    if (!bad && outcome.status === 'available') {
      await client.query(
        `UPDATE supplier_product_links SET check_status='available',stock_status=$2,price_amount=$3,price_currency=$4,
        negative_count=0,missing_count=0,first_problem_at=NULL,first_problem_reason=NULL,confirmation_due_at=NULL,
        last_error=NULL,last_checked_at=now(),last_seen_at=now(),last_good_result=$5::jsonb WHERE id=$1`,
        [
          row.id,
          outcome.stockStatus,
          outcome.priceAmount ?? null,
          outcome.priceCurrency ?? null,
          JSON.stringify({
            stockStatus: outcome.stockStatus,
            priceAmount: outcome.priceAmount ?? null,
            priceCurrency: outcome.priceCurrency ?? null,
            checkedAt: new Date().toISOString()
          })
        ]
      );
      return;
    }
    const second = row.negative_count > 0 && row.second_due;
    if (second && !paused && !manuallyPaused && health === false) {
      await pauseProvider(client, row.provider_code, 'Zdravstvena proba sajta nije uspela');
      paused = true;
    }
    if (second && !paused && !manuallyPaused && health === true && row.checks_enabled) {
      await recordSupplierStatistics(client, row.organization_id, row.provider_code, {
        disabled: 1
      });
      await client.query(
        `UPDATE supplier_product_links SET checks_enabled=false,negative_count=2,disabled_at=now(),disabled_reason=$2,
        check_status=$3,stock_status=$4,last_error=$5,last_checked_at=now() WHERE id=$1`,
        [
          row.id,
          reason,
          outcome.status === 'missing'
            ? 'missing'
            : outcome.status === 'available'
              ? 'available'
              : 'unverified',
          outcome.status === 'error' ? null : 'out_of_stock',
          outcome.status === 'error' ? reason : null
        ]
      );
    } else {
      await client.query(
        `UPDATE supplier_product_links SET negative_count=1,first_problem_at=COALESCE(first_problem_at,now()),
        first_problem_reason=COALESCE(first_problem_reason,$2),last_error=$2,last_checked_at=now(),
        check_status=$3,stock_status=$4,
        confirmation_due_at=CASE WHEN negative_count=0 AND checks_enabled THEN now()+interval '24 hours' ELSE confirmation_due_at END
        WHERE id=$1`,
        [
          row.id,
          reason,
          outcome.status === 'missing'
            ? 'missing'
            : outcome.status === 'available'
              ? 'available'
              : 'unverified',
          outcome.status === 'error' ? null : 'out_of_stock'
        ]
      );
    }
    if (health !== null && !paused && !manuallyPaused)
      await client.query(
        `UPDATE supplier_provider_checks SET health_ok=$2,health_checked_at=now() WHERE provider_code=$1`,
        [row.provider_code, health]
      );
  });
}

async function legacyNextSlot(client: QueryClient, link: QueueLink): Promise<Date> {
  const result = await client.query<{ next_check_at: Date | null }>(
    `SELECT supplier_regular_slot(p.cycle_epoch,p.phase_seconds,p.regular_interval_seconds,
      l.queue_position,now()+interval '1 second',p.cycle_seconds) AS next_check_at
    FROM supplier_product_links l JOIN supplier_provider_checks p ON p.provider_code=l.provider_code
    WHERE l.id=$1`,
    [link.id]
  );
  const next = result.rows[0]?.next_check_at;
  if (!next) throw new Error('Dobavljač nema slobodan redovni termin');
  return next;
}
async function finishLegacy(
  database: Database,
  adapters: Adapters,
  lease: Lease,
  link: QueueLink,
  outcome: SupplierOutcome,
  signal: AbortSignal,
  duration: number
) {
  const healthStarted = Date.now();
  let healthy = true;
  const prior = (
    await database.pool.query(
      'SELECT consecutive_errors,manual_pause_mode FROM supplier_provider_checks WHERE provider_code=$1',
      [link.provider_code]
    )
  ).rows[0];
  const probeNeeded =
    outcome.status === 'missing' || (outcome.status === 'error' && prior.consecutive_errors >= 2);
  if (probeNeeded && prior.manual_pause_mode !== 'all') {
    try {
      healthy = await adapters.home(link.provider_code, signal);
    } catch {
      healthy = false;
    }
  }
  const snapshot = await supplierTransaction(database.pool, async (client) => {
    const found = await client.query<QueueLink>(
      `SELECT l.* FROM supplier_product_links l WHERE l.id=$1 AND l.generation=$2 AND l.checks_enabled
      AND NOT l.removed AND EXISTS(SELECT 1 FROM supplier_check_leases WHERE token=$3 AND expires_at>now()) FOR UPDATE`,
      [link.id, link.generation, lease.token]
    );
    const row = found.rows[0];
    if (!row) return null;
    await client.query('DELETE FROM supplier_check_leases WHERE token=$1', [lease.token]);
    await recordSupplierStatistics(client, row.organization_id, row.provider_code, {
      outcome:
        outcome.status === 'available'
          ? outcome.stockStatus === 'out_of_stock'
            ? 'out_of_stock'
            : 'available'
          : outcome.status,
      duration
    });
    const provider = (
      await client.query(`SELECT * FROM supplier_provider_checks WHERE provider_code=$1`, [
        row.provider_code
      ])
    ).rows[0];
    const paused =
      provider.manual_pause_mode != null ||
      (provider.paused_until && new Date(provider.paused_until).getTime() > Date.now());
    await client.query(
      'UPDATE supplier_product_links SET window_observed_at=now(),window_bad=$2 WHERE id=$1',
      [row.id, outcome.status !== 'available' || outcome.stockStatus === 'out_of_stock']
    );
    if (probeNeeded && prior.manual_pause_mode !== 'all')
      await recordSupplierStatistics(client, 'site', row.provider_code, {
        outcome: healthy ? 'available' : 'error',
        duration: Date.now() - healthStarted
      });
    let next = row.next_check_at;
    // A manual-only check preserves the regular schedule; a coincident regular check is merged into it.
    const regular = link.legacy_due || lease.kind === 'initial';
    if (outcome.status === 'available') {
      if (regular) next = await legacyNextSlot(client, row);
      await client.query(
        `UPDATE supplier_product_links SET check_status='available',stock_status=$2,price_amount=$3,price_currency=$4,
        missing_count=0,last_checked_at=now(),last_seen_at=now(),last_error=NULL,next_check_at=$5,confirmation_due_at=NULL,
        first_problem_at=NULL,first_problem_reason=NULL,last_good_result=$6::jsonb WHERE id=$1`,
        [
          row.id,
          outcome.stockStatus,
          outcome.priceAmount ?? null,
          outcome.priceCurrency ?? null,
          next,
          JSON.stringify({ checkedAt: new Date().toISOString(), stockStatus: outcome.stockStatus })
        ]
      );
      await client.query(
        `UPDATE supplier_provider_checks SET consecutive_errors=0 WHERE provider_code=$1`,
        [row.provider_code]
      );
    } else {
      const reason =
        outcome.status === 'missing'
          ? 'Stranica proizvoda ne postoji'
          : 'Pristup sajtu ili čitanje proizvoda nije uspelo';
      const eligible =
        !row.last_checked_at || Date.now() - new Date(row.last_checked_at).getTime() >= 86400000;
      const count =
        outcome.status === 'missing' && healthy && eligible
          ? Math.min(row.missing_count + 1, paused ? 2 : 3)
          : row.missing_count;
      const final = count >= 3 && !paused && healthy;
      if (regular) next = final ? await legacyNextSlot(client, row) : new Date(Date.now() + 86400000);
      await client.query(
        `UPDATE supplier_product_links SET missing_count=$2,check_status=CASE WHEN $3 THEN 'missing' ELSE check_status END,
        stock_status=CASE WHEN $3 THEN NULL ELSE stock_status END,last_checked_at=now(),last_error=$4,next_check_at=$5,
        confirmation_due_at=CASE WHEN $3 THEN NULL ELSE now()+interval '24 hours' END,
        first_problem_at=COALESCE(first_problem_at,now()),first_problem_reason=COALESCE(first_problem_reason,$4) WHERE id=$1`,
        [row.id, count, final, reason, next]
      );
      if (outcome.status === 'error')
        await client.query(
          'UPDATE supplier_provider_checks SET consecutive_errors=consecutive_errors+1 WHERE provider_code=$1',
          [row.provider_code]
        );
      if (!healthy)
        await client.query(
          `UPDATE supplier_provider_checks SET paused_until=now()+interval '12 hours',pause_reason='Sajt dobavljača nije dostupan',health_ok=false,health_checked_at=now() WHERE provider_code=$1`,
          [row.provider_code]
        );
    }
    return (await client.query(STATE_SELECT + ' WHERE l.id=$1', [row.id])).rows[0];
  });
  // Legacy clients retain their existing event protocol; numbered providers use current revisions only.
  if (snapshot) {
    const requestId = randomUUID();
    await new SyncRepository(database.pool).appendServerEvent(
      {
        organizationId: link.organization_id,
        requestId,
        correlationId: requestId,
        userId: undefined as unknown as string
      },
      {
        aggregateType: 'supplier_product_link',
        aggregateId: link.id,
        operation: 'update',
        payload: {
          operationalSnapshot: {
            kind: 'supplier.link',
            productId: link.product_id,
            providerCode: link.provider_code,
            url: snapshot.url,
            status: snapshot.status,
            stockStatus: snapshot.stockStatus,
            priceAmount: snapshot.priceAmount,
            priceCurrency: snapshot.priceCurrency,
            checkedAt: snapshot.lastCheckedAt
          }
        },
        payloadVersion: 1
      }
    );
  }
}
export async function rollMissedSlots(
  client: QueryClient,
  providers: readonly string[] = ALL_PROVIDERS
) {
  const missed = await client.query<{
    organization_id: string;
    provider_code: string;
    skipped: number;
  }>(
    `WITH due AS MATERIALIZED (
    SELECT l.id,l.organization_id,l.provider_code,(floor(extract(epoch FROM now()-l.next_regular_at)/864000)::integer+1) AS skipped
    FROM supplier_product_links l JOIN supplier_provider_checks p ON p.provider_code=l.provider_code
    WHERE l.provider_code=ANY($1::text[]) AND l.next_regular_at IS NOT NULL AND (l.next_regular_at<=now()-interval '60 seconds'
      OR (p.manual_pause_mode IS NOT NULL AND l.next_regular_at<=LEAST(now(),COALESCE(p.manual_pause_until,now())))
      OR (p.paused_until IS NOT NULL AND l.next_regular_at<=now())))
    ,updated AS (UPDATE supplier_product_links l SET next_regular_at=l.next_regular_at+due.skipped*interval '240 hours'
    FROM due WHERE l.id=due.id RETURNING due.organization_id,due.provider_code,due.skipped)
    SELECT organization_id,provider_code,sum(skipped)::integer AS skipped FROM updated GROUP BY organization_id,provider_code`,
    [providers]
  );
  for (const row of missed.rows)
    await recordSupplierStatistics(client, row.organization_id, row.provider_code, {
      skipped: row.skipped
    });
  const legacy = await client.query<{
    organization_id: string;
    provider_code: string;
    skipped: number;
  }>(
    `WITH due AS MATERIALIZED (
    SELECT l.id,l.organization_id,l.provider_code,p.cycle_seconds,(floor(extract(epoch FROM now()-l.next_check_at)/p.cycle_seconds)::integer+1) AS skipped
    FROM supplier_product_links l JOIN supplier_provider_checks p ON p.provider_code=l.provider_code
    WHERE l.provider_code=ANY($1::text[]) AND l.provider_code IN ('linkel','milano') AND l.checks_enabled AND NOT l.removed AND l.initial_requested_at IS NULL
      AND l.last_error IS NULL AND l.missing_count=0 AND p.manual_pause_mode IS NOT NULL
      AND l.next_check_at<=LEAST(now(),COALESCE(p.manual_pause_until,now())))
    ,updated AS (UPDATE supplier_product_links l SET next_check_at=l.next_check_at+due.skipped*make_interval(secs => due.cycle_seconds)
    FROM due WHERE l.id=due.id RETURNING due.organization_id,due.provider_code,due.skipped)
    SELECT organization_id,provider_code,sum(skipped)::integer AS skipped FROM updated GROUP BY organization_id,provider_code`,
    [providers]
  );
  for (const row of legacy.rows)
    await recordSupplierStatistics(client, row.organization_id, row.provider_code, {
      skipped: row.skipped
    });
}
export function startNumberedSupplierChecks(
  database: Database,
  logger: Logger,
  adapters: Adapters
): () => void {
  let dispatching = false;
  let closed = false;
  let initialized = false;
  let lastMaintenance = 0;
  const perform = async (lease: Lease, link?: QueueLink) => {
    const started = Date.now();
    const signal = AbortSignal.timeout(60_000);
    try {
      if (link) {
        let outcome: SupplierOutcome;
        try {
          outcome = await adapters.page(link.provider_code, link.url, signal);
        } catch {
          outcome = {
            status: 'error',
            message: 'Provera je prekinuta ili je istekao rok od 60 sekundi'
          };
        }
        if (NUMBERED_PROVIDERS.includes(link.provider_code as NumberedProvider))
          await finishLink(database, adapters, lease, link, outcome, signal, Date.now() - started);
        else
          await finishLegacy(
            database,
            adapters,
            lease,
            link,
            outcome,
            signal,
            Date.now() - started
          );
      } else {
        let healthy = false;
        try {
          healthy = await healthProbe(database, adapters, lease.provider_code, signal);
        } catch {
          /* treat as unhealthy */
        }
        await supplierTransaction(database.pool, async (client) => {
          const current = await client.query(
            'SELECT token FROM supplier_check_leases WHERE token=$1 AND expires_at>now()',
            [lease.token]
          );
          if (!current.rowCount) return;
          await client.query('DELETE FROM supplier_check_leases WHERE token=$1', [lease.token]);
          await recordSupplierStatistics(client, 'site', lease.provider_code, {
            outcome: healthy ? 'available' : 'error',
            duration: Date.now() - started
          });
          if (healthy)
            await client.query(
              `UPDATE supplier_provider_checks SET paused_until=NULL,pause_reason=NULL,
            health_ok=true,health_checked_at=now(),probe_requested_at=NULL,updated_at=now() WHERE provider_code=$1`,
              [lease.provider_code]
            );
          else
            await pauseProvider(client, lease.provider_code, 'Zdravstvena proba sajta nije uspela');
        });
      }
    } catch (error) {
      logger.error({ err: error, provider: lease.provider_code }, 'Numbered supplier check failed');
    } finally {
      await supplierTransaction(database.pool, async (client) => {
        const released = await client.query<Lease>(
          `DELETE FROM supplier_check_leases WHERE token=$1 RETURNING *`,
          [lease.token]
        );
        if (released.rowCount && lease.link_id)
          await client.query(
            `UPDATE supplier_product_links SET updated_at=now()
          WHERE id=$1 AND generation=$2 AND NOT removed AND checks_enabled`,
            [lease.link_id, lease.generation]
          );
      }).catch((error) => logger.error({ err: error }, 'Supplier lease release failed'));
    }
  };
  const dispatch = async () => {
    if (closed || dispatching) return;
    dispatching = true;
    try {
      const claimed = await supplierTransaction(database.pool, async (client) => {
        if (!initialized) {
          await client.query(
            `UPDATE supplier_provider_checks SET cycle_epoch=to_timestamp((floor(extract(epoch FROM now())/360)+1)*360)
            WHERE provider_code=ANY($1::text[]) AND cycle_epoch IS NULL`,
            [NUMBERED_PROVIDERS]
          );
          await client.query(
            `UPDATE supplier_product_links l SET next_regular_at=supplier_regular_slot(p.cycle_epoch,p.phase_seconds,p.interval_seconds,l.queue_position,p.cycle_epoch)
            FROM supplier_provider_checks p WHERE l.provider_code=p.provider_code AND l.provider_code=ANY($1::text[])
              AND l.checks_enabled AND NOT l.removed AND l.next_regular_at IS NULL`,
            [NUMBERED_PROVIDERS]
          );
        }
        await expireSupplierLeases(client);
        await rollMissedSlots(client);
        await deferExpiredConfirmations(client);
        await client.query(`UPDATE supplier_provider_checks SET manual_pause_mode=NULL,manual_pause_until=NULL,manual_pause_reason=NULL,manual_pause_by=NULL,manual_pause_at=NULL
          WHERE manual_pause_until<=now()`);
        await client.query(
          `UPDATE supplier_provider_checks SET dispatcher_seen_at=now() WHERE provider_code=ANY($1::text[])`,
          [NUMBERED_PROVIDERS]
        );
        if (Date.now() - lastMaintenance > 3_600_000) {
          await client.query(
            `UPDATE supplier_product_links SET window_observed_at=NULL,window_bad=NULL WHERE window_observed_at<now()-interval '2 hours'`
          );
          await client.query(
            `DELETE FROM supplier_hourly_statistics WHERE hour_at<now()-interval '30 days'`
          );
          lastMaintenance = Date.now();
        }
        const used = await client.query<{ count: number }>(
          `SELECT count(*)::integer AS count FROM supplier_check_leases`
        );
        let remaining = 20 - (used.rows[0]?.count ?? 0);
        const tasks: { lease: Lease; link?: QueueLink }[] = [];
        const health = await client.query<{ provider_code: string }>(
          `SELECT provider_code FROM supplier_provider_checks p
          WHERE p.provider_code=ANY($1::text[]) AND (probe_requested_at IS NOT NULL OR (paused_until<=now() AND COALESCE(manual_pause_mode,'')<>'all'))
            AND NOT EXISTS (SELECT 1 FROM supplier_check_leases lease WHERE lease.provider_code=p.provider_code AND lease.kind='health') LIMIT $2`,
          [ALL_PROVIDERS, Math.max(remaining, 0)]
        );
        for (const p of health.rows) {
          const lease = await client.query<Lease>(
            `INSERT INTO supplier_check_leases(provider_code,kind) VALUES ($1,'health') RETURNING *`,
            [p.provider_code]
          );
          tasks.push({ lease: lease.rows[0]! });
          remaining--;
        }
        if (remaining > 0) {
          const links = await client.query<QueueLink>(
            `WITH eligible AS (SELECT l.*,row_number() OVER (PARTITION BY l.provider_code ORDER BY
              CASE WHEN l.initial_requested_at IS NOT NULL THEN 0 WHEN l.manual_requested_at IS NOT NULL THEN 1 WHEN l.confirmation_due_at<=now() THEN 2 ELSE 3 END,
              LEAST(l.initial_requested_at,l.manual_requested_at,l.confirmation_due_at,COALESCE(l.next_regular_at,l.next_check_at)),l.id) AS provider_position,(l.provider_code IN ('linkel','milano') AND l.next_check_at<=now()) AS legacy_due
            FROM supplier_product_links l JOIN products product ON product.id=l.product_id
            JOIN supplier_provider_checks p ON p.provider_code=l.provider_code
            WHERE l.provider_code=ANY($1::text[]) AND l.checks_enabled AND NOT l.removed AND l.url IS NOT NULL AND product.deleted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM supplier_check_leases lease WHERE lease.link_id=l.id)
              AND (l.initial_requested_at IS NOT NULL AND COALESCE(p.manual_pause_mode,'')<>'all'
                OR p.manual_pause_mode IS NULL AND (p.paused_until IS NULL OR (p.interval_seconds IS NULL AND p.paused_until<=now()))
                  AND (l.manual_requested_at IS NOT NULL OR l.confirmation_due_at<=now()
                    OR (l.provider_code=ANY($2::text[]) AND l.next_regular_at<=now() AND (l.first_problem_at IS NULL OR l.first_problem_at<=now()-interval '24 hours'))
                    OR (l.provider_code IN ('linkel','milano') AND l.next_check_at<=now())))
              AND (p.interval_seconds IS NOT NULL OR p.next_request_at<=now())
            ) SELECT l.* FROM eligible l WHERE l.provider_code=ANY($2::text[]) OR l.provider_position=1
            ORDER BY CASE WHEN l.initial_requested_at IS NOT NULL THEN 0 WHEN l.manual_requested_at IS NOT NULL THEN 1 WHEN l.confirmation_due_at<=now() THEN 2 ELSE 3 END,
              LEAST(l.initial_requested_at,l.manual_requested_at,l.confirmation_due_at,COALESCE(l.next_regular_at,l.next_check_at)),l.id LIMIT $3`,
            [ALL_PROVIDERS, NUMBERED_PROVIDERS, remaining]
          );
          const legacyClaimed = new Set<string>();
          for (const link of links.rows) {
            if (!NUMBERED_PROVIDERS.includes(link.provider_code as NumberedProvider)) {
              if (legacyClaimed.has(link.provider_code)) continue;
              legacyClaimed.add(link.provider_code);
              await client.query(
                `UPDATE supplier_provider_checks SET next_request_at=now()+interval '60 seconds' WHERE provider_code=$1`,
                [link.provider_code]
              );
            }
            const kind = link.initial_requested_at
              ? 'initial'
              : link.manual_requested_at
                ? 'manual'
                : link.confirmation_due_at && link.confirmation_due_at <= new Date()
                  ? 'confirmation'
                  : 'regular';
            const lease = await client.query<Lease>(
              `INSERT INTO supplier_check_leases(provider_code,link_id,generation,kind) VALUES ($1,$2,$3,$4) RETURNING *`,
              [link.provider_code, link.id, link.generation, kind]
            );
            await client.query(
              `UPDATE supplier_product_links SET initial_requested_at=NULL,manual_requested_at=NULL,
              next_regular_at=CASE WHEN next_regular_at<=now() THEN next_regular_at+interval '240 hours' ELSE next_regular_at END,
              confirmation_due_at=CASE WHEN confirmation_due_at<=now() THEN NULL ELSE confirmation_due_at END WHERE id=$1`,
              [link.id]
            );
            tasks.push({ lease: lease.rows[0]!, link });
          }
        }
        return tasks;
      });
      initialized = true;
      for (const task of claimed) void perform(task.lease, task.link);
    } catch (error) {
      logger.error({ err: error }, 'Supplier dispatcher failed');
    } finally {
      dispatching = false;
    }
  };
  const timer = setInterval(() => {
    void dispatch();
  }, 1_000);
  void dispatch();
  return () => {
    closed = true;
    clearInterval(timer);
  };
}
