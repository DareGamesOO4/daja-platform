import type pg from 'pg';
import { ValidationFailedError } from '@daja/security';

export function normalizeEkkaUrl(value: string | null): string | null {
  if (value === null || value.trim() === '') return null;
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new ValidationFailedError('Ekka link nije ispravna URL adresa'); }
  if (url.protocol !== 'https:' || !['ekka.rs', 'www.ekka.rs'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port || url.pathname.split('/').filter(Boolean).length < 2) {
    throw new ValidationFailedError('Ekka link mora biti direktna HTTPS adresa artikla sa ekka.rs');
  }
  url.hash = '';
  return url.toString();
}

export function normalizeBultimeUrl(value: string | null): string | null {
  if (value === null || value.trim() === '') return null;
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new ValidationFailedError('Bultime link nije ispravna URL adresa'); }
  if (url.protocol !== 'https:' || !['bultime.bg', 'www.bultime.bg'].includes(url.hostname.toLowerCase()) ||
      url.username || url.password || url.port ||
      (url.searchParams.has('route') && url.searchParams.get('route') !== 'product/product') ||
      !/^[1-9]\d*$/.test(url.searchParams.get('product_id') ?? '')) {
    throw new ValidationFailedError('Bultime link mora biti direktna HTTPS adresa artikla sa bultime.bg');
  }
  return `https://bultime.bg/index.php?route=product/product&product_id=${url.searchParams.get('product_id')}`;
}

export function normalizeLinkelUrl(value: string | null): string | null {
  if (value === null || value.trim() === '') return null;
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new ValidationFailedError('Linkel link nije ispravna URL adresa'); }
  if (url.protocol !== 'https:' || !['linkel.rs', 'www.linkel.rs'].includes(url.hostname.toLowerCase()) ||
      url.username || url.password || url.port || url.pathname.split('/').filter(Boolean).length < 3) {
    throw new ValidationFailedError('Linkel link mora biti direktna HTTPS adresa artikla sa linkel.rs');
  }
  url.hash = '';
  return url.toString();
}

export async function saveEkkaLink(
  client: Pick<pg.Pool | pg.PoolClient, 'query'>,
  organizationId: string,
  productId: string,
  supplierUrl: string | null
): Promise<void> {
  const url = normalizeEkkaUrl(supplierUrl);
  if (!url) {
    await client.query(
      `DELETE FROM supplier_product_links WHERE organization_id = $1 AND product_id = $2 AND provider_code = 'ekka'`,
      [organizationId, productId]
    );
    return;
  }
  await client.query(
    `INSERT INTO supplier_product_links (organization_id, product_id, provider_code, url)
     VALUES ($1, $2, 'ekka', $3)
     ON CONFLICT (organization_id, product_id, provider_code) DO UPDATE
       SET url = EXCLUDED.url, check_status = 'unverified', missing_count = 0,
           external_reference = NULL, last_checked_at = NULL, last_seen_at = NULL,
           next_check_at = now(), last_error = NULL, updated_at = now()
     WHERE supplier_product_links.url IS DISTINCT FROM EXCLUDED.url`,
    [organizationId, productId, url]
  );
}

export async function saveBultimeLink(
  client: Pick<pg.Pool | pg.PoolClient, 'query'>,
  organizationId: string,
  productId: string,
  supplierUrl: string | null
): Promise<void> {
  const url = normalizeBultimeUrl(supplierUrl);
  if (!url) {
    await client.query(
      `DELETE FROM supplier_product_links WHERE organization_id = $1 AND product_id = $2 AND provider_code = 'bultime'`,
      [organizationId, productId]
    );
    return;
  }
  await client.query(
    `INSERT INTO supplier_product_links (organization_id, product_id, provider_code, url)
     VALUES ($1, $2, 'bultime', $3)
     ON CONFLICT (organization_id, product_id, provider_code) DO UPDATE
       SET url = EXCLUDED.url, check_status = 'unverified', stock_status = NULL, missing_count = 0,
           external_reference = NULL, last_checked_at = NULL, last_seen_at = NULL,
           next_check_at = now(), last_error = NULL, updated_at = now()
     WHERE supplier_product_links.url IS DISTINCT FROM EXCLUDED.url`,
    [organizationId, productId, url]
  );
}

export async function saveLinkelLink(
  client: Pick<pg.Pool | pg.PoolClient, 'query'>,
  organizationId: string,
  productId: string,
  supplierUrl: string | null
): Promise<void> {
  const url = normalizeLinkelUrl(supplierUrl);
  if (!url) {
    await client.query(
      `DELETE FROM supplier_product_links WHERE organization_id = $1 AND product_id = $2 AND provider_code = 'linkel'`,
      [organizationId, productId]
    );
    return;
  }
  await client.query(
    `INSERT INTO supplier_product_links (organization_id, product_id, provider_code, url)
     VALUES ($1, $2, 'linkel', $3)
     ON CONFLICT (organization_id, product_id, provider_code) DO UPDATE
       SET url = EXCLUDED.url, check_status = 'unverified', stock_status = NULL, price_amount = NULL,
           price_currency = NULL, missing_count = 0, external_reference = NULL,
           last_checked_at = NULL, last_seen_at = NULL, next_check_at = now(), last_error = NULL, updated_at = now()
     `,
    [organizationId, productId, url]
  );
  await client.query(
    `UPDATE supplier_provider_checks
     SET paused_until = NULL, consecutive_errors = 0, next_request_at = now(), updated_at = now()
     WHERE provider_code = 'linkel'`,
  );
}
