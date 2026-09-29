import { SyncRepository, type Database } from '@daja/database';
import type { Logger } from '@daja/observability';
import { randomUUID } from 'node:crypto';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

type Link = { id: string; url: string; organization_id: string; product_id: string; missing_count: number };

async function ekkaPage(urlValue: string): Promise<'available' | 'missing' | 'error'> {
  let url = new URL(urlValue);
  for (let redirects = 0; redirects < 4; redirects += 1) {
    if (url.protocol !== 'https:' || !['ekka.rs', 'www.ekka.rs'].includes(url.hostname.toLowerCase()) || url.port || url.username || url.password) return 'error';
    let response: Response;
    try {
      response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'DajaShop supplier availability check (+https://dajashop.rs)' } });
    } catch { return 'error'; }
    if (response.status === 404 || response.status === 410) return 'missing';
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return 'error';
      url = new URL(location, url);
      if (url.pathname === '/' || url.pathname === '/index.php') return 'missing';
      continue;
    }
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('text/html')) return 'error';
    const body = (await response.text()).slice(0, 500_000);
    return /<h1\b[^>]*>[^<]+<\/h1>/i.test(body) && /Referenca/i.test(body) && /Stanje proizvoda/i.test(body)
      ? 'available' : 'error';
  }
  return 'error';
}

async function ekkaHomeHealthy(): Promise<boolean> {
  try {
    const response = await fetch('https://ekka.rs/', { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'DajaShop supplier availability check (+https://dajashop.rs)' } });
    return response.ok && (await response.text()).includes('Kategorije');
  } catch { return false; }
}

export function startSupplierChecks(database: Database, logger: Logger): () => void {
  let active = false;
  let closed = false;
  const run = async () => {
    if (active || closed) return;
    active = true;
    try {
      const due = await database.pool.query<Link>(
        `SELECT link.id, link.url, link.organization_id, link.product_id, link.missing_count
         FROM supplier_product_links link JOIN products product ON product.id = link.product_id AND product.organization_id = link.organization_id
         WHERE link.provider_code = 'ekka' AND link.next_check_at <= now() AND product.deleted_at IS NULL
         ORDER BY link.next_check_at, link.id LIMIT 1`
      );
      if (!due.rows[0]) return;
      const slot = await database.pool.query(
        `UPDATE supplier_provider_checks SET next_request_at = now() + interval '60 seconds', updated_at = now()
         WHERE provider_code = 'ekka' AND next_request_at <= now() AND (paused_until IS NULL OR paused_until <= now()) RETURNING provider_code`
      );
      if (!slot.rowCount) return;
      const link = due.rows[0];
      const claim = await database.pool.query<Link>(
        `UPDATE supplier_product_links SET next_check_at = now() + interval '10 minutes', updated_at = now()
         WHERE id = $1 AND url = $2 AND next_check_at <= now()
         RETURNING id, url, organization_id, product_id, missing_count`,
        [link.id, link.url]
      );
      if (!claim.rows[0]) return;
      const outcome = await ekkaPage(link.url);
      if (outcome === 'available') {
        const saved = await database.pool.query(
          `UPDATE supplier_product_links SET check_status = 'available', missing_count = 0, last_checked_at = now(), last_seen_at = now(), last_error = NULL, next_check_at = now() + interval '7 days', updated_at = now()
           WHERE id = $1 AND url = $2`, [link.id, link.url]
        );
        await database.pool.query(`UPDATE supplier_provider_checks SET consecutive_errors = 0, paused_until = NULL WHERE provider_code = 'ekka'`);
        if (saved.rowCount) await publishStatus(database, link, 'available');
      } else if (outcome === 'missing') {
        if (!(await ekkaHomeHealthy())) {
          await database.pool.query(`UPDATE supplier_provider_checks SET paused_until = now() + interval '12 hours', consecutive_errors = 0, updated_at = now() WHERE provider_code = 'ekka'`);
          await database.pool.query(`UPDATE supplier_product_links SET next_check_at = now() + interval '12 hours', last_error = 'Ekka sajt nije dostupan' WHERE id = $1 AND url = $2`, [link.id, link.url]);
          return;
        }
        await database.pool.query(`UPDATE supplier_provider_checks SET consecutive_errors = 0 WHERE provider_code = 'ekka'`);
        const count = Math.min(link.missing_count + 1, 3);
        const saved = await database.pool.query(
          `UPDATE supplier_product_links SET missing_count = $3, check_status = CASE WHEN $3 >= 3 THEN 'missing' ELSE check_status END,
             last_checked_at = now(), last_error = NULL, next_check_at = now() + ($4::bigint * interval '1 millisecond'), updated_at = now()
           WHERE id = $1 AND url = $2`, [link.id, link.url, count, count >= 3 ? WEEK_MS : DAY_MS]
        );
        if (saved.rowCount) await publishStatus(database, link, count >= 3 ? 'missing' : 'checking');
      } else {
        await database.pool.query(
          `UPDATE supplier_product_links SET last_error = 'Ekka provera nije uspela', next_check_at = now() + interval '24 hours', updated_at = now()
           WHERE id = $1 AND url = $2`, [link.id, link.url]
        );
        const failures = await database.pool.query<{ consecutive_errors: number }>(
          `UPDATE supplier_provider_checks SET consecutive_errors = consecutive_errors + 1 WHERE provider_code = 'ekka' RETURNING consecutive_errors`
        );
        if ((failures.rows[0]?.consecutive_errors ?? 0) >= 3 && !(await ekkaHomeHealthy())) {
          await database.pool.query(`UPDATE supplier_provider_checks SET paused_until = now() + interval '12 hours', consecutive_errors = 0, updated_at = now() WHERE provider_code = 'ekka'`);
          logger.warn('Ekka is unavailable; supplier checks paused for 12 hours');
        }
      }
    } catch (error) {
      logger.error({ err: error }, 'Supplier check failed');
    } finally { active = false; }
  };
  const timer = setInterval(() => { void run(); }, 30_000);
  void run();
  return () => { closed = true; clearInterval(timer); };
}

async function publishStatus(database: Database, link: Link, status: string): Promise<void> {
  const requestId = randomUUID();
  await new SyncRepository(database.pool).appendServerEvent(
    { organizationId: link.organization_id, requestId, correlationId: requestId, userId: undefined as unknown as string },
    {
      aggregateType: 'supplier_product_link', aggregateId: link.id, operation: 'update',
      payload: { operationalSnapshot: { kind: 'supplier.link', productId: link.product_id, url: link.url, status, checkedAt: new Date().toISOString() } },
      payloadVersion: 1
    }
  );
}
