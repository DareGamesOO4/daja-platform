const NBS_CURRENT_FOREIGN_EXCHANGE = 'https://webappcenter.nbs.rs/ExchangeRateWebApp/ExchangeRate/CurrentForeignExchange';

let cachedRate: { value: number; fetchedAt: number } | null = null;

export async function currentEurRsdMiddleRate(): Promise<number> {
  if (cachedRate && Date.now() - cachedRate.fetchedAt < 60 * 60 * 1000) return cachedRate.value;
  const response = await fetch(NBS_CURRENT_FOREIGN_EXCHANGE, { signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'DajaShop exchange-rate display' } });
  if (!response.ok) throw new Error(`NBS kurs nije dostupan (${response.status})`);
  const html = await response.text();
  const row = html.match(/<tr>\s*<td>EUR<\/td>[\s\S]*?<td>([0-9]+,[0-9]+)<\/td>\s*<td>([0-9]+,[0-9]+)<\/td>\s*<\/tr>/i);
  if (!row) throw new Error('NBS EUR kurs nije pronađen');
  const buying = Number((row[1] ?? '').replace(',', '.'));
  const selling = Number((row[2] ?? '').replace(',', '.'));
  const middle = (buying + selling) / 2;
  if (!Number.isFinite(middle) || middle <= 0) throw new Error('NBS EUR kurs nije ispravan');
  cachedRate = { value: middle, fetchedAt: Date.now() };
  return middle;
}
