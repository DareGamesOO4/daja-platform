/* Explicit, owner-requested maintenance. No write without --apply and a reviewed backup. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const organizationId = '00000000-0000-4000-8000-000000000101';
const brandId = '43726b8b-cf63-459e-a360-8ce7ef92a678';
const departmentId = '0570a9bd-f20e-44da-bacc-b76f5a6db499';
const runId = 'qq-male-prices-20261102';
const batchOperation = 'catalog.prices.reprice';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalModel = value => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const localRequire = name => require(require.resolve(name, { paths: [process.cwd(), __dirname] }));
const moduleImport = file => import(pathToFileURL(path.resolve(file)).href);
const scope = `p.organization_id=$1 AND p.brand_id=$2 AND p.department_id=$3
 AND p.deleted_at IS NULL AND v.organization_id=p.organization_id AND v.deleted_at IS NULL
 AND translate(upper(v.gender),'ŠŽ','SZ')='MUSKI'`;

function scaled(value, decimals) {
  const match = String(value).match(new RegExp(`^(\\d+)(?:\\.(\\d{1,${decimals}}))?$`));
  if (!match) throw Error('Invalid exact decimal');
  return BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt((match[2] ?? '').padEnd(decimals, '0'));
}

function validatePlan(plan) {
  if (plan.runId !== runId || !plan.rate.directNbsConfirmed || plan.rate.source !== 'NBS') throw Error('Wrong plan or unconfirmed NBS rate');
  const rate = scaled(plan.rate.eurRsdRate, 4);
  if (rate < 1000000n || rate > 1400000n) throw Error('Unexpected EUR/RSD rate');
  const ids = new Set(), products = new Set();
  const ready = plan.rows.filter(row => row.status === 'ready');
  if (!ready.length || ready.length !== plan.counts.ready || plan.rows.length !== plan.counts.total || plan.counts.sourcesPending) throw Error('Incomplete plan');
  for (const row of ready) {
    if (!row.variantId || ids.has(row.variantId) || products.has(row.productId)) throw Error('Missing or duplicate identity');
    ids.add(row.variantId); products.add(row.productId);
    const sourcePrice = (key, host) => {
      const source = row.sources[key];
      if (source?.status !== 'verified') return null;
      if (new URL(source.finalUrl ?? source.url).hostname.replace(/^www\./, '') !== host || source.currency !== 'EUR' || source.http !== 200) throw Error('Unexpected source');
      if (!source.checkedAt || !source.title || !source.priceFragment) throw Error('Missing source evidence');
      return scaled(source.priceEUR, 2) * rate;
    };
    const timezone = sourcePrice('timezone', 'timezone-bg.com');
    const stilius = sourcePrice('qandq', 'qandq-casio.com');
    let numerator, denominator = 1000000n, rule;
    if (timezone !== null && stilius !== null && stilius > timezone) {
      numerator = timezone + stilius; denominator *= 2n; rule = 'average_when_stilius_higher';
    } else if (timezone !== null) { numerator = timezone; rule = 'timezone'; }
    else if (stilius !== null) { numerator = stilius; rule = 'stilius_only'; }
    else throw Error('No verified price');
    const hundred = denominator * 100n;
    const target = Number(((numerator + hundred - 1n) / hundred) * 100n + 200n);
    if (target !== row.targetRsd || row.targetMinor !== target * 100 || row.rule !== rule || !Number.isSafeInteger(row.currentPublicPriceMinor)) throw Error(`Invalid calculation or price units: ${row.model}`);
  }
  return ready;
}

async function inspect(client) {
  const result = await client.query(`SELECT to_jsonb(p) AS product,to_jsonb(v) AS variant
    FROM products p JOIN product_variants v ON v.product_id=p.id WHERE ${scope} ORDER BY p.id,v.id`, [organizationId, brandId, departmentId]);
  return result.rows;
}

function checkIdentities(live, plan, ready, baseline = true) {
  const byVariant = new Map(live.map(row => [row.variant.id, row]));
  const plannedProducts = new Set(plan.rows.map(row => row.productId));
  if (live.some(row => !plannedProducts.has(row.product.id))) throw Error('New male Q&Q products appeared; refresh the source plan first');
  for (const row of ready) {
    const found = byVariant.get(row.variantId);
    if (!found || found.product.id !== row.productId || found.product.slug !== row.slug || found.variant.currency !== 'RSD' || ![found.product.name, found.variant.mpn, found.variant.name, found.variant.sku].some(value => normalModel(value) === normalModel(row.model))) throw Error(`Identity/scope mismatch: ${row.model}`);
    // Public catalog cards return minor units, not whole dinars.
    if (baseline && Number(found.variant.current_price_amount) !== row.currentPublicPriceMinor) throw Error(`Price changed since source capture: ${row.model}`);
  }
}

async function prices(client, ids) {
  return (await client.query(`SELECT to_jsonb(vp) AS price FROM variant_prices vp
    WHERE organization_id=$1 AND variant_id=ANY($2::uuid[]) ORDER BY vp.id`, [organizationId, ids])).rows.map(row => row.price);
}

function invariantRows(rows, selected) {
  return rows.map(({ product, variant }) => {
    const copy = { ...variant };
    if (selected.has(copy.id)) {
      delete copy.current_price_amount; delete copy.version; delete copy.updated_at;
    }
    return { product, variant: copy };
  });
}

async function clearCache(client, ready) {
  if (!process.env.REDIS_URL) throw Error('REDIS_URL missing');
  const Redis = localRequire('ioredis');
  const redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true, connectTimeout: 5000 });
  try {
    await redis.connect();
    const slugs = (await client.query('SELECT slug FROM products WHERE organization_id=$1 AND id=ANY($2::uuid[])', [organizationId, ready.map(row => row.productId)])).rows.map(row => row.slug);
    const keys = ['catalog:sitemap:', 'catalog:sitemap:v2:', 'catalog:sitemap:v3:', 'catalog:sitemap:v4:', 'catalog:merchant-feed:', 'catalog:merchant-feed:v2:', 'catalog:merchant-feed:v3:'].map(prefix => prefix + organizationId);
    keys.push(...slugs.flatMap(slug => ['catalog:slug:', 'catalog:slug:public-v2:', 'catalog:slug:public-v3:'].map(prefix => `${prefix}${organizationId}:${slug}`)));
    for (let offset = 0; offset < keys.length; offset += 250) await redis.del(...keys.slice(offset, offset + 250));
    return true;
  } finally { redis.disconnect(); }
}

async function run() {
  const [mode = '--inspect', planFile, backupFile = '/tmp/qq-male-prices-20261102-before.json'] = process.argv.slice(2);
  if (!['--inspect', '--backup', '--apply', '--verify', '--cache'].includes(mode) || !planFile) throw Error('Usage: reprice-qq-male.cjs --inspect|--backup|--apply|--verify|--cache plan.json [backup.json]');
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const ready = validatePlan(plan), ids = ready.map(row => row.variantId), selected = new Set(ids);
  const planHash = hash({ runId, rate: plan.rate, rows: plan.rows });
  const { Client } = localRequire('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  let committed = false;
  try {
    await client.query("SET TIME ZONE 'UTC'");
    if (mode === '--cache') { console.log(JSON.stringify({ cacheCleared: await clearCache(client, ready) })); return; }
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='30s'");
    if (mode === '--apply') {
      await client.query('SELECT id FROM products WHERE organization_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE', [organizationId, ready.map(row => row.productId)]);
      await client.query('SELECT id FROM product_variants WHERE organization_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE', [organizationId, ids]);
      await client.query('SELECT id FROM variant_prices WHERE organization_id=$1 AND variant_id=ANY($2::uuid[]) ORDER BY id FOR UPDATE', [organizationId, ids]);
    }
    const live = await inspect(client), history = await prices(client, ids);
    checkIdentities(live, plan, ready, mode !== '--verify');
    const currentSales = await client.query(`SELECT id FROM variant_prices WHERE organization_id=$1 AND variant_id=ANY($2::uuid[])
      AND price_type='sale' AND cancelled_at IS NULL AND (valid_until IS NULL OR valid_until>now())`, [organizationId, ids]);
    if (currentSales.rowCount) throw Error('Active or scheduled sale prices require separate review');
    const marker = await client.query('SELECT id,after_payload FROM audit_events WHERE organization_id=$1 AND request_id=$2 AND operation=$3', [organizationId, runId, batchOperation]);
    const body = { runId, organizationId, brandId, departmentId, planHash, rows: live, prices: history };
    const fingerprint = hash(body);
    if (mode === '--inspect' || mode === '--backup') {
      if (marker.rowCount) throw Error('Already applied; use --verify');
      if (mode === '--backup') fs.writeFileSync(backupFile, JSON.stringify({ ...body, fingerprint }), { flag: 'wx', mode: 0o600 });
      await client.query('ROLLBACK');
      console.log(JSON.stringify({ mode, scope: live.length, ready: ready.length, skipped: plan.rows.length - ready.length, fingerprint, planHash,
        sample: ready.slice(0, 4).map(row => ({ model: row.model, beforeRsd: row.currentPublicPriceMinor / 100, targetRsd: row.targetRsd })) }));
      return;
    }
    const backup = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
    const { fingerprint: savedFingerprint, ...savedBody } = backup;
    if (hash(savedBody) !== savedFingerprint || backup.planHash !== planHash || backup.runId !== runId) throw Error('Invalid backup or changed plan');
    if (mode === '--verify') {
      const mismatches = ready.filter(row => Number(live.find(item => item.variant.id === row.variantId)?.variant.current_price_amount) !== row.targetMinor);
      const audits = await client.query("SELECT count(*)::int AS count FROM audit_events WHERE organization_id=$1 AND request_id=$2 AND operation='price_change'", [organizationId, runId]);
      const current = history.filter(row => row.price_type === 'sell' && row.valid_until === null);
      const historyValid = ready.every(row => current.filter(item => item.variant_id === row.variantId).length === 1 && Number(current.find(item => item.variant_id === row.variantId)?.amount_minor) === row.targetMinor);
      if (marker.rowCount !== 1 || audits.rows[0].count !== ready.length || mismatches.length || !historyValid) throw Error(`Verification mismatch: ${mismatches.map(row => row.model).join(',')}`);
      await client.query('ROLLBACK');
      console.log(JSON.stringify({ verified: true, prices: ready.length, audits: audits.rows[0].count, historyValid, backupFingerprint: savedFingerprint, planHash }));
      return;
    }
    if (marker.rowCount || process.env.QQ_PRICES_EXPECTED_FINGERPRINT !== savedFingerprint || fingerprint !== savedFingerprint) throw Error('Already applied, missing reviewed fingerprint, or catalog changed after backup');
    const { CatalogRepository, StorefrontRepository, AuditRepository, OutboxRepository } = await moduleImport('packages/database/dist/index.js');
    const { OperationalSyncProjector } = await moduleImport('apps/api/dist/operational-sync-projector.js');
    const ctx = { organizationId, requestId: runId, correlationId: crypto.randomUUID(), userId: null, deviceId: null };
    const catalog = new CatalogRepository(client), audit = new AuditRepository(client), outbox = new OutboxRepository(client);
    const storefront = new StorefrontRepository(client), projector = new OperationalSyncProjector(client);
    const byId = new Map(live.map(row => [row.variant.id, row.variant]));
    const reason = 'Owner requested male Q&Q prices: Timezone, average when Stilius higher, round up to 100 RSD then add 200 RSD; NBS ' + plan.rate.asOf;
    let changed = 0;
    for (const row of ready) {
      const { before, after, priceChanged } = await catalog.patchVariant(ctx, row.variantId, { expectedVersion: Number(byId.get(row.variantId).version), currentPriceAmount: row.targetMinor });
      if (!priceChanged) throw Error('Unexpected no-op; refresh the plan');
      await storefront.refreshProductSnapshots({ organizationId, productId: row.productId });
      await audit.append({ ctx, aggregateType: 'variant', aggregateId: row.variantId, operation: 'price_change', beforePayload: before, afterPayload: after, reason });
      await outbox.append({ ctx, eventType: 'PriceChanged', aggregateType: 'variant', aggregateId: row.variantId, payload: { variantId: row.variantId, productId: row.productId, price: row.targetMinor } });
      // Audit request IDs are text; sync request IDs must be UUIDs.
      await projector.publishProductChange({ ...ctx, requestId: ctx.correlationId }, row.productId, row.variantId, 'update');
      changed++;
    }
    const after = await inspect(client);
    if (hash(invariantRows(live, selected)) !== hash(invariantRows(after, selected))) throw Error('Fields other than selected prices, versions and update times changed');
    if (ready.some(row => Number(after.find(item => item.variant.id === row.variantId)?.variant.current_price_amount) !== row.targetMinor)) throw Error('Final price mismatch');
    const report = { committed: true, runId, changed, skipped: plan.rows.length - ready.length, invariantFieldsUnchanged: true, priceHistoryAndAudit: changed, syncEvents: changed, planHash, backupFingerprint: savedFingerprint, at: new Date().toISOString() };
    await audit.append({ ctx, aggregateType: 'catalog_brand', aggregateId: brandId, operation: batchOperation, beforePayload: backup, afterPayload: { ...report, sources: plan.rows.map(row => ({ model: row.model, status: row.status, sources: row.sources, targetRsd: row.targetRsd })) }, reason });
    await client.query('COMMIT'); committed = true;
    let cacheCleared = false;
    try { cacheCleared = await clearCache(client, ready); } catch { console.log('Prices COMMITTED; retry --cache. Do not repeat --apply.'); }
    fs.writeFileSync(backupFile + '.applied.json', JSON.stringify({ ...report, cacheCleared }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ ...report, cacheCleared }));
  } catch (error) {
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    if (committed) console.error('Prices already committed. Use --verify; never repeat --apply.');
    throw error;
  } finally { await client.end(); }
}

if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { run, validatePlan, runId };
