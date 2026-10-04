import { createHash } from 'node:crypto';
import type { SearchSynonym } from './catalog-search-settings.js';
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
  seed: z.string().max(80).default('catalog'),
  literal: z.enum(['yes','no']).default('no')
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
  conditions: Array<{id:string;label:string;query:string}>;
  appliedCorrection: {query:string;label:string;original:string} | null;
  completions: Array<{label:string;query:string;count:number}>;
  similar: Array<{product:PublicProductCard;reason:string}>;
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
interface Snapshot { entries: Entry[]; facets: Facet[]; synonyms: SearchSynonym[]; expires: number }
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
Object.assign(synonyms, {
  srebran:'srebrna', zlatan:'zlatna', crn:'crna', beo:'bela', plav:'plava', zelen:'zelena', crven:'crvena',
  mens:'muski', man:'muski', muskim:'muski', muskog:'muski', muskom:'muski', muskarca:'muski',
  womens:'zenski', woman:'zenski', ladies:'zenski', lady:'zenski', zenskim:'zenski', zenskog:'zenski', zenskom:'zenski', zenu:'zenski',
  srebrnim:'srebrna', srebrnog:'srebrna', srebrnom:'srebrna', srebrnu:'srebrna',
  zlatnim:'zlatna', zlatnog:'zlatna', zlatnom:'zlatna', zlatnu:'zlatna',
  crnim:'crna', crnog:'crna', crnom:'crna', crnu:'crna', belim:'bela', belog:'bela', belom:'bela', belu:'bela',
  plavim:'plava', plavog:'plava', plavom:'plava', plavu:'plava', zelenim:'zelena', zelenog:'zelena', zelenom:'zelena', zelenu:'zelena',
  crvenim:'crvena', crvenog:'crvena', crvenom:'crvena', crvenu:'crvena',
  purple:'ljubicasta', violet:'ljubicasta', orange:'narandzasta', beige:'bez', cream:'krem', burgundy:'bordo', pink:'roze', rose:'roze', yellow:'zuta',
  strap:'narukvica', bracelet:'narukvica', band:'narukvica', kais:'narukvica', kaisem:'narukvica', kaisa:'narukvica', narukvicom:'narukvica', narukvice:'narukvica',
  dial:'brojcanik', brojcanikom:'brojcanik', brojcanika:'brojcanik', case:'kuciste', kucistem:'kuciste', kucista:'kuciste',
  koznim:'koza', koznoj:'koza', koznu:'koza', koznom:'koza', guma:'silikon', gumeni:'silikon', gumena:'silikon', rubber:'silikon', silikonskim:'silikon',
  metalni:'metal', metalna:'metal', metalnim:'metal', metalnom:'metal', steel:'celik', stainless:'nerdjajuci',
  sapphire:'safirno', safir:'safirno', mineral:'mineralno', glass:'staklo',
  rectangular:'pravougaoni', pravougaoni:'pravougaoni', pravougaona:'pravougaoni', pravougaono:'pravougaoni', square:'kvadratni', kvadratna:'kvadratni', round:'okrugao', okrugli:'okrugao', okrugla:'okrugao',
  elegant:'elegantni', elegantan:'elegantni', elegantna:'elegantni', dress:'elegantni', sport:'sportski', sports:'sportski', sporty:'sportski', casual:'svakodnevni', everyday:'svakodnevni',
  automatic:'automatski', automatskim:'automatski', automatskog:'automatski', mehanicki:'mehanicki', mechanical:'mehanicki',
  datuma:'datum', day:'dan', weekday:'dan_u_nedelji', crown:'krunica', hands:'analogni', kazaljke:'analogni', kazaljkama:'analogni', numbers:'brojevi',
  remote:'daljinski', remotes:'daljinski', batteries:'baterije', glasses:'naocare', sunglasses:'naocare',
  under:'do', below:'do', over:'preko', above:'preko', from:'od', between:'izmedju', to:'do', and:'i', or:'ili', without:'bez', not:'nije', with:'sa',
  bicolor:'dvobojni', dvobojna:'dvobojni', dvobojno:'dvobojni',
  danielklein:'daniel klein', klajn:'klein', dk:'daniel klein', qandq:'q q',
  uskoro:'uskoro', datumom:'datum'
});
const phrases: Record<string,string> = {
  'daniel klajn':'daniel klein', 'q&q':'q q', 'q & q':'q q', 'men’s':'muski', "men's":'muski', "women's":'zenski', 'women’s':'zenski',
  'sat sa kazaljkama':'analogni', 'sat sa ciframa':'brojevi', 'sat sa brojevima':'brojevi',
  'sat na navijanje':'rucno navijanje', 'hand winding':'rucno navijanje', 'manual winding':'rucno navijanje',
  'sat bez baterije':'mehanicki', 'self winding':'automatski', 'self-winding':'automatski',
  'stainless steel':'nerdjajuci celik', 'two tone':'dvobojni', 'two-tone':'dvobojni', 'srebrno zlatni':'dvobojni',
  'water resistant':'vodootpornost', 'waterproof':'vodootpornost',
  'in stock':'na stanju', 'dostupan odmah':'na stanju', 'samo dostupni':'na stanju', 'available now':'na stanju',
  'za odelo':'elegantni', 'za svaki dan':'svakodnevni', 'sa brojevima':'brojevi',
  'thin watch':'tanak sat', 'za muskarce':'muski', 'za zene':'zenski',
  'muskisat':'muski sat', 'zenskisat':'zenski sat', 'crniili':'crni ili'
};
function prepareQuery(query:string,custom:SearchSynonym[]=[]):string {
  let text=query.toLowerCase().replace(/[а-яђјљњћџ]/g,l=>cyrillic[l]??l).replace(/đ/g,'dj').normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const replacements=[...custom.map(s=>[normalize(s.alias),normalize(s.target)] as const),...Object.entries(phrases)].sort((a,b)=>b[0].length-a[0].length);
  const lookup=new Map(replacements);
  if(replacements.length){
    const pattern=replacements.map(([alias])=>escapePattern(alias).replace(/ /g,'\\s+')).join('|');
    text=text.replace(new RegExp(`(?<![a-z0-9])(?:${pattern})(?![a-z0-9])`,'g'),match=>lookup.get(match.replace(/\s+/g,' '))??match);
  }
  return text.replace(/[a-z]+/g,(word:string,offset:number)=> /\d/.test(text[offset+word.length]||'') || (word==='dk'&&/^\s+\d/.test(text.slice(offset+word.length))) ? word : synonyms[word]??word).replace(/\s+/g,' ').trim();
}
const colors = new Set(['bela', 'crna', 'plava', 'zelena', 'crvena', 'srebrna', 'zlatna', 'braon', 'siva', 'bez', 'krem', 'bordo', 'ljubicasta', 'narandzasta', 'roze', 'zuta']);
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
    const [products, initialConfigs, searchSettings] = await Promise.all([
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
      pool.query<{ department: string; published: { filters: Node[] } | null }>('SELECT department, published FROM catalog_filter_configurations WHERE organization_id = $1', [organizationId]),
      pool.query<{synonyms:SearchSynonym[]}>('SELECT synonyms FROM catalog_search_settings WHERE organization_id=$1',[organizationId])
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
    return { entries, facets, synonyms:searchSettings.rows[0]?.synonyms||[], expires: Date.now() + 10_000 };
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
interface SearchConstraint { id:string; label:string; test:(row:SearchRow)=>boolean; query:string }
interface Parsed { tests: Array<(row: SearchRow) => boolean>; terms: string[]; labels: string[]; model: string; conditions:SearchConstraint[] }
const escapePattern=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function numericAttribute(row:SearchRow,pattern:RegExp):number|undefined{
  for(const [key,value] of Object.entries(publicAttributes(row.attributes))){
    if(!pattern.test(normalize(key)))continue;
    for(const item of Array.isArray(value)?value:[value]){const match=String(item??'').replace(',','.').match(/^(\d+(?:\.\d+)?)\s*(?:mm)?$/i);if(match)return Number(match[1]);}
  }
  return undefined;
}
function booleanAttribute(row:SearchRow,pattern:RegExp,expected:boolean){
  return Object.entries(publicAttributes(row.attributes)).some(([key,value])=>pattern.test(normalize(key))&&(Array.isArray(value)?value:[value]).some(v=>(expected?/^(da|yes|true|1)$/i:/^(ne|no|false|0)$/i).test(String(v).trim())));
}
function colorMatch(row:SearchRow,color:string,part?:string){
  const qualifier=part==='narukvica'?/narukvic|kais|strap|bracelet/:part==='brojcanik'?/brojcanik|dial/:part==='kuciste'?/kucist|case/:null;
  return Object.entries(publicAttributes(row.attributes)).some(([key,value])=>/boja|color|colour/.test(normalize(key))&&(!qualifier||qualifier.test(normalize(key)))&&canonical(Array.isArray(value)?value.join(' '):value).split(' ').includes(color));
}
function parseQuery(query: string, facets: Facet[], custom:SearchSynonym[]=[]): Parsed {
  const conditions:SearchConstraint[]=[];
  const colorPattern=[...colors].join('|');
  const whole=prepareQuery(query,custom)
    .replace(new RegExp(`\\b(brojcanik|narukvica|kuciste)\\s+((?:${colorPattern})(?:\\s+ili\\s+(?:${colorPattern}))+)\\b`,'g'),(_match,part:string,choices:string)=>`${choices} ${part}`)
    .replace(new RegExp(`\\b(brojcanik|narukvica|kuciste)\\s+(${colorPattern})\\b`,'g'),(_match,part:string,color:string)=>`${color} ${part}`);
  let text=whole;
  const add=(match:string,label:string,test:(row:SearchRow)=>boolean)=>{
    conditions.push({id:`condition-${conditions.length}`,label,test,query:whole.replace(match,' ').replace(/\s+/g,' ').trim()});
    return ' ';
  };
  const number='(\\d+(?:[.,]\\d+)*(?:\\s*(?:k|hiljada))?)';
  // Read dimensions before money: "do 40 mm" is never a 40 RSD price.
  text=text.replace(/\b(?:(?:od|izmedju)\s+)?(\d+(?:[.,]\d+)?)\s*(?:mm\s*)?(?:[-–]|do|i)\s*(\d+(?:[.,]\d+)?)\s*mm\b/g,(match,a:string,b:string)=>{
    const min=Number(a.replace(',','.')),max=Number(b.replace(',','.'));
    return add(match,`Prečnik: ${min}–${max} mm`,row=>{const n=numericAttribute(row,/precnik|diameter/);return n!==undefined&&n>=min&&n<=max;});
  });
  text=text.replace(/\b(?:(do|ispod|preko|od)\s+)?(\d+(?:[.,]\d+)?)\s*mm\b/g,(match,direction:string|undefined,raw:string)=>{
    const n=Number(raw.replace(',','.'));
    return add(match,`Prečnik: ${direction?direction+' ':''}${n} mm`,row=>{const value=numericAttribute(row,/precnik|diameter/);return value!==undefined&&(direction==='do'||direction==='ispod'?value<=n:direction==='od'||direction==='preko'?value>=n:value===n);});
  });
  text=text.replace(/\b(?:tanak|tanki)\b/g,match=>add(match,'Debljina: do 10 mm',row=>{const n=numericAttribute(row,/debljina|thickness/);return n!==undefined&&n<=10;}));
  text=text.replace(new RegExp(`\\b(?:od|izmedju)\\s+${number}\\s*(?:rsd|din(?:ara|ar|ari|arima)?)?\\s+(?:do|i|-)\\s+${number}\\s*(?:rsd|din(?:ara|ar|ari|arima)?)?\\b`,'g'),(match,a:string,b:string)=>{
    const min=amount(a),max=amount(b);return add(match,`Cena: ${min/100}–${max/100} RSD`,row=>row.price>=min&&row.price<=max);
  });
  text=text.replace(new RegExp(`\\b(do|ispod|od|preko)\\s+${number}\\s*(?:rsd|din(?:ara|ar|ari|arima)?)?\\b`,'g'),(match,direction:string,raw:string)=>{
    const n=amount(raw),minimum=direction==='od'||direction==='preko';return add(match,`Cena ${minimum?'od':'do'} ${n/100} RSD`,row=>minimum?row.price>=n:row.price<=n);
  });
  text=text.replace(/\b(?:na stanju|dostupni|dostupan|dostupna)\b/g,match=>add(match,'Na stanju',row=>row.in_stock));
  text=text.replace(/\b(?:vodootpornost\s+)?(\d+)\s*(atm|bar|m)\b/g,(match,n:string,unit:string)=>{
    const atm=unit==='m'?Number(n)/10:Number(n);
    return add(match,`Vodootpornost: ${atm} ATM (oznaka)`,row=>Object.entries(publicAttributes(row.attributes)).some(([key,value])=>/vodootpor|water/.test(normalize(key))&&(Array.isArray(value)?value:[value]).some(v=>{
      const m=String(v).toLowerCase().match(/(\d+(?:[.,]\d+)?)\s*(atm|bar|m)\b/);return m&&Number(m[1]!.replace(',','.'))/(m[2]==='m'?10:1)===atm;
    })));
  });
  text=text.replace(/\b(bez|sa)\s+datum\b/g,(match,mode:string)=>add(match,mode==='bez'?'Bez datuma':'Sa datumom',row=>booleanAttribute(row,/^datum$|^date$/,mode==='sa')));
  text=text.replace(/\b(?:rucno navijanje|mehanicki)\b/g,(match)=>add(match,match==='mehanicki'?'Mehanički (ručni ili automatski)':'Ručno navijanje',row=>Object.entries(publicAttributes(row.attributes)).some(([key,value])=>/tip.*mehaniz|movement.*type/.test(normalize(key))&&(/rucn|manual|hand|mehanick/.test(canonical(value))||(match==='mehanicki'&&/automat/.test(canonical(value)))))));
  text=text.replace(/\b(?:nerdjajuci\s+)?celik\b/g,match=>add(match,'Nerđajući čelik',row=>Object.entries(publicAttributes(row.attributes)).some(([key,value])=>/materijal|narukvic|kucist|material/.test(normalize(key))&&!/boja|color/.test(normalize(key))&&/celik|stainless|steel/.test(canonical(value)))));
  text=text.replace(/\bmetal\b/g,match=>add(match,'Metalna narukvica / kućište',row=>Object.entries(publicAttributes(row.attributes)).some(([key,value])=>/materijal|narukvic|kucist|material/.test(normalize(key))&&!/boja|color/.test(normalize(key))&&/metal|celik|titan|mesing|steel/.test(canonical(value)))));
  text=text.replace(/\bdvobojni\b/g,match=>add(match,'Dvobojni',row=>Object.entries(publicAttributes(row.attributes)).some(([key,value])=>{
    const text=canonical(value);return /dvoboj|bicolor|two tone/.test(text)||(/boja|color/.test(normalize(key))&&/narukvic|kucist|strap|case/.test(normalize(key))&&[...colors].filter(color=>text.split(' ').includes(color)).length>=2);
  })));
  text=text.replace(/\bvodootpornost\b/g,match=>add(match,'Vodootpornost navedena',row=>Object.entries(publicAttributes(row.attributes)).some(([key,value])=>/vodootpor|water/.test(normalize(key))&&Number.parseFloat(String(value))>0)));
  // Group adjacent alternatives into one OR condition, rather than requiring both brands/colors.
  const aliases=[...new Set(facets.flatMap(f=>f.aliases))].filter(a=>!colors.has(a)).sort((a,b)=>b.length-a.length);
  const orAliases=[...aliases,...colors,'muski','zenski','unisex'];
  if(orAliases.length){
    const atom=`(?:${orAliases.map(escapePattern).join('|')})`;
    text=text.replace(new RegExp(`\\b(${atom}(?:\\s+ili\\s+${atom})+)(?:\\s+(narukvica|brojcanik|kuciste))?\\b`,'g'),(match,choices:string,part:string|undefined)=>{
      const list=choices.split(/\s+ili\s+/);
      return add(match,(part?`Boja ${part==='narukvica'?'narukvice':part==='brojcanik'?'brojčanika':'kućišta'}: `:'')+list.map(alias=>displayValue(facets.find(f=>f.aliases.includes(alias)&&f.kind!=='attributes')?.option.label??alias)).join(' ili '),row=>list.some(alias=>colors.has(alias)?colorMatch(row,alias,part):['muski','zenski','unisex'].includes(alias)?canonical(row.gender)===alias||canonical(row.gender)==='unisex':facets.some(f=>f.aliases.includes(alias)&&optionMatches(row,f))));
    });
  }
  for(const gender of ['muski','zenski','unisex']){
    text=text.replace(new RegExp(`\\b${gender}\\b`,'g'),match=>add(match,gender==='muski'?'Muški':gender==='zenski'?'Ženski':'Unisex',row=>canonical(row.gender)===gender||(gender!=='unisex'&&canonical(row.gender)==='unisex')));
  }
  const colorWords=[...colors].join('|');
  // Accept both "crni brojčanik" and "brojčanik crni".
  text=text.replace(new RegExp(`\\b(brojcanik|narukvica|kuciste)\\s+(${colorWords})\\b`,'g'),(_match,part:string,color:string)=>`${color} ${part}`);
  text=text.replace(new RegExp(`\\b(?:(bez|nije)\\s+)?(${colorWords})(?:\\s+(?:boja\\s+)?(narukvica|brojcanik|kuciste))?\\b`,'g'),(match,negative:string|undefined,color:string,part:string|undefined)=>add(match,`${negative?'Isključena boja':'Boja'}${part?` ${part==='narukvica'?'narukvice':part==='brojcanik'?'brojčanika':'kućišta'}`:''}: ${displayValue(color)}`,row=>negative?!colorMatch(row,color,part):colorMatch(row,color,part)));
  for(const alias of aliases){
    text=text.replace(new RegExp(`(?<![a-z0-9])(?:(bez|nije)\\s+)?${escapePattern(alias)}(?![a-z0-9])`,'g'),(match,negative:string|undefined)=>{
      const matching=facets.filter(f=>f.aliases.includes(alias));
      const facet=matching[0];
      const label=facet&&/^(da|ne|yes|no|true|false|0|1)$/i.test(facet.option.label)?`${displayValue(facet.node.title)}: ${/^(da|yes|true|1)$/i.test(facet.option.label)?'Da':'Ne'}`:displayValue(facet?.option.label??alias);
      return add(match,`${negative?'Bez: ':''}${label}`,row=>negative?!matching.some(f=>optionMatches(row,f)):matching.some(f=>optionMatches(row,f)));
    });
  }
  let terms=normalize(text).split(/\s+/).filter(Boolean);
  for(const department of departments){
    if(terms.includes(department)){add(department,displayValue(department),row=>row.department===department);terms=terms.filter(t=>t!==department);}
  }
  const stop=new Set(['trazim','zelim','treba','mi','molim','neki','neka','neko','satovi','sa','s','za','na','od','i','ili','koji','koja','koje','ima','imaju','looking','for','a','the','please','find','show','me','watch','boja','narukvica','brojcanik','kuciste','vodootpornost','staklo','text','model','modeli','want','need','zaista']);
  terms=terms.filter(t=>!stop.has(t));
  // Compact split model codes before matching, without changing ordinary numeric price/dimension conditions.
  if(terms.some(t=>/\d/.test(t))&&terms.every(t=>/^[a-z0-9]+$/.test(t))) {
    const joined=terms.join('');
    if(/^(?:dk|ra|cr|sr|lr|ag|r|ae|a|f|w|mtp|lq|ga|gma|ecb)\d/i.test(joined))terms=[joined];
  }
  return {tests:conditions.map(c=>c.test),terms,labels:conditions.map(c=>c.label),conditions,model:terms.some(t=>/[a-z]/.test(t)&&/\d/.test(t))?terms.join(''):''};
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
interface WordFix { query:string; label:string; safe:boolean; cost:number; token:string }
function wordCorrections(query:string,entries:Entry[],facets:Facet[],custom:SearchSynonym[]):WordFix[]{
  const text=prepareQuery(query,custom);
  const vocabulary=new Map<string,string>();
  const add=(alias:string,target:string)=>{if(alias.length>=3&&!/\d/.test(alias))vocabulary.set(alias,target);};
  for(const [alias,target] of Object.entries(synonyms))if(!target.includes(' '))add(alias,target);
  for(const facet of facets)for(const alias of facet.aliases)for(const word of alias.split(' '))add(word,word);
  for(const entry of entries)for(const word of `${entry.brand} ${entry.category} ${entry.specs} ${entry.features}`.split(' '))if(word.length<=30)add(word,word);
  const unresolved=new Set(parseQuery(text,facets).terms);
  const tokens=text.match(/[a-z0-9]+/g)||[];
  const fixes:WordFix[]=[];
  for(const token of [...new Set(tokens)]){
    // Model numbers and short brand abbreviations require explicit user confirmation.
    if(!unresolved.has(token)||/\d/.test(token)||token.length<4||vocabulary.has(token)||['trazim','zelim','treba','please','looking','izmedju','hiljada','stanju','navijanje'].includes(token))continue;
    const swapped=token.replace(/[yz]/g,c=>c==='y'?'z':'y');
    const maximum=token.length>=7?3:token.length>=5?2:1;
    const matches=new Map<string,number>();
    for(const [alias,target] of vocabulary){
      const cost=alias===swapped?1:distance(token,alias,maximum);
      if(cost<=maximum)matches.set(target,Math.min(matches.get(target)??Infinity,cost));
    }
    // Missing space: only join two known words, never invent a product code.
    for(let i=3;i<=token.length-3;i++)if(vocabulary.has(token.slice(0,i))&&vocabulary.has(token.slice(i)))matches.set(`${vocabulary.get(token.slice(0,i))} ${vocabulary.get(token.slice(i))}`,1);
    const best=[...matches].sort((a,b)=>a[1]-b[1]||a[0].localeCompare(b[0],'sr')).slice(0,3);
    for(const [candidate,cost] of best){
      const safe=(cost<=2||(cost===3&&candidate.slice(0,2)===token.slice(0,2)))&&(best.length===1||best[1]![1]>cost);
      fixes.push({query:text.replace(new RegExp(`\\b${escapePattern(token)}\\b`,'g'),candidate),label:candidate,safe,cost,token});
    }
  }
  return fixes.sort((a,b)=>a.cost-b.cost);
}
function modelCorrections(query:string,parsed:Parsed,entries:Entry[]):Array<{label:string;query:string}>{
  if(!parsed.model&&!parsed.terms.some(t=>/\d/.test(t)))return [];
  const needle=compact(parsed.model||parsed.terms.join(' '));
  const maximum=needle.length>=8?2:1;
  return entries.map(entry=>({entry,cost:Math.min(...entry.codes.map(code=>distance(needle,code,maximum)))}))
    .filter(v=>v.cost>0&&v.cost<=maximum).sort((a,b)=>a.cost-b.cost).slice(0,3).map(v=>({label:v.entry.row.name,query:query.replace(new RegExp(parsed.terms.map(escapePattern).join('[\\s_-]*'),'i'),v.entry.row.name)}));
}
// Canonical tokens are for matching only. Customer-facing suggestions use Serbian agreement.
const colorForms: Record<string, [string, string, string, string]> = {
  bela:['beli','bele','belim','belom'], crna:['crni','crne','crnim','crnom'],
  plava:['plavi','plave','plavim','plavom'], zelena:['zeleni','zelene','zelenim','zelenom'],
  crvena:['crveni','crvene','crvenim','crvenom'], srebrna:['srebrni','srebrne','srebrnim','srebrnom'],
  zlatna:['zlatni','zlatne','zlatnim','zlatnom'], siva:['sivi','sive','sivim','sivom'],
  ljubicasta:['ljubičasti','ljubičaste','ljubičastim','ljubičastom'],
  narandzasta:['narandžasti','narandžaste','narandžastim','narandžastom'],
  zuta:['žuti','žute','žutim','žutom'], braon:['braon','braon','braon','braon'],
  bez:['bež','bež','bež','bež'], krem:['krem','krem','krem','krem'],
  bordo:['bordo','bordo','bordo','bordo'], roze:['roze','roze','roze','roze']
};
const adjectiveForms: Record<string, [string, string]> = {
  muski:['muški','muške'], zenski:['ženski','ženske'], unisex:['unisex','unisex'],
  automatski:['automatski','automatske'], kvarc:['kvarcni','kvarcne'],
  okrugao:['okrugli','okrugle'], pravougaoni:['pravougaoni','pravougaone'],
  kvadratni:['kvadratni','kvadratne'], elegantni:['elegantni','elegantne'],
  sportski:['sportski','sportske'], svakodnevni:['svakodnevni','svakodnevne'],
  analogni:['analogni','analogne'], digitalni:['digitalni','digitalne'], dvobojni:['dvobojni','dvobojne']
};
const displayWords: Record<string,string> = {
  naocare:'naočare', kuciste:'kućište', brojcanik:'brojčanik', datum:'datum',
  rucno:'ručno', mehanicki:'mehanički', nerdjajuci:'nerđajući', celik:'čelik',
  koza:'koža', ljubicasta:'ljubičasta', narandzasta:'narandžasta', zuta:'žuta',
  muski:'muški', zenski:'ženski', bez:'bez'
};
function displayValue(value:string):string {
  return value.replace(/[A-Za-z]+/g, word => {
    const replacement=displayWords[word.toLowerCase()];
    return replacement ? (word[0]===word[0]?.toUpperCase()?replacement[0]!.toUpperCase()+replacement.slice(1):replacement) : word;
  });
}
function colorPhrase(color:string,part:string):string {
  const forms=colorForms[color];
  if(!forms)return displayValue(color);
  return part==='narukvica'?`sa ${forms[3]} narukvicom`:part==='brojcanik'?`sa ${forms[2]} brojčanikom`:`sa ${forms[2]} kućištem`;
}
function displaySearchQuery(query:string,facets:Facet[],departmentHint?:string):string {
  let text=prepareQuery(query);
  const parts:string[]=[];
  // Keep negation and alternatives as explicit conditions rather than rewriting their meaning.
  if(/\b(?:bez|nije|ili)\b/.test(text)) {
    const parsed=parseQuery(text,facets);
    return [...parsed.labels,...parsed.terms.map(displayValue)].join(' · ');
  }
  text=text.replace(new RegExp(`\\b(?:sa\\s+)?(${[...colors].join('|')})\\s+(narukvica|brojcanik|kuciste)\\b`,'g'),(_match,color:string,part:string)=>{parts.push(colorPhrase(color,part));return ' ';});
  text=text.replace(/\b(?:sa\s+)?datum\b/g,()=>{parts.push('sa datumom');return ' ';});
  const tokens=text.split(/\s+/).filter(Boolean);
  const department=tokens.find(token=>(departments as readonly string[]).includes(token))||departmentHint;
  if(department){
    const feminine=department==='naocare'||department==='baterije';
    const adjectives:string[]=[];
    const remaining=tokens.filter(token=>{
      const forms=colorForms[token]||adjectiveForms[token];
      if(forms){adjectives.push(forms[feminine?1:0]);return false;}
      return token!==department;
    });
    const remainder=parseQuery(remaining.join(' '),facets);
    const details=[...remainder.labels,...remainder.terms.map(displayValue)];
    text=[[...adjectives,displayValue(department),...parts].join(' '),...details].join(' · ');
  }else {
    const parsed=parseQuery(text,facets);
    text=[...parsed.labels,...parsed.terms.map(displayValue),...parts].join(' · ');
  }
  // Preserve the configured spelling of brands and collections, including model names.
  for(const facet of facets.filter(f=>f.kind!=='attributes'))for(const alias of facet.aliases){
    if(alias)text=text.replace(new RegExp(`(?<![a-z0-9])${escapePattern(alias)}(?![a-z0-9])`,'gi'),()=>facet.option.label);
  }
  return text.replace(/\s+/g,' ').trim();
}
function completionQueries(query:string,entries:Entry[],facets:Facet[],custom:SearchSynonym[]){
  const base=prepareQuery(query,custom),result:Array<{label:string;query:string;count:number}>=[];
  if(!base||/\b(?:bez|nije)\b/.test(base))return result;
  const baseParsed=parseQuery(base,facets,custom);
  const matching=entries.filter(entry=>rank(entry,baseParsed,base)!==null);
  if(!matching.length)return result;
  const candidates=facets.map(facet=>({facet,count:matching.filter(entry=>optionMatches(entry.row,facet)).length})).filter(item=>item.count).sort((a,b)=>b.count-a.count).slice(0,40);
  for(const {facet} of candidates){
    const value=/^(da|yes|true|1)$/i.test(facet.option.label)?facet.node.title:facet.option.label;
    if(facet.aliases.some(a=>` ${canonical(base)} `.includes(` ${a} `)))continue;
    const token=canonical(value);
    const source=normalize(facet.option.conditions.map(condition=>condition.source).join(' '));
    const part=colors.has(token)?(/narukvic/.test(source)?'narukvica':/brojcanik/.test(source)?'brojcanik':/kucist/.test(source)?'kuciste':undefined):undefined;
    const addition=part?`${token} ${part}`:value;
    const next=`${base} ${addition}`.slice(0,120),parsed=parseQuery(next,facets,custom);
    const count=entries.filter(entry=>rank(entry,parsed,next)!==null).length;
    let label=displaySearchQuery(next,facets,facet.department);
    if(token==='dan u nedelji')label=`${displaySearchQuery(base,facets,facet.department)} sa prikazom dana u nedelji`;
    else if(token==='datum')label=`${displaySearchQuery(base,facets,facet.department)} sa datumom`;
    else if(!part&&!colorForms[token]&&!adjectiveForms[token])label=`${displaySearchQuery(base,facets,facet.department)} · ${displayValue(facet.node.title)}: ${/^(da|yes|true|1)$/i.test(facet.option.label)?'Da':displayValue(value)}`;
    if(count&&!result.some(r=>canonical(r.query)===canonical(next)||r.label===label))result.push({label,query:next,count});
  }
  return result.sort((a,b)=>b.count-a.count||a.label.localeCompare(b.label,'sr')).slice(0,5);
}

function cursorOffset(cursor: string | undefined, key: string): number {
  if (!cursor) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { key?: string; offset?: number };
    if (decoded.key !== key || !Number.isSafeInteger(decoded.offset) || decoded.offset! < 0 || decoded.offset! > 1_000_000) throw new Error('cursor');
    return decoded.offset!;
  } catch { throw new ValidationFailedError('Neispravan kursor pretrage.'); }
}
export async function searchPublicCatalog(pool: Pool, organizationId: string, input: SearchQuery): Promise<CatalogSearchResponse> {
  const data=await snapshot(pool,organizationId);
  const scope=data.entries.filter(entry=>!input.department||entry.row.department===input.department);
  const facets=data.facets.filter(f=>!input.department||f.department===input.department);
  const raw=input.q.length>=2?input.q:'';
  let effective=prepareQuery(raw,data.synonyms),parsed=parseQuery(raw,facets,data.synonyms);
  const find=(p:Parsed,q:string)=>scope.map(entry=>({entry,score:rank(entry,p,q)})).filter((v):v is {entry:Entry;score:number}=>v.score!==null);
  let ranked=raw?find(parsed,effective):[];
  const exactEmpty=Boolean(raw&&!ranked.length);
  const fixes=exactEmpty?wordCorrections(raw,scope,facets,data.synonyms):[];
  const corrected:Array<{label:string;query:string}>=[];
  let appliedCorrection:CatalogSearchResponse['appliedCorrection']=null;
  if(exactEmpty){
    // Apply only unambiguous word corrections that actually yield matching catalog products.
    let candidate=effective;
    for(let pass=0;pass<4;pass++){
      const safe=wordCorrections(candidate,scope,facets,[]).find(f=>f.safe&&f.query!==candidate);
      if(!safe)break;candidate=safe.query;
      const next=parseQuery(candidate,facets),matches=find(next,candidate);
      if(matches.length){if(input.literal!=='yes'){effective=candidate;parsed=next;ranked=matches;appliedCorrection={query:candidate,label:displaySearchQuery(candidate,facets),original:input.q};}break;}
    }
    for(const fix of fixes){if(find(parseQuery(fix.query,facets),fix.query).length&&!corrected.some(c=>c.query===fix.query))corrected.push({label:displaySearchQuery(fix.query,facets),query:fix.query});}
    // Bounded combinations cover several misspelled words without dropping other conditions.
    if(!corrected.length&&!ranked.length){
      let beam:Array<{query:string;cost:number}>=[{query:effective,cost:0}];
      const seen=new Set<string>([effective]);
      for(let depth=0;depth<4&&beam.length&&corrected.length<3;depth++){
        const next:Array<{query:string;cost:number}>=[];
        for(const node of beam){
          const options=wordCorrections(node.query,scope,facets,[]),token=options[0]?.token;
          for(const fix of options.filter(f=>f.token===token).slice(0,3)){
            if(seen.has(fix.query))continue;seen.add(fix.query);
            if(find(parseQuery(fix.query,facets),fix.query).length)corrected.push({label:displaySearchQuery(fix.query,facets),query:fix.query});
            else next.push({query:fix.query,cost:node.cost+fix.cost});
          }
        }
        beam=next.sort((a,b)=>a.cost-b.cost).slice(0,8);
      }
    }
    corrected.push(...modelCorrections(effective,parsed,scope));
  }
  ranked.sort((a,b)=>{
    const price=a.entry.row.price-b.entry.row.price;
    if(input.sort!=='relevance'&&price)return input.sort==='price_asc'?price:-price;
    return b.score-a.score||Number(b.entry.row.in_stock)-Number(a.entry.row.in_stock)||a.entry.row.name.localeCompare(b.entry.row.name,'sr-Latn',{numeric:true})||a.entry.row.id.localeCompare(b.entry.row.id);
  });
  const key=createHash('sha256').update(JSON.stringify([organizationId,input.q,effective,input.department,input.sort,input.literal])).digest('hex').slice(0,24);
  const offset=input.mode==='results'?cursorOffset(input.cursor,key):0,size=input.mode==='results'?24:6;
  const selected=ranked.slice(offset,offset+size).map(v=>v.entry.row.id);
  // Similar products relax exactly one explicit condition. Never silently relax codes or words.
  const alternatives:Array<{id:string;reason:string;score:number}>=[];
  if(raw&&!parsed.model&&parsed.conditions.length){
    for(let i=0;i<parsed.conditions.length;i++){
      if(departments.some(d=>d===normalize(parsed.conditions[i]!.label))||parsed.conditions[i]!.label==='Na stanju'||(/^(Bez|Isključena boja)/.test(parsed.conditions[i]!.label)))continue;
      const relaxed={...parsed,tests:parsed.tests.filter((_,j)=>j!==i)};
      for(const result of find(relaxed,effective)){
        if(ranked.some(r=>r.entry.row.id===result.entry.row.id)||alternatives.some(a=>a.id===result.entry.row.id))continue;
        alternatives.push({id:result.entry.row.id,reason:`Ne ispunjava uslov: ${parsed.conditions[i]!.label}`,score:result.score});
      }
    }
  }
  alternatives.sort((a,b)=>b.score-a.score);const nearby=alternatives.slice(0,6);
  const ids=[...new Set([...selected,...nearby.map(a=>a.id)])];
  const cards=ids.length?(await new CatalogRepository(pool).listPublicProducts({organizationId},{productIds:ids,limit:ids.length})).items:[];
  const byId=new Map(cards.map(card=>[card.productId,card]));
  const ordered=(keys:string[])=>keys.flatMap(id=>byId.has(id)?[byId.get(id)!]:[]);
  const groups=suggestions(facets,raw?ranked.map(v=>v.entry):scope,canonical(effective));
  return {
    query:input.q,normalizedQuery:canonical(effective),recognized:parsed.labels,
    conditions:parsed.conditions.map(({id,label,query})=>({id,label,query})),appliedCorrection,
    completions:raw&&input.mode==='suggestions'?completionQueries(effective,scope,facets,[]):[],
    similar:nearby.flatMap(a=>byId.has(a.id)?[{product:byId.get(a.id)!,reason:a.reason}]:[]),
    intent:parsed.model?'products':groups.brands.length?'brands':groups.collections.length?'collections':'products',
    groups,items:ordered(selected),total:ranked.length,departments:departments.map(d=>({id:d,count:ranked.filter(v=>v.entry.row.department===d).length})),
    corrections:corrected.slice(0,3),recommendations:[],
    message:raw&&!ranked.length?parsed.model?'Nemamo taj model ili oznaka nije tačno ukucana.':'Nema rezultata koji ispunjavaju sve uslove.':null,
    nextCursor:offset+size<ranked.length?Buffer.from(JSON.stringify({key,offset:offset+size})).toString('base64url'):null
  };
}
