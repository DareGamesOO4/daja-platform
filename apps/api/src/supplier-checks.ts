import { SyncRepository, type Database } from '@daja/database';
import type { Logger } from '@daja/observability';
import { randomUUID } from 'node:crypto';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

type Provider = 'ekka' | 'bultime' | 'linkel';
type Link = { id: string; url: string; provider_code: Provider; organization_id: string; product_id: string; missing_count: number };
type Outcome = { status: 'available'; stockStatus: 'in_stock' | 'out_of_stock' | null; priceAmount?: number | null; priceCurrency?: string | null } | { status: 'missing' | 'error' };

async function ekkaPage(urlValue: string): Promise<Outcome> {
  let url = new URL(urlValue);
  for (let redirects = 0; redirects < 4; redirects += 1) {
    if (url.protocol !== 'https:' || !['ekka.rs', 'www.ekka.rs'].includes(url.hostname.toLowerCase()) || url.port || url.username || url.password) return { status: 'error' };
    let response: Response;
    try {
      response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'DajaShop supplier availability check (+https://dajashop.rs)' } });
    } catch { return { status: 'error' }; }
    if (response.status === 404 || response.status === 410) return { status: 'missing' };
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return { status: 'error' };
      url = new URL(location, url);
      if (url.pathname === '/' || url.pathname === '/index.php') return { status: 'missing' };
      continue;
    }
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('text/html')) return { status: 'error' };
    const body = (await response.text()).slice(0, 500_000);
    if (!/<h1\b[^>]*>[^<]+<\/h1>/i.test(body) || !/Referenca/i.test(body) || !/Stanje proizvoda/i.test(body)) return { status: 'error' };
    const price = body.match(/<meta\s+property=["']product:price:amount["']\s+content=["']([^"']+)["']/i)?.[1];
    const currency = body.match(/<meta\s+property=["']product:price:currency["']\s+content=["']([^"']+)["']/i)?.[1]?.toUpperCase() || null;
    return { status: 'available', stockStatus: null, priceAmount: price && Number.isFinite(Number(price)) ? Number(price) : null, priceCurrency: currency };
  }
  return { status: 'error' };
}

async function ekkaHomeHealthy(): Promise<boolean> {
  try {
    const response = await fetch('https://ekka.rs/', { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'DajaShop supplier availability check (+https://dajashop.rs)' } });
    return response.ok && (await response.text()).includes('Kategorije');
  } catch { return false; }
}

async function bultimePage(urlValue: string): Promise<Outcome> {
  const productId = new URL(urlValue).searchParams.get('product_id');
  let url = new URL(urlValue);
  for (let redirects = 0; redirects < 4; redirects += 1) {
    if (url.protocol !== 'https:' || !['bultime.bg', 'www.bultime.bg'].includes(url.hostname.toLowerCase()) || url.port || url.username || url.password) return { status: 'error' };
    let response: Response;
    try {
      response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'DajaShop supplier availability check (+https://dajashop.rs)' } });
    } catch { return { status: 'error' }; }
    if (response.status === 404 || response.status === 410) return { status: 'missing' };
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return { status: 'error' };
      url = new URL(location, url);
      if (url.pathname === '/' || url.searchParams.get('route') === 'common/home') return { status: 'missing' };
      if (url.searchParams.get('product_id') !== productId) return { status: 'error' };
      continue;
    }
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('text/html')) return { status: 'error' };
    const body = (await response.text()).slice(0, 1_000_000);
    if (!body.includes('route-product-product') || !body.includes(`product_id=${productId}`) ||
        !/<h1\b[^>]*>\s*(?:<span[^>]*>)?[^<]+(?:<\/span>)?\s*<\/h1>/i.test(body) ||
        !body.includes('product-model')) return { status: 'error' };
    const stock = body.match(/<li\b[^>]*class=["'][^"']*\bproduct-stock\b[^"']*["'][^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>/i)?.[1]?.trim();
    const offerPrice = body.match(/"offers"\s*:\s*\{[\s\S]{0,1200}?"priceCurrency"\s*:\s*"([A-Z]+)"[\s\S]{0,160}?"price"\s*:\s*"?([0-9.]+)/i);
    return { status: 'available', stockStatus: stock === 'В наличност' ? 'in_stock' : stock === 'Няма наличност' ? 'out_of_stock' : null, priceAmount: offerPrice ? Number(offerPrice[2]) : null, priceCurrency: offerPrice?.[1] || null };
  }
  return { status: 'error' };
}

async function linkelPage(urlValue: string): Promise<Outcome> {
  let url = new URL(urlValue);
  for (let redirects = 0; redirects < 4; redirects += 1) {
    if (url.protocol !== 'https:' || !['linkel.rs', 'www.linkel.rs'].includes(url.hostname.toLowerCase()) || url.port || url.username || url.password) return { status: 'error' };
    let response: Response;
    try { response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'DajaShop supplier availability check (+https://dajashop.rs)' } }); }
    catch { return { status: 'error' }; }
    if (response.status === 404 || response.status === 410) return { status: 'missing' };
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return { status: 'error' };
      url = new URL(location, url);
      if (url.pathname === '/' || url.pathname === '/sr/' || url.pathname.includes('controller=404')) return { status: 'missing' };
      continue;
    }
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('text/html')) return { status: 'error' };
    const body = (await response.text()).slice(0, 1_000_000);
    // Linkel's canonical tag and product-id class are not stable across
    // templates. The product body marker is stable, so do not reject a valid
    // product merely because those optional HTML details changed.
    const hasProductBody = /<body\b[^>]*\bid=["']product["']/i.test(body);
    if (!hasProductBody) return { status: 'error' };
    const price = body.match(/<meta\s+property=["']product:price:amount["']\s+content=["']([^"']+)["']/i)?.[1];
    const currency = body.match(/<meta\s+property=["']product:price:currency["']\s+content=["']([^"']+)["']/i)?.[1]?.toUpperCase() || null;
    const visible = body.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
    const stockStatus = /Nije na stanju/i.test(visible) ? 'out_of_stock' : /Na stanju/i.test(visible) ? 'in_stock' : null;
    return { status: 'available', stockStatus, priceAmount: price && Number.isFinite(Number(price)) ? Number(price) : null, priceCurrency: currency };
  }
  return { status: 'error' };
}

async function homeHealthy(provider: Provider): Promise<boolean> {
  if (provider === 'ekka') return ekkaHomeHealthy();
  if (provider === 'linkel') {
    try {
      const response = await fetch('https://www.linkel.rs/sr/', { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'DajaShop supplier availability check (+https://dajashop.rs)' } });
      return response.ok && (await response.text()).includes('LINK Electronics');
    } catch { return false; }
  }
  try {
    const response = await fetch('https://bultime.bg/index.php?route=common/home', { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'DajaShop supplier availability check (+https://dajashop.rs)' } });
    return response.ok && (await response.text()).includes('route-common-home');
  } catch { return false; }
}

export async function previewSupplierLink(provider: Provider, url: string): Promise<Outcome | { status: 'unverified' }> {
  if (provider === 'ekka') return ekkaPage(url);
  if (provider === 'bultime') return bultimePage(url);
  const result = await linkelPage(url);
  // A failed fetch or an unfamiliar supplier response cannot establish that
  // the product URL is invalid. Keep the saved link eligible for later checks.
  return result.status === 'error' ? { status: 'unverified' } : result;
}

export function startSupplierChecks(database: Database, logger: Logger): () => void {
  let active = false;
  let closed = false;
  const run = async () => {
    if (active || closed) return;
    active = true;
    try {
      const due = await database.pool.query<Link>(
        `SELECT link.id, link.url, link.provider_code, link.organization_id, link.product_id, link.missing_count
         FROM supplier_product_links link JOIN products product ON product.id = link.product_id AND product.organization_id = link.organization_id
         WHERE link.provider_code IN ('ekka', 'bultime', 'linkel') AND link.next_check_at <= now() AND product.deleted_at IS NULL
           AND EXISTS (SELECT 1 FROM supplier_provider_checks provider WHERE provider.provider_code = link.provider_code
                       AND provider.next_request_at <= now() AND (provider.paused_until IS NULL OR provider.paused_until <= now()))
         ORDER BY link.next_check_at, link.id LIMIT 1`
      );
      if (!due.rows[0]) return;
      const slot = await database.pool.query(
        `UPDATE supplier_provider_checks SET next_request_at = now() + interval '60 seconds', updated_at = now()
         WHERE provider_code = $1 AND next_request_at <= now() AND (paused_until IS NULL OR paused_until <= now()) RETURNING provider_code`,
        [due.rows[0].provider_code]
      );
      if (!slot.rowCount) return;
      const link = due.rows[0];
      const claim = await database.pool.query<Link>(
        `UPDATE supplier_product_links SET next_check_at = now() + interval '10 minutes', updated_at = now()
         WHERE id = $1 AND url = $2 AND next_check_at <= now()
         RETURNING id, url, provider_code, organization_id, product_id, missing_count`,
        [link.id, link.url]
      );
      if (!claim.rows[0]) return;
      const outcome: Outcome = link.provider_code === 'ekka'
        ? await ekkaPage(link.url)
        : link.provider_code === 'bultime' ? await bultimePage(link.url) : await linkelPage(link.url);
      if (outcome.status === 'available') {
        const saved = await database.pool.query(
          `UPDATE supplier_product_links SET check_status = 'available', stock_status = $3, price_amount = $4, price_currency = $5, missing_count = 0, last_checked_at = now(), last_seen_at = now(), last_error = NULL, next_check_at = now() + interval '7 days', updated_at = now()
           WHERE id = $1 AND url = $2`, [link.id, link.url, outcome.stockStatus, outcome.priceAmount ?? null, outcome.priceCurrency ?? null]
        );
        await database.pool.query(`UPDATE supplier_provider_checks SET consecutive_errors = 0, paused_until = NULL WHERE provider_code = $1`, [link.provider_code]);
        if (saved.rowCount) await publishStatus(database, link, 'available', outcome.stockStatus, outcome.priceAmount, outcome.priceCurrency);
      } else if (outcome.status === 'missing') {
        if (!(await homeHealthy(link.provider_code))) {
          await database.pool.query(`UPDATE supplier_provider_checks SET paused_until = now() + interval '12 hours', consecutive_errors = 0, updated_at = now() WHERE provider_code = $1`, [link.provider_code]);
          await database.pool.query(`UPDATE supplier_product_links SET next_check_at = now() + interval '12 hours', last_error = 'Sajt dobavljača nije dostupan' WHERE id = $1 AND url = $2`, [link.id, link.url]);
          return;
        }
        await database.pool.query(`UPDATE supplier_provider_checks SET consecutive_errors = 0 WHERE provider_code = $1`, [link.provider_code]);
        const count = Math.min(link.missing_count + 1, 3);
        const saved = await database.pool.query(
          `UPDATE supplier_product_links SET missing_count = $3, check_status = CASE WHEN $3 >= 3 THEN 'missing' ELSE check_status END,
             stock_status = CASE WHEN $3 >= 3 THEN NULL ELSE stock_status END,
             price_amount = CASE WHEN $3 >= 3 THEN NULL ELSE price_amount END,
             price_currency = CASE WHEN $3 >= 3 THEN NULL ELSE price_currency END,
             last_checked_at = now(), last_error = NULL, next_check_at = now() + ($4::bigint * interval '1 millisecond'), updated_at = now()
           WHERE id = $1 AND url = $2`, [link.id, link.url, count, count >= 3 ? WEEK_MS : DAY_MS]
        );
        if (saved.rowCount) await publishStatus(database, link, count >= 3 ? 'missing' : 'checking');
      } else {
        await database.pool.query(
          `UPDATE supplier_product_links SET last_error = $3, next_check_at = now() + interval '24 hours', updated_at = now()
           WHERE id = $1 AND url = $2`, [link.id, link.url, `${link.provider_code === 'ekka' ? 'Ekka' : 'Bultime'} provera nije uspela`]
        );
        const failures = await database.pool.query<{ consecutive_errors: number }>(
          `UPDATE supplier_provider_checks SET consecutive_errors = consecutive_errors + 1 WHERE provider_code = $1 RETURNING consecutive_errors`,
          [link.provider_code]
        );
        if ((failures.rows[0]?.consecutive_errors ?? 0) >= 3 && !(await homeHealthy(link.provider_code))) {
          await database.pool.query(`UPDATE supplier_provider_checks SET paused_until = now() + interval '12 hours', consecutive_errors = 0, updated_at = now() WHERE provider_code = $1`, [link.provider_code]);
          logger.warn({ provider: link.provider_code }, 'Supplier is unavailable; checks paused for 12 hours');
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

async function publishStatus(database: Database, link: Link, status: string, stockStatus: string | null = null, priceAmount?: number | null, priceCurrency?: string | null): Promise<void> {
  const requestId = randomUUID();
  await new SyncRepository(database.pool).appendServerEvent(
    { organizationId: link.organization_id, requestId, correlationId: requestId, userId: undefined as unknown as string },
    {
      aggregateType: 'supplier_product_link', aggregateId: link.id, operation: 'update',
      payload: { operationalSnapshot: { kind: 'supplier.link', productId: link.product_id, providerCode: link.provider_code, url: link.url, status, stockStatus, priceAmount: priceAmount ?? null, priceCurrency: priceCurrency ?? null, checkedAt: new Date().toISOString() } },
      payloadVersion: 1
    }
  );
}
