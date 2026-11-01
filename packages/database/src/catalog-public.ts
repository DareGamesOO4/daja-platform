// Internal supplier/import evidence belongs in staff responses only.
const privateKeys = /^(?:_catalog_import|originalFilename|sourceFilename|importedAt|supplier_?sku|source(?:_?url|_?image(?:_?url)?)?|supplier(?:_?url|_?reference)?|metadata|import(?:_?metadata|_?source)?)$/i;
const supplierUrl = /https?:\/\/[^\s<>"']*(?:bultime\.bg|timezone-bg\.com|qandq-casio\.com|ekka\.rs|linkel\.rs|milano[^/\s"']*|orient-watch\.com|danielklein[^/\s"']*)[^\s<>"']*/gi;
export function publicCatalogText(text: string): string {
  return text
    // Stray copied source/favicons credit paragraphs are not product content.
    .replace(/<p\b[^>]*>\s*\[image\]\([^<]*\)\s*<\/p>/gi, '')
    .replace(/<p\b[^>]*>\s*(?:bultime\.bg|timezone-bg\.com|qandq-casio\.com|(?:www\.)?(?:linkel|ekka)\.rs)\s*<\/p>/gi, '')
    .replace(/Bultime ovaj model svrstava u/gi, 'Ovaj model ima')
    .replace(/Bultime ga svrstava u/gi, 'Model ima')
    .replace(/<a\b[^>]*href=["'][^"']*(?:bultime\.bg|timezone-bg\.com|qandq-casio\.com|linkel\.rs|ekka\.rs)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(supplierUrl, '');
}
export function publicCatalogValue(value: unknown): unknown {
  if (value instanceof Date) return value;
  if (typeof value === 'string') return publicCatalogText(value);
  if (Array.isArray(value)) return value.map(publicCatalogValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !privateKeys.test(key) && (!key.startsWith('_') || key === '_translations')
  ).map(([key, item]) => [key, publicCatalogValue(item)]));
}
