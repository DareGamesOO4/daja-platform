import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Browser, BrowserContext, Page, Response as BrowserResponse } from 'playwright-core';
import { z } from 'zod';
import type { SupplierOutcome } from '../apps/api/src/supplier-queue.js';
import { priceFromMarkup } from '../apps/api/src/supplier-prices.js';

const home = 'https://qandq-casio.com/index.php';
const productId = /^[1-9]\d*$/;
const jobSchema = z.discriminatedUnion('kind', [
  z.object({ token: z.uuid(), kind: z.literal('health') }),
  z.object({ token: z.uuid(), kind: z.literal('product'), url: z.url() })
]);
const accessError = { status: 'error', accessFailed: true, message: 'Studio nije učitao Stilius stranicu.' } as const;
const parseError = { status: 'error', accessFailed: false, message: 'Studio nije potvrdio cenu ili stanje Stilius artikla.' } as const;
type Api = (route: string, payload: unknown, signal: AbortSignal) => Promise<Response>;

function browserPath() {
  return [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
    .filter((folder): folder is string => Boolean(folder))
    .flatMap(folder => [
      join(folder, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(folder, 'Google', 'Chrome', 'Application', 'chrome.exe')
    ]).find(existsSync);
}

function stiliusHost(url: URL) {
  return url.protocol === 'https:' && !url.username && !url.password && !url.port
    && ['qandq-casio.com', 'www.qandq-casio.com'].includes(url.hostname);
}

function stiliusId(url: URL) {
  const id = url.searchParams.get('id');
  return stiliusHost(url) && url.pathname === '/product.php' && id && productId.test(id) ? id : null;
}

async function readPage(page: Page, target: string, expected: (url: URL) => boolean) {
  let status: number | undefined;
  const capture = (response: BrowserResponse) => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
      status = expected(new URL(response.url())) ? response.status() : undefined;
    }
  };
  page.on('response', capture);
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 12_000 });
    await page.waitForURL(expected, { waitUntil: 'domcontentloaded', timeout: 10_000 });
    return status;
  } finally {
    page.off('response', capture);
  }
}

async function readProduct(page: Page, id: string): Promise<SupplierOutcome> {
  const status = await readPage(page, new URL('/product.php?id=' + id, home).href, url => stiliusId(url) === id);
  if (status === 404 || status === 410) return { status: 'missing' };
  if (status !== 200) return accessError;
  const offer = await page.evaluate(expectedId => {
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    const product = document.querySelector('#product_info');
    if (!canonical || new URL(canonical.href).searchParams.get('id') !== expectedId
        || !product?.querySelector('h1.product-title')) return null;

    const stock = product.querySelector('.product-stock');
    const pricing = product.querySelector('.product-pricing');
    const regular = pricing?.querySelector('.product-old-price, del, s')
      ?? pricing?.querySelector('.product-price');
    return {
      stockStatus: stock?.classList.contains('is-available') ? 'in_stock' as const
        : stock?.classList.contains('is-unavailable') ? 'out_of_stock' as const : null,
      regularPrice: regular?.textContent?.trim()
    };
  }, id);
  if (!offer) return parseError;
  const price = priceFromMarkup(offer.regularPrice, 'EUR');
  const priceAmount = price !== null && price > 0 && price <= 100_000_000 ? price : null;
  if (!offer.stockStatus && priceAmount === null) return parseError;
  return { status: 'available', stockStatus: offer.stockStatus, priceAmount, priceCurrency: 'EUR' };
}

async function check(page: Page, job: z.infer<typeof jobSchema>): Promise<SupplierOutcome> {
  if (job.kind === 'product') {
    const id = stiliusId(new URL(job.url));
    return id ? readProduct(page, id) : parseError;
  }
  if (await readPage(page, home, url => stiliusHost(url) && ['/', '/index.php'].includes(url.pathname)) !== 200) {
    return accessError;
  }
  const links = await page.locator('a[href*="product.php?id="]').evaluateAll(anchors =>
    anchors.slice(0, 40).map(anchor => (anchor as HTMLAnchorElement).href));
  const sample = links.map(url => stiliusId(new URL(url))).find(Boolean);
  return sample ? readProduct(page, sample) : parseError;
}

export async function runLocalStilius(api: Api, shutdown: AbortSignal, setStatus: (status: string) => void) {
  const executablePath = browserPath();
  if (!executablePath) {
    setStatus('Potreban je Microsoft Edge ili Google Chrome.');
    return;
  }
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let lastJob = 0;
  const close = async () => {
    const active = browser;
    browser = undefined;
    context = undefined;
    await active?.close().catch(() => {});
  };
  shutdown.addEventListener('abort', () => void close(), { once: true });
  try {
    while (!shutdown.aborted) {
      let wait = 15_000;
      try {
        if (browser && Date.now() - lastJob > 60_000) await close();
        const claim = await api('stilius/claim', {}, shutdown);
        if (claim.status === 204) {
          setStatus('Čeka posao');
        } else {
          const payload = await claim.json();
          const job = jobSchema.parse(payload?.data ?? payload);
          lastJob = Date.now();
          setStatus(job.kind === 'health' ? 'Proverava pristup sajtu' : 'Čita cenu i stanje artikla');
          if (!browser?.isConnected() || !context) {
            try {
              await close();
              const { chromium } = await import('playwright-core');
              browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, timeout: 12_000 });
              context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
              await context.route('**/*', route => stiliusHost(new URL(route.request().url())) &&
                !['image', 'font', 'media'].includes(route.request().resourceType()) ? route.continue() : route.abort());
            } catch {
              await close();
              // Leave the job queued for the other Studio if this PC cannot start a browser.
              setStatus('Ovaj računar ne može da pokrene pregledač za Stilius.');
              await delay(120_000, undefined, { signal: shutdown }).catch(() => {});
              continue;
            }
          }
          shutdown.throwIfAborted();
          const page = await context.newPage();
          let outcome: SupplierOutcome;
          try {
            outcome = await check(page, job);
          } catch {
            outcome = accessError;
          } finally {
            await page.close().catch(() => {});
          }
          await api('stilius/complete', { token: job.token, outcome, duration: Date.now() - lastJob }, shutdown);
          setStatus(outcome.status === 'error' ? outcome.message ?? 'Provera nije uspela' : 'Rezultat poslat');
          wait = 6_000;
        }
      } catch {
        if (!shutdown.aborted) setStatus('Čeka vezu sa DAJA redom za Stilius');
      }
      await delay(wait, undefined, { signal: shutdown }).catch(() => {});
    }
  } finally {
    await close();
  }
}
