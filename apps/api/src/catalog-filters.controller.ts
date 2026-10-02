import { Body, Controller, Get, Inject, Param, Post, Put, Req, ConflictException } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import type { AppConfig } from '@daja/config';
import { TransactionManager, type Database } from '@daja/database';
import { requirePermission } from '@daja/security';
import { parseWithSchema } from '@daja/validation';
import type { Logger } from '@daja/observability';
import { CONFIG, DATABASE, LOGGER } from './tokens.js';
import { resolveRequestContext, resolvePublicRequestContext } from './runtime/request-context.js';
import { initializeCatalogFilters } from './catalog-filters-defaults.js';
import { invalidateCatalogSearch } from './catalog-search.js';
import { automaticFilterOptions } from './catalog-filter-options.js';

const departmentSchema = z.enum(['satovi', 'daljinski', 'baterije', 'naocare']);
const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const sourceSchema = z.string().min(1).max(300).refine((value) => ['brand', 'gender', 'category', 'price'].includes(value) || /^(spec|feature):.+/.test(value));
const imageSchema = z.string().max(2048).refine((value) => !value || /^https:\/\//.test(value) || /^\/(?!\/)/.test(value));
const conditionSchema = z.object({ source: sourceSchema, values: z.array(z.string().max(500)).min(1).max(500) }).strict();
const optionSchema = z.object({
  id: idSchema, label: z.string().trim().min(1).max(240), visible: z.boolean(),
  color: z.string().regex(/^$|^#[0-9a-fA-F]{6}$/), image: imageSchema,
  conditions: z.array(conditionSchema).min(1).max(30)
}).strict();
interface FilterNode {
  id: string; title: string; description: string; visible: boolean; open: boolean; priority: number;
  mode: 'group' | 'options'; style: 'checkbox' | 'color' | 'material' | 'range'; match: 'any' | 'all';
  columns: number; showCounts: boolean; unit: string; sources: string[];
  options: z.infer<typeof optionSchema>[]; children: FilterNode[];
  autoAddOptions?: boolean | undefined;
}
const nodeSchema: z.ZodType<FilterNode> = z.lazy(() => z.object({
  id: idSchema, title: z.string().trim().min(1).max(240), description: z.string().max(1000),
  visible: z.boolean(), open: z.boolean(), priority: z.number().int().min(0).max(10000),
  mode: z.enum(['group', 'options']), style: z.enum(['checkbox', 'color', 'material', 'range']),
  autoAddOptions: z.boolean().optional(),
  match: z.enum(['any', 'all']), columns: z.number().int().min(1).max(8), showCounts: z.boolean(),
  unit: z.string().max(30), sources: z.array(sourceSchema).max(30),
  options: z.array(optionSchema).max(1000), children: z.array(nodeSchema).max(100)
}).strict());
const configSchema = z.object({ schemaVersion: z.literal(1), filters: z.array(nodeSchema).max(200) }).strict().superRefine((config, ctx) => {
  const ids = new Set<string>();
  let total = 0;
  const visit = (nodes: FilterNode[], depth: number) => {
    for (const node of nodes) {
      total++;
      if (depth > 4 || total > 300 || ids.has(node.id)) ctx.addIssue({ code: 'custom', message: 'Neispravna dubina ili ponovljen ID filtera.' });
      ids.add(node.id);
      if (new Set(node.options.map((option) => option.id)).size !== node.options.length) ctx.addIssue({ code: 'custom', message: 'Opcije moraju imati jedinstvene identifikatore.' });
      if (node.mode === 'group' && (node.options.length || node.sources.length)) ctx.addIssue({ code: 'custom', message: 'Grupa može sadržati samo podfiltere.' });
      if (node.mode === 'options' && node.children.length) ctx.addIssue({ code: 'custom', message: 'Filter sa opcijama ne može imati podfiltere.' });
      if (node.style === 'range' && node.mode === 'options') {
        const units = new Set<string>();
        if (node.sources.length !== 1 || node.sources[0]?.startsWith('feature:')) ctx.addIssue({ code: 'custom', message: 'Slider zahteva jedan numerički izvor.' });
        for (const option of node.options) for (const condition of option.conditions) for (const value of condition.values) {
          const match = value.trim().replace(',', '.').match(/^(\d+(?:\.\d+)?)\s*([^\d]*)$/);
          if (!match || condition.source !== node.sources[0]) ctx.addIssue({ code: 'custom', message: 'Slider zahteva numeričke opcije istog izvora.' });
          else units.add(match[2]!.trim().toLowerCase());
        }
        units.delete('');
        if (units.size > 1 || (units.size === 1 && node.unit && !units.has(node.unit.toLowerCase()))) ctx.addIssue({ code: 'custom', message: 'Slider mora koristiti istu jedinicu.' });
      }
      visit(node.children, depth + 1);
    }
  };
  visit(config.filters, 0);
});
const changeSchema = z.object({ revision: z.number().int().nonnegative(), configuration: configSchema }).strict();
const revisionSchema = z.object({ revision: z.number().int().nonnegative(), restoreRevision: z.number().int().positive().optional() }).strict();

@Controller()
export class CatalogFiltersController {
  constructor(@Inject(DATABASE) private readonly database: Database, @Inject(CONFIG) private readonly config: AppConfig, @Inject(LOGGER) private readonly logger: Logger) {}

  @Get('public/catalog/filters/:department')
  async published(@Req() request: Request, @Param('department') rawDepartment: string) {
    const department = parseWithSchema(departmentSchema, rawDepartment);
    const ctx = this.config.PUBLIC_ORGANIZATION_ID
      ? resolvePublicRequestContext(request, this.config.PUBLIC_ORGANIZATION_ID) : resolveRequestContext(request);
    await new TransactionManager(this.database.pool, this.logger).run((client) => initializeCatalogFilters(client, ctx.organizationId, department));
    const result = await this.database.pool.query('SELECT published AS configuration FROM catalog_filter_configurations WHERE organization_id = $1 AND department = $2', [ctx.organizationId, department]);
    const configuration = result.rows[0]?.configuration as { filters: FilterNode[] } | null;
    if (!configuration) return { configuration: null };
    const products = await this.database.pool.query<{ attributes: Record<string, unknown>; brand: string | null; category: string | null; gender: string | null; features: Array<{ title: string }>; price: string | null }>(`
      SELECT v.attributes, v.gender, p.features, b.name AS brand, c.name AS category, (v.current_price_amount / 100.0)::text AS price
      FROM products p
      JOIN departments d ON d.id = p.department_id AND d.organization_id = p.organization_id AND d.deleted_at IS NULL
      JOIN LATERAL (SELECT * FROM product_variants pv WHERE pv.organization_id = p.organization_id AND pv.product_id = p.id AND pv.deleted_at IS NULL AND pv.active AND pv.published ORDER BY pv.current_price_amount DESC, pv.id LIMIT 1) v ON true
      LEFT JOIN brands b ON b.id = p.brand_id AND b.organization_id = p.organization_id AND b.deleted_at IS NULL
      LEFT JOIN categories c ON c.id = p.primary_category_id AND c.organization_id = p.organization_id AND c.deleted_at IS NULL
      WHERE p.organization_id = $1 AND d.slug = $2 AND p.deleted_at IS NULL AND p.active AND p.published`, [ctx.organizationId, department]);
    const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[_\s-]+/g, ' ').trim();
    const read = (source: string) => products.rows.flatMap((product) => {
      if (source.startsWith('feature:')) return (product.features || []).some((feature) => feature.title?.trim() === source.slice(8)) ? ['Da'] : [];
      if (source === 'gender') {
        const gender = normalize(product.gender || 'UNISEX');
        return gender === 'unisex' ? ['Muški', 'Ženski'] : ['muski', 'm'].includes(gender) ? ['Muški'] : ['zenski', 'z'].includes(gender) ? ['Ženski'] : [product.gender || ''];
      }
      const key = source.slice(5);
      const raw = source.startsWith('spec:') ? product.attributes?.[key] ?? Object.entries(product.attributes || {}).find(([name]) => normalize(name) === normalize(key))?.[1] : product[source as 'brand' | 'category' | 'price'];
      return (Array.isArray(raw) ? raw : [raw]).filter((value) => value !== null && value !== undefined && typeof value !== 'object').map((value) => String(value).trim());
    });
    return { configuration: { ...configuration, filters: automaticFilterOptions(configuration.filters, read) } };
  }

  @Get('admin/catalog/filters/:department')
  async draft(@Req() request: Request, @Param('department') rawDepartment: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.read');
    const department = parseWithSchema(departmentSchema, rawDepartment);
    await new TransactionManager(this.database.pool, this.logger).run((client) => initializeCatalogFilters(client, ctx.organizationId, department));
    const state = await this.database.pool.query('SELECT revision, draft, published FROM catalog_filter_configurations WHERE organization_id = $1 AND department = $2', [ctx.organizationId, department]);
    const history = await this.database.pool.query('SELECT revision, published_at AS "publishedAt", published_by AS "publishedBy" FROM catalog_filter_versions WHERE organization_id = $1 AND department = $2 ORDER BY revision DESC LIMIT 100', [ctx.organizationId, department]);
    return { ...(state.rows[0] ?? { revision: 0, draft: null, published: null }), history: history.rows };
  }

  @Put('admin/catalog/filters/:department/draft')
  async save(@Req() request: Request, @Param('department') department: string, @Body() body: unknown) {
    const input = parseWithSchema(changeSchema, body);
    return this.change(request, department, input.revision, input.configuration);
  }

  @Post('admin/catalog/filters/:department/publish')
  async publish(@Req() request: Request, @Param('department') department: string, @Body() body: unknown) {
    const input = parseWithSchema(revisionSchema, body);
    return this.change(request, department, input.revision, undefined, true, input.restoreRevision);
  }

  private async change(request: Request, rawDepartment: string, revision: number, configuration?: z.infer<typeof configSchema>, publish = false, restoreRevision?: number) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const department = parseWithSchema(departmentSchema, rawDepartment);
    const result = await new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      await client.query('INSERT INTO catalog_filter_configurations (organization_id, department) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ctx.organizationId, department]);
      const current = await client.query('SELECT revision, draft FROM catalog_filter_configurations WHERE organization_id = $1 AND department = $2 FOR UPDATE', [ctx.organizationId, department]);
      if (current.rows[0]?.revision !== revision) throw new ConflictException('Filtere je izmenio drugi administrator. Ponovo učitaj podešavanja.');
      let next: unknown = configuration ?? current.rows[0]?.draft;
      if (restoreRevision !== undefined) {
        const previous = await client.query('SELECT configuration FROM catalog_filter_versions WHERE organization_id = $1 AND department = $2 AND revision = $3', [ctx.organizationId, department, restoreRevision]);
        next = previous.rows[0]?.configuration;
      }
      const valid = parseWithSchema(configSchema, next);
      const newRevision = revision + 1;
      await client.query(`UPDATE catalog_filter_configurations SET draft = $3::jsonb, revision = $4, updated_by = $5, updated_at = now()${publish ? ', published = $3::jsonb' : ''} WHERE organization_id = $1 AND department = $2`, [ctx.organizationId, department, JSON.stringify(valid), newRevision, ctx.userId]);
      if (publish) await client.query('INSERT INTO catalog_filter_versions (organization_id, department, revision, configuration, published_by) VALUES ($1, $2, $3, $4::jsonb, $5)', [ctx.organizationId, department, newRevision, JSON.stringify(valid), ctx.userId]);
      return { revision: newRevision, configuration: valid };
    });
    if (publish) invalidateCatalogSearch(ctx.organizationId);
    return result;
  }
}
