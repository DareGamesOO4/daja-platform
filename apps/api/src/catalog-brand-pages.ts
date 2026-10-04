import { TransactionManager, type Database } from '@daja/database';
import type { Logger } from '@daja/observability';
import { initializeCatalogFilters } from './catalog-filters-defaults.js';
import { automaticFilterOptions } from './catalog-filter-options.js';

interface BrandFilterNode {
  mode: string; sources: string[]; visible: boolean; style: string;
  autoAddOptions?: boolean | undefined; unit?: string;
  options: Array<{ id: string; label: string; visible: boolean; urlSlug?: string;
    conditions: Array<{ source: string; values: string[] }> }>;
  children: BrandFilterNode[];
}

// Keep identical to the storefront catalogUrls.urlSlug URL encoding.
function urlSlug(value: string): string {
  const cyrillic = 'абвгдђежзијклљмнњопрстћуфхцчџш';
  const latin = ['a','b','v','g','d','dj','e','z','z','i','j','k','l','lj','m','n','nj','o','p','r','s','t','c','u','f','h','c','c','dz','s'];
  return value.toLowerCase().replace(/[а-яђјљњћџ]/g, char => latin[cyrillic.indexOf(char)] || char)
    .replace(/đ/g, 'dj').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ostalo';
}

export async function publicBrandPaths(database: Database, organizationId: string, logger: Logger): Promise<string[]> {
  await new TransactionManager(database.pool, logger).run(client => initializeCatalogFilters(client, organizationId, 'satovi'));
  const [settings, brands] = await Promise.all([
    database.pool.query<{ configuration: { filters: BrandFilterNode[] } | null }>(
      'SELECT published AS configuration FROM catalog_filter_configurations WHERE organization_id = $1 AND department = $2',
      [organizationId, 'satovi']),
    database.pool.query<{ name: string }>(`
      SELECT DISTINCT b.name FROM products p
      JOIN departments d ON d.id = p.department_id AND d.organization_id = p.organization_id AND d.deleted_at IS NULL
      JOIN brands b ON b.id = p.brand_id AND b.organization_id = p.organization_id AND b.deleted_at IS NULL
      WHERE p.organization_id = $1 AND d.slug = 'satovi' AND p.deleted_at IS NULL AND p.active AND p.published
        AND EXISTS (SELECT 1 FROM product_variants v WHERE v.organization_id = p.organization_id
          AND v.product_id = p.id AND v.deleted_at IS NULL AND v.active AND v.published)`, [organizationId]),
  ]);
  const configuration = settings.rows[0]?.configuration;
  if (!configuration) return [];
  const names = new Set(brands.rows.map(brand => brand.name.trim()));
  const filters = automaticFilterOptions(configuration.filters, source => source === 'brand' ? [...names] : []);
  const leaves = (nodes: BrandFilterNode[], parentVisible = true): Array<{ node: BrandFilterNode; visible: boolean }> =>
    nodes.flatMap(node => node.mode === 'group' ? leaves(node.children, parentVisible && node.visible)
      : [{ node, visible: parentVisible && node.visible }]);
  // The storefront route resolves the first brand filter in the published tree.
  const brand = leaves(filters).find(({ node }) => node.sources.includes('brand'));
  if (!brand?.visible) return [];
  const used = new Set<string>();
  return brand.node.options.flatMap(option => {
    const base = urlSlug(option.urlSlug || option.label);
    let slug = base;
    let count = 2;
    while (used.has(slug)) slug = `${base}-${count++}`;
    used.add(slug);
    const hasProducts = option.conditions.some(condition => condition.source === 'brand'
      && condition.values.some(value => names.has(value)));
    return option.visible && hasProducts ? [`/brend/${slug}`] : [];
  });
}
