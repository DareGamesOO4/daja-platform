import type { Configuration, Node } from './catalog-page.js';

// Keep the public URL adapter aligned with dajashopweb/src/utils/catalogUrls.js.
const cyrillic = 'абвгдђежзијклљмнњопрстћуфхцчџш';
const latin = ['a','b','v','g','d','dj','e','z','z','i','j','k','l','lj','m','n','nj','o','p','r','s','t','c','u','f','h','c','c','dz','s'];
const slug = (value: string) => value.toLowerCase().replace(/[а-яђјљњћџ]/g, char => latin[cyrillic.indexOf(char)] || char)
  .replace(/đ/g, 'dj').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ostalo';
const flatten = (nodes: Node[]): Node[] => nodes.flatMap(node => node.mode === 'group' ? flatten(node.children) : [node]);
const movementRole = (node: Node) => {
  const labels = [...node.sources.map(source => source.replace(/^spec:/, '')), node.title]
    .map(value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[_\s-]+/g, ' ').trim());
  return labels.some(value => /^(tip mehanizma|movement type|type of movement)$/.test(value)) ? 'type'
    : labels.some(value => /^(mehanizam|movement|kalibar|caliber|calibre|model mehanizma|movement model)$/.test(value)) ? 'model' : '';
};
export function publicListingParams(raw: URLSearchParams, configuration: Configuration, pathname: string) {
  const next = new URLSearchParams(raw);
  const used = new Set(['page', 'sort', 'q', 'utm-source', 'utm-medium', 'utm-campaign']);
  const unique = (base: string, keys: Set<string>) => {
    let key = base, index = 2;
    while (keys.has(key)) key = `${base}-${index++}`;
    keys.add(key); return key;
  };
  let routeBrand: string | null = null;
  if (/^\/brend\/[^/]+\/?$/.test(pathname)) {
    try { routeBrand = decodeURIComponent(pathname.split('/')[2]!); } catch { routeBrand = pathname.split('/')[2]!; }
  }
  const routeGender = pathname === '/muski-satovi' ? 'Muški' : pathname === '/zenski-satovi' ? 'Ženski' : null;
  const nodes = flatten(configuration.filters);
  for (const node of nodes) {
    const role = movementRole(node);
    const base = node.sources.includes('brand') ? 'brend' : node.sources.includes('price') ? 'cena'
      : role === 'type' ? 'mehanizam' : role === 'model' ? 'kalibar' : slug(node.title);
    const key = unique(slug(node.urlSlug || base), used);
    const selectedKey = `cf_${node.id}`;
    if (node.style === 'range') {
      for (const [suffix, edge] of [['od', 'min'], ['do', 'max']] as const) {
        const value = raw.get(`${key}-${suffix}`) ?? (node.sources[0] === 'price' ? raw.get(edge) : null);
        const internal = `cf_${edge}_${node.id}`;
        if (value !== null && value !== '' && Number.isFinite(Number(value))) next.set(internal, value);
        const source = node.sources[0];
        const legacy = source?.startsWith('spec:') ? raw.getAll(`spec_${source.slice(5)}`)
          .map(value => value.trim().replace(',', '.').match(/^(\d+(?:\.\d+)?)\s*[^\d]*$/)?.[1])
          .filter((value): value is string => value !== undefined).map(Number) : [];
        if (!next.has(internal) && legacy.length) next.set(internal, String(edge === 'min' ? Math.min(...legacy) : Math.max(...legacy)));
        if (next.has(internal) && (next.get(internal) === '' || !Number.isFinite(Number(next.get(internal))))) next.delete(internal);
        next.delete(`${key}-${suffix}`);
      }
      continue;
    }
    const optionKeys = new Set<string>();
    const options = node.options.map(option => ({ option, slug: unique(slug(option.urlSlug || option.label), optionKeys) }));
    const requested = [...raw.getAll(key), ...(node.sources.includes('brand') && routeBrand ? [routeBrand] : [])];
    if (node.sources.includes('gender') && routeGender && !requested.length && !raw.has(selectedKey) && !raw.has('gender')) requested.push(routeGender);
    const ids = new Set(raw.getAll(selectedKey));
    for (const value of requested) {
      const found = options.find(item => item.slug === value || slug(item.option.label) === slug(value));
      if (found?.option.visible) ids.add(found.option.id);
    }
    for (const option of node.options.filter(option => option.visible)) {
      if (option.conditions.some(condition => raw.getAll(condition.source.startsWith('spec:') ? `spec_${condition.source.slice(5)}` : condition.source)
        .some(value => condition.values.includes(value)))) ids.add(option.id);
    }
    next.delete(key); next.delete(selectedKey);
    node.options.filter(option => option.visible && ids.has(option.id)).forEach(option => next.append(selectedKey, option.id));
  }
  const types = nodes.filter(node => movementRole(node) === 'type');
  if (types.length && !types.some(node => next.has(`cf_${node.id}`))) {
    nodes.filter(node => movementRole(node) === 'model').forEach(node => {
      next.delete(`cf_${node.id}`); next.delete(`cf_min_${node.id}`); next.delete(`cf_max_${node.id}`);
    });
  }
  for (const key of [...new Set(next.keys())]) if (['brand', 'gender', 'category', 'min', 'max'].includes(key) || key.startsWith('spec_')) next.delete(key);
  return next;
}
