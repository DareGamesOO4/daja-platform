/** Import the reviewed offline Linkel package through the staff catalogue API.
 * Defaults to a read-only preview. Pass --apply to upload media and save stock.
 * Credentials come from explicit, ignored env files and CATALOG_IMPORT_TOKEN.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'dotenv';
import pg from 'pg';
import sharp from 'sharp';
import { R2MediaStorageAdapter, MediaRepository, productMediaStorageKey } from '../packages/database/src/media.js';
import { CatalogRepository } from '../packages/database/src/catalog.js';
import { AuditRepository } from '../packages/database/src/audit.js';
import { OutboxRepository } from '../packages/database/src/outbox.js';
import { StorefrontRepository } from '../packages/database/src/storefront.js';
import { OperationalSyncProjector } from '../apps/api/src/operational-sync-projector.js';

const { values } = parseArgs({ options: {
  package: { type: 'string' }, 'env-file': { type: 'string' }, 'override-env-file': { type: 'string' },
  'api-url': { type: 'string' }, organization: { type: 'string' }, actor: { type: 'string' },
  report: { type: 'string' }, apply: { type: 'boolean', default: false }
} });
for (const key of ['package', 'env-file', 'api-url', 'organization', 'actor', 'report'] as const) {
  if (!values[key]) throw new Error(`Missing --${key}`);
}
const env = { ...parse(await readFile(values['env-file']!)),
  ...(values['override-env-file'] ? parse(await readFile(values['override-env-file'])) : {}) };
const token = process.env.CATALOG_IMPORT_TOKEN;
if (!token) throw new Error('CATALOG_IMPORT_TOKEN is required; use an authorized staff access token.');
const organizationId = values.organization!;
if (env.PUBLIC_ORGANIZATION_ID !== organizationId) throw new Error('Organization does not match the selected configuration.');
const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
if (claims.org !== organizationId || claims.sub !== values.actor) throw new Error('Staff token does not match --organization and --actor.');
const base = values['api-url']!.replace(/\/$/, '');
if (new URL(base).protocol !== 'https:') throw new Error('The staff API must use HTTPS.');
const pool = new pg.Pool({ connectionString: env.RENDER_DATABASE_URL || env.DATABASE_URL,
  ssl: { rejectUnauthorized: true }, max: 2, connectionTimeoutMillis: 15000 });
const root = dirname(resolve(values.package!));
const packageBytes = await readFile(resolve(values.package!));
const packageHash = sha(packageBytes);
const pkg = JSON.parse(packageBytes.toString('utf8'));
const categories: Record<string, string> = { alkalne: 'Alkalne', dugmaste: 'Dugmaste', punjive: 'Punjive', 'li-socl2': 'Li-SOCl₂' };
const report: { packageHash: string; startedAt: string; completedAt?: string; products: any[] } = {
  packageHash, startedAt: new Date().toISOString(), products: []
};

function sha(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex'); }
function stableId(text: string) {
  const hex = sha(Buffer.from(text)).slice(0, 32).split('');
  hex[12] = '5'; hex[16] = '8';
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
function slug(text: string) {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function name(text: string) { return text.replace(/^BATERIJA\b/, 'Baterija').replace(/^BATERIJE\b/, 'Baterije'); }
function summary(text: string) { return text.replace(/\s+/g, ' ').trim().slice(0, 160); }
async function api(path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90000)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${JSON.stringify(data.error || data)}`);
  return data && typeof data === 'object' && 'data' in data ? data.data : data;
}
function rows(data: any): any[] {
  if (Array.isArray(data)) return data;
  for (const key of ['data', 'items', 'departments', 'brands', 'categories', 'locations']) if (Array.isArray(data?.[key])) return data[key];
  throw new Error('Unexpected catalogue list response');
}
async function saveReport() {
  await mkdir(dirname(resolve(values.report!)), { recursive: true });
  await writeFile(resolve(values.report!), JSON.stringify(report, null, 2) + '\n');
}

const lock = await pool.connect();
try {
  await lock.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`${organizationId}:linkel-batteries-import`]);
  if (pkg.schemaVersion !== 'daja.catalog-package.v1' || pkg.products?.length !== 49) throw new Error('Expected the reviewed 49-product Linkel package.');
  const ids = new Set<string>(), skus = new Set<string>();
  // Validate every asset before the first write, including checksums and dimensions.
  const prepared = [];
  for (const product of pkg.products) {
    if (!/^LINKEL-\d+$/.test(product.externalId) || ids.has(product.externalId) || !product.supplierSku || skus.has(product.supplierSku)) throw new Error('Duplicate or invalid source identifier/SKU.');
    ids.add(product.externalId); skus.add(product.supplierSku);
    if (!categories[product.source.categorySlug]) throw new Error('Unknown battery category.');
    if (!Number.isSafeInteger(product.normalizedRow.priceMinor) || product.normalizedRow.priceMinor <= 0) throw new Error('Invalid source price.');
    const sourceUrl = new URL(product.source.url);
    if (sourceUrl.protocol !== 'https:' || sourceUrl.hostname !== 'www.linkel.rs') throw new Error('Unexpected supplier URL.');
    const media = pkg.media.find((m: any) => product.mediaRefs.includes(m.id));
    if (!media || media.image.mimeType !== 'image/avif' || media.thumbnail.mimeType !== 'image/avif') throw new Error('AVIF original and thumbnail are required.');
    const buffers: Buffer[] = [];
    for (const asset of [media.image, media.thumbnail]) {
      const path = resolve(root, asset.path);
      if (!path.startsWith(root + sep)) throw new Error('Media path escapes the package.');
      const buffer = await readFile(path), metadata = await sharp(buffer).metadata();
      if (sha(buffer) !== asset.sha256 || buffer.length !== asset.sizeBytes || metadata.width !== asset.width || metadata.height !== asset.height || metadata.format !== 'heif') throw new Error(`Invalid AVIF asset for ${product.externalId}`);
      buffers.push(buffer);
    }
    const productName = name(product.normalizedRow.name);
    prepared.push({ product, media, buffers, productName, productSlug: slug(`nextcell-${productName}`) });
  }
  const [departments, brands, cats, locations] = await Promise.all([
    api('/departments').then(rows), api('/brands').then(rows), api('/categories').then(rows),
    pool.query('SELECT id,code,active FROM locations WHERE organization_id=$1 AND active AND deleted_at IS NULL', [organizationId]).then(result => result.rows)
  ]);
  const department = departments.find(x => x.slug === 'baterije' && x.active);
  const location = locations.find(x => x.code === 'C31' && x.active);
  if (!department || !location) throw new Error('Active Baterije department and C31 location are required.');
  let brand = brands.find(x => x.departmentId === department.id && x.name.toLowerCase() === 'nextcell');
  if (brand && !brand.active) throw new Error('Existing Nextcell brand is inactive.');
  const existing = (await pool.query(`SELECT p.id,p.external_id,p.slug,v.id AS variant_id,v.sku,v.attributes,
    (SELECT a.metadata->>'packageHash' FROM product_media pm JOIN media_assets a ON a.id=pm.media_asset_id AND a.organization_id=pm.organization_id
      WHERE pm.organization_id=p.organization_id AND pm.product_id=p.id AND a.deleted_at IS NULL ORDER BY pm.is_primary DESC,pm.position LIMIT 1) AS media_package_hash
    FROM products p LEFT JOIN product_variants v ON v.organization_id=p.organization_id AND v.product_id=p.id AND v.deleted_at IS NULL
    WHERE p.organization_id=$1 AND (p.external_id=ANY($2::text[]) OR p.slug=ANY($3::text[]) OR v.sku=ANY($4::text[]))`,
    [organizationId, [...ids], prepared.map(x => x.productSlug), [...skus]])).rows;
  for (const old of existing) {
    const match = prepared.find(x => x.product.externalId === old.external_id && x.product.supplierSku === old.sku && x.productSlug === old.slug);
    if (!match || (old.attributes?._catalog_import?.packageHash !== packageHash && old.media_package_hash !== packageHash)) throw new Error('An unrelated product already uses an import ID, SKU or slug. Nothing will be overwritten.');
  }
  console.log(JSON.stringify({ mode: values.apply ? 'apply' : 'preview', products: prepared.length, alreadyImported: existing.length,
    brand: 'Nextcell', categories: Object.values(categories), stockPerProduct: 1, currency: 'RSD', published: true, format: 'avif65' }));
  if (!values.apply) process.exitCode = 0;
  else {
    const storage = new R2MediaStorageAdapter({
      R2_ACCOUNT_ID: env.R2_ACCOUNT_ID!, R2_BUCKET: env.R2_BUCKET!, R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID!,
      R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY!, R2_ENDPOINT: env.R2_ENDPOINT!, MEDIA_PUBLIC_BASE_URL: env.MEDIA_PUBLIC_BASE_URL!
    });
    // Validate the media destination before creating taxonomy or product records.
    if (storage.bucket() !== 'dajashop-images' || new URL(storage.publicUrl('probe')!).hostname !== 'cdn.dajashop.rs') throw new Error('Unexpected media destination.');
    if (!brand) brand = await api('/brands', { name: 'Nextcell', slug: 'nextcell', departmentId: department.id, active: true });
    if (!brand.id) throw new Error('Brand creation did not return an identifier.');
    const categoryIds: Record<string, string> = {};
    for (const [index, [categorySlug, categoryName]] of Object.entries(categories).entries()) {
      let category = cats.find(x => x.departmentId === department.id && x.brandId === brand.id && x.slug === categorySlug);
      if (category && !category.active) throw new Error('An existing battery category is inactive.');
      if (!category) category = await api('/categories', { name: categoryName, slug: categorySlug, departmentId: department.id, brandId: brand.id, sortOrder: (index + 1) * 10, active: true });
      if (!category.id) throw new Error('Category creation did not return an identifier.');
      categoryIds[categorySlug] = category.id;
    }
    for (const item of prepared) {
      const { product, media, buffers, productName, productSlug } = item;
      const old = existing.find(x => x.external_id === product.externalId);
      if (old?.attributes?._catalog_import?.packageHash === packageHash) {
        report.products.push({ externalId: product.externalId, sku: product.supplierSku, productId: old.id, variantId: old.variant_id, slug: old.slug, status: 'already_imported' });
        await saveReport(); continue;
      }
      const mediaId = stableId(`${organizationId}:${product.externalId}:${media.image.sha256}`);
      const key = productMediaStorageKey({ organizationId, mediaId, productSlug, imageIndex: 1, extension: '.avif' });
      const thumbnailKey = key.replace(/\.avif$/, '-thumb.avif');
      // Immutable keys make a retry safe even if a prior HTTP response was lost.
      const known = (await pool.query('SELECT checksum_sha256,status FROM media_assets WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL', [organizationId, mediaId])).rows[0];
      if (known && known.checksum_sha256 !== media.image.sha256) throw new Error('Media identifier collision.');
      if (!known || known.status !== 'ready') {
        for (const [index, asset] of [media.image, media.thumbnail].entries()) {
          await storage.putObject({ key: index === 0 ? key : thumbnailKey, body: buffers[index]!, contentType: 'image/avif',
            cacheControl: 'public, max-age=31536000, immutable', sizeBytes: asset.sizeBytes,
            metadata: { sha256: asset.sha256, source: 'linkel', 'source-id': product.source.id, quality: '65' } });
        }
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(`INSERT INTO media_assets (id,organization_id,storage_provider,storage_bucket,storage_key,public_url,mime_type,size_bytes,checksum_sha256,status,metadata)
            VALUES ($1,$2,'r2',$3,$4,$5,'image/avif',$6,$7,'uploaded',$8::jsonb)
            ON CONFLICT (id) DO NOTHING`, [mediaId, organizationId, storage.bucket(), key, storage.publicUrl(key), media.image.sizeBytes, media.image.sha256,
            JSON.stringify({ source: 'linkel', sourceId: product.source.id, sourceUrl: product.source.imageUrl, packageHash, format: 'avif', quality: 65 })]);
          const ready = await new MediaRepository(client).markReady({ organizationId, mediaId, width: media.image.width, height: media.image.height,
            derivatives: [{ width: media.thumbnail.width, height: media.thumbnail.height, mimeType: 'image/avif', storageKey: thumbnailKey,
              publicUrl: storage.publicUrl(thumbnailKey)!, sizeBytes: media.thumbnail.sizeBytes, checksumSha256: media.thumbnail.sha256 }] });
          if (!ready) throw new Error('Could not register the prepared image.');
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      }
      const description = product.normalizedRow.description || productName;
      const english = { ...product.translations.en, description: product.translations.en.description || product.translations.en.name };
      const attributes = { _translations: { en: { ...english, metaDescription: summary(`Nextcell ${english.description}`) } },
        _catalog_import: { supplier: 'Linkel', packageHash, externalId: product.externalId, source: product.source },
        tip: categories[product.source.categorySlug] };
      const saved = await api('/admin/catalog/save', {
        requestId: stableId(`${organizationId}:linkel-import-v2:${packageHash}:${product.externalId}:stock1-published:${old ? `recover-${old.id}` : 'create'}`),
        ...(old ? { id: old.id } : {}),
        product: { name: productName, slug: productSlug, externalId: product.externalId, description,
          departmentId: department.id, brandId: brand.id, primaryCategoryId: categoryIds[product.source.categorySlug],
          itemCondition: 'new', active: true, published: true, linkelUrl: product.source.url,
          seo: { metaTitle: `${productName} | Nextcell`, metaDescription: summary(`Nextcell ${description}`) } },
        variant: { ...(old ? { id: old.variant_id } : {}), sku: product.supplierSku, mpn: product.supplierSku, currentPriceAmount: product.normalizedRow.priceMinor,
          currency: 'RSD', active: true, published: true,
          attributes: { tip: categories[product.source.categorySlug] } },
        stock: { quantity: 1, reconcileQuantity: true, persistPlacement: true,
          pieces: [{ epc: '', locationId: location.id, zoneId: null, binId: null }] },
        media: [{ mediaId, position: 0, isPrimary: true, altText: `Nextcell ${productName}` }],
        removedMediaLinkIds: [], deletedVariantIds: []
      });
      if (!saved.productId || !saved.variantId) throw new Error('Product save did not return product and variant identifiers.');
      // Install reviewed internal metadata using the domain repository as a
      // separate transaction. This also supports APIs predating reserved keys;
      // a lost response resumes from the immutable media/package fingerprint.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const ctx = { organizationId, userId: values.actor!, requestId: stableId(`${saved.productId}:metadata:${packageHash}`),
          correlationId: stableId(`${organizationId}:linkel:${packageHash}`), roles: [], permissions: [] };
        await client.query('SELECT id FROM product_variants WHERE organization_id=$1 AND id=$2 FOR UPDATE', [organizationId, saved.variantId]);
        const changed = await new CatalogRepository(client).patchVariant(ctx, saved.variantId, { attributes });
        await new AuditRepository(client).append({ ctx, aggregateType: 'variant', aggregateId: saved.variantId, operation: 'update',
          beforePayload: changed.before, afterPayload: changed.after, reason: 'Reviewed Linkel package: translations and import provenance' });
        await new StorefrontRepository(client).refreshProductSnapshots({ organizationId, productId: saved.productId });
        await new OperationalSyncProjector(client).publishProductChange(ctx, saved.productId, saved.variantId);
        await new OutboxRepository(client).append({ ctx, eventType: 'ProductUpdated', aggregateType: 'product', aggregateId: saved.productId,
          payload: { productId: saved.productId, variantId: saved.variantId, slug: productSlug, published: true } });
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      report.products.push({ externalId: product.externalId, sku: product.supplierSku, name: productName, category: categories[product.source.categorySlug],
        productId: saved.productId, variantId: saved.variantId, slug: saved.product?.slug || productSlug,
        priceMinor: product.normalizedRow.priceMinor, currency: 'RSD', quantity: 1, published: true,
        imageUrl: storage.publicUrl(key), thumbnailUrl: storage.publicUrl(thumbnailKey), status: 'imported' });
      await saveReport();
      console.log(`Imported ${report.products.length}/${prepared.length}: ${product.supplierSku}`);
    }
    const result = await pool.query(`SELECT p.external_id,p.published,p.active,v.sku,v.current_price_amount,v.published AS variant_published,
      COALESCE((SELECT SUM(b.quantity) FROM inventory_balances b WHERE b.organization_id=p.organization_id AND b.variant_id=v.id),0)::int AS quantity,
      (SELECT COUNT(*) FROM product_media pm JOIN media_assets a ON a.id=pm.media_asset_id WHERE pm.organization_id=p.organization_id AND pm.product_id=p.id AND a.mime_type='image/avif' AND a.status='ready')::int AS images
      FROM products p JOIN product_variants v ON v.product_id=p.id AND v.organization_id=p.organization_id AND v.deleted_at IS NULL
      WHERE p.organization_id=$1 AND p.external_id=ANY($2::text[]) AND p.deleted_at IS NULL`, [organizationId, [...ids]]);
    if (result.rowCount !== 49 || result.rows.some(x => x.quantity !== 1 || !x.published || !x.active || !x.variant_published || x.images !== 1 || Number(x.current_price_amount) !== prepared.find(p => p.product.externalId === x.external_id)!.product.normalizedRow.priceMinor)) throw new Error('Final persisted catalogue/stock totals do not match the package. See the checkpoint report.');
    report.completedAt = new Date().toISOString(); await saveReport();
    console.log('Completed: 49 published Nextcell batteries, one unit each, AVIF originals and thumbnails.');
  }
} finally {
  await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`${organizationId}:linkel-batteries-import`]).catch(() => {});
  lock.release(); await pool.end();
}
