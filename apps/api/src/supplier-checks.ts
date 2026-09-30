import { type Database } from '@daja/database';
import type { Logger } from '@daja/observability';
import { AsyncLocalStorage } from 'node:async_hooks';
import { startNumberedSupplierChecks } from './supplier-queue.js';

const supplierDeadline = new AsyncLocalStorage<AbortSignal>();
function supplierSignal(): AbortSignal {
  const deadline=supplierDeadline.getStore();
  return deadline ? AbortSignal.any([deadline,AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
}



type Provider = 'ekka' | 'bultime' | 'linkel' | 'milano' | 'timezone' | 'qandq';
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
    const stockStatus = explicitStock(product.slice(0,20_000)) ?? 'in_stock';
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

export function startSupplierChecks(database: Database, logger: Logger): () => void {
  return startNumberedSupplierChecks(database,logger,{page:checkSupplierPage,home:checkSupplierHome});
}
