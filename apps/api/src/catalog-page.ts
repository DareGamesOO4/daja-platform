import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { CatalogRepository } from '@daja/database';
import { z } from 'zod';
import { automaticFilterOptions } from './catalog-filter-options.js';
import { initializeCatalogFilters } from './catalog-filters-defaults.js';
import { departmentBrandNames } from './catalog-department-brands.js';

export interface Option { id: string; label: string; visible: boolean; color: string; image: string; conditions: Array<{ source: string; values: string[] }> }
export interface Node { id: string; title: string; visible: boolean; priority: number; mode: string; style: string; match: string; unit: string; sources: string[]; options: Option[]; children: Node[]; autoAddOptions?: boolean | undefined }
export interface Configuration { schemaVersion: number; filters: Node[] }
interface Product {
  id: string; name: string; slug: string; department: string; brand: string | null; category: string | null;
  gender: string | null; price: number; attributes: Record<string, unknown>; features: Array<{title: string}>;
  active: boolean; published: boolean; createdAt: string; updatedAt: string;
}
export const catalogPageSchema = z.object({
  department: z.enum(['satovi', 'daljinski', 'baterije', 'naocare']).default('satovi'),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  params: z.string().max(16000).default(''),
  fixedGender: z.enum(['Muški', 'Ženski']).optional(),
  configurationVersion: z.string().max(64).optional()
});
type Query = z.infer<typeof catalogPageSchema>;
const normalize = (value: unknown) => String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[_\s-]+/g, ' ').trim();
const specKey = (value: string) => normalize(value).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const gender = (value: unknown) => { const text = normalize(value); return !text || text === 'unisex' ? 'unisex' : ['muski','m'].includes(text) ? 'muski' : ['zenski','z'].includes(text) ? 'zenski' : text; };
const numeric = (value: unknown) => { const match = String(value ?? '').trim().replace(',', '.').match(/^(\d+(?:\.\d+)?)\s*([^\d]*)$/); return match ? { number: Number(match[1]), unit: match[2]!.trim().toLowerCase() } : null; };
const productValues = new WeakMap<Product, Map<string, string[]>>();
const attributeIndexes = new WeakMap<Product, Map<string, unknown>>();
const optionResults = new WeakMap<Product, WeakMap<Option, boolean>>();
function values(product: Product, source: string): string[] {
  let cached = productValues.get(product);
  if (!cached) { cached = new Map(); productValues.set(product, cached); }
  const known = cached.get(source);
  if (known) return known;
  const result = readValues(product, source);
  cached.set(source, result);
  return result;
}
function readValues(product: Product, source: string): string[] {
  if (source.startsWith('feature:')) return product.features.some(feature => feature.title?.trim() === source.slice(8) && !feature.title.startsWith('_') && !/^rfid\b/i.test(feature.title)) ? ['Da'] : [];
  if (source === 'gender') { const value = gender(product.gender); return value === 'unisex' ? ['Muški','Ženski'] : value === 'muski' ? ['Muški'] : value === 'zenski' ? ['Ženski'] : [String(product.gender ?? '')]; }
  const key = source.slice(5);
  let attributes = attributeIndexes.get(product);
  if (source.startsWith('spec:') && !attributes) {
    attributes = new Map();
    for (const [name, value] of Object.entries(product.attributes)) {
      const normalized = specKey(name);
      if (!attributes.has(normalized)) attributes.set(normalized, value);
    }
    attributeIndexes.set(product, attributes);
  }
  const raw = source.startsWith('spec:') ? product.attributes[key] ?? attributes?.get(specKey(key)) : product[source as 'brand' | 'category' | 'price'];
  return (Array.isArray(raw) ? raw : [raw]).filter(value => value !== null && value !== undefined && typeof value !== 'object').map(value => String(value).trim()).filter(Boolean);
}
const leaves = (nodes: Node[]): Node[] => [...nodes].sort((a,b) => a.priority-b.priority).flatMap(node => !node.visible ? [] : node.mode === 'group' ? leaves(node.children) : [node]);
function optionMatches(product: Product, option: Option) {
  let cached = optionResults.get(product);
  if (!cached) { cached = new WeakMap(); optionResults.set(product, cached); }
  const known = cached.get(option);
  if (known !== undefined) return known;
  const result = option.conditions.some(condition => condition.values.some(value => values(product, condition.source).includes(value)));
  cached.set(option, result);
  return result;
}
function activeFilters(params: URLSearchParams, nodes: Node[], fixedGender?: string) {
  return nodes.flatMap(node => {
    if (fixedGender && node.sources.includes('gender')) return [];
    if (node.style === 'range') {
      const min = params.get(`cf_min_${node.id}`); const max = params.get(`cf_max_${node.id}`);
      if (min === null && max === null) return [];
      const lower = min === null ? -Infinity : Number(min), upper = max === null ? Infinity : Number(max);
      return [{ id: node.id, test: (product: Product) => values(product, node.sources[0]!).some(value => {
        const number = numeric(value)?.number;
        return number !== undefined && number >= lower && number <= upper;
      }) }];
    }
    const ids = params.getAll(`cf_${node.id}`);
    const selected = node.options.filter(option => option.visible && ids.includes(option.id));
    return selected.length ? [{ id: node.id, test: (product: Product) => node.match === 'all'
      ? selected.every(option => optionMatches(product, option)) : selected.some(option => optionMatches(product, option)) }] : [];
  });
}
async function productsSnapshot(pool: Pool, organizationId: string, department?: string, includeHidden = false): Promise<Product[]> {
  // Filter/sort metadata stays on the server. Only selected cards load media.
  const result = await pool.query<Product>(`SELECT p.id, p.name, p.slug, COALESCE(d.slug,'satovi') AS department,
    b.name AS brand, c.name AS category, v.gender, v.current_price_amount::double precision / 100 AS price,
    COALESCE(v.attributes,'{}'::jsonb) AS attributes, COALESCE(p.features,'[]'::jsonb) AS features,
    p.active, p.published,
    p.created_at AS "createdAt", p.updated_at AS "updatedAt"
    FROM products p
    JOIN LATERAL (SELECT pv.gender, pv.current_price_amount, pv.attributes FROM product_variants pv
      WHERE pv.organization_id=p.organization_id AND pv.product_id=p.id AND pv.deleted_at IS NULL AND pv.active AND pv.published
      ORDER BY pv.current_price_amount DESC, pv.id LIMIT 1) v ON true
    LEFT JOIN departments d ON d.id=p.department_id AND d.organization_id=p.organization_id AND d.deleted_at IS NULL
    LEFT JOIN brands b ON b.id=p.brand_id AND b.organization_id=p.organization_id AND b.deleted_at IS NULL
    LEFT JOIN categories c ON c.id=p.primary_category_id AND c.organization_id=p.organization_id AND c.deleted_at IS NULL
    WHERE p.organization_id=$1 AND p.deleted_at IS NULL AND ($3::boolean OR (p.active AND p.published))
      AND ($2::text IS NULL OR COALESCE(d.slug,'satovi')=$2)
    ORDER BY p.updated_at DESC, p.id DESC`, [organizationId, department ?? null, includeHidden]);
  return result.rows;
}
async function cards(pool: Pool, organizationId: string, ids: string[], includeHidden = false) {
  if (!ids.length) return [];
  const result = await new CatalogRepository(pool).listPublicProducts({organizationId}, {productIds: ids, limit: ids.length, includeHidden});
  const order = new Map(ids.map((id,index) => [id,index]));
  // Preserve card galleries, prices, availability and cart identity, without
  // serializing every specification and feature twice in the initial HTML.
  return result.items.sort((a,b) => order.get(a.productId)!-order.get(b.productId)!).map(card => {
    const { attributes: _attributes, features: _features, ...compact } = card;
    return { ...compact, images: compact.images.map(image => ({ url: image.url, thumb: image.thumb })) };
  });
}
type Facet = { values: Array<{value: string; label: string; color: string; image: string; count: number}>; selected: string[]; numbers: number[] };
interface Selection { products: Product[]; facets: Record<string, Facet> }
interface Snapshot { products: Product[]; configuration: Configuration; version: string; nodes: Node[]; selections: Map<string, Selection> }
const snapshots = new Map<string, { pool: Pool; expires: number; promise: Promise<Snapshot> }>();
const SNAPSHOT_TTL = 10_000;
export function invalidateCatalogPages(organizationId: string) {
  for (const key of snapshots.keys()) if (key.startsWith(`${organizationId}:`)) snapshots.delete(key);
}
async function loadSnapshot(pool: Pool, organizationId: string, department: string, includeHidden: boolean): Promise<Snapshot> {
  const [products, configResult, brands] = await Promise.all([
    productsSnapshot(pool,organizationId,department,includeHidden),
    pool.query<{configuration: Configuration}>('SELECT published AS configuration FROM catalog_filter_configurations WHERE organization_id=$1 AND department=$2',[organizationId,department]),
    departmentBrandNames(pool, organizationId, department)
  ]);
  let saved = configResult.rows[0]?.configuration;
  // Initialization is a one-time fallback, not a transaction on every read.
  if (!saved) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); await initializeCatalogFilters(client,organizationId,department); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    saved = (await pool.query<{configuration: Configuration}>('SELECT published AS configuration FROM catalog_filter_configurations WHERE organization_id=$1 AND department=$2',[organizationId,department])).rows[0]?.configuration;
  }
  if (!saved) throw new Error('Published catalog filters unavailable');
  const sources = new Map<string, string[]>();
  const configuration = {...saved,filters: automaticFilterOptions(saved.filters,source => {
    let known = sources.get(source);
    if (!known) {
      known = [...new Set([...(source === 'brand' ? brands : []), ...products.flatMap(product => values(product,source))])];
      sources.set(source, known);
    }
    return known;
  })};
  return { products, configuration, nodes: leaves(configuration.filters), selections: new Map(),
    version: createHash('sha256').update(JSON.stringify(configuration)).digest('hex') };
}
function snapshot(pool: Pool, organizationId: string, department: string, includeHidden = false) {
  const key = `${organizationId}:${department}:${includeHidden ? 'admin' : 'public'}`;
  const cached = snapshots.get(key);
  if (cached && cached.pool === pool && cached.expires > Date.now()) return cached.promise;
  const entry = { pool, expires: Date.now() + SNAPSHOT_TTL, promise: loadSnapshot(pool,organizationId,department,includeHidden) };
  snapshots.set(key, entry);
  while (snapshots.size > 40) snapshots.delete(snapshots.keys().next().value!);
  void entry.promise.catch(() => { if (snapshots.get(key) === entry) snapshots.delete(key); });
  return entry.promise;
}
export async function publicCatalogConfiguration(pool: Pool, organizationId: string, department: string) {
  const data = await snapshot(pool, organizationId, department);
  return { configuration: data.configuration, version: data.version };
}
function selectProducts(data: Snapshot, params: URLSearchParams, fixedGender?: string): Selection {
  // Pagination and sorting cannot change facet counts. Ignore tracking keys too.
  const selectionParams = new URLSearchParams([...params].filter(([key]) => key === 'q' || key.startsWith('cf_')));
  selectionParams.sort();
  const key = JSON.stringify([fixedGender, selectionParams.toString()]);
  const cached = data.selections.get(key);
  if (cached) return cached;
  const { products, nodes } = data;
  const tests = activeFilters(params, nodes, fixedGender);
  const query = params.get('q')?.trim().toLowerCase();
  const failures = new Map<Product, string[]>();
  const eligible = products.filter(product => {
    if (query && !`${product.brand || ''} ${product.name}`.toLowerCase().includes(query)) return false;
    if (fixedGender && !values(product, 'gender').some(value => gender(value) === gender(fixedGender))) return false;
    failures.set(product, tests.filter(test => !test.test(product)).map(test => test.id));
    return true;
  });
  const filtered = eligible.filter(product => failures.get(product)!.length === 0);
  const facets = Object.fromEntries(nodes.map(node => {
    const candidates = eligible.filter(product => {
      const failed = failures.get(product)!;
      return failed.length === 0 || (failed.length === 1 && failed[0] === node.id);
    });
    const options = node.options.filter(option => option.visible);
    const selected = params.getAll(`cf_${node.id}`);
    const selectedOptions = options.filter(option => selected.includes(option.id));
    const choices = options.map(option => {
      const others = node.match === 'all' ? selectedOptions.filter(other => other.id !== option.id) : [];
      let count = 0;
      for (const product of candidates) if (optionMatches(product,option) && others.every(other => optionMatches(product,other))) count++;
      return {value:option.id,label:option.label,color:option.color,image:option.image,count};
    }).filter(value => value.count > 0 || selected.includes(value.value));
    const approved = options.flatMap(option => option.conditions.flatMap(condition => condition.values)).map(numeric).filter(value => value !== null);
    const numbers = node.style === 'range' ? [...new Set(candidates.flatMap(product => values(product,node.sources[0]!)).map(numeric).filter(value => value !== null)
      .filter(value => node.sources[0] === 'price' || approved.some(number => number.number === value.number && number.unit === value.unit)).map(value => value.number))].sort((a,b) => a-b) : [];
    return [node.id,{values:choices,selected,numbers}];
  }));
  const result = { products: filtered, facets };
  data.selections.set(key, result);
  while (data.selections.size > 64) data.selections.delete(data.selections.keys().next().value!);
  return result;
}
export async function publicCatalogPage(pool: Pool, organizationId: string, input: Query, includeHidden = false) {
  const data = await snapshot(pool, organizationId, input.department, includeHidden);
  const params = new URLSearchParams(input.params);
  const selection = selectProducts(data, params, input.fixedGender);
  const filtered = [...selection.products];
  const collator = new Intl.Collator('sr-RS',{sensitivity:'base'});
  const sort = params.get('sort') || 'popular';
  filtered.sort((a,b) => {
    if (includeHidden) {
      const aHidden = !a.active || !a.published;
      const bHidden = !b.active || !b.published;
      if (aHidden !== bHidden) return aHidden ? 1 : -1;
    }
    return sort === 'price-asc' ? a.price-b.price : sort === 'price-desc' ? b.price-a.price : sort === 'name' ? collator.compare(a.name,b.name) : 0;
  });
  const total = filtered.length;
  const hiddenCount = includeHidden
    ? filtered.filter(product => !product.active || !product.published).length
    : undefined;
  const page = Math.min(input.page,Math.max(1,Math.ceil(total/32)));
  const items = await cards(pool,organizationId,filtered.slice((page-1)*32,page*32).map(product => product.id),includeHidden);
  return {items,total,page,perPage:32,configurationVersion:data.version,
    ...(input.configurationVersion === data.version ? {} : {configuration:data.configuration}),
    facets:selection.facets,...(hiddenCount === undefined ? {} : {hiddenCount})};
}
const homeSlugs = ['casio-mtp-1314pl-8a','daniel-3271','qq-classic-qw12','ga-100-1a1','orient-diver','daniel-klein-dk13965-4'];
export async function publicHomeProducts(pool: Pool, organizationId: string) {
  // Same selection as the former 64-card homepage seed; send only the six
  // cards that its public recommendations section actually renders.
  const products = (await productsSnapshot(pool,organizationId)).slice(0,64);
  const curated = homeSlugs.flatMap(slug => products.filter(product => product.slug === slug));
  const chosen = [...curated,...products.filter(product => !curated.some(item => item.id === product.id))].slice(0,6);
  return {items:await cards(pool,organizationId,chosen.map(product => product.id))};
}
