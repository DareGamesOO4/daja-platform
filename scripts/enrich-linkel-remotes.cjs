/** Apply a reviewed, evidence-backed remote catalogue plan via the staff API.
 * The caller supplies its existing authorized staff token and tenant-scoped pool.
 * Preview is read-only; run({apply:true,...}) is required for mutations.
 * No media/stock/brand writes, and no inferred negative answers.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run({ planPath, reportPath, pool, token, apiBase, organizationId, apply = false }) {
  // pg removes a failed idle client itself; handle the event without dumping connection details.
  if (!pool.listenerCount('error')) pool.on('error', () => console.warn('Database idle connection closed; reconnecting.'));
  const bytes = await fs.readFile(planPath);
  const plan = JSON.parse(bytes);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  if (claims.org !== organizationId || plan.organizationId !== organizationId) throw Error('Staff/plan tenant mismatch');
  if (new URL(apiBase).protocol !== 'https:') throw Error('HTTPS staff API required');
  if (plan.schemaVersion !== 1 || plan.products.length !== 1071 || plan.review.images !== 1414) throw Error('Incomplete reviewed plan');
  const excluded = new Set(plan.excluded.map(p => p.externalId));
  if (!excluded.has('LINKEL-195') || plan.products.some(p => excluded.has(p.externalId))) throw Error('Excluded product present');
  if (new Set(plan.products.map(p => p.variantId)).size !== plan.products.length) throw Error('Duplicate variants');
  const keys = new Set(plan.definitions.map(d => d.key));
  for (const p of plan.products) {
    if (!p.brand.startsWith('Za ') || p.price < 10000 || p.price % 10000 || p.price > p.expectedPrice) throw Error('Unsafe price or compatibility brand: ' + p.externalId);
    if (Object.keys(p.specs).some(k => !keys.has(k) || !p.evidence[k])) throw Error('Specification without definition/evidence');
    if (p.specs.garancija_daljinskog !== '2 godine') throw Error('Missing confirmed shop warranty');
  }
  const api = async (endpoint, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(apiBase.replace(/\/$/, '') + endpoint, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000)
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) { const error = Error(`${endpoint}: HTTP ${response.status}`); error.status = response.status; throw error; }
    return data && typeof data === 'object' && 'data' in data ? data.data : data;
  };
  const report = { planHash: hash, startedAt: new Date().toISOString(), apply, review: plan.review, excluded: plan.excluded, definitions: [], completed: [], failures: [] };
  let writes = Promise.resolve();
  const checkpoint = () => {
    const snapshot = JSON.stringify(report, null, 2);
    writes = writes.then(async () => { await fs.mkdir(path.dirname(reportPath), { recursive: true }); await fs.writeFile(reportPath + '.tmp', snapshot); await fs.rename(reportPath + '.tmp', reportPath); });
    return writes;
  };
  const current = async p => {
    const result = await pool.query(`SELECT v.id,v.version,v.attributes,v.current_price_amount,p.external_id,p.department_id,b.name AS brand
      FROM product_variants v JOIN products p ON p.id=v.product_id AND p.organization_id=v.organization_id
      JOIN brands b ON b.id=p.brand_id AND b.organization_id=p.organization_id
      WHERE v.organization_id=$1 AND v.id=$2 AND p.id=$3 AND v.deleted_at IS NULL AND p.deleted_at IS NULL`, [organizationId, p.variantId, p.productId]);
    const row = result.rows[0];
    if (!row || row.external_id !== p.externalId || row.department_id !== plan.departmentId || row.brand !== p.brand || !row.brand.startsWith('Za ')) throw Error('Catalogue identity changed: ' + p.externalId);
    return row;
  };
  // Validate every current row in one tenant-scoped read before any mutation.
  const baseline = (await pool.query(`SELECT v.id,v.attributes,v.current_price_amount,p.external_id,p.department_id,p.id AS product_id,b.name AS brand
    FROM product_variants v JOIN products p ON p.id=v.product_id AND p.organization_id=v.organization_id
    JOIN brands b ON b.id=p.brand_id AND b.organization_id=p.organization_id
    WHERE v.organization_id=$1 AND v.id=ANY($2::uuid[]) AND v.deleted_at IS NULL AND p.deleted_at IS NULL`, [organizationId, plan.products.map(p => p.variantId)])).rows;
  const baselineById = new Map(baseline.map(row => [row.id, row]));
  for (const p of plan.products) {
    const row = baselineById.get(p.variantId);
    if (!row || row.external_id !== p.externalId || row.department_id !== plan.departmentId || row.product_id !== p.productId || row.brand !== p.brand) throw Error('Catalogue identity changed: ' + p.externalId);
    const applied = row.attributes._catalog_import?.specificationReview?.planHash === hash;
    if (!applied && (!isDeepStrictEqual(row.attributes, p.expectedAttributes) || Number(row.current_price_amount) !== p.expectedPrice)) throw Error('Concurrent product edit: ' + p.externalId);
  }
  await checkpoint();
  if (!apply) return report;
  let definitions = await api('/spec_keys');
  for (const definition of plan.definitions) {
    let found = definitions.find(s => s.slug === definition.slug || s.name === definition.name);
    const payload = { name: definition.name, slug: definition.slug, departmentId: plan.departmentId, unit: definition.unit, dataType: definition.dataType, optionValues: definition.optionValues, active: true };
    if (found && found.departmentId !== plan.departmentId) throw Error('Definition belongs to another department: ' + definition.name);
    if (!found) {
      // Reconcile an uncertain POST response before considering another creation.
      try { await api('/spec_keys', payload); }
      catch (error) { definitions = await api('/spec_keys'); if (!definitions.some(s => s.slug === definition.slug && s.departmentId === plan.departmentId)) throw error; }
      definitions = await api('/spec_keys'); found = definitions.find(s => s.slug === definition.slug);
    }
    if (!found || !isDeepStrictEqual(found.optionValues, definition.optionValues)) throw Error('Unexpected saved answer options: ' + definition.name);
    report.definitions.push({ ...definition, id: found.id });
  }
  // Initialize through an existing answer so the API returns a stored configuration version.
  const warranty = report.definitions.find(d => d.key === 'garancija_daljinskog');
  let editor = await api('/specification-editor', { action: 'get', departmentId: plan.departmentId });
  if (!editor.version) editor = await api('/specification-editor', { action: 'option', departmentId: plan.departmentId, specId: warranty.id, value: '2 godine' });
  const configuration = { groups: plan.groups, fields: report.definitions.map((d, order) => ({ specId: d.id, groupId: d.group, order, visibility: [], options: d.optionValues.map(value => ({ value, rules: [] })) })) };
  if (!isDeepStrictEqual(editor.configuration, configuration)) await api('/specification-editor', { action: 'configure', departmentId: plan.departmentId, version: editor.version, configuration });
  await checkpoint();
  let next = 0;
  const update = async p => {
    for (let attempt = 0; attempt < 7; attempt++) {
      try {
        const row = await current(p);
        const already = row.attributes._catalog_import?.specificationReview?.planHash === hash;
        if (already) {
          if (Number(row.current_price_amount) !== p.price || Object.entries(p.specs).some(([k, v]) => row.attributes[k] !== v)) throw Error('Saved review subsequently edited: ' + p.externalId);
        } else {
          if (!isDeepStrictEqual(row.attributes, p.expectedAttributes) || Number(row.current_price_amount) !== p.expectedPrice) throw Error('Concurrent edit: ' + p.externalId);
          const attributes = { ...row.attributes, ...p.specs, _catalog_import: { ...row.attributes._catalog_import, specificationReview: { planHash: hash, reviewedAt: new Date().toISOString(), previousPriceAmount: p.expectedPrice, rounding: 'floor_to_100_RSD', evidence: p.evidence } } };
          // Replace only the two legacy attributes created by this supplier import.
          if (attributes.supplier_sku === p.sku) delete attributes.supplier_sku;
          if (attributes.tip === p.expectedAttributes.tip) delete attributes.tip;
          await api('/variants/' + p.variantId, { attributes, currentPriceAmount: p.price, expectedVersion: Number(row.version) }, 'PATCH');
        }
        report.completed.push({ externalId: p.externalId, sku: p.sku, previousPriceRsd: p.expectedPrice / 100, priceRsd: p.price / 100, specifications: Object.keys(p.specs).length, resumed: already });
        await checkpoint();
        if (report.completed.length % 50 === 0) console.log(`Saved ${report.completed.length}/${plan.products.length}`);
        return;
      } catch (error) {
        if (([409,429,500,502,503,504].includes(error.status) || error.name === 'TimeoutError' || error instanceof TypeError || /connection terminated|connection timeout|ECONNRESET|ETIMEDOUT/i.test(error.message)) && attempt < 6) { await delay(Math.min(8000, 500 * 2 ** attempt)); continue; }
        report.failures.push({ externalId: p.externalId, error: error.message }); await checkpoint(); return;
      }
    }
  };
  await Promise.all(Array.from({ length: 3 }, async () => { while (next < plan.products.length) await update(plan.products[next++]); }));
  report.finishedAt = new Date().toISOString();
  report.success = report.completed.length === plan.products.length && !report.failures.length;
  await checkpoint();
  console.log(JSON.stringify({ success: report.success, saved: report.completed.length, failed: report.failures.length, definitions: report.definitions.length }));
  return report;
}
module.exports = { run };
