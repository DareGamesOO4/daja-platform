import { SyncRepository, type Database } from '@daja/database';
import type { Logger } from '@daja/observability';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { acquireSupplierLease, startNumberedSupplierChecks } from './supplier-queue.js';

const supplierDeadline = new AsyncLocalStorage<AbortSignal>();
function supplierSignal(): AbortSignal {
  const deadline=supplierDeadline.getStore();
  return deadline ? AbortSignal.any([deadline,AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
}


const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

type Provider = 'ekka' | 'bultime' | 'linkel' | 'milano' | 'timezone' | 'qandq';
type Link = { id: string; url: string; provider_code: Provider; organization_id: string; product_id: string; missing_count: number; last_checked_at: Date | null; next_check_at: Date };
type Outcome = { status: 'available'; stockStatus: 'in_stock' | 'out_of_stock' | null; priceAmount?: number | null; priceCurrency?: string | null } | { status: 'missing' | 'error'; message?: string };

function explicitStock(markup: string): 'in_stock' | 'out_of_stock' | null {
  const metadata=markup.match(/(?:itemprop=["']availability["'][^>]*(?:href|content)=["'][^"']*schema\.org\/|property=["']product:availability["'][^>]*content=["'])(InStock|OutOfStock|instock|outofstock)/i)?.[1]?.toLowerCase();
  if (metadata) return metadata==='instock'?'in_stock':'out_of_stock';
  const text=markup.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/\s+/g,' ');
  if (/out of stock|nije na (?:stanju|lageru)|nema na (?:stanju|lageru)|rasprodato|rasprodat|няма(?: в)? наличност|изчерпан|не е наличен/i.test(text)) return 'out_of_stock';
  if (/in stock|в наличност|na stanju|na lageru/i.test(text)) return 'in_stock';
  return null;
}

function ekkaStock(body: string): 'in_stock' | 'out_of_stock' | null {
  // PrestaShop includes its out-of-stock placeholder even when the whole
  // availability paragraph is hidden. Anonymous quantities can also be zero
  // while ordering is enabled, so neither is evidence that stock is absent.
  const paragraph = body.match(/<p\b[^>]*id=["']availability_statut["'][^>]*>[\s\S]*?<\/p>/i)?.[0] || '';
  const value = paragraph.match(/<span\b[^>]*id=["']availability_value["'][^>]*>[\s\S]*?<\/span>/i)?.[0] || '';
  const hidden = (element: string): boolean => {
    const tag = element.match(/^<[^>]*>/)?.[0] || '';
    const style = tag.match(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/i)?.[2] || '';
    const classes = tag.match(/\bclass\s*=\s*(["'])([\s\S]*?)\1/i)?.[2] || '';
    return /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i.test(style)
      || /\shidden(?:\s|=|>)/i.test(tag)
      || /(?:^|\s)(?:hidden|hide|d-none)(?:\s|$)/i.test(classes);
  };
  const metadata = body.match(/<[^>]*(?:itemprop=["']availability["']|property=["']product:availability["'])[^>]*>/gi)?.join(' ') || '';
  const visibleValue = paragraph && value && !hidden(paragraph) && !hidden(value) ? value : '';
  return explicitStock(metadata + visibleValue);
}

async function ekkaPage(urlValue: string): Promise<Outcome> {
  let url = new URL(urlValue);
  for (let redirects = 0; redirects < 4; redirects += 1) {
    if (url.protocol !== 'https:' || !['ekka.rs', 'www.ekka.rs'].includes(url.hostname.toLowerCase()) || url.port || url.username || url.password) return { status: 'error' };
    let response: Response;
    try {
      response = await fetch(url, { redirect: 'manual', signal: supplierSignal(), headers: { 'user-agent': 'DajaShop supplier availability check (+https://dajashop.rs)' } });
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
    // Ekka hides stock from anonymous visitors. When no visible stock value
    // is supplied, a confirmed valid product page is the availability fallback.
    return { status: 'available', stockStatus: ekkaStock(body) ?? 'in_stock', priceAmount: price && Number.isFinite(Number(price)) ? Number(price) : null, priceCurrency: currency };
  }
  return { status: 'error' };
}

async function ekkaHomeHealthy(): Promise<boolean> {
  try {
    const response = await fetch('https://ekka.rs/', { signal: supplierSignal(), headers: { 'user-agent': 'DajaShop supplier availability check (+https://dajashop.rs)' } });
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
      response = await fetch(url, { redirect: 'manual', signal: supplierSignal(), headers: { 'user-agent': 'DajaShop supplier availability check (+https://dajashop.rs)' } });
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
    if (url.protocol !== 'https:' || !['linkel.rs', 'www.linkel.rs'].includes(url.hostname.toLowerCase()) || url.port || url.username || url.password) return { status: 'error', message: 'Linkel je preusmerio na drugu adresu.' };
    let response: Response;
    try {
      response = await fetch(url, { redirect: 'manual', signal: supplierSignal(), headers: { 'user-agent': 'DajaShop supplier availability check (+https://dajashop.rs)' } });
      if (response.status === 428) {
        // Retry once with browser headers when Linkel rejects the service request.
        response = await fetch(url, {
          redirect: 'manual', signal: supplierSignal(),
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': 'sr-RS,sr;q=0.9,en;q=0.8',
          },
        });
      }
    }
    catch { return { status: 'error', message: 'Server trenutno ne može da pristupi Linkel sajtu.' }; }
    if (response.status === 404 || response.status === 410) return { status: 'missing' };
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return { status: 'error', message: 'Linkel je vratio preusmerenje bez adrese.' };
      url = new URL(location, url);
      if (url.pathname === '/' || url.pathname === '/sr/' || url.pathname.includes('controller=404')) return { status: 'missing' };
      continue;
    }
    if (!response.ok) return { status: 'error', message: `Linkel je serveru vratio HTTP ${response.status}.` };
    if (!(response.headers.get('content-type') ?? '').includes('text/html')) return { status: 'error', message: 'Linkel nije vratio HTML stranicu.' };
    const body = (await response.text()).slice(0, 1_000_000);
    // Linkel's canonical tag and product-id class are not stable across
    // templates. The product body marker is stable, so do not reject a valid
    // product merely because those optional HTML details changed.
    const hasProductBody = /<body\b[^>]*\bid=["']product["']/i.test(body);
    if (!hasProductBody) return { status: 'error', message: 'Linkel stranica nema očekivanu oznaku proizvoda.' };
    const price = body.match(/<meta\s+property=["']product:price:amount["']\s+content=["']([^"']+)["']/i)?.[1];
    const currency = body.match(/<meta\s+property=["']product:price:currency["']\s+content=["']([^"']+)["']/i)?.[1]?.toUpperCase() || null;
    const visible = body.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
    const stockStatus = /Nije na stanju/i.test(visible) ? 'out_of_stock' : /Na stanju/i.test(visible) ? 'in_stock' : null;
    return { status: 'available', stockStatus, priceAmount: price && Number.isFinite(Number(price)) ? Number(price) : null, priceCurrency: currency };
  }
  return { status: 'error', message: 'Linkel je vratio previše preusmerenja.' };
}

async function additionalPage(provider: 'milano' | 'timezone' | 'qandq', urlValue: string): Promise<Outcome> {
  const domains = { milano: ['milanogroup.eu', 'www.milanogroup.eu'], timezone: ['timezone-bg.com', 'www.timezone-bg.com'], qandq: ['qandq-casio.com', 'www.qandq-casio.com'] };
  let url = new URL(urlValue);
  const requestedId = provider === 'qandq' ? url.searchParams.get('id') : null;
  for (let redirects = 0; redirects < 4; redirects += 1) {
    if (url.protocol !== 'https:' || !domains[provider].includes(url.hostname.toLowerCase()) || url.port || url.username || url.password) return { status: 'error' };
    let response: Response;
    try { response = await fetch(url, { redirect: 'manual', signal: supplierSignal(), headers: { 'user-agent': 'DajaShop supplier availability check (+https://dajashop.rs)' } }); }
    catch { return { status: 'error', message: 'Server trenutno ne može da pristupi sajtu dobavljača.' }; }
    if (response.status === 404 || response.status === 410) return { status: 'missing' };
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return { status: 'error' };
      url = new URL(location, url);
      if (url.pathname === '/' || (provider === 'qandq' && url.searchParams.get('id') !== requestedId)) return { status: 'missing' };
      continue;
    }
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('text/html')) return { status: 'error', message: `Dobavljač je serveru vratio HTTP ${response.status}.` };
    const body = (await response.text()).slice(0, 1_000_000);
    if (provider === 'milano') {
      if (!/property=["']product:price:amount["']/.test(body) || !/property=["']product:availability["']/.test(body)) return { status: 'error' };
      const price = body.match(/<meta\b[^>]*property=["']product:price:amount["'][^>]*content=["']([0-9.]+)["']/i)?.[1];
      const stock = body.match(/<meta\b[^>]*property=["']product:availability["'][^>]*content=["']([^"']+)["']/i)?.[1]?.toLowerCase();
      if (!price) return { status: 'error' };
      return { status: 'available', stockStatus: stock === 'instock' ? 'in_stock' : stock === 'outofstock' ? 'out_of_stock' : null, priceAmount: Number(price), priceCurrency: 'EUR' };
    }
    if (provider === 'timezone') {
      if (!/class=["']product-price["']/.test(body) || !/itemprop=["']availability["']/.test(body)) return { status: 'error' };
      const price = body.match(/<li\b[^>]*class=["']product-price["'][^>]*>\s*([0-9.,]+)\s*€/i)?.[1];
      const stock = body.match(/itemprop=["']availability["'][^>]*href=["'][^"']*schema\.org\/(InStock|OutOfStock)/i)?.[1];
      if (!price) return { status: 'error' };
      return { status: 'available', stockStatus: stock === 'InStock' ? 'in_stock' : stock === 'OutOfStock' ? 'out_of_stock' : null, priceAmount: Number(price.replace(',', '.')), priceCurrency: 'EUR' };
    }
    const product = body.split('id="product_info"')[1];
    if (!product || !/Модел|Model/i.test(product.slice(0, 20000))) return { status: 'error' };
    const price = product.match(/<b\b[^>]*>\s*([0-9.,]+)\s*(?:&euro;|€)\s*<\/b>/i)?.[1];
    if (!price) return { status: 'error' };
    const stockStatus = explicitStock(product.slice(0,20_000));
    return { status: 'available', stockStatus, priceAmount: Number(price.replace(',', '.')), priceCurrency: 'EUR' };
  }
  return { status: 'error' };
}

async function homeHealthy(provider: Provider): Promise<boolean> {
  if (provider === 'ekka') return ekkaHomeHealthy();
  if (provider === 'milano' || provider === 'timezone' || provider === 'qandq') {
    const home = { milano: 'https://milanogroup.eu/', timezone: 'https://timezone-bg.com/', qandq: 'https://www.qandq-casio.com/' }[provider];
    try { const response = await fetch(home, { signal: supplierSignal() }); return response.ok && (await response.text()).includes('<html'); }
    catch { return false; }
  }
  if (provider === 'linkel') {
    try {
      const response = await fetch('https://www.linkel.rs/sr/', { signal: supplierSignal(), headers: { 'user-agent': 'DajaShop supplier availability check (+https://dajashop.rs)' } });
      return response.ok && (await response.text()).includes('LINK Electronics');
    } catch { return false; }
  }
  try {
    const response = await fetch('https://bultime.bg/index.php?route=common/home', { signal: supplierSignal(), headers: { 'user-agent': 'DajaShop supplier availability check (+https://dajashop.rs)' } });
    return response.ok && (await response.text()).includes('route-common-home');
  } catch { return false; }
}

export async function checkSupplierPage(provider: string, url: string, signal: AbortSignal): Promise<Outcome> {
  return supplierDeadline.run(signal, () => provider === 'ekka' ? ekkaPage(url) : provider === 'bultime' ? bultimePage(url) : provider === 'linkel' ? linkelPage(url) : additionalPage(provider as 'milano' | 'timezone' | 'qandq',url));
}
export async function checkSupplierHome(provider: string, signal: AbortSignal): Promise<boolean> {
  return supplierDeadline.run(signal, () => homeHealthy(provider as Provider));
}

export async function previewSupplierLink(provider: Provider, url: string): Promise<Outcome | { status: 'unverified'; message?: string }> {
  const result = await checkSupplierPage(provider,url,AbortSignal.timeout(60_000));
  if (provider === 'ekka' || provider === 'bultime') return result;
  // A failed fetch or an unfamiliar supplier response cannot establish that
  // the product URL is invalid. Keep the saved link eligible for later checks.
  return result.status === 'error'
    ? { status: 'unverified', ...(result.message ? { message: result.message } : {}) }
    : result;
}

async function nextWeeklySlot(client: Pick<Database['pool'], 'query'>, link: Link): Promise<Date> {
  const now = Date.now();
  if (link.last_checked_at) return new Date(Math.max(now, link.next_check_at.getTime()) + WEEK_MS);
  const queued = await client.query<{ next_check_at: Date }>(
    `SELECT scheduled.next_check_at FROM supplier_product_links scheduled
     JOIN products product ON product.id = scheduled.product_id AND product.organization_id = scheduled.organization_id
     WHERE scheduled.provider_code IN ('linkel','milano') AND scheduled.id <> $1 AND scheduled.check_status = 'available' AND scheduled.missing_count = 0
       AND scheduled.last_checked_at IS NOT NULL AND scheduled.last_error IS NULL AND product.deleted_at IS NULL
       AND scheduled.next_check_at > now() AND scheduled.next_check_at < now() + interval '7 days'
     ORDER BY scheduled.next_check_at`, [link.id]
  );
  if (!queued.rows.length) return new Date(now + WEEK_MS);
  const horizon = now + WEEK_MS;
  let previous = now;
  let largestStart = now;
  let largestEnd = now;
  for (const row of queued.rows) {
    const point = new Date(row.next_check_at).getTime();
    if (point - previous > largestEnd - largestStart) { largestStart = previous; largestEnd = point; }
    previous = point;
  }
  if (horizon - previous > largestEnd - largestStart) { largestStart = previous; largestEnd = horizon; }
  return new Date(Math.floor((largestStart + largestEnd) / 2));
}

export function startSupplierChecks(database: Database, logger: Logger): () => void {
  const stopNumbered = startNumberedSupplierChecks(database,logger,{page:checkSupplierPage,home:checkSupplierHome});
  let active = false;
  let closed = false;
  const run = async () => {
    if (active || closed) return;
    active = true;
    let lease: string | null = null;
    const signal=AbortSignal.timeout(60_000);
    try {
      const due = await database.pool.query<Link>(
        `SELECT link.id, link.url, link.provider_code, link.organization_id, link.product_id, link.missing_count, link.last_checked_at, link.next_check_at
         FROM supplier_product_links link JOIN products product ON product.id = link.product_id AND product.organization_id = link.organization_id
         WHERE link.provider_code IN ('linkel', 'milano') AND link.next_check_at <= now() AND product.deleted_at IS NULL
           AND EXISTS (SELECT 1 FROM supplier_provider_checks provider WHERE provider.provider_code = link.provider_code
                       AND provider.next_request_at <= now() AND (provider.paused_until IS NULL OR provider.paused_until <= now()))
         ORDER BY CASE WHEN link.last_checked_at IS NULL THEN 0 ELSE 1 END, link.next_check_at, link.id LIMIT 1`
      );
      if (!due.rows[0]) return;
      lease=await acquireSupplierLease(database.pool,due.rows[0].provider_code,'legacy');
      if (!lease) return;
      const slot = await database.pool.query(
        `UPDATE supplier_provider_checks SET next_request_at = now() + interval '60 seconds', updated_at = now()
         WHERE provider_code = $1 AND next_request_at <= now() AND (paused_until IS NULL OR paused_until <= now()) RETURNING provider_code`,
        [due.rows[0].provider_code]
      );
      if (!slot.rowCount) return;
      const link = due.rows[0];
      const claim = await database.pool.query<{ id: string }>(
        `UPDATE supplier_product_links SET next_check_at = now() + interval '10 minutes', updated_at = now()
         WHERE id = $1 AND url = $2 AND next_check_at <= now()
         RETURNING id`,
        [link.id, link.url]
      );
      if (!claim.rows[0]) return;
      const outcome = await checkSupplierPage(link.provider_code,link.url,signal);
      if (outcome.status === 'available') {
        const client = await database.pool.connect();
        let saved = false;
        try {
          await client.query('BEGIN');
          await client.query(`SELECT pg_advisory_xact_lock(hashtext('supplier-weekly-queue'))`);
          const nextCheckAt = await nextWeeklySlot(client, link);
          const update = await client.query(
            `UPDATE supplier_product_links SET check_status = 'available', stock_status = $3, price_amount = $4, price_currency = $5,
               missing_count = 0, last_checked_at = now(), last_seen_at = now(), last_error = NULL, next_check_at = $6, updated_at = now()
             WHERE id = $1 AND url = $2`, [link.id, link.url, outcome.stockStatus, outcome.priceAmount ?? null, outcome.priceCurrency ?? null, nextCheckAt]
          );
          saved = Boolean(update.rowCount);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally { client.release(); }
        await database.pool.query(`UPDATE supplier_provider_checks SET consecutive_errors = 0, paused_until = NULL WHERE provider_code = $1`, [link.provider_code]);
        if (saved) await publishStatus(database, link, 'available', outcome.stockStatus, outcome.priceAmount, outcome.priceCurrency);
      } else if (outcome.status === 'missing') {
        if (!(await checkSupplierHome(link.provider_code,signal))) {
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
           WHERE id = $1 AND url = $2`, [link.id, link.url, `${link.provider_code} provera nije uspela`]
        );
        const failures = await database.pool.query<{ consecutive_errors: number }>(
          `UPDATE supplier_provider_checks SET consecutive_errors = consecutive_errors + 1 WHERE provider_code = $1 RETURNING consecutive_errors`,
          [link.provider_code]
        );
        if ((failures.rows[0]?.consecutive_errors ?? 0) >= 3 && !(await checkSupplierHome(link.provider_code,signal))) {
          await database.pool.query(`UPDATE supplier_provider_checks SET paused_until = now() + interval '12 hours', consecutive_errors = 0, updated_at = now() WHERE provider_code = $1`, [link.provider_code]);
          logger.warn({ provider: link.provider_code }, 'Supplier is unavailable; checks paused for 12 hours');
        }
      }
    } catch (error) {
      logger.error({ err: error }, 'Supplier check failed');
    } finally {
      if (lease) await database.pool.query('DELETE FROM supplier_check_leases WHERE token=$1',[lease]).catch(error=>logger.error({err:error},'Legacy supplier lease release failed'));
      active = false;
    }
  };
  const timer = setInterval(() => { void run(); }, 30_000);
  void run();
  return () => { closed = true; clearInterval(timer); stopNumbered(); };
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
