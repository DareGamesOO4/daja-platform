/** Import the reviewed offline 1072-remote AVIF60 Linkel package through the staff catalogue API.
 * Defaults to a read-only preview. Pass --apply to upload media and save stock.
 * Credentials come from explicit, ignored env files and CATALOG_IMPORT_TOKEN.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
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
  ssl: { rejectUnauthorized: true }, max: 5, connectionTimeoutMillis: 15000 });
const root = dirname(resolve(values.package!));
const packageBytes = await readFile(resolve(values.package!));
const packageHash = sha(packageBytes);
const pkg = JSON.parse(packageBytes.toString('utf8'));

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

function summary(text: string) { return text.replace(/\s+/g, ' ').trim().slice(0, 160); }
async function api(path: string, body?: unknown) {
  // Only GETs and the staff save endpoint with its stable requestId are replayable.
  const replayable = body === undefined || (path === '/admin/catalog/save' && typeof (body as any)?.requestId === 'string');
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90000)
      });
    } catch (error) {
      if (!replayable || attempt >= 5) throw error;
      await delay(Math.min(4000, 500 * 2 ** attempt) + Math.random() * 250); continue;
    }
    const text = await response.text();
    if (replayable && [429, 500, 502, 503, 504].includes(response.status) && attempt < 5) {
      console.warn(`Retrying ${path} after HTTP ${response.status} (attempt ${attempt + 1})`);
      await delay(Math.min(4000, 500 * 2 ** attempt) + Math.random() * 250); continue;
    }
    const data = JSON.parse(text);
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${JSON.stringify(data.error || data)}`);
    return data && typeof data === 'object' && 'data' in data ? data.data : data;
  }
}
function rows(data: any): any[] {
  if (Array.isArray(data)) return data;
  for (const key of ['data', 'items', 'departments', 'brands', 'categories', 'locations']) if (Array.isArray(data?.[key])) return data[key];
  throw new Error('Unexpected catalogue list response');
}
let reportWrites = Promise.resolve();
async function saveReport() {
  const snapshot = JSON.stringify(report, null, 2) + '\n';
  const destination = resolve(values.report!);
  reportWrites = reportWrites.then(async () => {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination + '.tmp', snapshot);
    await rename(destination + '.tmp', destination);
  });
  await reportWrites;
}

const lock = await pool.connect();
try {
  await lock.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`${organizationId}:linkel-remotes-import`]);
  if (pkg.schemaVersion !== 'daja.catalog-package.v1' || pkg.products?.length !== 1072 || pkg.defaults.imageQuality !== 60) throw new Error('Expected the reviewed 1072-product AVIF60 remotes package.');
  const ids = new Set<string>(), skus = new Set<string>(), slugs = new Set<string>();
  const mediaById = new Map<string, any>(pkg.media.map((m: any) => [m.id, m]));
  const prepared: any[] = [];
  for (const product of pkg.products) {
    const n = product.normalizedRow;
    if (!/^LINKEL-\d+$/.test(product.externalId) || ids.has(product.externalId) || !product.sku || skus.has(product.sku)) throw new Error('Duplicate or invalid import ID/SKU');
    ids.add(product.externalId); skus.add(product.sku);
    if (!Number.isSafeInteger(n.priceMinor) || n.priceMinor <= 0 || product.stockQuantity !== 1 || !product.brandSlug || !product.categorySlug) throw new Error(`Invalid price, stock or taxonomy for ${product.externalId}`);
    const sourceUrl = new URL(product.source.source_url);
    if (sourceUrl.protocol !== 'https:' || sourceUrl.hostname !== 'www.linkel.rs') throw new Error('Unexpected source URL');
    const productSlug = n.slug;
    if (!productSlug || slugs.has(productSlug)) throw new Error('Duplicate product slug');
    slugs.add(productSlug);
    const assets = [];
    for (const [position, ref] of product.mediaRefs.entries()) {
      const media = mediaById.get(ref);
      if (!media) throw new Error('Missing media ref');
      for (const asset of [media.image, media.thumbnail]) {
        const file = resolve(root, asset.path);
        if (!file.startsWith(root + sep) || asset.mimeType !== 'image/avif') throw new Error('Invalid AVIF path/type');
        const buffer = await readFile(file), metadata = await sharp(buffer).metadata();
        if (sha(buffer) !== asset.sha256 || buffer.length !== asset.sizeBytes || metadata.width !== asset.width || metadata.height !== asset.height || metadata.format !== 'heif') throw new Error(`Invalid image ${ref}`);
      }
      const mediaId = stableId(`${organizationId}:${product.externalId}:${ref}:${media.image.sha256}`);
      const key = productMediaStorageKey({ organizationId, mediaId, productSlug, imageIndex: position + 1, extension: '.avif' });
      assets.push({ media, mediaId, key, thumbnailKey: key.replace(/\.avif$/, '-thumb.avif'), position });
    }
    if (!assets.length) throw new Error('Every remote needs a primary image');
    prepared.push({ product, productName: n.name, productSlug, assets });
  }
  const [departments, brands, cats, locations] = await Promise.all([
    api('/departments').then(rows), api('/brands').then(rows), api('/categories').then(rows),
    pool.query('SELECT id,code,active FROM locations WHERE organization_id=$1 AND active AND deleted_at IS NULL', [organizationId]).then(r => r.rows)
  ]);
  const department = departments.find(x => x.slug === 'daljinski' && x.active);
  const location = locations.find(x => x.code === 'C31' && x.active);
  if (!department || !location) throw new Error('Existing active Daljinski department and C31 location required');
  const existing = (await pool.query(`SELECT p.id,p.external_id,p.slug,v.id AS variant_id,v.sku,v.attributes,
    (SELECT a.metadata->>'packageHash' FROM product_media pm JOIN media_assets a ON a.id=pm.media_asset_id AND a.organization_id=pm.organization_id
      WHERE pm.organization_id=p.organization_id AND pm.product_id=p.id AND a.deleted_at IS NULL ORDER BY pm.is_primary DESC,pm.position LIMIT 1) AS media_package_hash
    FROM products p LEFT JOIN product_variants v ON v.organization_id=p.organization_id AND v.product_id=p.id AND v.deleted_at IS NULL
    WHERE p.organization_id=$1 AND p.deleted_at IS NULL AND (p.external_id=ANY($2::text[]) OR p.slug=ANY($3::text[]) OR v.sku=ANY($4::text[]))`,
    [organizationId, [...ids], [...slugs], [...skus]])).rows;
  for (const old of existing) {
    const item = prepared.find(x => x.product.externalId === old.external_id && x.product.sku === old.sku && x.productSlug === old.slug);
    if (!item || (old.attributes?._catalog_import?.packageHash !== packageHash && old.media_package_hash !== packageHash)) throw new Error('Unrelated product uses an import ID, SKU or slug; nothing will be overwritten');
  }
  console.log(JSON.stringify({ mode: values.apply ? 'apply' : 'preview', products: prepared.length, alreadyImported: existing.length, media: pkg.media.length, brandCount: pkg.taxonomy.brands.length, categoryBindings: pkg.taxonomy.brandCategoryBindings.length, priceOverrides: pkg.products.filter((p: any) => p.priceOverride).length, stockPerProduct: 1 }));
  if (values.apply) {
    const storage = new R2MediaStorageAdapter({ R2_ACCOUNT_ID: env.R2_ACCOUNT_ID!, R2_BUCKET: env.R2_BUCKET!, R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID!, R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY!, R2_ENDPOINT: env.R2_ENDPOINT!, MEDIA_PUBLIC_BASE_URL: env.MEDIA_PUBLIC_BASE_URL! });
    if (storage.bucket() !== 'dajashop-images' || new URL(storage.publicUrl('probe')!).hostname !== 'cdn.dajashop.rs') throw new Error('Unexpected R2/CDN destination');
    const brandIds: Record<string, string> = {}, categoryIds: Record<string, string> = {};
    for (const b of pkg.taxonomy.brands) {
      let current = brands.find(x => x.departmentId === department.id && x.slug === b.slug);
      if (current && (!current.active || current.name !== b.name)) throw new Error('Existing brand has conflicting name/state');
      if (!current) current = await api('/brands', { name: b.name, slug: b.slug, departmentId: department.id, active: true });
      if (!current.id) throw new Error('Missing brand id');
      brandIds[b.slug] = current.id;
    }
    for (const [index, binding] of pkg.taxonomy.brandCategoryBindings.entries()) {
      const c = pkg.taxonomy.categories.find((x: any) => x.slug === binding.categorySlug);
      const brandId = brandIds[binding.brandSlug];
      if (!c || !brandId) throw new Error('Invalid category binding');
      let current = cats.find(x => x.departmentId === department.id && x.brandId === brandId && x.slug === c.slug);
      if (current && (!current.active || current.name !== c.name)) throw new Error('Existing category has conflicting name/state');
      if (!current) current = await api('/categories', { name: c.name, slug: c.slug, departmentId: department.id, brandId, sortOrder: (index + 1) * 10, active: true });
      if (!current.id) throw new Error('Missing category id');
      categoryIds[`${binding.brandSlug}:${c.slug}`] = current.id;
    }
    console.log('Taxonomy ready: 130 compatibility brands and 167 brand/category bindings');
    async function importOne(item: any) {
      const { product, productName, productSlug, assets } = item;
      const old = existing.find(x => x.external_id === product.externalId);
      if (old?.attributes?._catalog_import?.packageHash === packageHash) {
        // Keep an untranslated source description in the product's source language.
        if (old.attributes?._translations?.en?.description === product.normalizedRow.description) {
          const attributes = structuredClone(old.attributes);
          delete attributes._translations.en.description;
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const ctx = { organizationId, userId: values.actor!, requestId: stableId(`${old.id}:source-language:${packageHash}`), correlationId: stableId(`${organizationId}:linkel-remotes:${packageHash}`), roles: [], permissions: [] };
            const changed = await new CatalogRepository(client).patchVariant(ctx, old.variant_id, { attributes });
            await new AuditRepository(client).append({ ctx, aggregateType: 'variant', aggregateId: old.variant_id, operation: 'update', beforePayload: changed.before, afterPayload: changed.after, reason: 'Preserve untranslated supplier description in its source language' });
            await new StorefrontRepository(client).refreshProductSnapshots({ organizationId, productId: old.id });
            await new OperationalSyncProjector(client).publishProductChange(ctx, old.id, old.variant_id);
            await new OutboxRepository(client).append({ ctx, eventType: 'ProductUpdated', aggregateType: 'product', aggregateId: old.id, payload: { productId: old.id, variantId: old.variant_id, published: true } });
            await client.query('COMMIT');
          } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
        }
        report.products.push({ externalId: product.externalId, sku: product.sku, productId: old.id, variantId: old.variant_id, slug: old.slug, status: 'already_imported' });
        await saveReport(); return;
      }
      for (const a of assets) {
        const { media, mediaId, key, thumbnailKey } = a;
        const known = (await pool.query('SELECT checksum_sha256,status FROM media_assets WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL', [organizationId, mediaId])).rows[0];
        if (known && known.checksum_sha256 !== media.image.sha256) throw new Error('Media identifier collision');
        if (!known || known.status !== 'ready') {
          for (const [index, asset] of [media.image, media.thumbnail].entries()) {
            await storage.putObject({ key: index === 0 ? key : thumbnailKey, body: await readFile(resolve(root, asset.path)), contentType: 'image/avif', cacheControl: 'public, max-age=31536000, immutable', sizeBytes: asset.sizeBytes, metadata: { sha256: asset.sha256, source: 'linkel', 'source-id': product.source.source_id, quality: '60' } });
          }
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query(`INSERT INTO media_assets (id,organization_id,storage_provider,storage_bucket,storage_key,public_url,mime_type,size_bytes,checksum_sha256,status,metadata)
              VALUES ($1,$2,'r2',$3,$4,$5,'image/avif',$6,$7,'uploaded',$8::jsonb) ON CONFLICT (id) DO NOTHING`,
              [mediaId, organizationId, storage.bucket(), key, storage.publicUrl(key), media.image.sizeBytes, media.image.sha256, JSON.stringify({ source: 'linkel', sourceId: product.source.source_id, sourceUrl: media.sourceUrl, packageHash, format: 'avif', quality: 60 })]);
            const ready = await new MediaRepository(client).markReady({ organizationId, mediaId, width: media.image.width, height: media.image.height, derivatives: [{ width: media.thumbnail.width, height: media.thumbnail.height, mimeType: 'image/avif', storageKey: thumbnailKey, publicUrl: storage.publicUrl(thumbnailKey)!, sizeBytes: media.thumbnail.sizeBytes, checksumSha256: media.thumbnail.sha256 }] });
            if (!ready) throw new Error('Could not register prepared image');
            await client.query('COMMIT');
          } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
        }
      }
      const description = product.normalizedRow.description || productName;
      const categoryName = product.normalizedRow.category;
      const englishName = productName.replace(/Daljinski za/ig, 'Remote control for').replace(/KLIMU/g, 'AIR CONDITIONER');
      const attributes = {
        _translations: { en: { name: englishName, ...(product.translations?.en?.description ? { description: product.translations.en.description } : {}), metaDescription: summary(englishName) } },
        _catalog_import: { supplier: 'Linkel', packageHash, externalId: product.externalId, sourceUrl: product.source.source_url, supplierSku: product.supplierSku, sourceAvailability: product.source.availability, priceOverride: product.priceOverride ?? null, replacementModels: product.replacements },
        tip: categoryName, supplier_sku: product.supplierSku
      };
      const saved = await api('/admin/catalog/save', {
        requestId: stableId(`${organizationId}:linkel-remotes:${packageHash}:${product.externalId}:stock1-published:${old ? `recover-${old.id}` : 'create'}`),
        ...(old ? { id: old.id } : {}),
        product: { name: productName, slug: productSlug, externalId: product.externalId, description, departmentId: department.id, brandId: brandIds[product.brandSlug], primaryCategoryId: categoryIds[`${product.brandSlug}:${product.categorySlug}`], itemCondition: 'new', active: true, published: true, linkelUrl: product.source.source_url, seo: { metaTitle: productName, metaDescription: summary(description) } },
        variant: { ...(old ? { id: old.variant_id } : {}), sku: product.sku, mpn: /^[A-Za-z0-9]/.test(product.supplierSku) ? product.supplierSku : null, currentPriceAmount: product.normalizedRow.priceMinor, currency: 'RSD', active: true, published: true, attributes: { tip: categoryName, supplier_sku: product.supplierSku } },
        stock: { quantity: 1, reconcileQuantity: true, persistPlacement: true, pieces: [{ epc: '', locationId: location.id, zoneId: null, binId: null }] },
        media: assets.map((a: any) => ({ mediaId: a.mediaId, position: a.position, isPrimary: a.position === 0, altText: productName })), removedMediaLinkIds: [], deletedVariantIds: []
      });
      if (!saved.productId || !saved.variantId) throw new Error('Save did not return product and variant IDs');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const ctx = { organizationId, userId: values.actor!, requestId: stableId(`${saved.productId}:metadata:${packageHash}`), correlationId: stableId(`${organizationId}:linkel-remotes:${packageHash}`), roles: [], permissions: [] };
        await client.query('SELECT id FROM product_variants WHERE organization_id=$1 AND id=$2 FOR UPDATE', [organizationId, saved.variantId]);
        const changed = await new CatalogRepository(client).patchVariant(ctx, saved.variantId, { attributes });
        await new AuditRepository(client).append({ ctx, aggregateType: 'variant', aggregateId: saved.variantId, operation: 'update', beforePayload: changed.before, afterPayload: changed.after, reason: 'Reviewed Linkel remotes import: provenance, replacements and user-authorized temporary price' });
        await new StorefrontRepository(client).refreshProductSnapshots({ organizationId, productId: saved.productId });
        await new OperationalSyncProjector(client).publishProductChange(ctx, saved.productId, saved.variantId);
        await new OutboxRepository(client).append({ ctx, eventType: 'ProductUpdated', aggregateType: 'product', aggregateId: saved.productId, payload: { productId: saved.productId, variantId: saved.variantId, slug: productSlug, published: true } });
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
      report.products.push({ externalId: product.externalId, sku: product.sku, supplierSku: product.supplierSku, name: productName, category: categoryName, productId: saved.productId, variantId: saved.variantId, slug: productSlug, priceMinor: product.normalizedRow.priceMinor, temporaryPrice: Boolean(product.priceOverride), quantity: 1, published: true, imageCount: assets.length, imageUrl: storage.publicUrl(assets[0].key), status: 'imported' });
      await saveReport();
      console.log(`Imported ${report.products.length}/${prepared.length}: ${product.sku}`);
    }
    // Four workers bound API/database pressure; each product uses idempotent staff-save requests.
    let next = 0, stopped = false;
    const workers = await Promise.allSettled(Array.from({ length: 4 }, async () => {
      while (!stopped && next < prepared.length) {
        const item = prepared[next++];
        for (let attempt = 0; ; attempt++) {
          try { await importOne(item); break; }
          catch (e) {
            if (attempt < 5 && ['40P01', '40001'].includes(String((e as any)?.code))) {
              console.warn(`Retrying rolled-back metadata transaction for ${item.product.externalId}`);
              await delay(Math.min(4000, 500 * 2 ** attempt) + Math.random() * 250); continue;
            }
            stopped = true; throw e;
          }
        }
      }
    }));
    const failed = workers.find(x => x.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    const result = await pool.query(`SELECT p.external_id,p.published,p.active,v.sku,v.current_price_amount,v.published AS variant_published,
      COALESCE((SELECT SUM(b.quantity) FROM inventory_balances b WHERE b.organization_id=p.organization_id AND b.variant_id=v.id),0)::int AS quantity,
      (SELECT COUNT(*) FROM product_media pm JOIN media_assets a ON a.id=pm.media_asset_id AND a.organization_id=pm.organization_id WHERE pm.organization_id=p.organization_id AND pm.product_id=p.id AND a.mime_type='image/avif' AND a.status='ready')::int AS images
      FROM products p JOIN product_variants v ON v.product_id=p.id AND v.organization_id=p.organization_id AND v.deleted_at IS NULL
      WHERE p.organization_id=$1 AND p.external_id=ANY($2::text[]) AND p.deleted_at IS NULL`, [organizationId, [...ids]]);
    if (result.rowCount !== 1072 || result.rows.some(x => {
      const item = prepared.find(p => p.product.externalId === x.external_id)!;
      return x.quantity !== 1 || !x.published || !x.active || !x.variant_published || x.images !== item.assets.length || Number(x.current_price_amount) !== item.product.normalizedRow.priceMinor;
    })) throw new Error('Persisted catalogue, prices, media or stock do not match the package');
    report.completedAt = new Date().toISOString(); await saveReport();
    console.log('Completed: 1072 published remotes, 178 temporary prices at 900 RSD, one unit each, AVIF60 originals and thumbnails.');
  }
} finally {
  await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`${organizationId}:linkel-remotes-import`]).catch(() => {});
  lock.release(); await pool.end();
}
