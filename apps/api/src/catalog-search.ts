import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { CatalogRepository, type PublicProductCard } from '@daja/database';
import { ValidationFailedError } from '@daja/security';
import { initializeCatalogFilters } from './catalog-filters-defaults.js';
import { automaticFilterOptions } from './catalog-filter-options.js';

const departments = ['satovi', 'daljinski', 'baterije', 'naocare'] as const;
const routes: Record<string, string> = { satovi: '/catalog', daljinski: '/daljinski', baterije: '/baterije', naocare: '/naocare' };
export const publicSearchQuerySchema = z.object({
  q: z.string().trim().max(120).default(''),
  mode: z.enum(['suggestions', 'results']).default('suggestions'),
  department: z.enum(departments).optional(),
  sort: z.enum(['relevance', 'price_asc', 'price_desc']).default('relevance'),
  cursor: z.string().max(1000).optional(),
  seed: z.string().max(80).default('catalog')
});
type SearchQuery = z.infer<typeof publicSearchQuerySchema>;
interface SearchRow {
  id: string; name: string; slug: string; sku: string | null; mpn: string | null;
  brand: string | null; category: string | null; department: string; gender: string | null;
  description: string | null; attributes: Record<string, unknown>;
  features: Array<{ title: string; subtitle?: string }>;
  price: number; in_stock: boolean;
}
interface Condition { source: string; values: string[] }
interface Option { id: string; label: string; visible: boolean; conditions: Condition[] }
interface Node {
  id: string; title: string; visible: boolean; mode: string; style: string;
  sources: string[]; options: Option[]; children: Node[];
  autoAddOptions?: boolean; unit?: string;
}
interface Facet { department: string; node: Node; option: Option; aliases: string[]; kind: 'brands' | 'collections' | 'attributes' }
export interface Suggestion { id: string; label: string; detail: string; href: string; count: number }
export interface CatalogSearchResponse {
  query: string;
  normalizedQuery: string;
  recognized: string[];
  intent: 'products' | 'brands' | 'collections';
  groups: Record<'brands' | 'collections' | 'attributes', Suggestion[]>;
  items: PublicProductCard[];
  total: number;
  departments: Array<{ id: string; count: number }>;
  corrections: Array<{ label: string; query: string }>;
  recommendations: PublicProductCard[];
  message: string | null;
  nextCursor: string | null;
}
interface Entry { row: SearchRow; codes: string[]; name: string; brand: string; category: string; specs: string; features: string; description: string }
interface Snapshot { entries: Entry[]; facets: Facet[]; expires: number }
const snapshots = new Map<string, Promise<Snapshot>>();
export function invalidateCatalogSearch(organizationId: string) { snapshots.delete(organizationId); }

const cyrillic: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ђ: 'dj', е: 'e', ж: 'z', з: 'z', и: 'i', ј: 'j', к: 'k', л: 'l', љ: 'lj', м: 'm', н: 'n', њ: 'nj', о: 'o', п: 'p', р: 'r', с: 's', т: 't', ћ: 'c', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'c', џ: 'dz', ш: 's' };
const synonyms: Record<string, string> = {
  muski: 'muski', muska: 'muski', muske: 'muski', muskarce: 'muski', men: 'muski', male: 'muski',
  zenski: 'zenski', zenska: 'zenski', zenske: 'zenski', zene: 'zenski', women: 'zenski', female: 'zenski',
  automatik: 'automatski', automatic: 'automatski', automatska: 'automatski', automatsko: 'automatski', automatika: 'automatski',
  quartz: 'kvarc', kvarcni: 'kvarc', kvarcna: 'kvarc', kvarcno: 'kvarc',
  srebrni: 'srebrna', srebrno: 'srebrna', srebrne: 'srebrna', silver: 'srebrna',
  zlatni: 'zlatna', zlatno: 'zlatna', zlatne: 'zlatna', gold: 'zlatna',
  crni: 'crna', crno: 'crna', crne: 'crna', black: 'crna',
  beli: 'bela', belo: 'bela', bele: 'bela', white: 'bela',
  plavi: 'plava', plavo: 'plava', plave: 'plava', blue: 'plava',
  zeleni: 'zelena', zeleno: 'zelena', zelene: 'zelena', green: 'zelena',
  crveni: 'crvena', crveno: 'crvena', crvene: 'crvena', red: 'crvena',
  braon: 'braon', brown: 'braon', sivi: 'siva', sivo: 'siva', sive: 'siva', gray: 'siva', grey: 'siva',
  kozna: 'koza', kozni: 'koza', kozno: 'koza', leather: 'koza', silikonska: 'silikon', silikonski: 'silikon', silicone: 'silikon',
  hronograf: 'hronograf', chronograph: 'hronograf', datum: 'datum', date: 'datum',
  sat: 'satovi', satove: 'satovi', satova: 'satovi', watch: 'satovi', watches: 'satovi',
  daljinski: 'daljinski', daljinske: 'daljinski', naocare: 'naocare', baterija: 'baterije', battery: 'baterije'
};
const colors = new Set(['bela', 'crna', 'plava', 'zelena', 'crvena', 'srebrna', 'zlatna', 'braon', 'siva', 'bez', 'krem', 'bordo', 'ljubicasta', 'narandzasta']);
function normalize(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[а-яђјљњћџ]/g, (letter) => cyrillic[letter] ?? letter)
    .replace(/đ/g, 'dj').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}
function canonical(value: unknown) { return normalize(value).split(' ').map((word) => synonyms[word] ?? word).join(' '); }
function compact(value: unknown) { return normalize(value).replace(/ /g, ''); }
function internal(key: string) { return key.startsWith('_') || /^(additional_?barcodes|rfid_?piece_?placements)$/i.test(key); }
function publicAttributes(attributes: Record<string, unknown>) { return Object.fromEntries(Object.entries(attributes ?? {}).filter(([key]) => !internal(key))); }
function publicFeatures(features: SearchRow['features']) { return (features ?? []).filter((feature) => feature.title && !internal(feature.title) && !/^rfid\b/i.test(feature.title)); }
function values(row: SearchRow, source: string): string[] {
  if (source.startsWith('feature:')) return publicFeatures(row.features).some((feature) => feature.title.trim() === source.slice(8)) ? ['Da'] : [];
  if (source === 'gender') {
    const gender = canonical(row.gender);
    return gender === 'unisex' ? ['Muški', 'Ženski'] : gender === 'muski' ? ['Muški'] : gender === 'zenski' ? ['Ženski'] : [String(row.gender ?? '')];
  }
  if (source === 'price') return [String(Number(row.price) / 100)];
  if (source.startsWith('spec:')) {
    const key = source.slice(5);
    if (internal(key)) return [];
    const attrs = publicAttributes(row.attributes);
    const raw = attrs[key] ?? Object.entries(attrs).find(([name]) => normalize(name) === normalize(key))?.[1];
    return (Array.isArray(raw) ? raw : [raw]).filter((item) => item !== null && item !== undefined && typeof item !== 'object').map(String);
  }
  return [String(source === 'brand' ? row.brand ?? '' : source === 'category' ? row.category ?? '' : '')];
}
function optionMatches(row: SearchRow, facet: Facet) {
  return row.department === facet.department && facet.option.conditions.some((condition) => condition.values.some((value) => values(row, condition.source).includes(value)));
}
function collectFacets(department: string, nodes: Node[], result: Facet[]) {
  for (const node of nodes) {
    if (!node.visible) continue;
    if (node.mode === 'group') { collectFacets(department, node.children ?? [], result); continue; }
    if (node.style === 'range') continue;
    for (const option of node.options ?? []) {
      if (!option.visible || !option.conditions.length) continue;
      const aliases = [option.label];
      for (const condition of option.conditions) {
        if (condition.source.startsWith('feature:')) aliases.push(condition.source.slice(8));
        for (const value of condition.values) {
          if (!/^(da|ne|yes|no|true|false|0|1)$/i.test(value.trim())) aliases.push(value);
          else if (/^(da|yes|true|1)$/i.test(value.trim())) aliases.push(node.title);
        }
      }
      const kind = option.conditions.every((condition) => condition.source === 'brand') ? 'brands'
        : option.conditions.every((condition) => condition.source === 'category') ? 'collections' : 'attributes';
      result.push({ department, node, option, kind, aliases: [...new Set(aliases.map(canonical).filter((alias) => alias.length >= 2 && !/^(da|ne|yes|no)$/.test(alias)))] });
    }
  }
}

async function snapshot(pool: Pool, organizationId: string): Promise<Snapshot> {
  const cached = snapshots.get(organizationId);
  if (cached) {
    const value = await cached;
    if (value.expires > Date.now()) return value;
  }
  const loading = (async () => {
    // Only lightweight searchable metadata is cached on the server. Images and
    // current public cards are loaded for the selected IDs, never for every keypress.
    const [products, initialConfigs] = await Promise.all([
      pool.query<SearchRow>(`SELECT p.id, p.name, p.slug, p.description, p.features,
        v.sku, v.mpn, v.gender, v.attributes, b.name AS brand, c.name AS category, d.slug AS department,
        COALESCE(sale.amount_minor, v.current_price_amount) AS price,
        COALESCE(inv.quantity, 0) > 0 AS in_stock
        FROM products p
        JOIN LATERAL (SELECT * FROM product_variants pv WHERE pv.organization_id = p.organization_id AND pv.product_id = p.id
          AND pv.deleted_at IS NULL AND pv.active AND pv.published ORDER BY pv.current_price_amount DESC, pv.id LIMIT 1) v ON true
        JOIN departments d ON d.id = p.department_id AND d.organization_id = p.organization_id AND d.deleted_at IS NULL
        LEFT JOIN brands b ON b.id = p.brand_id AND b.organization_id = p.organization_id AND b.deleted_at IS NULL
        LEFT JOIN categories c ON c.id = p.primary_category_id AND c.organization_id = p.organization_id AND c.deleted_at IS NULL
        LEFT JOIN LATERAL (SELECT amount_minor FROM variant_prices vp WHERE vp.organization_id = p.organization_id AND vp.variant_id = v.id
          AND vp.price_type = 'sale' AND vp.valid_from <= now() AND vp.cancelled_at IS NULL AND (vp.valid_until IS NULL OR vp.valid_until > now())
          ORDER BY vp.valid_from DESC, vp.created_at DESC LIMIT 1) sale ON true
        LEFT JOIN LATERAL (SELECT SUM(quantity) AS quantity FROM inventory_balances ib WHERE ib.organization_id = p.organization_id AND ib.variant_id = v.id) inv ON true
        WHERE p.organization_id = $1 AND p.deleted_at IS NULL AND p.active AND p.published AND d.slug = ANY($2::text[])`, [organizationId, departments]),
      pool.query<{ department: string; published: { filters: Node[] } | null }>('SELECT department, published FROM catalog_filter_configurations WHERE organization_id = $1', [organizationId])
    ]);
    let configs = initialConfigs;
    const missing = departments.filter((department) => !configs.rows.some((config) => config.department === department));
    if (missing.length) {
      // Use the same one-time baseline as the public filters endpoint. Never
      // regenerate an existing configuration or approve a new option here.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const department of missing) await initializeCatalogFilters(client, organizationId, department);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
      configs = await pool.query<{ department: string; published: { filters: Node[] } | null }>('SELECT department, published FROM catalog_filter_configurations WHERE organization_id = $1', [organizationId]);
    }
    const facets: Facet[] = [];
    for (const config of configs.rows) {
      const rows = products.rows.filter((row) => row.department === config.department);
      collectFacets(config.department, automaticFilterOptions(config.published?.filters ?? [], (source) => rows.flatMap((row) => values(row, source))), facets);
    }
    const entries = products.rows.map((row): Entry => ({
      row, codes: [...new Set([row.sku, row.mpn, row.name].filter(Boolean).map(compact))],
      name: canonical(row.name), brand: canonical(row.brand), category: canonical(row.category),
      // Boolean specification keys cannot imply function presence: only an
      // approved condition or an explicit feature title can establish it.
      specs: canonical(Object.entries(publicAttributes(row.attributes)).flatMap(([key, value]) => {
        const items = (Array.isArray(value) ? value : [value]).filter((item) => item !== null && item !== undefined && typeof item !== 'object');
        return items.length && !items.every((item) => /^(da|ne|yes|no|true|false|0|1)$/i.test(String(item).trim())) ? [key, ...items] : [];
      }).join(' ')),
      features: canonical(publicFeatures(row.features).map((feature) => `${feature.title} ${feature.subtitle ?? ''}`).join(' ')),
      description: canonical(String(row.description ?? '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>|&(?:[a-z]+|#\d+);/gi, ' '))
    }));
    return { entries, facets, expires: Date.now() + 10_000 };
  })();
  // Bound the organization cache and deduplicate concurrent cold requests.
  if (snapshots.size >= 20 && !snapshots.has(organizationId)) snapshots.delete(snapshots.keys().next().value ?? '');
  snapshots.set(organizationId, loading);
  try { return await loading; } catch (error) { if (snapshots.get(organizationId) === loading) snapshots.delete(organizationId); throw error; }
}

function amount(value: string): number {
  const multiplier = /(?:k|hiljada)$/i.test(value) ? 1000 : 1;
  let numeric = value.replace(/(?:k|hiljada)$/i, '').replace(/\s/g, '');
  numeric = numeric.replace(/[.,](?=\d{3}(?:[.,]|$))/g, '').replace(',', '.');
  return Number(numeric) * multiplier * 100;
}
interface Parsed { tests: Array<(row: SearchRow) => boolean>; terms: string[]; labels: string[]; model: string }
function parseQuery(query: string, facets: Facet[]): Parsed {
  const tests: Parsed['tests'] = []; const labels: string[] = [];
  const number = '(\\d+(?:[.,]\\d+)*(?:\\s*(?:k|hiljada))?)';
  let text = query.toLowerCase();
  text = text.replace(new RegExp(`\\bod\\s+${number}\\s*(?:rsd|din(?:ara)?)?\\s+do\\s+${number}\\s*(?:rsd|din(?:ara)?)?(?![\\d.,]|\\s*mm)`, 'g'), (_match, first: string, second: string) => {
    const min = amount(first); const max = amount(second);
    tests.push((row) => Number(row.price) >= min && Number(row.price) <= max); labels.push(`Cena: ${min / 100}–${max / 100} RSD`); return ' ';
  });
  text = text.replace(new RegExp(`\\b(do|ispod|od|preko)\\s+${number}\\s*(?:rsd|din(?:ara)?)?(?![\\d.,]|\\s*mm)`, 'g'), (_match, direction: string, raw: string) => {
    const price = amount(raw); const minimum = direction === 'od' || direction === 'preko';
    tests.push((row) => minimum ? Number(row.price) >= price : Number(row.price) <= price); labels.push(`Cena ${minimum ? 'od' : 'do'} ${price / 100} RSD`); return ' ';
  });
  text = text.replace(/\b(\d+(?:[.,]\d+)?)\s*mm\b/g, (_match, raw: string) => {
    const diameter = Number(raw.replace(',', '.'));
    tests.push((row) => Object.entries(publicAttributes(row.attributes)).some(([key, value]) => /precnik|diameter/.test(normalize(key)) && (Array.isArray(value) ? value : [value]).some((item) => {
      const match = String(item ?? '').replace(',', '.').match(/^(\d+(?:\.\d+)?)\s*(mm)?$/i); return match && Number(match[1]) === diameter;
    }))); labels.push(`Prečnik: ${diameter} mm`); return ' ';
  });
  let normalized = ` ${canonical(text)} `;
  for (const gender of ['muski', 'zenski', 'unisex']) {
    if (!normalized.includes(` ${gender} `)) continue;
    tests.push((row) => canonical(row.gender) === gender || (gender !== 'unisex' && canonical(row.gender) === 'unisex'));
    labels.push(gender === 'muski' ? 'Muški' : gender === 'zenski' ? 'Ženski' : 'Unisex');
    normalized = normalized.split(` ${gender} `).join(' ');
  }
  // Generic color means any public color field; naming a part narrows only that field.
  normalized = normalized.replace(/\b(bela|crna|plava|zelena|crvena|srebrna|zlatna|braon|siva|bez|krem|bordo|ljubicasta|narandzasta)(?:\s+(?:boja\s+)?(narukvic\w*|kais\w*|brojcanik\w*|kucist\w*))?\b/g, (_match, color: string, part: string | undefined) => {
    const qualifier = part?.startsWith('narukvic') || part?.startsWith('kais') ? /narukvic|kais|strap|bracelet/
      : part?.startsWith('brojcanik') ? /brojcanik|dial/ : part ? /kucist|case/ : null;
    tests.push((row) => Object.entries(publicAttributes(row.attributes)).some(([key, value]) => /boja|color|colour/.test(normalize(key)) && (!qualifier || qualifier.test(normalize(key))) && canonical(Array.isArray(value) ? value.join(' ') : value).split(' ').includes(color)));
    labels.push(`${color}${part ? ` ${part}` : ''}`); return ' ';
  });
  const aliases = [...new Set(facets.flatMap((facet) => facet.aliases))].filter((alias) => !colors.has(alias)).sort((a, b) => b.length - a.length);
  for (const alias of aliases) {
    if (!normalized.includes(` ${alias} `)) continue;
    const matching = facets.filter((facet) => facet.aliases.includes(alias));
    tests.push((row) => matching.some((facet) => optionMatches(row, facet)));
    labels.push(matching[0]?.option.label ?? alias); normalized = normalized.split(` ${alias} `).join(' ');
  }
  const terms = normalized.trim().split(/\s+/).filter(Boolean);
  // Department words are meaningful constraints, not stop words.
  for (const department of departments) {
    if (terms.includes(department)) { tests.push((row) => row.department === department); labels.push(department); }
  }
  const remainder = terms.filter((term) => !departments.some((department) => department === term));
  return { tests, terms: remainder, labels: [...new Set(labels)], model: remainder.some((term) => /[a-z]/.test(term) && /\d/.test(term)) ? remainder.join('') : '' };
}
function rank(entry: Entry, parsed: Parsed, query: string): number | null {
  if (!parsed.tests.every((test) => test(entry.row))) return null;
  let score = 0;
  const whole = compact(query);
  if (entry.codes.includes(whole)) score += 5000;
  else if (whole && entry.codes.some((code) => code.startsWith(whole))) score += 4000;
  for (const term of parsed.terms) {
    const code = compact(term);
    const part = entry.codes.some((value) => value.includes(code)) ? 1200
      : entry.name.includes(term) ? 1000 : entry.brand.includes(term) ? 800
        : entry.category.includes(term) ? 700 : entry.specs.includes(term) || entry.features.includes(term) ? 400
          : entry.description.includes(term) ? 100 : 0;
    if (!part) return null;
    score += part;
  }
  return score + parsed.tests.length * 500;
}
function facetHref(facet: Facet): string {
  const params = new URLSearchParams({ [`cf_${facet.node.id}`]: facet.option.id });
  return `${routes[facet.department] ?? '/catalog'}?${params.toString()}`;
}
function aliasScore(alias: string, query: string): number {
  if (!query) return 1;
  if (alias === query) return 100;
  if (alias.startsWith(query)) return 80;
  if (alias.includes(query)) return 70;
  if (` ${query} `.includes(` ${alias} `)) return 60;
  return 0;
}
function suggestions(facets: Facet[], entries: Entry[], query: string) {
  const groups: Record<'brands' | 'collections' | 'attributes', Suggestion[]> = { brands: [], collections: [], attributes: [] };
  const scored = facets.map((facet) => ({ facet, score: Math.max(0, ...facet.aliases.map((alias) => aliasScore(alias, query))), count: entries.filter((entry) => optionMatches(entry.row, facet)).length }))
    .filter((item) => item.score && item.count && (query || item.facet.kind !== 'attributes')).sort((a, b) => b.score - a.score || b.count - a.count || a.facet.option.label.localeCompare(b.facet.option.label));
  for (const { facet, count } of scored) {
    const group = groups[facet.kind]; const limit = facet.kind === 'attributes' ? 4 : 3;
    if (group.length >= limit) continue;
    const label = /^(da|yes|true|1)$/i.test(facet.option.label) ? facet.node.title : facet.option.label;
    if (group.some((item) => item.label === label && item.detail === facet.department)) continue;
    group.push({ id: `${facet.department}:${facet.node.id}:${facet.option.id}`, label, detail: facet.kind === 'attributes' ? `${facet.node.title} · ${facet.department}` : facet.department, href: facetHref(facet), count });
  }
  return groups;
}
function distance(a: string, b: string, maximum: number): number {
  if (Math.abs(a.length - b.length) > maximum) return maximum + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let beforePrevious: number[] = [];
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) {
      let value = Math.min(next[j]! + 1, previous[j + 1]! + 1, previous[j]! + Number(a[i] !== b[j]));
      if (i > 0 && j > 0 && a[i] === b[j - 1] && a[i - 1] === b[j]) value = Math.min(value, beforePrevious[j - 1]! + 1);
      next.push(value);
    }
    beforePrevious = previous;
    previous = next;
  }
  return previous[b.length]!;
}
async function corrections(pool: Pool, organizationId: string, query: string, parsed: Parsed, entries: Entry[], facets: Facet[]) {
  const needle = parsed.model || compact(parsed.terms.join(' ') || query);
  if (needle.length < 4) return [];
  // pg_trgm provides a bounded shortlist, followed by a strict edit-distance
  // check. Approximate matches never enter the exact result list.
  const result = await pool.query<{ name: string; sku: string | null; mpn: string | null }>(`SELECT p.name, v.sku, v.mpn FROM products p
    JOIN product_variants v ON v.product_id = p.id AND v.organization_id = p.organization_id
    WHERE p.organization_id = $1 AND p.deleted_at IS NULL AND p.active AND p.published
      AND v.deleted_at IS NULL AND v.active AND v.published
      AND (similarity(p.normalized_name, $2) >= 0.2 OR similarity(COALESCE(v.sku, ''), $2) >= 0.2 OR similarity(COALESCE(v.mpn, ''), $2) >= 0.2)
    ORDER BY GREATEST(similarity(p.normalized_name, $2), similarity(COALESCE(v.sku, ''), $2), similarity(COALESCE(v.mpn, ''), $2)) DESC LIMIT 40`, [organizationId, parsed.model || parsed.terms.join(' ') || query]);
  const allowed = new Set(entries.map((entry) => entry.row.name));
  const maximum = needle.length >= 8 ? 2 : 1;
  const candidates = result.rows.filter((row) => allowed.has(row.name)).map((row) => {
    const alternatives = [row.name, row.sku, row.mpn].filter((value): value is string => Boolean(value));
    const best = alternatives.map((value) => ({ value, distance: distance(needle, compact(value), maximum) })).sort((a, b) => a.distance - b.distance)[0]!;
    return { query: best.value, label: row.name, distance: best.distance };
  });
  if (!parsed.model) {
    for (const entry of entries) for (const value of [entry.row.brand, entry.row.category]) {
      if (value) candidates.push({ query: value, label: value, distance: distance(needle, compact(value), maximum) });
    }
    for (const facet of facets) {
      if (!entries.some((entry) => optionMatches(entry.row, facet))) continue;
      const label = /^(da|yes|true|1)$/i.test(facet.option.label) ? facet.node.title : facet.option.label;
      for (const alias of facet.aliases) candidates.push({ query: label, label, distance: distance(needle, compact(alias), maximum) });
    }
  }
  return candidates.filter((candidate) => candidate.distance > 0 && candidate.distance <= maximum).sort((a, b) => a.distance - b.distance || a.label.localeCompare(b.label))
    .filter((candidate, index, all) => all.findIndex((other) => canonical(other.query) === canonical(candidate.query)) === index).slice(0, 3).map(({ label, query: corrected }) => {
      // Retain recognized price/gender/other conditions when fixing one model
      // or word, rather than silently replacing the entire combined query.
      const pattern = parsed.terms.length ? new RegExp(parsed.terms.join('[\\s_-]*'), 'i') : null;
      const replacement = pattern ? query.replace(pattern, () => corrected) : corrected;
      return { label, query: (replacement === query ? corrected : replacement).slice(0, 120) };
    });
}
function cursorOffset(cursor: string | undefined, key: string): number {
  if (!cursor) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { key?: string; offset?: number };
    if (decoded.key !== key || !Number.isSafeInteger(decoded.offset) || decoded.offset! < 0 || decoded.offset! > 1_000_000) throw new Error('cursor');
    return decoded.offset!;
  } catch { throw new ValidationFailedError('Neispravan kursor pretrage.'); }
}
function seeded(seed: string, id: string) { return createHash('sha256').update(`${seed}:${id}`).digest('hex'); }

export async function searchPublicCatalog(pool: Pool, organizationId: string, input: SearchQuery): Promise<CatalogSearchResponse> {
  const data = await snapshot(pool, organizationId);
  const scope = data.entries.filter((entry) => !input.department || entry.row.department === input.department);
  const facets = data.facets.filter((facet) => !input.department || facet.department === input.department);
  const query = input.q.length >= 2 ? canonical(input.q) : '';
  const parsed = parseQuery(input.q.length >= 2 ? input.q : '', facets);
  const ranked = query ? scope.map((entry) => ({ entry, score: rank(entry, parsed, input.q) })).filter((item): item is { entry: Entry; score: number } => item.score !== null) : [];
  ranked.sort((a, b) => {
    const priceDifference = Number(a.entry.row.price) - Number(b.entry.row.price);
    if (input.sort !== 'relevance' && priceDifference) return input.sort === 'price_asc' ? priceDifference : -priceDifference;
    return b.score - a.score || Number(b.entry.row.department === 'satovi') - Number(a.entry.row.department === 'satovi') || a.entry.row.name.localeCompare(b.entry.row.name, 'sr-Latn', { numeric: true }) || a.entry.row.id.localeCompare(b.entry.row.id);
  });
  const key = createHash('sha256').update(JSON.stringify([organizationId, input.q, input.department, input.sort])).digest('hex').slice(0, 24);
  const offset = input.mode === 'results' ? cursorOffset(input.cursor, key) : 0;
  const size = input.mode === 'results' ? 24 : 6;
  const selected = ranked.slice(offset, offset + size).map(({ entry }) => entry.row.id);
  const recommended = query && !ranked.length ? data.entries.filter((entry) => entry.row.department === 'satovi')
    .sort((a, b) => Number(b.row.in_stock) - Number(a.row.in_stock) || seeded(input.seed, a.row.id).localeCompare(seeded(input.seed, b.row.id))).slice(0, 6).map((entry) => entry.row.id) : [];
  const ids = [...new Set([...selected, ...recommended])];
  const cards = ids.length ? (await new CatalogRepository(pool).listPublicProducts({ organizationId }, { productIds: ids, limit: ids.length })).items : [];
  const byId = new Map(cards.map((card) => [card.productId, card]));
  const ordered = (keys: string[]) => keys.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
  const groups = suggestions(facets, query ? ranked.map(({ entry }) => entry) : scope, query);
  const departmentCounts = departments.map((department) => ({ id: department, count: ranked.filter(({ entry }) => entry.row.department === department).length }));
  return {
    query: input.q, normalizedQuery: query, recognized: parsed.labels,
    intent: parsed.model ? 'products' : groups.brands.length ? 'brands' : groups.collections.length ? 'collections' : 'products',
    groups, items: ordered(selected), total: ranked.length, departments: departmentCounts,
    corrections: query && !ranked.length ? await corrections(pool, organizationId, input.q, parsed, scope, facets) : [],
    recommendations: ordered(recommended),
    message: query && !ranked.length ? parsed.model ? 'Nemamo taj model ili oznaka nije tačno ukucana.' : 'Nema rezultata za ovu pretragu.' : null,
    nextCursor: offset + size < ranked.length ? Buffer.from(JSON.stringify({ key, offset: offset + size })).toString('base64url') : null
  };
}
