export function priceFromMarkup(markup: string | undefined, currency: 'EUR' | 'RSD'): number | null {
  const unit = currency === 'EUR' ? '(?:€|&euro;|EUR)' : '(?:RSD|din\\.?)';
  const text = markup?.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ');
  const amount = text?.match(new RegExp('([0-9]+(?:[.\\s][0-9]{3})*(?:[.,][0-9]{1,2})?)\\s*' + unit, 'i'))?.[1];
  if (!amount) return null;
  const value = Number(amount.replace(/[.\s](?=\d{3}\b)/g, '').replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

export function metaPrice(body: string, field: string): string | undefined {
  const tag = body.match(new RegExp('<meta\\b(?=[^>]*\\b(?:property|itemprop)=["\x27]' + field + '["\x27])[^>]*>', 'i'))?.[0];
  return tag?.match(/\bcontent=["']([^"']+)["']/i)?.[1];
}

export function linkelRegularPrice(body: string): number | null {
  const details = body.match(/<div\b(?=[^>]*\bid=["']product-details["'])[^>]*\bdata-product="([^"]+)"/i)?.[1];
  const regular = details?.match(/&quot;price_without_reduction&quot;\s*:\s*([0-9.]+)/i)?.[1];
  const price = metaPrice(body, 'product:price:amount') ?? metaPrice(body, 'price');
  const currency = metaPrice(body, 'product:price:currency')?.toUpperCase() ?? 'RSD';
  if (currency !== 'RSD') return null;
  if (regular && Number.isFinite(Number(regular))) return Math.round(Number(regular) * 100) / 100;
  const mainPrice = body.split(/\bclass=["']product-prices\b/i)[1]?.split(/\bid=["'](?:add-to-cart-or-refresh|product-details)["']/i)[0];
  const regularMarkup = mainPrice?.match(/<span\b[^>]*class=["'][^"']*\bregular-price\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1];
  if (regularMarkup !== undefined || /&quot;has_discount&quot;\s*:\s*true/i.test(details ?? '') ||
      /\b(?:has-discount|product-discount)\b/i.test(mainPrice ?? '')) {
    return priceFromMarkup(regularMarkup, 'RSD');
  }
  return price && /^\d+(?:\.\d+)?$/.test(price) ? Number(price) : null;
}
