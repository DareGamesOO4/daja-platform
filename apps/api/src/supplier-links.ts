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
