import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

const home = 'https://www.linkel.rs/sr/';
const jobSchema = z.object({ token: z.uuid(), kind: z.enum(['health', 'product']), url: z.url() });
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
  const amount = page.html.match(/<meta\s+property=["']product:price:amount["']\s+content=["']([^"']+)["']/i)?.[1];
  const currency = page.html.match(/<meta\s+property=["']product:price:currency["']\s+content=["']([^"']+)["']/i)?.[1];
  const priceAmount = amount ? Number(amount) : NaN;
  const availability = (page.html.match(/itemprop=["']availability["'][^>]*schema\.org\/(InStock|OutOfStock)\b/i)?.[1] ??
    page.html.match(/"availability"\s*:\s*"https?:\/\/schema\.org\/(InStock|OutOfStock)"/i)?.[1])?.toLowerCase();
  const stockStatus = availability === 'instock' ? 'in_stock' : availability === 'outofstock' ? 'out_of_stock' : null;
  if (!stockStatus || currency?.toUpperCase() !== 'RSD' || !Number.isFinite(priceAmount) || priceAmount < 0 || priceAmount > 100_000_000) {
    return { status: 'error', accessFailed: false } as const;
  }
  return { status: 'available', stockStatus, priceAmount, priceCurrency: 'RSD' } as const;
}

export async function runLocalLinkel(api: Api, shutdown: AbortSignal, setStatus: (message: string) => void) {
  while (!shutdown.aborted) {
    const started = Date.now();
    let wait = 15_000;
    try {
      const response = await api('linkel/claim', {}, shutdown);
      if (response.status === 204) {
        setStatus('Čeka sledeći termin');
      } else {
        wait = 400_000;
        const payload = await response.json();
        const job = jobSchema.parse(payload?.data ?? payload);
        setStatus('Provera u toku');
        let result = { outcome: failed as ReturnType<typeof readProduct>, homeHealthy: false, blocked: false };
        try {
          const page = await readLinkel(job.url, shutdown);
          result.blocked = blocked(page);
          if (job.kind === 'health') result.homeHealthy = isHome(page);
          else {
            result.outcome = readProduct(page);
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
        await api('linkel/complete', { token: job.token, duration: Date.now() - started, ...result }, shutdown);
        setStatus(result.blocked ? 'Linkel je odbio pristup' : job.kind === 'health'
          ? (result.homeHealthy ? 'Linkel je dostupan' : 'Linkel nije dostupan')
          : result.outcome.status === 'error' ? 'Cena ili stanje nisu potvrđeni' : 'Poslednja provera ' + new Date().toLocaleString('sr-RS'));
      }
    } catch (error) {
      if (!shutdown.aborted) setStatus(error instanceof Error ? error.message : 'Provera nije uspela');
    }
    await delay(Math.max(0, wait - (Date.now() - started)), undefined, { signal: shutdown }).catch(() => {});
  }
}
