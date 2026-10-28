const NBS_CURRENT_MIDDLE_RATE = 'https://webappcenter.nbs.rs/ExchangeRateWebApp/ExchangeRate/CurrentMiddleRate';
const CACHE_MS = 15 * 60 * 1000;

type NbsEurRate = {
  eurRsdRate: number;
  asOf: string;
  fetchedAt: string;
  source: 'NBS';
  sourceUrl: string;
};

let cachedRate: { data: NbsEurRate; checkedDay: string; fetchedAt: number } | null = null;
let pendingRate: Promise<NbsEurRate> | null = null;

const belgradeDay = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Belgrade', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());

async function fetchCurrentRate(): Promise<NbsEurRate> {
  const checkedDay = belgradeDay();
  const response = await fetch(NBS_CURRENT_MIDDLE_RATE, {
    signal: AbortSignal.timeout(10000), cache: 'no-store',
    headers: { 'user-agent': 'DajaShop daily official NBS exchange rate' }
  });
  if (!response.ok) throw new Error(`NBS kurs nije dostupan (${response.status})`);
  const html = await response.text();
  const row = html.match(/<tr\b[^>]*>\s*<td\b[^>]*>\s*EUR\s*<\/td>[\s\S]*?<\/tr>/i)?.[0];
  const cells = [...(row || '').matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
    .map(match => match[1]!.replace(/<[^>]+>/g, '').replace(/&nbsp;|&#160;/g, ' ').trim());
  if (cells.length !== 5 || cells[1] !== '978' || cells[3] !== '1') throw new Error('NBS EUR red nije ispravan');
  const eurRsdRate = Number((cells[4] || '').replace(/\s/g, '').replace(',', '.'));
  const headings = [...html.matchAll(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi)];
  const date = headings.map(match => match[1]!.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\./)).find(Boolean);
  if (!date || !Number.isFinite(eurRsdRate) || eurRsdRate <= 0) throw new Error('NBS kurs ili datum liste nije ispravan');
  const asOf = `${date[3]}-${date[2]!.padStart(2, '0')}-${date[1]!.padStart(2, '0')}`;
  const fetchedAt = Date.now();
  const data: NbsEurRate = { eurRsdRate, asOf, fetchedAt: new Date(fetchedAt).toISOString(), source: 'NBS', sourceUrl: NBS_CURRENT_MIDDLE_RATE };
  cachedRate = { data, checkedDay, fetchedAt };
  return data;
}

// Revalidate every day in Belgrade and at most every 15 minutes while in use.
// On weekends/holidays, NBS's current list remains the last applicable list.
export async function currentNbsEurRate(): Promise<NbsEurRate> {
  if (cachedRate && cachedRate.checkedDay === belgradeDay() && Date.now() - cachedRate.fetchedAt < CACHE_MS) return cachedRate.data;
  if (!pendingRate) pendingRate = fetchCurrentRate().finally(() => { pendingRate = null; });
  return pendingRate;
}

export async function currentEurRsdMiddleRate(): Promise<number> {
  return (await currentNbsEurRate()).eurRsdRate;
}
