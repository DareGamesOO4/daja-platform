import type { Pool } from 'pg';
import { CatalogRepository } from '@daja/database';
import { z } from 'zod';
import { automaticFilterOptions } from './catalog-filter-options.js';
import { initializeCatalogFilters } from './catalog-filters-defaults.js';

interface Option { id: string; label: string; visible: boolean; color: string; image: string; conditions: Array<{ source: string; values: string[] }> }
interface Node { id: string; title: string; visible: boolean; priority: number; mode: string; style: string; match: string; unit: string; sources: string[]; options: Option[]; children: Node[]; autoAddOptions?: boolean | undefined }
interface Configuration { schemaVersion: number; filters: Node[] }
interface Product {
  id: string; name: string; slug: string; department: string; brand: string | null; category: string | null;
  gender: string | null; price: number; attributes: Record<string, unknown>; features: Array<{title: string}>;
  createdAt: string; updatedAt: string;
}
export const catalogPageSchema = z.object({
  department: z.enum(['satovi', 'daljinski', 'baterije', 'naocare']).default('satovi'),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  params: z.string().max(16000).default(''),
  fixedGender: z.enum(['Muški', 'Ženski']).optional()
});
type Query = z.infer<typeof catalogPageSchema>;
const normalize = (value: unknown) => String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[_\s-]+/g, ' ').trim();
const specKey = (value: string) => normalize(value).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const gender = (value: unknown) => { const text = normalize(value); return !text || text === 'unisex' ? 'unisex' : ['muski','m'].includes(text) ? 'muski' : ['zenski','z'].includes(text) ? 'zenski' : text; };
const numeric = (value: unknown) => { const match = String(value ?? '').trim().replace(',', '.').match(/^(\d+(?:\.\d+)?)\s*([^\d]*)$/); return match ? { number: Number(match[1]), unit: match[2]!.trim().toLowerCase() } : null; };
function values(product: Product, source: string): string[] {
  if (source.startsWith('feature:')) return product.features.some(feature => feature.title?.trim() === source.slice(8) && !feature.title.startsWith('_') && !/^rfid\b/i.test(feature.title)) ? ['Da'] : [];
  if (source === 'gender') { const value = gender(product.gender); return value === 'unisex' ? ['Muški','Ženski'] : value === 'muski' ? ['Muški'] : value === 'zenski' ? ['Ženski'] : [String(product.gender ?? '')]; }
  const key = source.slice(5);
  const raw = source.startsWith('spec:') ? product.attributes[key] ?? Object.entries(product.attributes).find(([name]) => specKey(name) === specKey(key))?.[1] : product[source as 'brand' | 'category' | 'price'];
  return (Array.isArray(raw) ? raw : [raw]).filter(value => value !== null && value !== undefined && typeof value !== 'object').map(value => String(value).trim()).filter(Boolean);
}
const leaves = (nodes: Node[]): Node[] => [...nodes].sort((a,b) => a.priority-b.priority).flatMap(node => !node.visible ? [] : node.mode === 'group' ? leaves(node.children) : [node]);
const optionMatches = (product: Product, option: Option) => option.conditions.some(condition => condition.values.some(value => values(product, condition.source).includes(value)));
function matches(product: Product, params: URLSearchParams, nodes: Node[], fixedGender?: string, ignoreId?: string) {
  const query = params.get('q')?.trim().toLowerCase();
  if (query && !`${product.brand || ''} ${product.name}`.toLowerCase().includes(query)) return false;
  if (fixedGender && !values(product, 'gender').some(value => gender(value) === gender(fixedGender))) return false;
  return nodes.filter(node => node.id !== ignoreId && !(fixedGender && node.sources.includes('gender'))).every(node => {
    if (node.style === 'range') {
      const min = params.get(`cf_min_${node.id}`); const max = params.get(`cf_max_${node.id}`);
      if (min === null && max === null) return true;
      return values(product, node.sources[0]!).some(value => { const number = numeric(value)?.number; return number !== undefined && (min === null || number >= Number(min)) && (max === null || number <= Number(max)); });
    }
    const ids = params.getAll(`cf_${node.id}`);
    const selected = node.options.filter(option => option.visible && ids.includes(option.id));
    return !selected.length || (node.match === 'all' ? selected.every(option => optionMatches(product,option)) : selected.some(option => optionMatches(product,option)));
  });
}
async function productsSnapshot(pool: Pool, organizationId: string, department?: string): Promise<Product[]> {
  // Filter/sort metadata stays on the server. Only selected cards load media.
  const result = await pool.query<Product>(`SELECT p.id, p.name, p.slug, COALESCE(d.slug,'satovi') AS department,
    b.name AS brand, c.name AS category, v.gender, v.current_price_amount::double precision / 100 AS price,
    COALESCE(v.attributes,'{}'::jsonb) AS attributes, COALESCE(p.features,'[]'::jsonb) AS features,
    p.created_at AS "createdAt", p.updated_at AS "updatedAt"
    FROM products p
    JOIN LATERAL (SELECT pv.gender, pv.current_price_amount, pv.attributes FROM product_variants pv
      WHERE pv.organization_id=p.organization_id AND pv.product_id=p.id AND pv.deleted_at IS NULL AND pv.active AND pv.published
      ORDER BY pv.current_price_amount DESC, pv.id LIMIT 1) v ON true
    LEFT JOIN departments d ON d.id=p.department_id AND d.organization_id=p.organization_id AND d.deleted_at IS NULL
    LEFT JOIN brands b ON b.id=p.brand_id AND b.organization_id=p.organization_id AND b.deleted_at IS NULL
    LEFT JOIN categories c ON c.id=p.primary_category_id AND c.organization_id=p.organization_id AND c.deleted_at IS NULL
    WHERE p.organization_id=$1 AND p.deleted_at IS NULL AND p.active AND p.published
      AND ($2::text IS NULL OR COALESCE(d.slug,'satovi')=$2)
    ORDER BY p.updated_at DESC, p.id DESC`, [organizationId, department ?? null]);
  return result.rows;
}
async function cards(pool: Pool, organizationId: string, ids: string[]) {
  if (!ids.length) return [];
  const result = await new CatalogRepository(pool).listPublicProducts({organizationId}, {productIds: ids, limit: ids.length});
  const order = new Map(ids.map((id,index) => [id,index]));
  // Preserve card galleries, prices, availability and cart identity, without
  // serializing every specification and feature twice in the initial HTML.
  return result.items.sort((a,b) => order.get(a.productId)!-order.get(b.productId)!).map(card => {
    const { attributes: _attributes, features: _features, ...compact } = card;
    return { ...compact, images: compact.images.map(image => ({ url: image.url, thumb: image.thumb })) };
  });
}
export async function publicCatalogPage(pool: Pool, organizationId: string, input: Query) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); await initializeCatalogFilters(client,organizationId,input.department); await client.query('COMMIT'); }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  const [products, configResult] = await Promise.all([
    productsSnapshot(pool,organizationId,input.department),
    pool.query<{configuration: Configuration}>('SELECT published AS configuration FROM catalog_filter_configurations WHERE organization_id=$1 AND department=$2',[organizationId,input.department])
  ]);
  const saved = configResult.rows[0]?.configuration;
  if (!saved) throw new Error('Published catalog filters unavailable');
  const configuration = {...saved,filters: automaticFilterOptions(saved.filters,source => products.flatMap(product => values(product,source)))};
  const nodes = leaves(configuration.filters);
  const params = new URLSearchParams(input.params);
  const filtered = products.filter(product => matches(product,params,nodes,input.fixedGender));
  const collator = new Intl.Collator('sr-RS',{sensitivity:'base'});
  const sort = params.get('sort') || 'popular';
  filtered.sort((a,b) => sort === 'price-asc' ? a.price-b.price : sort === 'price-desc' ? b.price-a.price : sort === 'name' ? collator.compare(a.name,b.name) : 0);
  const facets = Object.fromEntries(nodes.map(node => {
    const candidates = products.filter(product => matches(product,params,nodes,input.fixedGender,node.id));
    const options = node.options.filter(option => option.visible);
    const selected = params.getAll(`cf_${node.id}`);
    const selectedOptions = options.filter(option => selected.includes(option.id));
    const choices = options.map(option => ({value:option.id,label:option.label,color:option.color,image:option.image,
      count:candidates.filter(product => optionMatches(product,option) && (node.match !== 'all' || selectedOptions.filter(other => other.id !== option.id).every(other => optionMatches(product,other)))).length
    })).filter(value => value.count > 0 || selected.includes(value.value));
    const approved = options.flatMap(option => option.conditions.flatMap(condition => condition.values)).map(numeric).filter(value => value !== null);
    const numbers = node.style === 'range' ? [...new Set(candidates.flatMap(product => values(product,node.sources[0]!)).map(numeric).filter(value => value !== null)
      .filter(value => node.sources[0] === 'price' || approved.some(number => number.number === value.number && number.unit === value.unit)).map(value => value.number))].sort((a,b) => a-b) : [];
    return [node.id,{values:choices,selected,numbers}];
  }));
  const total = filtered.length;
  const page = Math.min(input.page,Math.max(1,Math.ceil(total/32)));
  const items = await cards(pool,organizationId,filtered.slice((page-1)*32,page*32).map(product => product.id));
  return {items,total,page,perPage:32,configuration,facets};
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
