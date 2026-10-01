import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

const normalized = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[_\s-]+/g, ' ').trim();
const internal = (key: string) => key.startsWith('_') || ['additional_barcodes', 'additionalbarcodes', 'rfid_piece_placements', 'rfidpieceplacements'].includes(key.toLowerCase());

/** Snapshot the existing public filters once; new sources require approval afterwards. */
export async function initializeCatalogFilters(client: PoolClient, organizationId: string, department: string) {
  const existing = await client.query('SELECT revision FROM catalog_filter_configurations WHERE organization_id = $1 AND department = $2', [organizationId, department]);
  if (existing.rowCount) return;
  const products = await client.query<{ brand: string | null; category: string | null; gender: string | null; price: string | null; attributes: Record<string, unknown> }>(
    `SELECT b.name AS brand, c.name AS category, v.gender, (v.current_price_amount / 100.0)::text AS price, v.attributes
     FROM products p
     JOIN departments d ON d.id = p.department_id AND d.organization_id = p.organization_id AND d.deleted_at IS NULL
     JOIN LATERAL (SELECT * FROM product_variants pv WHERE pv.organization_id = p.organization_id AND pv.product_id = p.id AND pv.deleted_at IS NULL AND pv.active AND pv.published ORDER BY pv.current_price_amount DESC, pv.id LIMIT 1) v ON true
     LEFT JOIN brands b ON b.id = p.brand_id AND b.organization_id = p.organization_id AND b.deleted_at IS NULL
     LEFT JOIN categories c ON c.id = p.primary_category_id AND c.organization_id = p.organization_id AND c.deleted_at IS NULL
     WHERE p.organization_id = $1 AND d.slug = $2 AND p.deleted_at IS NULL AND p.active AND p.published`, [organizationId, department]
  );
  const sources = new Map<string, { title: string; values: Set<string> }>([
    ['gender', { title: 'Pol', values: new Set(['Muški', 'Ženski']) }],
    ['brand', { title: 'Brend', values: new Set() }], ['category', { title: 'Kolekcija', values: new Set() }]
  ]);
  const add = (source: string, title: string, raw: unknown) => {
    if (raw === null || raw === undefined || typeof raw === 'object') return;
    const value = String(raw).trim();
    if (!value) return;
    if (!sources.has(source)) sources.set(source, { title, values: new Set() });
    sources.get(source)!.values.add(value);
  };
  for (const product of products.rows) {
    add('brand', 'Brend', product.brand); add('category', 'Kolekcija', product.category);
    add('price', 'Cena', product.price === null ? null : String(Number(product.price)));
    for (const [key, value] of Object.entries(product.attributes ?? {})) {
      if (!internal(key)) add(`spec:${key}`, key.replace(/_+/g, ' '), value);
    }
  }
  const priority = (source: string, title: string) => {
    const label = normalized(title);
    if (source === 'gender') return 0;
    if (source === 'brand') return 1;
    if (source === 'category') return 2;
    if (/^(stil|style|dizajn)$/.test(label)) return 3;
    if (/^(serija|series)$/.test(label)) return 4;
    if (/^(precnik|diameter|case diameter)\b/.test(label)) return 5;
    if (/^(tip mehanizma|mehanizam|movement( type)?)$/.test(label)) return 6;
    if (/^(staklo|tip stakla|glass|crystal( type)?)$/.test(label)) return 7;
    if (/(boja|color|colour|materijal|material)/.test(label)) return 8;
    return source === 'price' ? 10 : 9;
  };
  const filters = [...sources].filter(([, source]) => source.values.size > 0).sort(([a, first], [b, second]) => priority(a, first.title) - priority(b, second.title) || first.title.localeCompare(second.title, 'sr-Latn')).map(([id, source]) => {
    const label = normalized(source.title);
    const style = id === 'price' || /^(precnik|diameter|case diameter)\b/.test(label) ? 'range'
      : /\b(boja|color|colour)\b/.test(label) ? 'color'
        : /(narukvic|kais|strap|bracelet)/.test(label) && /(materijal|material)/.test(label) ? 'material' : 'checkbox';
    let values = [...source.values].sort((a, b) => a.localeCompare(b, 'sr-Latn', { numeric: true }));
    if (id === 'price') values = [...new Set([String(Math.min(...values.map(Number))), String(Math.max(...values.map(Number)))])];
    const numeric = values.map((value) => value.replace(',', '.').match(/^(\d+(?:\.\d+)?)\s*([^\d]*)$/));
    const units = new Set(numeric.map((match) => match?.[2]?.trim().toLowerCase()).filter(Boolean));
    const validRange = numeric.every(Boolean) && units.size <= 1;
    return { id: randomUUID(), title: source.title, description: '', visible: true, open: ['gender', 'brand', 'price'].includes(id), priority: 0, mode: 'options', style: style === 'range' && !validRange ? 'checkbox' : style, match: 'any', columns: style === 'color' ? 5 : 1, showCounts: style !== 'color', unit: id === 'price' ? 'RSD' : [...units][0] || '', sources: [id], children: [] as unknown[], options: values.map((value) => ({ id: randomUUID(), label: value, visible: true, color: '', image: '', conditions: [{ source: id, values: [value] }] })) };
  });
  const bracelet = filters.filter((node) => /(narukvic|kais|strap|bracelet)/.test(normalized(node.title)) && ['color', 'material'].includes(node.style));
  if (bracelet.length > 1) {
    const first = bracelet[0]!;
    const index = filters.indexOf(first);
    for (const node of bracelet) filters.splice(filters.indexOf(node), 1);
    filters.splice(index, 0, { ...first, id: randomUUID(), title: 'Narukvica', mode: 'group', sources: [], options: [], children: [...bracelet].sort((a, b) => Number(a.style === 'color') - Number(b.style === 'color')).map((node, priority) => ({ ...node, priority, title: bracelet.length === 2 ? node.style === 'color' ? 'Boja' : 'Materijal' : node.title })) });
  }
  const configuration = JSON.stringify({ schemaVersion: 1, filters: filters.map((node, index) => ({ ...node, priority: index })) });
  const created = await client.query('INSERT INTO catalog_filter_configurations (organization_id, department, revision, draft, published) VALUES ($1, $2, 1, $3::jsonb, $3::jsonb) ON CONFLICT DO NOTHING RETURNING revision', [organizationId, department, configuration]);
  if (created.rowCount) await client.query('INSERT INTO catalog_filter_versions (organization_id, department, revision, configuration) VALUES ($1, $2, 1, $3::jsonb)', [organizationId, department, configuration]);
}
