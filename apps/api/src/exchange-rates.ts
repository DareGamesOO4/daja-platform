const NBS_CURRENT_MIDDLE_RATE = 'https://webappcenter.nbs.rs/ExchangeRateWebApp/ExchangeRate/CurrentMiddleRate';
const CACHE_MS = 15 * 60 * 1000;
const NBS_CURRENCY_CODES = { EUR: '978', USD: '840', BAM: '977', MKD: '807', CHF: '756' } as const;
type ForeignCurrency = keyof typeof NBS_CURRENCY_CODES;

type NbsExchangeRates = {
  base: 'RSD';
  rates: Record<'RSD' | ForeignCurrency, number>;
  eurRsdRate: number;
  asOf: string;
  fetchedAt: string;
  source: 'NBS';
  sourceUrl: string;
};

let cachedRate: { data: NbsExchangeRates; checkedDay: string; fetchedAt: number } | null = null;
let pendingRate: Promise<NbsExchangeRates> | null = null;

const belgradeDay = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Belgrade', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());

async function fetchCurrentRate(): Promise<NbsExchangeRates> {
  const checkedDay = belgradeDay();
  const response = await fetch(NBS_CURRENT_MIDDLE_RATE, {
    signal: AbortSignal.timeout(10000), cache: 'no-store',
    headers: { 'user-agent': 'DajaShop daily official NBS exchange rate' }
  });
  if (!response.ok) throw new Error(`NBS kurs nije dostupan (${response.status})`);
  const html = await response.text();
  const rates = { RSD: 1 } as Record<'RSD' | ForeignCurrency, number>;
  for (const row of html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)) {
    const cells = [...row[0].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(match => match[1]!.replace(/<[^>]+>/g, '').replace(/&nbsp;|&#160;/g, ' ').trim());
    const currency = cells[0];
    if (!currency || !Object.hasOwn(NBS_CURRENCY_CODES, currency)) continue;
    const code = currency as ForeignCurrency;
    const units = Number(cells[3]);
    const amountRsd = Number((cells[4] || '').replace(/\s/g, '').replace(',', '.'));
    if (cells.length !== 5 || cells[1] !== NBS_CURRENCY_CODES[code] || !Number.isFinite(units) || units <= 0 || !Number.isFinite(amountRsd) || amountRsd <= 0) {
      throw new Error(`NBS ${code} red nije ispravan`);
    }
    // Number of foreign-currency units for one RSD; NBS may quote 1 or 100 units.
    rates[code] = units / amountRsd;
  }
  if (Object.keys(NBS_CURRENCY_CODES).some(code => !Number.isFinite(rates[code as ForeignCurrency]) || rates[code as ForeignCurrency] <= 0)) {
    throw new Error('NBS kursna lista ne sadrži sve podržane valute');
  }
  const eurRsdRate = 1 / rates.EUR;
  const headings = [...html.matchAll(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi)];
  const date = headings.map(match => match[1]!.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\./)).find(Boolean);
  if (!date || !Number.isFinite(eurRsdRate) || eurRsdRate <= 0) throw new Error('NBS kurs ili datum liste nije ispravan');
  const asOf = `${date[3]}-${date[2]!.padStart(2, '0')}-${date[1]!.padStart(2, '0')}`;
  const fetchedAt = Date.now();
  const data: NbsExchangeRates = { base: 'RSD', rates, eurRsdRate, asOf, fetchedAt: new Date(fetchedAt).toISOString(), source: 'NBS', sourceUrl: NBS_CURRENT_MIDDLE_RATE };
  cachedRate = { data, checkedDay, fetchedAt };
  return data;
}

// Revalidate every day in Belgrade and at most every 15 minutes while in use.
// On weekends/holidays, NBS's current list remains the last applicable list.
export async function currentNbsExchangeRates(): Promise<NbsExchangeRates> {
  if (cachedRate && cachedRate.checkedDay === belgradeDay() && Date.now() - cachedRate.fetchedAt < CACHE_MS) return cachedRate.data;
  if (!pendingRate) pendingRate = fetchCurrentRate().finally(() => { pendingRate = null; });
  return pendingRate;
}

export async function currentEurRsdMiddleRate(): Promise<number> {
  return (await currentNbsExchangeRates()).eurRsdRate;
}
