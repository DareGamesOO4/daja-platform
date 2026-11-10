import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { linkelRegularPrice } from '../apps/api/src/supplier-prices.js';

const workerId = createHash('sha256').update(hostname().toLowerCase()).digest('hex');
const home = 'https://www.linkel.rs/sr/';
const jobSchema = z.object({ token: z.uuid(), kind: z.enum(['health', 'product']), url: z.url(), stockOnly: z.boolean().default(false) });
const failed = { status: 'error', accessFailed: true } as const;
type Api = (route: string, payload: unknown, signal: AbortSignal) => Promise<Response>;

async function readLinkel(value: string, shutdown: AbortSignal) {
  let url = new URL(value);
  const signal = AbortSignal.any([shutdown, AbortSignal.timeout(15_000)]);
  for (let redirects = 0; redirects < 3; redirects++) {
    if (url.protocol !== 'https:' || !['linkel.rs', 'www.linkel.rs'].includes(url.hostname) ||
      url.username || url.password || url.port) throw new Error('Nevažeća Linkel adresa.');
    const response = await fetch(url, {
      redirect: 'manual', signal,
      headers: { 'user-agent': 'DajaShop supplier availability check (+https://dajashop.rs)' }
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      url = new URL(location, url);
      continue;
    }
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) {
      await response.body?.cancel();
      return { status: response.status, html: '' };
    }
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let html = '';
    if (reader) {
      try {
        while (html.length < 1_000_000) {
          const { value: chunk, done } = await reader.read();
          if (done) break;
          html += decoder.decode(chunk, { stream: true });
        }
        html += decoder.decode();
      } finally {
        await reader.cancel().catch(() => {});
      }
    }
    return { status: response.status, html };
  }
  throw new Error('Previše Linkel preusmerenja.');
}

function blocked(page: Awaited<ReturnType<typeof readLinkel>>) {
  return [403, 428, 429].includes(page.status) ||
    /<title[^>]*>[^<]*(?:captcha|just a moment|access denied|verify you are human)/i.test(page.html);
}

function isHome(page: Awaited<ReturnType<typeof readLinkel>>) {
  return page.status === 200 && !blocked(page) && /<body\b[^>]*\bid=["']index["']/i.test(page.html);
}

function readProduct(page: Awaited<ReturnType<typeof readLinkel>>) {
  if (page.status === 404 || page.status === 410 || isHome(page)) return { status: 'missing' } as const;
  if (page.status !== 200 || blocked(page) || !/<body\b[^>]*\bid=["']product["']/i.test(page.html)) return failed;
  const priceAmount = linkelRegularPrice(page.html);
  const availability = (page.html.match(/itemprop=["']availability["'][^>]*schema\.org\/(InStock|OutOfStock)\b/i)?.[1] ??
    page.html.match(/"availability"\s*:\s*"https?:\/\/schema\.org\/(InStock|OutOfStock)"/i)?.[1])?.toLowerCase();
  // The main form contains this product's stock label. Related products can have different stock and prices.
  const form = page.html.match(/<form\b[^>]*\bid=["']add-to-cart-or-refresh["'][^>]*>([\s\S]*?)<\/form>/i)?.[1] ?? '';
  const visible = form.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ');
  const stockStatus = availability === 'instock' ? 'in_stock' : availability === 'outofstock' ? 'out_of_stock'
    : /(?:nije|nema) na stanju/i.test(visible) ? 'out_of_stock' : /na stanju/i.test(visible) ? 'in_stock' : null;
  const validPrice = priceAmount !== null && priceAmount >= 0 && priceAmount <= 100_000_000;
  if (!validPrice && !stockStatus) return { status: 'error', accessFailed: false } as const;
  return { status: 'available', stockStatus, priceAmount: validPrice ? priceAmount : null, priceCurrency: 'RSD' } as const;
}

const scheduleTime = new Intl.DateTimeFormat('sr-Latn-RS', {
  timeZone: 'Europe/Belgrade', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
});

function idleStatus(response: Response) {
  const time = Date.parse(response.headers.get('X-Daja-Linkel-Next-At') ?? '');
  const when = time > Date.now() ? scheduleTime.format(time) : '';
  switch (response.headers.get('X-Daja-Linkel-State')) {
    case 'paused': return 'Provere pauzirane u adminu' + (when ? ' do ' + when : '');
    case 'protection': return when ? 'Zaštitna pauza do ' + when : 'Čeka proveru pristupa Linkelu';
    case 'bulk': return 'Masovna provera · čeka sledeći artikal';
    case 'running': return 'Provera je u toku na drugom DAJA računaru';
    case 'empty': return 'Nema Linkel linkova u redu';
    default: return 'Čeka sledeći termin' + (when ? ' · ' + when : '');
  }
}

export async function runLocalLinkel(
  api: Api, shutdown: AbortSignal, setStatus: (message: string, lastResult?: string) => void
) {
  let retryDelay = 15_000;
  while (!shutdown.aborted) {
    let wait = 15_000;
    try {
      const response = await api('linkel/claim', { workerId }, shutdown);
      const serverWait = Number(response.headers.get('X-Daja-Linkel-Wait-Ms'));
      if (Number.isFinite(serverWait) && serverWait >= 3_000 && serverWait <= 400_000) wait = serverWait;
      if (response.status === 204) {
        setStatus(idleStatus(response));
      } else {
        const payload = await response.json();
        const job = jobSchema.parse(payload?.data ?? payload);
        setStatus(job.kind === 'health' ? 'Proverava pristup Linkelu' : 'Provera artikla u toku na ovom računaru');
        const started = Date.now();
        let result = { outcome: failed as ReturnType<typeof readProduct>, homeHealthy: false, blocked: false };
        try {
          const page = await readLinkel(job.url, shutdown);
          result.blocked = blocked(page);
          if (job.kind === 'health') result.homeHealthy = isHome(page);
          else {
            const outcome = readProduct(page);
            result.outcome = outcome.status === 'available' && outcome.priceAmount === null && !job.stockOnly
              ? { status: 'error', accessFailed: false }
              : outcome;
            if (result.outcome.status === 'missing') {
              const homepage = isHome(page) ? page : await readLinkel(home, shutdown);
              result.homeHealthy = isHome(homepage);
              result.blocked = blocked(homepage);
              if (result.blocked) result.outcome = failed;
            }
          }
        } catch {
          shutdown.throwIfAborted();
        }
        await api('linkel/complete', { token: job.token, duration: Date.now() - started, regularPrice: true, ...result }, shutdown);
        const issue = result.blocked ? 'Linkel je odbio pristup (zaštita sajta ili ograničenje zahteva).' :
          job.kind === 'health' && !result.homeHealthy ? 'Početna strana Linkela nije dostupna.' :
          job.kind === 'product' && result.outcome.status === 'error' ? (result.outcome.accessFailed
            ? 'Stranica artikla nije dostupna.' : 'Cena ili stanje nisu potvrđeni.') : null;
        const lastResult = issue ?? (job.kind === 'health' ? 'Pristup potvrđen' :
          result.outcome.status === 'missing' ? (result.homeHealthy ? 'Stranica artikla nije pronađena' : 'Pristup sajtu nije potvrđen') :
          result.outcome.status === 'available' && result.outcome.stockStatus === null ? 'Cena očitana, stanje nije navedeno' : 'Rezultat poslat');
        setStatus(result.blocked || (job.kind === 'health' && !result.homeHealthy)
          ? 'Zaštitna pauza' : 'Čeka sledeći termin', scheduleTime.format(new Date()) + ' · ' + lastResult);
        // Refresh the shared queue promptly after submitting the result.
        wait = Math.max(0, wait - (Date.now() - started));
      }
      retryDelay = 15_000;
    } catch (error) {
      if (!shutdown.aborted) {
        const issue = error instanceof Error && /^DAJA API je vratio HTTP \d+\.$/.test(error.message)
          ? error.message : 'Studio nije uspeo da preuzme ili završi Linkel proveru.';
        setStatus(issue);
        wait = retryDelay;
        retryDelay = Math.min(retryDelay * 2, 120_000);
      }
    }
    await delay(wait, undefined, { signal: shutdown }).catch(() => {});
  }
}
