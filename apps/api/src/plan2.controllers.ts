/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  ForbiddenException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Queue } from 'bullmq';
import { z } from 'zod';
import type { AppConfig } from '@daja/config';
import type { RequestContext } from '@daja/shared';
import {
  AuditRepository,
  CatalogRepository,
  ImportRepository,
  InventoryRepository,
  MediaRepository,
  OutboxRepository,
  R2MediaStorageAdapter,
  type RedisConnection,
  RfidRepository,
  StorefrontRepository,
  TransactionManager,
  type Database
} from '@daja/database';
import type { Logger } from '@daja/observability';
import {
  requirePermission,
  ResourceConflictError,
  ResourceNotFoundError,
  TenantAccessDeniedError,
  ValidationFailedError
} from '@daja/security';
import {
  attributesSchema,
  amountMinorSchema,
  currencySchema,
  paginationLimitSchema,
  parseWithSchema,
  slugSchema,
  uuidSchema
} from '@daja/validation';
import { CONFIG, DATABASE, LOGGER, REDIS } from './tokens.js';
import { resolvePublicRequestContext, resolveRequestContext } from './runtime/request-context.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { OperationalSyncProjector } from './operational-sync-projector.js';
import { ensurePrimaryMediaThumbnail, importRemoteImage } from './remote-media.service.js';
import { ProductAlertService } from './product-alert.service.js';
import { saveBultimeLink, saveEkkaLink, saveLinkelLink, saveAdditionalLink } from './supplier-links.js';
import { normalizeBultimeUrl, normalizeEkkaUrl, normalizeLinkelUrl, normalizeAdditionalUrl } from './supplier-links.js';
import { previewSupplierLink } from './supplier-checks.js';
import { ALL_PROVIDERS, acquireSupplierLease, requestSupplierProbe, supplierProviderSummary, supplierStates, supplierStatesForProducts, supplierStateFields } from './supplier-queue.js';
import { pauseSuppliers, resumeSuppliers, supplierLinkActions, supplierLinksList, supplierStatistics, supplierTimeline, supplierCsv } from './supplier-admin.js';
import { canManageSupplierChecks } from './supplier-access.js';
import { currentEurRsdMiddleRate } from './exchange-rates.js';
import { readSearchSettings, saveSearchSettings, searchSettingsSchema, type SearchSettingsResult } from './catalog-search-settings.js';
import { invalidateCatalogSearch, searchPublicCatalog, publicSearchQuerySchema, type CatalogSearchResponse } from './catalog-search.js';
import { workforceSummary, meaningfulSpecsSql, effectiveRateSql } from './workforce-data.js';
import { specificationEditor, specificationEditorRequestSchema } from './specification-editor.js';
import { recordWorkSession, workSessionSchema, workforceDashboard, dashboardQuerySchema } from './workforce-sessions.js';
import { loadGroupState, groupOverview, resolveGroupMembers, mutateGroups, groupSaveSchema, groupRevisionSchema } from './variant-groups.js';

const productCreateSchema = z.object({
  linkelUrl: z.string().trim().max(2048).url().nullable().optional(),
  milanoUrl: z.string().trim().max(2048).url().nullable().optional(),
  timezoneUrl: z.string().trim().max(2048).url().nullable().optional(),
  qandqUrl: z.string().trim().max(2048).url().nullable().optional(),
  bultimeUrl: z.string().trim().max(2048).url().nullable().optional(),
  supplierUrl: z.string().trim().max(2048).url().refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && ['ekka.rs', 'www.ekka.rs'].includes(url.hostname.toLowerCase()) && !url.username && !url.password && !url.port && url.pathname.split('/').filter(Boolean).length >= 2;
    } catch { return false; }
  }).nullable().optional(),
  name: z.string().trim().min(1).max(240),
  slug: slugSchema,
  description: z.string().max(20_000).nullable().optional(),
  itemCondition: z.enum(['new', 'used', 'refurbished']).optional(),
  brandId: uuidSchema.nullable().optional(),
  primaryCategoryId: uuidSchema.nullable().optional(),
  departmentId: uuidSchema.nullable().optional(),
  seo: z.record(z.string(), z.string()).optional(),
  features: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(160),
        subtitle: z.string().trim().max(320).optional()
      })
    )
    .optional(),
  // Product assets may be stored as an absolute CDN URL or as a Storage path
  // such as `/models/watch.glb`, which is what the admin modal advertises.
  model3DUrl: z
    .string()
    .trim()
    .refine((value) => /^https?:\/\//i.test(value) || value.startsWith('/'), {
      message: '3D model URL must be an http(s) URL or a Storage path'
    })
    .nullable()
    .optional(),
  marketingFlags: z
    .array(z.enum(['new', 'popular', 'recommended']))
    .max(3)
    .optional(),
  active: z.boolean().optional(),
  published: z.boolean().optional(),
  legacyFirestoreId: z.string().trim().min(1).max(240).nullable().optional(),
  externalId: z.string().trim().min(1).max(240).nullable().optional()
});

const productPatchSchema = productCreateSchema.partial().extend({
  expectedVersion: z.coerce.number().int().positive().optional()
});

const catalogAuditQuerySchema = z.object({
  productId: uuidSchema.optional(),
  actorUserId: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});

const workforceQuerySchema = z.object({
  start: z.string().datetime().optional(),
  end: z.string().datetime().optional()
});

const workforceRateSchema = z.object({ rateMinor: z.coerce.number().int().min(0).max(10_000_000) });
const workforceReviewSchema = z.object({
  status: z.enum(['approved', 'changes_requested']),
  note: z.string().trim().max(2_000).optional()
});

const optionalSkuSchema = z
  .string()
  .trim()
  .max(120)
  .nullable()
  .optional()
  .transform((value) => value || null);

const variantCreateSchema = z.object({
  sku: optionalSkuSchema,
  barcode: z.string().trim().min(1).max(120).nullable().optional(),
  mpn: z.string().trim().min(1).max(120).nullable().optional(),
  name: z.string().trim().min(1).max(240).nullable().optional(),
  gender: z.string().trim().min(1).max(80).nullable().optional(),
  currentPriceAmount: amountMinorSchema,
  currency: currencySchema,
  attributes: attributesSchema.optional(),
  active: z.boolean().optional(),
  published: z.boolean().optional()
});

const variantPatchSchema = variantCreateSchema.partial().extend({
  // null is intentional: it means the user explicitly cleared the EPC field.
  epc: z.string().trim().min(1).nullable().optional(),
  expectedVersion: z.coerce.number().int().positive().optional()
});
const scheduledPriceSchema = z.object({
  amountMinor: amountMinorSchema,
  currency: currencySchema,
  priceType: z.enum(['sell', 'sale', 'cost']),
  validFrom: z.string().datetime().optional(),
  validUntil: z.string().datetime().nullable().optional()
});

const brandSchema = z.object({
  name: z.string().trim().min(1).max(240),
  slug: slugSchema.optional(),
  departmentId: uuidSchema,
  active: z.boolean().optional()
});

const categorySchema = z.object({
  name: z.string().trim().min(1).max(240),
  slug: slugSchema.optional(),
  departmentId: uuidSchema,
  brandId: uuidSchema.nullable().optional(),
  parentId: uuidSchema.nullable().optional(),
  sortOrder: z.coerce.number().int().optional(),
  active: z.boolean().optional()
});

const specKeySchema = z.object({
  name: z.string().trim().min(1).max(240),
  slug: slugSchema.optional(),
  departmentId: uuidSchema,
  unit: z.string().trim().max(80).nullable().optional(),
  dataType: z.string().trim().min(1).max(80).optional(),
  optionValues: z.array(z.string().trim().min(1).max(160)).max(100).optional(),
  active: z.boolean().optional()
});

const departmentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugSchema.optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
  active: z.boolean().optional()
});

function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sitemapLastmod(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function storefrontSiteUrl(config: AppConfig): string {
  return (
    config.OAUTH_FRONTEND_REDIRECT_URL ||
    config.CORS_ALLOWED_ORIGINS.find((origin) => !origin.includes('localhost')) ||
    config.STOREFRONT_PUBLIC_BASE_URL ||
    'https://dajashop.rs'
  ).replace(/\/$/, '');
}

function merchantDescription(value: unknown, fallback: string): string {
  const text = String(value || fallback).replace(/\s+/g, ' ').trim();
  return text.slice(0, 5000);
}

function merchantCondition(value: unknown): string {
  return value === 'used' ? 'used' : value === 'refurbished' ? 'refurbished' : 'new';
}

@Controller('public/catalog')
export class PublicCatalogController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(REDIS) private readonly redis: RedisConnection
  ) {}

  @Get('search')
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  async search(@Req() request: Request, @Query() query: Record<string, string | undefined>): Promise<CatalogSearchResponse> {
    return searchPublicCatalog(this.database.pool, this.publicContext(request).organizationId, parseWithSchema(publicSearchQuerySchema, query));
  }

  @Get('products')
  async products(@Req() request: Request, @Query() query: Record<string, string | undefined>) {
    const ctx = this.publicContext(request);
    return new CatalogRepository(this.database.pool).listPublicProducts(ctx, {
      brand: query.brand,
      category: query.category,
      gender: query.gender,
      minPrice: query.minPrice ? amountMinorSchema.parse(query.minPrice) : undefined,
      maxPrice: query.maxPrice ? amountMinorSchema.parse(query.maxPrice) : undefined,
      query: query.query,
      cursor: query.cursor,
      limit: parseWithSchema(paginationLimitSchema, query.limit),
      sort: query.sort
    });
  }

  @Get('sitemap.xml')
  async sitemap(@Req() request: Request, @Res() response: Response): Promise<void> {
    const ctx = this.publicContext(request);
    const cacheKey = `catalog:sitemap:${ctx.organizationId}`;
    const cached = await this.redis.client.get(cacheKey);
    if (cached) {
      response
        .type('application/xml')
        .setHeader('Cache-Control', 'public, max-age=3600')
        .send(cached);
      return;
    }

    const rows = (
      await this.database.pool.query<{
        slug: string;
        updated_at: string | Date;
        images: string[];
      }>(
        `SELECT p.slug, p.updated_at,
                COALESCE(media.items, '[]'::jsonb) AS images
         FROM products p
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(ma.public_url ORDER BY pm.is_primary DESC, pm.position ASC, pm.id) AS items
           FROM product_media pm
           JOIN media_assets ma ON ma.id = pm.media_asset_id AND ma.status = 'ready'
           WHERE pm.organization_id = p.organization_id AND pm.product_id = p.id
         ) media ON true
         WHERE p.organization_id = $1 AND p.deleted_at IS NULL AND p.active AND p.published
         ORDER BY p.updated_at DESC, p.id DESC`,
        [ctx.organizationId]
      )
    ).rows;
    const siteUrl = storefrontSiteUrl(this.config);
    const staticEntries = [
      '/',
      '/catalog',
      '/muski-satovi',
      '/zenski-satovi',
      '/naocare',
      '/baterije',
      '/daljinski',
      '/about',
      '/contact',
      '/faq',
      '/usluge'
    ]
      .map((path) => `<url><loc>${escapeXml(`${siteUrl}${path}`)}</loc></url>`)
      .join('');
    const entries = rows
      .map((row) => {
        const productUrl = `${siteUrl}/product/${encodeURIComponent(row.slug)}`;
        const images = (Array.isArray(row.images) ? row.images : [])
          .filter(Boolean)
          .map((image) => `<image:image><image:loc>${escapeXml(image)}</image:loc></image:image>`)
          .join('');
        return `<url><loc>${escapeXml(productUrl)}</loc><lastmod>${sitemapLastmod(row.updated_at)}</lastmod>${images}</url>`;
      })
      .join('');
    const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">${staticEntries}${entries}</urlset>`;
    await this.redis.client.set(cacheKey, xml, 'EX', 3600);
    response
      .type('application/xml')
      .setHeader('Cache-Control', 'public, max-age=3600')
      .send(xml);
  }

  @Get('merchant-feed.xml')
  async merchantFeed(@Req() request: Request, @Res() response: Response): Promise<void> {
    const ctx = this.publicContext(request);
    const cacheKey = `catalog:merchant-feed:${ctx.organizationId}`;
    const cached = await this.redis.client.get(cacheKey);
    if (cached) {
      response.type('application/xml').setHeader('Cache-Control', 'public, max-age=3600').send(cached);
      return;
    }

    const rows = (
      await this.database.pool.query<{
        product_id: string; variant_id: string; name: string; slug: string; description: string | null;
        item_condition: string; brand: string | null; category: string | null; department: string | null;
        sku: string | null; barcode: string | null; mpn: string | null; price: number; currency: string;
        available_quantity: number; images: Array<{ url: string }>;
      }>(
        `SELECT p.id AS product_id, v.id AS variant_id, p.name, p.slug, p.description, p.item_condition,
                b.name AS brand, c.name AS category, d.name AS department, v.sku, v.barcode, v.mpn,
                COALESCE(active_sale.amount_minor, v.current_price_amount) AS price, v.currency,
                COALESCE(inventory.quantity, 0)::int AS available_quantity,
                COALESCE(media.items, '[]'::jsonb) AS images
         FROM products p
         JOIN product_variants v ON v.product_id = p.id AND v.organization_id = p.organization_id
           AND v.deleted_at IS NULL AND v.active AND v.published
         LEFT JOIN LATERAL (
           SELECT amount_minor FROM variant_prices
           WHERE organization_id = p.organization_id AND variant_id = v.id AND price_type = 'sale'
             AND valid_from <= now() AND cancelled_at IS NULL AND (valid_until IS NULL OR valid_until > now())
           ORDER BY valid_from DESC, created_at DESC LIMIT 1
         ) active_sale ON true
         LEFT JOIN brands b ON b.id = p.brand_id AND b.organization_id = p.organization_id
         LEFT JOIN categories c ON c.id = p.primary_category_id AND c.organization_id = p.organization_id
         LEFT JOIN departments d ON d.id = p.department_id AND d.organization_id = p.organization_id
         LEFT JOIN LATERAL (
           SELECT SUM(quantity)::integer AS quantity FROM inventory_balances
           WHERE organization_id = p.organization_id AND variant_id = v.id
         ) inventory ON true
         LEFT JOIN LATERAL (
           SELECT jsonb_agg(jsonb_build_object('url', ma.public_url) ORDER BY pm.is_primary DESC, pm.position ASC, pm.id) AS items
           FROM product_media pm JOIN media_assets ma ON ma.id = pm.media_asset_id AND ma.status = 'ready'
           WHERE pm.organization_id = p.organization_id AND pm.product_id = p.id
         ) media ON true
         WHERE p.organization_id = $1 AND p.deleted_at IS NULL AND p.active AND p.published
         ORDER BY p.updated_at DESC, p.id, v.id`,
        [ctx.organizationId]
      )
    ).rows;
    const siteUrl = storefrontSiteUrl(this.config);
    const items = rows
      .map((row) => {
        const title = [row.brand, row.name].filter(Boolean).join(' ').trim();
        const images = Array.isArray(row.images) ? row.images.map((image) => image?.url).filter(Boolean) : [];
        const primaryImage = images[0];
        const additionalImages = images.slice(1).map((image) => `<g:additional_image_link>${escapeXml(image)}</g:additional_image_link>`).join('');
        const productType = [row.department, row.category].filter(Boolean).join(' > ');
        const identifier = row.barcode
          ? `<g:gtin>${escapeXml(row.barcode)}</g:gtin>`
          : '<g:identifier_exists>false</g:identifier_exists>';
        return `<item><g:id>${escapeXml(row.variant_id)}</g:id><g:item_group_id>${escapeXml(row.product_id)}</g:item_group_id><title>${escapeXml(title)}</title><description>${escapeXml(merchantDescription(row.description, title))}</description><link>${escapeXml(`${siteUrl}/product/${encodeURIComponent(row.slug)}`)}</link>${primaryImage ? `<g:image_link>${escapeXml(primaryImage)}</g:image_link>` : ''}${additionalImages}<g:availability>${row.available_quantity > 0 ? 'in_stock' : 'out_of_stock'}</g:availability><g:price>${escapeXml(`${(row.price / 100).toFixed(2)} ${row.currency}`)}</g:price><g:condition>${merchantCondition(row.item_condition)}</g:condition>${row.brand ? `<g:brand>${escapeXml(row.brand)}</g:brand>` : ''}${identifier}${row.mpn ? `<g:mpn>${escapeXml(row.mpn)}</g:mpn>` : ''}${row.sku ? `<g:sku>${escapeXml(row.sku)}</g:sku>` : ''}${productType ? `<g:product_type>${escapeXml(productType)}</g:product_type>` : ''}<g:shipping><g:country>RS</g:country><g:service>Standardna dostava</g:service><g:price>${this.config.STOREFRONT_SHIPPING_COST_RSD.toFixed(2)} RSD</g:price></g:shipping></item>`;
      })
      .join('');
    const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>DajaShop Merchant Feed</title><link>${escapeXml(siteUrl)}</link><description>DajaShop proizvodi</description>${items}</channel></rss>`;
    await this.redis.client.set(cacheKey, xml, 'EX', 3600);
    response.type('application/xml').setHeader('Cache-Control', 'public, max-age=3600').send(xml);
  }

  @Get('products/:slug/variants')
  async productVariantGroup(@Req() request: Request, @Param('slug') slug: string, @Res({ passthrough: true }) response: Response) {
    const ctx = this.publicContext(request);
    const repository = new CatalogRepository(this.database.pool);
    const normalizedSlug = parseWithSchema(slugSchema, slug);
    response.setHeader('Cache-Control', 'no-store');
    const state = await loadGroupState(this.database.pool, ctx.organizationId, false);
    const source = state.products.find(item => item.slug === normalizedSlug && item.public);
    if (!source) throw new NotFoundException('Product not found');
    const ids = resolveGroupMembers(state, source.id);
    if (ids.length < 2) return { items: [] };
    const result = await repository.listPublicProducts(ctx, { productIds: ids, limit: ids.length });
    // Internal names and private group metadata never enter the public payload.
    const unique = [...new Map(result.items.map(item => [item.productId, item])).values()];
    return { items: unique.length < 2 || !unique.some(item => item.productId === source.id) ? [] : unique.filter(item => item.productId !== source.id) };
  }

  @Get('products/:slug')
  async productBySlug(
    @Req() request: Request,
    @Param('slug') slug: string,
    @Query('realtime') realtime?: string
  ) {
    const ctx = this.publicContext(request);
    const normalizedSlug = parseWithSchema(slugSchema, slug);
    const cacheKey = `catalog:slug:${ctx.organizationId}:${normalizedSlug}`;
    const cached = await this.redis.client.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as unknown;
    }
    const repository = new CatalogRepository(this.database.pool);
    const product = await repository.getPublicProductBySlug(ctx, normalizedSlug);
    if (!product) {
      const redirectTo = await repository.getPublicProductRedirect(ctx, normalizedSlug);
      // A product can disappear between a realtime event and this refresh.
      // That refresh is not a direct visitor navigation, so return a normal
      // empty payload instead of making an expected race visible as a 404.
      if (!redirectTo && realtime === '1') return null;
      if (!redirectTo) throw new NotFoundException('Product not found');
      // Return an absolute site path, not only a slug: both the SPA and the
      // Pages worker can then replace/redirect without depending on the
      // current route's relative path.
      const redirect = { redirectTo: `/product/${redirectTo}` };
      await this.redis.client.set(cacheKey, JSON.stringify(redirect), 'EX', 120);
      return redirect;
    }
    // Do not cache a sale beyond its expiry. A client refreshes only this
    // slug at that moment and must receive the regular price immediately.
    const saleExpiry =
      (product as { saleValidUntil?: string | null }).saleValidUntil;
    const expiresIn = saleExpiry ? new Date(saleExpiry).getTime() - Date.now() : Infinity;
    const cacheSeconds = Number.isFinite(expiresIn)
      ? Math.max(1, Math.min(120, Math.ceil(expiresIn / 1000)))
      : 120;
    await this.redis.client.set(cacheKey, JSON.stringify(product), 'EX', cacheSeconds);
    return product;
  }

  @Get('brands')
  async brands(@Req() request: Request) {
    return new CatalogRepository(this.database.pool).listBrands(this.publicContext(request));
  }

  @Get('categories')
  async categories(@Req() request: Request) {
    return new CatalogRepository(this.database.pool).listCategories(this.publicContext(request));
  }

  private publicContext(request: Request) {
    if (!this.config.PUBLIC_ORGANIZATION_ID) {
      return resolveRequestContext(request);
    }
    return resolvePublicRequestContext(request, this.config.PUBLIC_ORGANIZATION_ID);
  }
}

@Controller()
export class StaffCatalogController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(REDIS) private readonly redis: RedisConnection,
    private readonly realtime: RealtimeGateway,
    private readonly productAlerts: ProductAlertService
  ) {}

  private variantGroupContext(request: Request) {
    const ctx = resolveRequestContext(request);
    if (!ctx.isOwner) requirePermission(ctx, 'catalog.variant_groups.manage');
    return ctx;
  }

  @Get('admin/variant-groups')
  async variantGroups(@Req() request: Request) {
    const ctx = this.variantGroupContext(request);
    return groupOverview(await loadGroupState(this.database.pool, ctx.organizationId));
  }

  @Get('admin/variant-groups/:key')
  async variantGroup(@Req() request: Request, @Param('key') key: string) {
    const result = await this.variantGroups(request);
    const group = result.groups.find(item => item.key === key);
    if (!group) throw new ResourceNotFoundError('Variant group');
    return { group, products: result.products, assignments: result.assignments };
  }

  @Post('admin/variant-groups')
  async saveVariantGroup(@Req() request: Request, @Body() body: unknown) {
    const ctx = this.variantGroupContext(request);
    const result = await mutateGroups(this.database.pool, ctx, 'save', groupSaveSchema.parse(body));
    this.realtime.publish({ organizationId: ctx.organizationId, event: 'catalog.variant-groups.updated', payload: { revision: result.revision } });
    return result;
  }

  @Post('admin/variant-groups/:key/reset')
  async resetVariantGroup(@Req() request: Request, @Param('key') key: string, @Body() body: unknown) {
    const ctx = this.variantGroupContext(request);
    const result = await mutateGroups(this.database.pool, ctx, 'reset', { key, ...groupRevisionSchema.parse(body) });
    this.realtime.publish({ organizationId: ctx.organizationId, event: 'catalog.variant-groups.updated', payload: { revision: result.revision } });
    return result;
  }

  @Delete('admin/variant-groups/:key')
  async deleteVariantGroup(@Req() request: Request, @Param('key') key: string, @Body() body: unknown) {
    const ctx = this.variantGroupContext(request);
    const result = await mutateGroups(this.database.pool, ctx, 'delete', { key, ...groupRevisionSchema.parse(body) });
    this.realtime.publish({ organizationId: ctx.organizationId, event: 'catalog.variant-groups.updated', payload: { revision: result.revision } });
    return result;
  }

  @Post('admin/variant-groups/products/:id/automatic')
  async resetProductVariantGroup(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const ctx = this.variantGroupContext(request);
    const result = await mutateGroups(this.database.pool, ctx, 'product-reset', { key: uuidSchema.parse(id), ...groupRevisionSchema.parse(body) });
    this.realtime.publish({ organizationId: ctx.organizationId, event: 'catalog.variant-groups.updated', payload: { revision: result.revision } });
    return result;
  }

  @Post('supplier-links/preview')
  async previewSupplier(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.read');
    const input = z.object({ provider: z.enum(['ekka', 'bultime', 'linkel', 'milano', 'timezone', 'qandq']), url: z.string().trim().url() }).parse(body);
    const url = input.provider === 'ekka'
      ? normalizeEkkaUrl(input.url)
      : input.provider === 'bultime' ? normalizeBultimeUrl(input.url) : input.provider === 'linkel' ? normalizeLinkelUrl(input.url) : normalizeAdditionalUrl(input.provider, input.url);
    if (!url) throw new ValidationFailedError('Link dobavljača je obavezan');
    const lease=await acquireSupplierLease(this.database.pool,input.provider,'preview');
    if (!lease) return {status:'unverified',url,message:'Provera je odložena zbog ručne pauze ili zauzetosti sistema.'};
    try {
      const result = await previewSupplierLink(input.provider, url);
      return { ...result, url };
    } finally { await this.database.pool.query('DELETE FROM supplier_check_leases WHERE token=$1',[lease]); }
  }

  @Get('supplier-links/providers')
  async supplierProviders(@Req() request: Request) {
    const ctx=resolveRequestContext(request); requirePermission(ctx,'catalog.read');
    return {items:await supplierProviderSummary(this.database.pool,ctx.organizationId)};
  }

  @Get('supplier-links/states')
  async supplierCurrentStates(@Req() request: Request, @Query() query: Record<string,string>) {
    const ctx=resolveRequestContext(request); requirePermission(ctx,'catalog.read');
    const input=z.object({afterRevision:z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),limit:z.coerce.number().int().min(1).max(500).default(100),includeLegacy:z.enum(['true','false']).default('false')}).parse(query);
    return supplierStates(this.database.pool,ctx.organizationId,input.afterRevision,input.limit,input.includeLegacy==='true');
  }

  private async supplierManager(request: Request) {
    const ctx=resolveRequestContext(request);
    if(!await canManageSupplierChecks(this.database, ctx, this.config.STOREFRONT_ADMIN_EMAILS)) throw new ForbiddenException('Nemate dozvolu za upravljanje proverama dobavljača');
    return ctx;
  }

  @Post('supplier-links/:id/reactivate')
  async supplierReactivate(@Req() request: Request, @Param('id') id: string) {
    const ctx=await this.supplierManager(request);
    return supplierLinkActions(this.database.pool,ctx.organizationId,{action:'reactivate',ids:[z.string().uuid().parse(id)]});
  }

  @Post('supplier-links/providers/:code/probe')
  async supplierProbe(@Req() request: Request, @Param('code') code: string) {
    await this.supplierManager(request);
    await requestSupplierProbe(this.database.pool,code);
    return {accepted:true};
  }

  @Post('supplier-links/providers/pause')
  async supplierPause(@Req() request: Request,@Body() body:unknown) {
    const ctx=await this.supplierManager(request);
    const input=z.object({providers:z.array(z.enum(ALL_PROVIDERS)).min(1).max(6),mode:z.enum(['all','schedule']),until:z.string().datetime({offset:true}).nullable(),reason:z.string().trim().max(500).optional()}).parse(body);
    await pauseSuppliers(this.database.pool,input,ctx.userId);
    return {accepted:true};
  }

  @Post('supplier-links/providers/resume')
  async supplierResume(@Req() request:Request,@Body() body:unknown) {
    await this.supplierManager(request);
    const input=z.object({providers:z.array(z.enum(ALL_PROVIDERS)).min(1).max(6)}).parse(body);
    await resumeSuppliers(this.database.pool,input.providers);
    return {accepted:true};
  }

  @Post('supplier-links/actions')
  async supplierActions(@Req() request:Request,@Body() body:unknown) {
    const ctx=await this.supplierManager(request);
    const input=z.object({ids:z.array(z.string().uuid()).min(1).max(50),action:z.enum(['check','disable','reactivate']),reason:z.string().trim().max(500).optional()}).parse(body);
    return supplierLinkActions(this.database.pool,ctx.organizationId,input);
  }

  private supplierFilters(query:Record<string,string>) {
    return z.object({provider:z.enum(ALL_PROVIDERS).optional(),status:z.enum(['available','missing','unverified','disabled','checking','paused','waiting_confirmation']).optional(),search:z.string().max(240).optional(),
      attention:z.enum(['true','false']).optional().transform(value=>value==='true'),sort:z.enum(['name','number','last','next']).default('next'),direction:z.enum(['asc','desc']).default('asc'),page:z.coerce.number().int().min(1).max(100000).default(1)}).parse(query);
  }

  @Get('supplier-links/links')
  async supplierLinks(@Req() request:Request,@Query() query:Record<string,string>) {
    const ctx=resolveRequestContext(request);requirePermission(ctx,'catalog.read');
    return supplierLinksList(this.database.pool,ctx.organizationId,this.supplierFilters(query));
  }

  @Get('supplier-links/links/export')
  async supplierLinksExport(@Req() request:Request,@Query() query:Record<string,string>,@Res() response:Response) {
    const ctx=resolveRequestContext(request);requirePermission(ctx,'catalog.read');
    const result=await supplierLinksList(this.database.pool,ctx.organizationId,this.supplierFilters(query),true);
    response.setHeader('Content-Type','text/csv; charset=utf-8');
    response.setHeader('Content-Disposition','attachment; filename="dobavljaci.csv"');
    response.send(supplierCsv(result.items));
  }

  @Get('supplier-links/providers/:code/statistics')
  async supplierStatistics(@Req() request:Request,@Param('code') code:string,@Query() query:Record<string,string>) {
    const ctx=resolveRequestContext(request);requirePermission(ctx,'catalog.read');
    const provider=z.enum(['all',...ALL_PROVIDERS]).parse(code);
    const period=z.enum(['24h','7d','30d']).default('24h').parse(query.period);
    return supplierStatistics(this.database.pool,ctx.organizationId,provider,period);
  }

  @Get('supplier-links/timeline')
  async supplierTimeline(@Req() request:Request,@Query() query:Record<string,string>) {
    const ctx=resolveRequestContext(request);requirePermission(ctx,'catalog.read');
    return supplierTimeline(this.database.pool,ctx.organizationId,z.coerce.number().int().min(1).max(60).default(60).parse(query.minutes));
  }

  @Get('supplier-links/exchange-rate')
  async supplierExchangeRate(@Req() request: Request) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.read');
    return { base: 'EUR', quote: 'RSD', middleRate: await currentEurRsdMiddleRate(), source: 'NBS' };
  }

  private publishCatalogTaxonomy(
    organizationId: string,
    collection: 'departments' | 'brands' | 'categories' | 'spec_keys'
  ): void {
    this.realtime.publish({
      organizationId,
      event: 'catalog.taxonomy.updated',
      payload: { collections: [collection] }
    });
  }

  @Get('departments')
  async listDepartments(@Req() request: Request) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.read');
    return (
      await this.database.pool.query(
        `SELECT id, name, slug, sort_order AS "sortOrder", active
       FROM departments WHERE organization_id = $1 AND deleted_at IS NULL ORDER BY sort_order, name`,
        [ctx.organizationId]
      )
    ).rows;
  }

  @Post('departments')
  async createDepartment(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const input = parseWithSchema(departmentSchema, body);
    const result = await this.database.pool.query(
      `INSERT INTO departments (organization_id, name, slug, sort_order, active)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, slug, sort_order AS "sortOrder", active`,
      [
        ctx.organizationId,
        input.name,
        input.slug ?? slugifyLocal(input.name),
        input.sortOrder ?? 0,
        input.active ?? true
      ]
    );
    this.publishCatalogTaxonomy(ctx.organizationId, 'departments');
    return result.rows[0];
  }

  @Patch('departments/:id')
  async updateDepartment(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const departmentId = parseWithSchema(uuidSchema, id);
    const input = parseWithSchema(departmentSchema.partial(), body);
    const result = await this.database.pool.query(
      `UPDATE departments SET name = COALESCE($3, name), slug = COALESCE($4, slug),
       sort_order = COALESCE($5, sort_order), active = COALESCE($6, active), updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
       RETURNING id, name, slug, sort_order AS "sortOrder", active`,
      [
        ctx.organizationId,
        departmentId,
        input.name ?? null,
        input.slug ?? null,
        input.sortOrder ?? null,
        input.active ?? null
      ]
    );
    if (result.rowCount !== 1) throw new TenantAccessDeniedError();
    this.publishCatalogTaxonomy(ctx.organizationId, 'departments');
    return result.rows[0];
  }

  @Post('products')
  async createProduct(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const input = parseWithSchema(productCreateSchema, body);
    const product = await new TransactionManager(this.database.pool, this.logger).run(
      async (client) => {
        const product = await new CatalogRepository(client).createProduct(ctx, input);
        if (input.supplierUrl !== undefined) await saveEkkaLink(client, ctx.organizationId, product.id, input.supplierUrl);
        if (input.bultimeUrl !== undefined) await saveBultimeLink(client, ctx.organizationId, product.id, input.bultimeUrl);
        if (input.linkelUrl !== undefined) await saveLinkelLink(client, ctx.organizationId, product.id, input.linkelUrl);
        if (input.milanoUrl !== undefined) await saveAdditionalLink(client, ctx.organizationId, product.id, 'milano', input.milanoUrl);
        if (input.timezoneUrl !== undefined) await saveAdditionalLink(client, ctx.organizationId, product.id, 'timezone', input.timezoneUrl);
        if (input.qandqUrl !== undefined) await saveAdditionalLink(client, ctx.organizationId, product.id, 'qandq', input.qandqUrl);
        await client.query(
          `UPDATE products SET created_by_user_id = $3
           WHERE organization_id = $1 AND id = $2`,
          [ctx.organizationId, product.id, ctx.userId]
        );
        await new AuditRepository(client).append({
          ctx,
          aggregateType: 'product',
          aggregateId: product.id,
          operation: 'create',
          afterPayload: product
        });
        await new OutboxRepository(client).append({
          ctx,
          eventType: 'ProductCreated',
          aggregateType: 'product',
          aggregateId: product.id,
          payload: { productId: product.id, slug: product.slug }
        });
        return product;
      }
    );
    await this.invalidateCatalog(ctx.organizationId, product.slug);
    return product;
  }

  @Get('products')
  async listProducts(@Req() request: Request) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.read');
    return this.adminProductRows(ctx.organizationId, undefined, this.isCatalogContributor(ctx) ? ctx.userId : undefined);
  }

  @Get('products/:id')
  async getProduct(@Req() request: Request, @Param('id') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.read');
    const productId = parseWithSchema(uuidSchema, id);
    const product = (await this.adminProductRows(ctx.organizationId, productId, this.isCatalogContributor(ctx) ? ctx.userId : undefined))[0];
    if (!product) throw new TenantAccessDeniedError();
    return product;
  }

  @Get('admin/catalog-audit')
  async listCatalogAudit(
    @Req() request: Request,
    @Query() query: Record<string, string | undefined>
  ) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.read');
    const input = parseWithSchema(catalogAuditQuerySchema, query);
    const values: unknown[] = [ctx.organizationId];
    const productFilter = input.productId
      ? `AND (
           (audit.aggregate_type = 'product' AND audit.aggregate_id = $${values.push(input.productId)})
           OR (
             audit.aggregate_type IN ('variant', 'inventory_balance')
             AND variant.product_id = $${values.length}
           )
         )`
      : '';
    const actorFilter = input.actorUserId
      ? `AND audit.actor_user_id = $${values.push(input.actorUserId)}`
      : '';
    values.push(input.limit ?? 50);

    return (
      await this.database.pool.query(
        `SELECT audit.id,
                 audit.aggregate_type AS "aggregateType",
                 audit.aggregate_id AS "aggregateId",
                 CASE
                   WHEN audit.aggregate_type = 'product' THEN audit.aggregate_id
                   ELSE variant.product_id
                 END AS "productId",
                 audit.operation,
                audit.before_payload AS "beforePayload",
                audit.after_payload AS "afterPayload",
                audit.reason,
                audit.occurred_at AS "occurredAt",
                audit.actor_user_id AS "actorUserId",
                COALESCE(actor.display_name, actor.email, 'Sistem') AS "actorName",
                actor.email AS "actorEmail",
                COALESCE(
                  audit.after_payload ->> 'name',
                  audit.before_payload ->> 'name',
                  variant.name,
                  product.name,
                  'Artikal'
                ) AS "productName"
           FROM audit_events audit
           LEFT JOIN users actor
             ON actor.id = audit.actor_user_id
           LEFT JOIN product_variants variant
             ON audit.aggregate_type IN ('variant', 'inventory_balance')
            AND variant.organization_id = audit.organization_id
            AND variant.id = audit.aggregate_id
           LEFT JOIN products product
             ON product.organization_id = audit.organization_id
            AND product.id = CASE
              WHEN audit.aggregate_type = 'product' THEN audit.aggregate_id
              ELSE variant.product_id
            END
          WHERE audit.organization_id = $1
            AND audit.aggregate_type IN ('product', 'variant', 'inventory_balance')
            ${productFilter}
            ${actorFilter}
          ORDER BY audit.occurred_at DESC, audit.id DESC
          LIMIT $${values.length}`,
        values
      )
    ).rows;
  }

  @Get('admin/workforce')
  async workforce(@Req() request: Request, @Query() query: Record<string, string | undefined>) {
    const ctx = resolveRequestContext(request);
    this.requireWorkforceManager(ctx);
    const input = parseWithSchema(workforceQuerySchema, query);
    return workforceSummary(this.database.pool, ctx.organizationId,
      input.start ?? new Date(Date.now() - 30 * 86_400_000).toISOString(), input.end ?? new Date().toISOString());
  }

  @Get('admin/workforce/settings')
  async workforceSettings(@Req() request: Request) {
    const ctx = resolveRequestContext(request);
    this.requireWorkforceManager(ctx);
    return (await this.database.pool.query(
      `SELECT default_rate_minor AS "defaultRateMinor", currency FROM catalog_contributor_settings WHERE organization_id = $1`,
      [ctx.organizationId]
    )).rows[0] ?? { defaultRateMinor: 0, currency: 'RSD' };
  }

  @Patch('admin/workforce/settings')
  async updateWorkforceSettings(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    this.requireWorkforceManager(ctx);
    const input = parseWithSchema(workforceRateSchema, body);
    return (await this.database.pool.query(
      `INSERT INTO catalog_contributor_settings (organization_id, default_rate_minor, updated_by_user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id) DO UPDATE SET default_rate_minor = EXCLUDED.default_rate_minor, updated_at = now(), updated_by_user_id = EXCLUDED.updated_by_user_id
       RETURNING default_rate_minor AS "defaultRateMinor", currency`,
      [ctx.organizationId, input.rateMinor, ctx.userId]
    )).rows[0];
  }

  @Patch('admin/workforce/:userId/rate')
  async updateWorkforceRate(@Req() request: Request, @Param('userId') userId: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    this.requireWorkforceManager(ctx);
    const input = parseWithSchema(workforceRateSchema, body);
    const id = parseWithSchema(uuidSchema, userId);
    return (await this.database.pool.query(
      `INSERT INTO catalog_contributor_rates (organization_id, user_id, rate_minor, updated_by_user_id)
       SELECT $1, id, $3, $4 FROM users WHERE organization_id = $1 AND id = $2
       ON CONFLICT (organization_id, user_id) DO UPDATE SET rate_minor = EXCLUDED.rate_minor, updated_at = now(), updated_by_user_id = EXCLUDED.updated_by_user_id
       RETURNING rate_minor AS "rateMinor"`,
      [ctx.organizationId, id, input.rateMinor, ctx.userId]
    )).rows[0];
  }

  // Keep this outside /admin/workforce/:userId so it can never be interpreted
  // as a request for a different employee's protected profile.
  @Get('admin/my-workforce')
  async myWorkforce(@Req() request: Request) {
    const ctx = resolveRequestContext(request);
    const canViewOwnStats = this.isCatalogContributor(ctx) || ctx.permissions.includes('catalog.contributor');
    if (!canViewOwnStats) throw new TenantAccessDeniedError();
    const [summaryResult, returnsResult, dailyResult, hourlyResult] = await Promise.all([
      this.database.pool.query(
        `WITH bounds AS (
           SELECT date_trunc('day', now() AT TIME ZONE 'Europe/Belgrade') AT TIME ZONE 'Europe/Belgrade' AS today_start
         )
         SELECT
           count(*) FILTER (WHERE p.deleted_at IS NULL)::int AS "createdTotal",
           count(*) FILTER (WHERE p.deleted_at IS NULL AND p.created_at >= b.today_start)::int AS "createdToday",
           count(*) FILTER (WHERE p.deleted_at IS NULL AND p.created_at >= b.today_start - interval '1 day' AND p.created_at < b.today_start)::int AS "createdYesterday",
           count(*) FILTER (WHERE p.deleted_at IS NULL AND p.created_at >= b.today_start - interval '6 days')::int AS "createdThisWeek",
           count(*) FILTER (WHERE p.deleted_at IS NULL AND p.created_at >= date_trunc('month', now() AT TIME ZONE 'Europe/Belgrade') AT TIME ZONE 'Europe/Belgrade')::int AS "createdThisMonth",
           count(*) FILTER (WHERE p.deleted_at IS NULL AND p.quality_review_status = 'approved')::int AS "approvedCount",
           count(*) FILTER (WHERE p.deleted_at IS NULL AND p.quality_review_status = 'pending')::int AS "pendingCount",
           count(*) FILTER (WHERE p.deleted_at IS NULL AND p.quality_review_status = 'changes_requested')::int AS "changesRequestedCount",
           count(*) FILTER (WHERE p.deleted_at IS NOT NULL)::int AS "deletedCount",
           COALESCE(sum(p.compensation_amount_minor) FILTER (WHERE p.compensation_approved_at IS NOT NULL), 0)::int AS "approvedAmountMinor",
           COALESCE(rate.rate_minor, settings.default_rate_minor, 0)::int AS "rateMinor",
           COALESCE(settings.currency, 'RSD') AS currency
         FROM products p
         CROSS JOIN bounds b
         LEFT JOIN catalog_contributor_rates rate ON rate.organization_id = p.organization_id AND rate.user_id = p.created_by_user_id
         LEFT JOIN catalog_contributor_settings settings ON settings.organization_id = p.organization_id
         WHERE p.organization_id = $1 AND p.created_by_user_id = $2
         GROUP BY rate.rate_minor, settings.default_rate_minor, settings.currency`,
        [ctx.organizationId, ctx.userId],
      ),
      this.database.pool.query(
        `WITH bounds AS (
           SELECT date_trunc('day', now() AT TIME ZONE 'Europe/Belgrade') AT TIME ZONE 'Europe/Belgrade' AS today_start
         )
         SELECT
           count(*)::int AS "returnedTotal",
           count(*) FILTER (WHERE audit.occurred_at >= b.today_start)::int AS "returnedToday",
           count(*) FILTER (WHERE audit.occurred_at >= b.today_start - interval '1 day' AND audit.occurred_at < b.today_start)::int AS "returnedYesterday"
         FROM audit_events audit
         JOIN products p ON p.id = audit.aggregate_id AND p.organization_id = audit.organization_id
         CROSS JOIN bounds b
         WHERE audit.organization_id = $1 AND p.created_by_user_id = $2
           AND audit.operation = 'quality_changes_requested'`,
        [ctx.organizationId, ctx.userId],
      ),
      this.database.pool.query(
        `SELECT to_char(day, 'DD.MM') AS label, count(p.id)::int AS count
         FROM generate_series(
           (date_trunc('day', now() AT TIME ZONE 'Europe/Belgrade') - interval '6 days')::date,
           date_trunc('day', now() AT TIME ZONE 'Europe/Belgrade')::date,
           interval '1 day'
         ) AS day
         LEFT JOIN products p
           ON p.organization_id = $1 AND p.created_by_user_id = $2 AND p.deleted_at IS NULL
          AND p.created_at >= day AT TIME ZONE 'Europe/Belgrade'
          AND p.created_at < (day + interval '1 day') AT TIME ZONE 'Europe/Belgrade'
         GROUP BY day ORDER BY day`,
        [ctx.organizationId, ctx.userId],
      ),
      this.database.pool.query(
        `WITH bounds AS (
           SELECT date_trunc('day', now() AT TIME ZONE 'Europe/Belgrade') AT TIME ZONE 'Europe/Belgrade' AS today_start
         )
         SELECT to_char(created_at AT TIME ZONE 'Europe/Belgrade', 'HH24') AS hour, count(*)::int AS count
         FROM products p CROSS JOIN bounds b
         WHERE p.organization_id = $1 AND p.created_by_user_id = $2 AND p.deleted_at IS NULL AND p.created_at >= b.today_start
         GROUP BY 1 ORDER BY 1`,
        [ctx.organizationId, ctx.userId],
      ),
    ]);
    return {
      ...(summaryResult.rows[0] ?? {
        createdTotal: 0, createdToday: 0, createdYesterday: 0, createdThisWeek: 0, createdThisMonth: 0,
        approvedCount: 0, pendingCount: 0, changesRequestedCount: 0, deletedCount: 0,
        approvedAmountMinor: 0, rateMinor: 0, currency: 'RSD',
      }),
      ...(returnsResult.rows[0] ?? { returnedTotal: 0, returnedToday: 0, returnedYesterday: 0 }),
      daily: dailyResult.rows,
      hourly: hourlyResult.rows,
    };
  }

  @Get('admin/workforce-pricing')
  async workforcePricing(@Req() request: Request, @Query() query: Record<string, string | undefined>) {
    const ctx = resolveRequestContext(request);
    this.requireWorkforceManager(ctx);
    const { userId } = parseWithSchema(z.object({ userId: uuidSchema.optional() }), query);
    const [rules, personal, settings] = await Promise.all([
      this.database.pool.query(`SELECT id, user_id AS "userId", department_id AS "departmentId", brand_id AS "brandId", rate_minor AS "rateMinor"
        FROM catalog_contributor_rate_rules WHERE organization_id=$1 AND category_id IS NULL AND (user_id IS NULL OR user_id=$2) ORDER BY updated_at DESC`, [ctx.organizationId, userId ?? null]),
      this.database.pool.query(`SELECT rate_minor AS "rateMinor" FROM catalog_contributor_rates WHERE organization_id=$1 AND user_id=$2`, [ctx.organizationId, userId ?? null]),
      this.database.pool.query(`SELECT default_rate_minor AS "rateMinor" FROM catalog_contributor_settings WHERE organization_id=$1`, [ctx.organizationId]),
    ]);
    return { rules: rules.rows, personalRateMinor: personal.rows[0]?.rateMinor ?? null, defaultRateMinor: settings.rows[0]?.rateMinor ?? 0 };
  }

  @Put('admin/workforce-pricing')
  async saveWorkforcePricing(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    this.requireWorkforceManager(ctx);
    const input = parseWithSchema(z.object({ userId: uuidSchema.optional(), departmentId: uuidSchema.optional(), brandId: uuidSchema.optional(),
      rateMinor: z.number().int().min(0).max(10_000_000).nullable() }), body);
    if (input.brandId && !input.departmentId) throw new ValidationFailedError('Izaberite odeljenje.');
    if (!input.userId && !input.departmentId && input.rateMinor === null) throw new ValidationFailedError('Opšta cena ne može biti prazna.');
    return new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      if (input.userId) {
        const user = await client.query('SELECT 1 FROM users WHERE organization_id=$1 AND id=$2', [ctx.organizationId,input.userId]);
        if (!user.rowCount) throw new TenantAccessDeniedError();
      }
      if (input.departmentId) {
        const department = await client.query('SELECT 1 FROM departments WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL', [ctx.organizationId,input.departmentId]);
        if (!department.rowCount) throw new ValidationFailedError('Odeljenje nije dostupno.');
      }
      if (input.brandId) {
        const brand = await client.query('SELECT 1 FROM brands WHERE organization_id=$1 AND id=$2 AND department_id=$3 AND deleted_at IS NULL', [ctx.organizationId,input.brandId,input.departmentId]);
        if (!brand.rowCount) throw new ValidationFailedError('Brend ne pripada odeljenju.');
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`workforce-rates:${ctx.organizationId}`]);
      if (input.departmentId) {
        await client.query(`DELETE FROM catalog_contributor_rate_rules WHERE organization_id=$1 AND user_id IS NOT DISTINCT FROM $2::uuid
          AND department_id=$3 AND category_id IS NULL AND brand_id IS NOT DISTINCT FROM $4::uuid`, [ctx.organizationId,input.userId ?? null,input.departmentId,input.brandId ?? null]);
        if (input.rateMinor !== null) await client.query(`INSERT INTO catalog_contributor_rate_rules (organization_id,user_id,department_id,category_id,brand_id,rate_minor,updated_by_user_id)
          VALUES ($1,$2,$3,NULL,$4,$5,$6)`, [ctx.organizationId,input.userId ?? null,input.departmentId,input.brandId ?? null,input.rateMinor,ctx.userId]);
      } else if (input.userId) {
        if (input.rateMinor === null) await client.query('DELETE FROM catalog_contributor_rates WHERE organization_id=$1 AND user_id=$2', [ctx.organizationId,input.userId]);
        else await client.query(`INSERT INTO catalog_contributor_rates (organization_id,user_id,rate_minor,updated_by_user_id) VALUES ($1,$2,$3,$4)
          ON CONFLICT (organization_id,user_id) DO UPDATE SET rate_minor=EXCLUDED.rate_minor, updated_by_user_id=EXCLUDED.updated_by_user_id, updated_at=now()`, [ctx.organizationId,input.userId,input.rateMinor,ctx.userId]);
      } else {
        await client.query(`INSERT INTO catalog_contributor_settings (organization_id,default_rate_minor,updated_by_user_id) VALUES ($1,$2,$3)
          ON CONFLICT (organization_id) DO UPDATE SET default_rate_minor=EXCLUDED.default_rate_minor, updated_by_user_id=EXCLUDED.updated_by_user_id, updated_at=now()`, [ctx.organizationId,input.rateMinor,ctx.userId]);
      }
      await new AuditRepository(client).append({ ctx, aggregateType: 'catalog_compensation', aggregateId: input.userId ?? ctx.organizationId,
        operation: input.rateMinor === null ? 'rate_removed' : 'rate_updated', afterPayload: input });
      return { saved: true };
    });
  }

  @Get('admin/workforce/:userId')
  async workforceMember(@Req() request: Request, @Param('userId') userId: string) {
    const ctx = resolveRequestContext(request);
    this.requireWorkforceManager(ctx);
    const id = parseWithSchema(uuidSchema, userId);
    const rawProducts = await this.adminProductRows(ctx.organizationId, undefined, id, true);
    const products = await Promise.all(rawProducts.map(async (product) => {
      if (product.deletedAt) return { ...product, qualityMissing: [] };
      const quality = await this.productQuality(this.database.pool, ctx.organizationId, product.id);
      return { ...product, qualityMissing: quality.missing, qualityChecks: quality.checks };
    }));
    const activity = (await this.database.pool.query(
      `SELECT audit.id, audit.operation, audit.occurred_at AS "occurredAt", audit.aggregate_type AS "aggregateType", audit.aggregate_id AS "aggregateId",
              audit.before_payload AS "beforePayload", audit.after_payload AS "afterPayload", audit.reason,
              COALESCE(audit.after_payload ->> 'name', audit.before_payload ->> 'name', 'Artikal') AS "productName"
       FROM audit_events audit
       WHERE audit.organization_id = $1 AND audit.aggregate_type IN ('product', 'variant', 'inventory_balance')
         AND (audit.actor_user_id = $2 OR (audit.aggregate_type='product' AND EXISTS (
           SELECT 1 FROM products p WHERE p.organization_id=$1 AND p.id=audit.aggregate_id AND p.created_by_user_id=$2)))
       ORDER BY audit.occurred_at DESC LIMIT 250`, [ctx.organizationId, id]
    )).rows;
    const summaries = await workforceSummary(this.database.pool, ctx.organizationId, new Date(Date.now()-30*86_400_000).toISOString(), new Date().toISOString());
    const rates = (await this.database.pool.query(`SELECT p.id, ${effectiveRateSql('p')} AS "effectiveRateMinor"
      FROM products p WHERE p.organization_id=$1 AND p.created_by_user_id=$2`, [ctx.organizationId,id])).rows;
    return { products: products.map(product => ({ ...product, effectiveRateMinor: rates.find(rate => rate.id === product.id)?.effectiveRateMinor ?? 0 })), activity,
      summary: summaries.find(member => member.id === id) ?? null };
  }

  @Get('admin/workforce/:userId/timeline')
  async workforceTimeline(@Req() request: Request, @Param('userId') userId: string, @Query() query: Record<string, string | undefined>) {
    const ctx = resolveRequestContext(request);
    this.requireWorkforceManager(ctx);
    const id = parseWithSchema(uuidSchema, userId);
    const input = parseWithSchema(z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
        const parsed = new Date(`${value}T00:00:00Z`);
        return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
      })
    }), query);
    const entries = (await this.database.pool.query(
      `WITH bounds AS (
        SELECT $3::date::timestamp AT TIME ZONE 'Europe/Belgrade' AS start,
          ($3::date + 1)::timestamp AT TIME ZONE 'Europe/Belgrade' AS finish
      )
      SELECT 'product:' || p.id::text AS id, 'created' AS operation, 'product' AS "aggregateType",
        p.id AS "productId", p.name AS "productName", p.created_at AS "occurredAt", p.deleted_at AS "deletedAt"
      FROM products p CROSS JOIN bounds b
      WHERE p.organization_id=$1 AND p.created_by_user_id=$2 AND p.created_at >= b.start AND p.created_at < b.finish
      UNION ALL
      SELECT 'audit:' || a.id::text, a.operation, a.aggregate_type,
        p.id, COALESCE(p.name, a.after_payload->>'name', a.before_payload->>'name', 'Artikal'), a.occurred_at, p.deleted_at
      FROM audit_events a CROSS JOIN bounds b
      LEFT JOIN product_variants v ON a.aggregate_type IN ('variant', 'inventory_balance') AND v.id=a.aggregate_id AND v.organization_id=$1
      LEFT JOIN products p ON p.organization_id=$1 AND p.id=CASE WHEN a.aggregate_type='product' THEN a.aggregate_id ELSE v.product_id END
      WHERE a.organization_id=$1 AND a.actor_user_id=$2
        AND a.aggregate_type IN ('product', 'variant', 'inventory_balance')
        AND a.occurred_at >= b.start AND a.occurred_at < b.finish
        AND NOT (a.aggregate_type='product' AND a.operation IN ('create', 'created') AND COALESCE(p.created_by_user_id=$2, false))
      ORDER BY "occurredAt", id`, [ctx.organizationId, id, input.date]
    )).rows;
    return { date: input.date, timeZone: 'Europe/Belgrade', entries };
  }

  @Put('admin/work-sessions/:id')
  async saveWorkSession(@Req() request: Request, @Param('id') sessionId: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const input = parseWithSchema(workSessionSchema, body);
    if (input.productId) await this.assertContributorOwnsProduct(ctx, input.productId);
    return recordWorkSession(this.database.pool, ctx, parseWithSchema(uuidSchema, sessionId), input);
  }

  @Post('admin/work-sessions/:id/abandon')
  async abandonWorkSession(@Req() request: Request, @Param('id') sessionId: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const id = parseWithSchema(uuidSchema, sessionId);
    const input = parseWithSchema(z.object({ startedAt: z.string().datetime() }), body);
    if (new Date(input.startedAt).getTime() > Date.now() + 60_000) throw new ValidationFailedError('Invalid session timestamp');
    await this.database.pool.query(`INSERT INTO catalog_work_sessions(id,organization_id,user_id,kind,started_at,status,finished_at)
      VALUES($1,$2,$3,'create',$4,'abandoned',GREATEST(now(),$4::timestamptz)) ON CONFLICT(id) DO NOTHING`,
      [id, ctx.organizationId, ctx.userId, input.startedAt]);
    await this.database.pool.query(`UPDATE catalog_work_sessions SET status='abandoned',finished_at=GREATEST(now(),started_at),updated_at=now()
      WHERE id=$1 AND organization_id=$2 AND user_id=$3 AND status='open'`,
      [id, ctx.organizationId, ctx.userId]);
    return { ok: true };
  }

  @Get('admin/workforce/:userId/dashboard')
  async workforceDashboard(@Req() request: Request, @Param('userId') userId: string, @Query() query: Record<string, string | undefined>) {
    const ctx = resolveRequestContext(request);
    this.requireWorkforceManager(ctx);
    return workforceDashboard(this.database.pool, ctx.organizationId, parseWithSchema(uuidSchema, userId), parseWithSchema(dashboardQuerySchema, query));
  }

  @Patch('admin/workforce/products/:id/review')
  async reviewContributorProduct(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    this.requireWorkforceManager(ctx);
    const productId = parseWithSchema(uuidSchema, id);
    const input = parseWithSchema(workforceReviewSchema, body);
    if (input.status === 'changes_requested' && !input.note) throw new ValidationFailedError('Napomena je obavezna kada vraćate proizvod na doradu.');
    const review = await new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      const before = await new CatalogRepository(client).getProduct(ctx, productId);
      // The checklist is an approval aid, not a hard gate. A workforce manager
      // can approve compensation for incomplete products when appropriate.
      const result = await client.query(
        `UPDATE products SET quality_review_status = $3, quality_review_note = $4, quality_reviewed_by_user_id = $5, quality_reviewed_at = now(),
           compensation_approved_at = CASE WHEN $3 = 'approved' AND compensation_approved_at IS NULL THEN now() ELSE compensation_approved_at END,
           compensation_amount_minor = CASE WHEN $3 = 'approved' AND compensation_approved_at IS NULL THEN ${effectiveRateSql('products')} ELSE compensation_amount_minor END
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
         RETURNING quality_review_status AS "qualityReviewStatus", quality_review_note AS "qualityReviewNote", compensation_amount_minor AS "compensationAmountMinor"`,
        [ctx.organizationId, productId, input.status, input.note ?? null, ctx.userId]
      );
      if (!result.rows[0]) throw new TenantAccessDeniedError();
      await new AuditRepository(client).append({
        ctx,
        aggregateType: 'product',
        aggregateId: productId,
        operation: input.status === 'approved' ? 'quality_approved' : 'quality_changes_requested',
        beforePayload: before,
        afterPayload: result.rows[0],
        ...(input.note ? { reason: input.note } : {})
      });
      return { ...result.rows[0], slug: before.slug };
    });
    // A returned product must appear immediately in the contributor's
    // dashboard, without waiting for a manual browser refresh.
    await this.invalidateCatalog(ctx.organizationId, review.slug);
    return review;
  }

  @Patch('products/:id')
  async patchProduct(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const productId = parseWithSchema(uuidSchema, id);
    await this.assertContributorOwnsProduct(ctx, productId);
    const input = parseWithSchema(productPatchSchema, body);
    const patched = await new TransactionManager(this.database.pool, this.logger).run(
      async (client) => {
        const repository = new CatalogRepository(client);
        const before = await repository.getProduct(ctx, productId);
        const after = await repository.patchProduct(ctx, productId, input);
        if (input.supplierUrl !== undefined) await saveEkkaLink(client, ctx.organizationId, productId, input.supplierUrl);
        if (input.bultimeUrl !== undefined) await saveBultimeLink(client, ctx.organizationId, productId, input.bultimeUrl);
        if (input.linkelUrl !== undefined) await saveLinkelLink(client, ctx.organizationId, productId, input.linkelUrl);
        if (input.milanoUrl !== undefined) await saveAdditionalLink(client, ctx.organizationId, productId, 'milano', input.milanoUrl);
        if (input.timezoneUrl !== undefined) await saveAdditionalLink(client, ctx.organizationId, productId, 'timezone', input.timezoneUrl);
        if (input.qandqUrl !== undefined) await saveAdditionalLink(client, ctx.organizationId, productId, 'qandq', input.qandqUrl);
        await client.query(
          `UPDATE products
           SET quality_review_status = 'pending', quality_review_note = NULL,
               quality_reviewed_by_user_id = NULL, quality_reviewed_at = NULL
           WHERE organization_id = $1 AND id = $2 AND quality_review_status <> 'pending'`,
          [ctx.organizationId, productId]
        );
        await new StorefrontRepository(client).refreshProductSnapshots({
          organizationId: ctx.organizationId,
          productId
        });
        if (before.slug !== after.slug) {
          await client.query(
            `INSERT INTO product_slug_redirects (organization_id, product_id, old_slug)
             VALUES ($1, $2, $3)
             ON CONFLICT (organization_id, old_slug)
             DO UPDATE SET product_id = EXCLUDED.product_id, created_at = now()`,
            [ctx.organizationId, productId, before.slug]
          );
        }
        const relocated = await new MediaRepository(client).relocateProductMedia(
          ctx,
          { productId, previousSlug: before.slug, nextSlug: after.slug },
          () => new R2MediaStorageAdapter(this.config)
        );
        await new AuditRepository(client).append({
          ctx,
          aggregateType: 'product',
          aggregateId: productId,
          operation: 'update',
          beforePayload: before,
          afterPayload: after
        });
        return { beforeSlug: before.slug, after, staleMediaKeys: relocated.sourceKeys };
      }
    );
    if (patched.staleMediaKeys.length) {
      try {
        await new MediaRepository(this.database.pool).deleteStorageObjects(
          new R2MediaStorageAdapter(this.config),
          patched.staleMediaKeys
        );
      } catch (error) {
        // The new keys and DB references are already committed. Leaving an
        // old R2 copy is safe and preferable to breaking a saved product.
        this.logger.warn({ err: error, productId }, 'Could not delete old product media keys');
      }
    }
    // Outbox/sync must never prevent a catalog administrator from saving a
    // product. The audit record was already committed atomically with the
    // catalog change above, so it can never be missing from a saved update.
    try {
      await new TransactionManager(this.database.pool, this.logger).run(async (client) => {
        await new OutboxRepository(client).append({
          ctx,
          eventType: 'ProductUpdated',
          aggregateType: 'product',
          aggregateId: productId,
          payload: { productId, slug: patched.after.slug, published: patched.after.published }
        });
        const variant = await client.query<{ id: string }>(
          `SELECT id FROM product_variants
           WHERE organization_id = $1 AND product_id = $2 AND deleted_at IS NULL
           ORDER BY created_at LIMIT 1`,
          [ctx.organizationId, productId]
        );
        if (variant.rows[0]) {
          await new OperationalSyncProjector(client).publishProductChange(
            ctx,
            productId,
            variant.rows[0].id
          );
        }
      });
    } catch (error) {
      this.logger.warn({ err: error, productId }, 'Product saved but operational sync failed');
    }
    await this.invalidateCatalog(ctx.organizationId, patched.beforeSlug, patched.after.slug);
    return patched.after;
  }

  @Patch('products/:id/visibility')
  async patchVisibility(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const productId = parseWithSchema(uuidSchema, id);
    await this.assertContributorOwnsProduct(ctx, productId);
    const input = parseWithSchema(z.object({ active: z.boolean() }), body);
    const changed = await new TransactionManager(this.database.pool, this.logger).run(
      async (client) => {
        const repository = new CatalogRepository(client);
        const before = await repository.getProduct(ctx, productId);
        const result = await client.query<{
          id: string;
          slug: string;
          active: boolean;
          published: boolean;
        }>(
          `UPDATE products SET active = $3, version = version + 1, updated_at = now()
           WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
           RETURNING id, slug, active, published`,
          [ctx.organizationId, productId, input.active]
        );
        const after = result.rows[0];
        if (!after) throw new TenantAccessDeniedError();
        await new StorefrontRepository(client).refreshProductSnapshots({
          organizationId: ctx.organizationId,
          productId
        });
        await new AuditRepository(client).append({
          ctx,
          aggregateType: 'product',
          aggregateId: productId,
          operation: after.active ? 'publish' : 'unpublish',
          beforePayload: before,
          afterPayload: { ...before, ...after }
        });
        return after;
      }
    );
    await this.invalidateCatalog(ctx.organizationId, changed.slug);
    return changed;
  }

  @Delete('products/:id')
  async deleteProduct(@Req() request: Request, @Param('id') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    if (this.isCatalogContributor(ctx)) throw new TenantAccessDeniedError();
    const productId = parseWithSchema(uuidSchema, id);
    const deleted = await new TransactionManager(this.database.pool, this.logger).run(
      async (client) => {
        const repository = new CatalogRepository(client);
        const before = await repository.getProduct(ctx, productId);
        const variants = await client.query<{ id: string }>(
          `SELECT id FROM product_variants
           WHERE organization_id = $1 AND product_id = $2 AND deleted_at IS NULL`,
          [ctx.organizationId, productId]
        );
        const media = await client.query<{ media_asset_id: string }>(
          `DELETE FROM product_media
           WHERE organization_id = $1 AND product_id = $2
           RETURNING media_asset_id`,
          [ctx.organizationId, productId]
        );
        const mediaRepository = new MediaRepository(client);
        const storage = new R2MediaStorageAdapter(this.config);
        for (const mediaId of new Set(media.rows.map((item) => item.media_asset_id))) {
          await mediaRepository.discardUnreferenced(ctx, mediaId, storage);
        }
        await repository.softDeleteProduct(ctx, productId);
        await new StorefrontRepository(client).removeProductFromCustomerLists({
          organizationId: ctx.organizationId,
          productId
        });
        await new StorefrontRepository(client).removeProductAlerts({
          organizationId: ctx.organizationId,
          productId
        });
        await new AuditRepository(client).append({
          ctx,
          aggregateType: 'product',
          aggregateId: productId,
          operation: 'soft_delete',
          beforePayload: before
        });
        await new OutboxRepository(client).append({
          ctx,
          eventType: 'ProductUpdated',
          aggregateType: 'product',
          aggregateId: productId,
          payload: { productId, deleted: true }
        });
        const projector = new OperationalSyncProjector(client);
        for (const variant of variants.rows) {
          await projector.publishProductChange(ctx, productId, variant.id, 'delete');
        }
        return { deleted: true, slug: before.slug };
      }
    );
    await this.invalidateCatalog(ctx.organizationId, deleted.slug);
    return { deleted: true };
  }

  @Post('products/:id/variants')
  async createVariant(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const productId = parseWithSchema(uuidSchema, id);
    const input = parseWithSchema(variantCreateSchema, body);
    const created = await new TransactionManager(this.database.pool, this.logger).run(
      async (client) => {
        const repository = new CatalogRepository(client);
        const product = await repository.getProduct(ctx, productId);
        const variant = await repository.createVariant(ctx, productId, input);
        await new AuditRepository(client).append({
          ctx,
          aggregateType: 'variant',
          aggregateId: variant.id,
          operation: 'create',
          afterPayload: variant
        });
        await new OutboxRepository(client).append({
          ctx,
          eventType: 'ProductUpdated',
          aggregateType: 'product',
          aggregateId: productId,
          payload: { productId, variantId: variant.id }
        });
        await new OperationalSyncProjector(client).publishProductChange(
          ctx,
          productId,
          variant.id,
          'create'
        );
        return { productSlug: product.slug, variant };
      }
    );
    await this.invalidateCatalog(ctx.organizationId, created.productSlug);
    return created.variant;
  }

  @Patch('variants/:id')
  async patchVariant(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const variantId = parseWithSchema(uuidSchema, id);
    const input = parseWithSchema(variantPatchSchema, body);
    const patched = await new TransactionManager(this.database.pool, this.logger).run(
      async (client) => {
        const repository = new CatalogRepository(client);
        const { epc, ...variantInput } = input;
        const { before, after, priceChanged } = await repository.patchVariant(
          ctx,
          variantId,
          variantInput
        );
        await new StorefrontRepository(client).refreshProductSnapshots({
          organizationId: ctx.organizationId,
          productId: after.productId
        });
        // The EPC field lives in rfid_tags, not product_variants. A deliberate
        // null sent from the admin form must therefore clear every tag relation
        // for this variant in the same Save operation.
        if (epc === null) {
          await client.query(
            `UPDATE rfid_tags t
             SET inventory_item_id = NULL, variant_id = NULL, status = 'unassigned',
                 version = version + 1, updated_at = now()
             WHERE t.organization_id = $1 AND t.deleted_at IS NULL
               AND (
                 t.variant_id = $2
                 OR EXISTS (
                   SELECT 1 FROM inventory_items item
                   WHERE item.id = t.inventory_item_id
                     AND item.organization_id = t.organization_id
                     AND item.deleted_at IS NULL
                     AND item.variant_id = $2
                 )
               )`,
            [ctx.organizationId, variantId]
          );
        }
        const product = await repository.getProduct(ctx, after.productId);
        await new AuditRepository(client).append({
          ctx,
          aggregateType: 'variant',
          aggregateId: variantId,
          operation: priceChanged ? 'price_change' : 'update',
          beforePayload: before,
          afterPayload: after
        });
        await new OutboxRepository(client).append({
          ctx,
          eventType: priceChanged ? 'PriceChanged' : 'ProductUpdated',
          aggregateType: 'variant',
          aggregateId: variantId,
          payload: { variantId, productId: after.productId, price: after.currentPriceAmount }
        });
        await new OperationalSyncProjector(client).publishProductChange(
          ctx,
          after.productId,
          variantId
        );
        return {
          productSlug: product.slug,
          after,
          priceChanged,
          previousPriceAmount: before.currentPriceAmount
        };
      }
    );
    await this.invalidateCatalog(ctx.organizationId, patched.productSlug);
    if (patched.priceChanged) {
      await this.productAlerts.notifyPriceChanged({
        organizationId: ctx.organizationId,
        variantId,
        previousPriceAmount: patched.previousPriceAmount,
        currentPriceAmount: patched.after.currentPriceAmount
      });
    }
    return patched.after;
  }

  @Get('products/:id/variants')
  async listVariants(@Req() request: Request, @Param('id') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.read');
    return (
      await this.database.pool.query(
        `SELECT id, product_id AS "productId", sku, barcode, name, gender,
              current_price_amount AS "currentPriceAmount", currency, attributes,
              active, published, version
       FROM product_variants
       WHERE organization_id = $1 AND product_id = $2 AND deleted_at IS NULL
       ORDER BY created_at`,
        [ctx.organizationId, parseWithSchema(uuidSchema, id)]
      )
    ).rows;
  }

  @Delete('variants/:id')
  async deleteVariant(@Req() request: Request, @Param('id') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const variantId = parseWithSchema(uuidSchema, id);
    const deleted = await new TransactionManager(this.database.pool, this.logger).run(
      async (client) => {
        const variant = await client.query<{ product_id: string }>(
          `SELECT product_id FROM product_variants
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
          [ctx.organizationId, variantId]
        );
        const productId = variant.rows[0]?.product_id;
        if (!productId) throw new TenantAccessDeniedError();
        // Retire the associated EPC row as well. `deleted_at` makes the EPC
        // available for reassignment while retaining the historical record.
        await client.query(
          `UPDATE rfid_tags t
           SET deleted_at = now(), status = 'retired', inventory_item_id = NULL,
               variant_id = NULL, epc = CASE WHEN length(t.epc) % 2 = 1 THEN '0' || t.epc ELSE t.epc END,
               version = version + 1, updated_at = now()
           WHERE t.organization_id = $1 AND t.deleted_at IS NULL
             AND (t.variant_id = $2
               OR EXISTS (SELECT 1 FROM inventory_items item WHERE item.id = t.inventory_item_id
                          AND item.organization_id = t.organization_id AND item.variant_id = $2))`,
          [ctx.organizationId, variantId]
        );
        await client.query(
          `UPDATE product_variants SET deleted_at = now(), active = false, published = false,
         version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2`,
          [ctx.organizationId, variantId]
        );
        await new OperationalSyncProjector(client).publishProductChange(
          ctx,
          productId,
          variantId,
          'delete'
        );
        const product = await new CatalogRepository(client).getProduct(ctx, productId);
        return { slug: product.slug };
      }
    );
    await this.invalidateCatalog(ctx.organizationId, deleted.slug);
    return { deleted: true };
  }

  @Get('variants/:id/specifications')
  async listVariantSpecifications(@Req() request: Request, @Param('id') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.read');
    return (
      await this.database.pool.query(
        `SELECT vsv.spec_key_id AS "specKeyId", sk.name AS "specName", sk.slug AS "specSlug", sk.unit,
              sk.data_type AS "dataType", vsv.value
       FROM variant_specification_values vsv
       JOIN spec_keys sk ON sk.id = vsv.spec_key_id
       WHERE vsv.organization_id = $1 AND vsv.variant_id = $2
       ORDER BY sk.name`,
        [ctx.organizationId, parseWithSchema(uuidSchema, id)]
      )
    ).rows;
  }

  @Put('variants/:id/specifications')
  async replaceVariantSpecifications(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown
  ) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const variantId = parseWithSchema(uuidSchema, id);
    const input = parseWithSchema(
      z.object({
        values: z
          .array(z.object({ specKeyId: uuidSchema, value: z.string().trim().min(1).max(1000) }))
          .max(100)
      }),
      body
    );
    const variant = await this.database.pool.query(
      `SELECT v.product_id, p.department_id FROM product_variants v JOIN products p ON p.id = v.product_id
       WHERE v.organization_id = $1 AND v.id = $2 AND v.deleted_at IS NULL AND p.deleted_at IS NULL`,
      [ctx.organizationId, variantId]
    );
    if (variant.rowCount !== 1) throw new TenantAccessDeniedError();
    const departmentId = variant.rows[0].department_id;
    for (const item of input.values) {
      const valid = await this.database.pool.query(
        `SELECT 1 FROM spec_keys WHERE organization_id = $1 AND id = $2 AND active AND deleted_at IS NULL
         AND ($3::uuid IS NULL OR department_id = $3::uuid)`,
        [ctx.organizationId, item.specKeyId, departmentId]
      );
      if (valid.rowCount !== 1)
        throw new Error('Specification does not belong to this product department');
    }
    await new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      await client.query(
        `DELETE FROM variant_specification_values WHERE organization_id = $1 AND variant_id = $2`,
        [ctx.organizationId, variantId]
      );
      for (const item of input.values) {
        await client.query(
          `INSERT INTO variant_specification_values (organization_id, variant_id, spec_key_id, value) VALUES ($1, $2, $3, $4)`,
          [ctx.organizationId, variantId, item.specKeyId, item.value]
        );
      }
    });
    return this.listVariantSpecifications(request, id);
  }

  @Get('products/:id/media')
  async listProductMedia(@Req() request: Request, @Param('id') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.read');
    return (
      await this.database.pool.query(
        `SELECT pm.id, pm.media_asset_id AS "mediaId", pm.variant_id AS "variantId", pm.role, pm.position, pm.is_primary AS "isPrimary", pm.alt_text AS "altText",
              ma.public_url AS url, ma.status
       FROM product_media pm JOIN media_assets ma ON ma.id = pm.media_asset_id
       WHERE pm.organization_id = $1 AND pm.product_id = $2
       ORDER BY pm.is_primary DESC, pm.position, pm.id`,
        [ctx.organizationId, parseWithSchema(uuidSchema, id)]
      )
    ).rows;
  }

  @Post('products/:id/media')
  async attachProductMedia(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: unknown
  ) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const productId = parseWithSchema(uuidSchema, id);
    const input = parseWithSchema(
      z.object({
        mediaId: uuidSchema,
        role: z.string().trim().min(1).max(40).optional(),
        position: z.coerce.number().int().min(0).optional(),
        isPrimary: z.boolean().optional(),
        variantId: uuidSchema.nullable().optional(),
        altText: z.string().trim().max(240).nullable().optional()
      }),
      body
    );
    const product = await new CatalogRepository(this.database.pool).getProduct(ctx, productId);
    const asset = await this.database.pool.query(
      `SELECT 1 FROM media_assets WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [ctx.organizationId, input.mediaId]
    );
    if (asset.rowCount !== 1) throw new TenantAccessDeniedError();
    if (input.isPrimary) {
      await ensurePrimaryMediaThumbnail({
        config: this.config,
        database: this.database,
        organizationId: ctx.organizationId,
        mediaId: input.mediaId
      });
    }
    const result = await new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      // Serialize gallery mutations across tabs, retries and RFID sync.
      await client.query('SELECT id FROM products WHERE organization_id = $1 AND id = $2 FOR UPDATE', [ctx.organizationId, productId]);
      const activeAsset = await client.query(
        `SELECT id FROM media_assets WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [ctx.organizationId, input.mediaId]
      );
      if (activeAsset.rowCount !== 1) throw new TenantAccessDeniedError();
      if (input.isPrimary) await client.query(
        `UPDATE product_media SET is_primary = false WHERE organization_id = $1 AND product_id = $2`,
        [ctx.organizationId, productId]
      );
      return client.query(
        `INSERT INTO product_media (organization_id, product_id, variant_id, media_asset_id, role, position, is_primary, alt_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (organization_id, product_id, media_asset_id, role, (COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)))
         DO UPDATE SET position = EXCLUDED.position, is_primary = EXCLUDED.is_primary, alt_text = COALESCE(EXCLUDED.alt_text, product_media.alt_text)
         RETURNING id, media_asset_id AS "mediaId", role, position, is_primary AS "isPrimary", alt_text AS "altText"`,
        [ctx.organizationId, productId, input.variantId ?? null, input.mediaId, input.role ?? 'gallery', input.position ?? 0, input.isPrimary ?? false, input.altText ?? null]
      );
    });
    await new StorefrontRepository(this.database.pool).refreshProductSnapshots({
      organizationId: ctx.organizationId,
      productId
    });
    await this.publishProductSnapshots(ctx, productId);
    await this.invalidateCatalog(ctx.organizationId, product.slug);
    return result.rows[0];
  }

  @Patch('products/:productId/media/:mediaLinkId')
  async patchProductMedia(
    @Req() request: Request,
    @Param('productId') productIdParam: string,
    @Param('mediaLinkId') mediaLinkIdParam: string,
    @Body() body: unknown
  ) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const productId = parseWithSchema(uuidSchema, productIdParam);
    const linkId = parseWithSchema(uuidSchema, mediaLinkIdParam);
    const input = parseWithSchema(
      z.object({
        position: z.coerce.number().int().min(0).optional(),
        isPrimary: z.boolean().optional(),
        role: z.string().trim().min(1).max(40).optional(),
        variantId: uuidSchema.nullable().optional(),
        altText: z.string().trim().max(240).nullable().optional()
      }),
      body
    );
    const product = await new CatalogRepository(this.database.pool).getProduct(ctx, productId);
    if (input.isPrimary) {
      const media = await this.database.pool.query<{ media_id: string }>(
        `SELECT media_asset_id AS media_id FROM product_media WHERE organization_id = $1 AND product_id = $2 AND id = $3`,
        [ctx.organizationId, productId, linkId]
      );
      const mediaId = media.rows[0]?.media_id;
      if (!mediaId) throw new TenantAccessDeniedError();
      await ensurePrimaryMediaThumbnail({ config: this.config, database: this.database, organizationId: ctx.organizationId, mediaId });
    }
    const result = await new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      await client.query('SELECT id FROM products WHERE organization_id = $1 AND id = $2 FOR UPDATE', [ctx.organizationId, productId]);
      if (input.isPrimary) {
        const media = await client.query<{ media_id: string }>(
          `SELECT media_asset_id AS media_id FROM product_media
           WHERE organization_id = $1 AND product_id = $2 AND id = $3`,
          [ctx.organizationId, productId, linkId]
        );
        const mediaId = media.rows[0]?.media_id;
        if (!mediaId) throw new TenantAccessDeniedError();
        await client.query(
          `UPDATE product_media SET is_primary = false WHERE organization_id = $1 AND product_id = $2`,
          [ctx.organizationId, productId]
        );
      }
      return client.query(
        `UPDATE product_media SET position = COALESCE($4, position), role = COALESCE($5, role), is_primary = COALESCE($6, is_primary), variant_id = COALESCE($7, variant_id), alt_text = COALESCE($8, alt_text)
         WHERE organization_id = $1 AND product_id = $2 AND id = $3
         RETURNING id, media_asset_id AS "mediaId", role, position, is_primary AS "isPrimary", alt_text AS "altText"`,
        [
          ctx.organizationId,
          productId,
          linkId,
          input.position ?? null,
          input.role ?? null,
          input.isPrimary ?? null,
          input.variantId ?? null,
          input.altText ?? null
        ]
      );
    });
    if (result.rowCount !== 1) throw new TenantAccessDeniedError();
    await new StorefrontRepository(this.database.pool).refreshProductSnapshots({
      organizationId: ctx.organizationId,
      productId
    });
    await this.publishProductSnapshots(ctx, productId);
    await this.invalidateCatalog(ctx.organizationId, product.slug);
    return result.rows[0];
  }

  @Delete('products/:productId/media/:mediaLinkId')
  async detachProductMedia(
    @Req() request: Request,
    @Param('productId') productIdParam: string,
    @Param('mediaLinkId') mediaLinkIdParam: string
  ) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const productId = parseWithSchema(uuidSchema, productIdParam);
    const linkId = parseWithSchema(uuidSchema, mediaLinkIdParam);
    const product = await new CatalogRepository(this.database.pool).getProduct(ctx, productId);
    const result = await new TransactionManager(this.database.pool, this.logger).run(
      async (client) => {
        await client.query('SELECT id FROM products WHERE organization_id = $1 AND id = $2 FOR UPDATE', [ctx.organizationId, productId]);
        const deleted = await client.query<{ media_asset_id: string }>(
          `DELETE FROM product_media
         WHERE organization_id = $1 AND product_id = $2 AND id = $3
         RETURNING media_asset_id`,
          [ctx.organizationId, productId, linkId]
        );
        if (deleted.rowCount !== 1) return deleted;
        await client.query(
          `UPDATE product_media SET is_primary = true
           WHERE id = (SELECT id FROM product_media WHERE organization_id = $1 AND product_id = $2 ORDER BY position, id LIMIT 1)
             AND NOT EXISTS (SELECT 1 FROM product_media WHERE organization_id = $1 AND product_id = $2 AND is_primary)`,
          [ctx.organizationId, productId]
        );
        await new MediaRepository(client).discardUnreferenced(
          ctx,
          deleted.rows[0]!.media_asset_id,
          new R2MediaStorageAdapter(this.config)
        );
        return deleted;
      }
    );
    if (result.rowCount !== 1) return { deleted: true };
    await new StorefrontRepository(this.database.pool).refreshProductSnapshots({
      organizationId: ctx.organizationId,
      productId
    });
    await this.publishProductSnapshots(ctx, productId);
    await this.invalidateCatalog(ctx.organizationId, product.slug);
    return { deleted: true };
  }

  @Get('variants/:id/prices')
  async listVariantPrices(@Req() request: Request, @Param('id') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.read');
    return (
      await this.database.pool.query(
        `SELECT id, amount_minor AS "amountMinor", currency, price_type AS "priceType", valid_from AS "validFrom", valid_until AS "validUntil", cancelled_at AS "cancelledAt", created_at AS "createdAt" FROM variant_prices WHERE organization_id=$1 AND variant_id=$2 ORDER BY valid_from DESC`,
        [ctx.organizationId, parseWithSchema(uuidSchema, id)]
      )
    ).rows;
  }

  @Post('variants/:id/prices')
  async addVariantPrice(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const variantId = parseWithSchema(uuidSchema, id);
    const input = parseWithSchema(scheduledPriceSchema, body);
    if (input.priceType === 'sale') {
      const validFrom = input.validFrom ? new Date(input.validFrom) : new Date();
      const validUntil = input.validUntil ? new Date(input.validUntil) : null;
      if (!validUntil || validUntil <= validFrom || validUntil <= new Date()) {
        throw new ValidationFailedError('Sale end must be after its start and in the future');
      }
    }
    const variant = await new CatalogRepository(this.database.pool).getVariant(ctx, variantId);
    const result = await this.database.pool.query(
      `INSERT INTO variant_prices (organization_id,variant_id,amount_minor,currency,price_type,valid_from,valid_until,created_by) VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz,now()),$7::timestamptz,$8) RETURNING id,amount_minor AS "amountMinor",currency,price_type AS "priceType",valid_from AS "validFrom",valid_until AS "validUntil"`,
      [
        ctx.organizationId,
        variantId,
        input.amountMinor,
        input.currency,
        input.priceType,
        input.validFrom ?? null,
        input.validUntil ?? null,
        ctx.userId
      ]
    );
    const product = await new CatalogRepository(this.database.pool).getProduct(
      ctx,
      variant.productId
    );
    await new StorefrontRepository(this.database.pool).refreshProductSnapshots({
      organizationId: ctx.organizationId,
      productId: product.id
    });
    await new OperationalSyncProjector(this.database.pool).publishProductChange(
      ctx,
      product.id,
      variantId
    );
    await this.invalidateCatalog(ctx.organizationId, product.slug);
    if (input.priceType === 'sale') {
      await this.productAlerts.dispatchDueSaleStarts();
    }
    return result.rows[0];
  }

  @Delete('variants/:id/prices/sale')
  async clearVariantSale(@Req() request: Request, @Param('id') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const variantId = parseWithSchema(uuidSchema, id);
    const catalog = new CatalogRepository(this.database.pool);
    const variant = await catalog.getVariant(ctx, variantId);
    const product = await catalog.getProduct(ctx, variant.productId);

    // Price records are append-only. Marking a sale cancelled preserves its
    // schedule and alert audit record while removing it from every active
    // storefront query, including a sale that is scheduled for the future.
    const cancelled = await this.database.pool.query<{ id: string }>(
      `UPDATE variant_prices
       SET cancelled_at = now()
       WHERE organization_id = $1
         AND variant_id = $2
         AND price_type = 'sale'
         AND cancelled_at IS NULL
         AND (valid_until IS NULL OR valid_until > now())
       RETURNING id`,
      [ctx.organizationId, variantId]
    );

    await new StorefrontRepository(this.database.pool).refreshProductSnapshots({
      organizationId: ctx.organizationId,
      productId: product.id
    });
    await new OperationalSyncProjector(this.database.pool).publishProductChange(
      ctx,
      product.id,
      variantId
    );
    await this.invalidateCatalog(ctx.organizationId, product.slug);
    return { deleted: cancelled.rowCount ?? 0 };
  }

  @Get('admin/products/:id/reviews')
  async listAdminReviews(@Req() request: Request, @Param('id') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.read');
    return (
      await this.database.pool.query(
        `SELECT id,customer_id AS "customerId",user_name AS "userName",rating,comment,status,created_at AS "createdAt" FROM product_reviews WHERE organization_id=$1 AND product_id=$2 AND deleted_at IS NULL ORDER BY created_at DESC`,
        [ctx.organizationId, parseWithSchema(uuidSchema, id)]
      )
    ).rows;
  }

  @Patch('admin/reviews/:id')
  async moderateReview(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const input = parseWithSchema(
      z.object({ status: z.enum(['pending', 'published', 'rejected']) }),
      body
    );
    const result = await this.database.pool.query(
      `UPDATE product_reviews SET status=$3 WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING id,status`,
      [ctx.organizationId, parseWithSchema(uuidSchema, id), input.status]
    );
    if (!result.rowCount) throw new TenantAccessDeniedError();
    return result.rows[0];
  }

  @Delete('admin/reviews/:id')
  async deleteReview(@Req() request: Request, @Param('id') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const result = await this.database.pool.query(
      `UPDATE product_reviews SET deleted_at=now() WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL`,
      [ctx.organizationId, parseWithSchema(uuidSchema, id)]
    );
    if (!result.rowCount) throw new TenantAccessDeniedError();
    return { deleted: true };
  }

  @Get('brands')
  async listBrands(@Req() request: Request) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.read');
    const result = await this.database.pool.query(
      `SELECT id, name, slug, department_id AS "departmentId", active, version, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM brands
       WHERE organization_id = $1 AND deleted_at IS NULL
       ORDER BY normalized_name`,
      [ctx.organizationId]
    );
    return result.rows;
  }

  @Post('brands')
  async createBrand(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const input = parseWithSchema(brandSchema, body);
    await this.assertActiveDepartment(ctx.organizationId, input.departmentId);
    const result = await this.database.pool.query(
      `INSERT INTO brands (organization_id, name, slug, department_id, active)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, slug, department_id AS "departmentId", active, version, created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        ctx.organizationId,
        input.name,
        input.slug ?? slugifyLocal(input.name),
        input.departmentId,
        input.active ?? true
      ]
    );
    this.publishCatalogTaxonomy(ctx.organizationId, 'brands');
    return result.rows[0];
  }

  @Patch('brands/:id')
  async updateBrand(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const brandId = parseWithSchema(uuidSchema, id);
    const input = parseWithSchema(brandSchema.partial(), body);
    const current = await this.database.pool.query(
      `SELECT name, slug, department_id, active FROM brands WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [ctx.organizationId, brandId]
    );
    if (current.rowCount !== 1) {
      throw new TenantAccessDeniedError();
    }
    const row = current.rows[0];
    await this.assertActiveDepartment(ctx.organizationId, input.departmentId ?? row.department_id);
    const result = await this.database.pool.query(
      `UPDATE brands
       SET name = $3, slug = $4, department_id = $5, active = $6, version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
       RETURNING id, name, slug, department_id AS "departmentId", active, version, created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        ctx.organizationId,
        brandId,
        input.name ?? row.name,
        input.slug ?? row.slug,
        input.departmentId ?? row.department_id,
        input.active ?? row.active
      ]
    );
    this.publishCatalogTaxonomy(ctx.organizationId, 'brands');
    return result.rows[0];
  }

  @Delete('brands/:id')
  async deleteBrand(@Req() request: Request, @Param('id') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const brandId = parseWithSchema(uuidSchema, id);
    const used = await this.database.pool.query(
      `SELECT 1 FROM products WHERE organization_id = $1 AND brand_id = $2 AND deleted_at IS NULL LIMIT 1`,
      [ctx.organizationId, brandId]
    );
    if (used.rowCount)
      throw new ValidationFailedError('Brand cannot be deleted while products still use it');
    const result = await this.database.pool.query(
      `UPDATE brands
       SET deleted_at = now(), active = false, version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [ctx.organizationId, brandId]
    );
    if (result.rowCount !== 1) {
      throw new TenantAccessDeniedError();
    }
    this.publishCatalogTaxonomy(ctx.organizationId, 'brands');
    return { deleted: true };
  }

  @Get('categories')
  async listCategories(@Req() request: Request) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.read');
    const result = await this.database.pool.query(
      `SELECT id, parent_id AS "parentId", department_id AS "departmentId", brand_id AS "brandId", name, slug, sort_order AS "sortOrder",
              active, version, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM categories
       WHERE organization_id = $1 AND deleted_at IS NULL
       ORDER BY parent_id NULLS FIRST, sort_order, name`,
      [ctx.organizationId]
    );
    return result.rows;
  }

  @Post('categories')
  async createCategory(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const input = parseWithSchema(categorySchema, body);
    await this.assertBrandInDepartment(
      ctx.organizationId,
      input.brandId ?? null,
      input.departmentId
    );
    const result = await this.database.pool.query(
      `INSERT INTO categories (organization_id, parent_id, department_id, brand_id, name, slug, sort_order, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, parent_id AS "parentId", department_id AS "departmentId", brand_id AS "brandId", name, slug, sort_order AS "sortOrder",
                 active, version, created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        ctx.organizationId,
        input.parentId ?? null,
        input.departmentId,
        input.brandId ?? null,
        input.name,
        input.slug ?? slugifyLocal(input.name),
        input.sortOrder ?? 0,
        input.active ?? true
      ]
    );
    this.publishCatalogTaxonomy(ctx.organizationId, 'categories');
    return result.rows[0];
  }

  @Patch('categories/:id')
  async updateCategory(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const categoryId = parseWithSchema(uuidSchema, id);
    const input = parseWithSchema(categorySchema.partial(), body);
    const current = await this.database.pool.query(
      `SELECT parent_id, department_id, brand_id, name, slug, sort_order, active
       FROM categories WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [ctx.organizationId, categoryId]
    );
    if (current.rowCount !== 1) {
      throw new TenantAccessDeniedError();
    }
    const row = current.rows[0];
    await this.assertBrandInDepartment(
      ctx.organizationId,
      input.brandId ?? row.brand_id,
      input.departmentId ?? row.department_id
    );
    const result = await this.database.pool.query(
      `UPDATE categories
       SET parent_id = $3, department_id = $4, brand_id = $5, name = $6, slug = $7, sort_order = $8, active = $9,
           version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
       RETURNING id, parent_id AS "parentId", department_id AS "departmentId", brand_id AS "brandId", name, slug, sort_order AS "sortOrder",
                 active, version, created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        ctx.organizationId,
        categoryId,
        input.parentId === undefined ? row.parent_id : input.parentId,
        input.departmentId ?? row.department_id,
        input.brandId ?? row.brand_id,
        input.name ?? row.name,
        input.slug ?? row.slug,
        input.sortOrder ?? row.sort_order,
        input.active ?? row.active
      ]
    );
    this.publishCatalogTaxonomy(ctx.organizationId, 'categories');
    return result.rows[0];
  }

  @Delete('categories/:id')
  async deleteCategory(@Req() request: Request, @Param('id') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const categoryId = parseWithSchema(uuidSchema, id);
    const used = await this.database.pool.query(
      `SELECT 1 FROM products WHERE organization_id = $1 AND primary_category_id = $2 AND deleted_at IS NULL LIMIT 1`,
      [ctx.organizationId, categoryId]
    );
    if (used.rowCount)
      throw new ValidationFailedError('Category cannot be deleted while products still use it');
    const result = await this.database.pool.query(
      `UPDATE categories
       SET deleted_at = now(), active = false, version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [ctx.organizationId, categoryId]
    );
    if (result.rowCount !== 1) {
      throw new TenantAccessDeniedError();
    }
    this.publishCatalogTaxonomy(ctx.organizationId, 'categories');
    return { deleted: true };
  }

  @Get('catalog-search-settings')
  async getSearchSettings(@Req() request: Request): Promise<SearchSettingsResult> {
    const ctx=resolveRequestContext(request); requirePermission(ctx,'catalog.read');
    return readSearchSettings(this.database.pool,ctx.organizationId);
  }

  @Put('catalog-search-settings')
  async updateSearchSettings(@Req() request: Request,@Body() body: unknown): Promise<SearchSettingsResult> {
    const ctx=resolveRequestContext(request); requirePermission(ctx,'catalog.write');
    const result=await saveSearchSettings(this.database.pool,ctx.organizationId,parseWithSchema(searchSettingsSchema,body));
    invalidateCatalogSearch(ctx.organizationId); return result;
  }

  @Post('specification-editor')
  async editSpecificationLayout(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    const input = parseWithSchema(specificationEditorRequestSchema, body);
    requirePermission(ctx, input.action === 'get' ? 'catalog.read' : 'catalog.write');
    const result = await specificationEditor(this.database, ctx.organizationId, input);
    if (input.action !== 'get') this.publishCatalogTaxonomy(ctx.organizationId, 'spec_keys');
    return result;
  }

  @Get('spec_keys')
  async listSpecKeys(@Req() request: Request) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.read');
    const result = await this.database.pool.query(
      `SELECT id, name, slug, department_id AS "departmentId", unit, data_type AS "dataType", option_values AS "optionValues", active, version,
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM spec_keys
       WHERE organization_id = $1 AND deleted_at IS NULL
       ORDER BY name`,
      [ctx.organizationId]
    );
    return result.rows;
  }

  @Post('spec_keys')
  async createSpecKey(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const input = parseWithSchema(specKeySchema, body);
    await this.assertActiveDepartment(ctx.organizationId, input.departmentId);
    const slug = input.slug ?? slugifyLocal(input.name);
    const existing = await this.database.pool.query(
      `SELECT id
       FROM spec_keys
       WHERE organization_id = $1 AND deleted_at IS NULL AND (lower(name) = lower($2) OR slug = $3)
       LIMIT 1`,
      [ctx.organizationId, input.name, slug]
    );
    if (existing.rowCount) {
      throw new ResourceConflictError('Specifikacija sa ovim nazivom ili internim ključem već postoji.');
    }
    const result = await this.database.pool.query(
        `INSERT INTO spec_keys (organization_id, name, slug, department_id, unit, data_type, option_values, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         RETURNING id, name, slug, department_id AS "departmentId", unit, data_type AS "dataType", option_values AS "optionValues", active, version,
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [
          ctx.organizationId,
          input.name,
          slug,
          input.departmentId,
          input.unit ?? null,
          input.dataType ?? 'text',
          JSON.stringify([...new Set(input.optionValues ?? [])]),
          input.active ?? true
        ]
      )
      .catch((error: { code?: string }) => {
        if (error.code === '23505') {
          throw new ResourceConflictError('Specifikacija sa ovim nazivom ili internim ključem već postoji.');
        }
        throw error;
      });
    this.publishCatalogTaxonomy(ctx.organizationId, 'spec_keys');
    return result.rows[0];
  }

  @Patch('spec_keys/:id')
  async updateSpecKey(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const specKeyId = parseWithSchema(uuidSchema, id);
    const input = parseWithSchema(specKeySchema.partial(), body);
    const current = await this.database.pool.query(
      `SELECT name, slug, department_id, unit, data_type, option_values, active
       FROM spec_keys WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [ctx.organizationId, specKeyId]
    );
    if (current.rowCount !== 1) {
      throw new ResourceNotFoundError('specification');
    }
    const row = current.rows[0];
    await this.assertActiveDepartment(ctx.organizationId, input.departmentId ?? row.department_id);
    const nextName = input.name ?? row.name;
    const nextSlug = input.name === undefined ? (input.slug ?? row.slug) : slugifyLocal(nextName);
    const conflict = await this.database.pool.query<{ id: string }>(
      `SELECT id
       FROM spec_keys
       WHERE organization_id = $1 AND slug = $2 AND id <> $3 AND deleted_at IS NULL
       LIMIT 1`,
      [ctx.organizationId, nextSlug, specKeyId]
    );
    if (conflict.rowCount) {
      throw new ResourceConflictError('Specifikacija sa ovim internim ključem već postoji.');
    }
    const oldAttributeKeys = specificationAttributeKeys(row.name, row.slug);
    const [primaryAttributeKey, secondaryAttributeKey = '', legacyAttributeKey = ''] = oldAttributeKeys;
    const nextAttributeKey = specificationAttributeKey(nextName);
    const updated = await new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      let affected: Array<{ product_id: string }> = [];
      if (!oldAttributeKeys.includes(nextAttributeKey)) {
        affected = (
          await client.query<{ product_id: string }>(
            `UPDATE product_variants
             SET attributes = (COALESCE(attributes, '{}'::jsonb) - $2::text[]) || jsonb_build_object(
                   $3::text,
                   COALESCE(attributes -> $4::text, attributes -> $5::text, attributes -> $6::text)
                 ),
                 version = version + 1, updated_at = now()
             WHERE organization_id = $1 AND deleted_at IS NULL AND attributes ?| $2::text[]
             RETURNING product_id`,
            [ctx.organizationId, oldAttributeKeys, nextAttributeKey, primaryAttributeKey, secondaryAttributeKey, legacyAttributeKey]
          )
        ).rows;
      }
      const result = await client.query(
        `UPDATE spec_keys
         SET name = $3, slug = $4, department_id = $5, unit = $6, data_type = $7, option_values = $8::jsonb, active = $9,
             version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
         RETURNING id, name, slug, department_id AS "departmentId", unit, data_type AS "dataType", option_values AS "optionValues", active, version,
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [
          ctx.organizationId,
          specKeyId,
          nextName,
          nextSlug,
          input.departmentId ?? row.department_id,
          input.unit === undefined ? row.unit : input.unit,
          input.dataType ?? row.data_type,
          JSON.stringify([...new Set(input.optionValues ?? row.option_values ?? [])]),
          input.active ?? row.active
        ]
      );
      return { specKey: result.rows[0], productIds: [...new Set(affected.map((item) => item.product_id))] };
    }).catch((error: unknown) => {
      this.logger.error({ err: error, organizationId: ctx.organizationId, specKeyId }, 'Specification update failed');
      if ((error as { code?: string }).code === '23505') {
        throw new ResourceConflictError('Specifikacija sa ovim internim ključem već postoji.');
      }
      throw error;
    });
    // The specification and its product attributes are already committed above.
    // An operational snapshot is a follow-up notification; it must not turn a
    // successful rename in the web admin into a 500 response.
    try {
      await this.publishSpecificationAttributeChanges(ctx, updated.productIds);
    } catch (error) {
      this.logger.warn(
        { err: error, organizationId: ctx.organizationId, specKeyId, productIds: updated.productIds },
        'Specification saved but operational propagation failed'
      );
    }
    this.publishCatalogTaxonomy(ctx.organizationId, 'spec_keys');
    return updated.specKey;
  }

  @Delete('spec_keys/:id')
  async deleteSpecKey(@Req() request: Request, @Param('id') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const specKeyId = parseWithSchema(uuidSchema, id);
    const deletedProductIds = await new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      const current = await client.query<{ name: string; slug: string }>(
        `SELECT name, slug FROM spec_keys WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [ctx.organizationId, specKeyId]
      );
      const currentSpecKey = current.rows[0];
      if (!currentSpecKey) throw new TenantAccessDeniedError();
      const attributeKeys = specificationAttributeKeys(currentSpecKey.name, currentSpecKey.slug);
      const affected = await client.query<{ product_id: string }>(
        `UPDATE product_variants
         SET attributes = COALESCE(attributes, '{}'::jsonb) - $2::text[], version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND deleted_at IS NULL AND attributes ?| $2::text[]
         RETURNING product_id`,
        [ctx.organizationId, attributeKeys]
      );
      await client.query(
        `DELETE FROM variant_specification_values WHERE organization_id = $1 AND spec_key_id = $2`,
        [ctx.organizationId, specKeyId]
      );
      await client.query(
        `UPDATE spec_keys
         SET deleted_at = now(), active = false, version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [ctx.organizationId, specKeyId]
      );
      return [...new Set(affected.rows.map((item) => item.product_id))];
    });
    try {
      await this.publishSpecificationAttributeChanges(ctx, deletedProductIds);
    } catch (error) {
      this.logger.warn(
        { err: error, organizationId: ctx.organizationId, specKeyId, productIds: deletedProductIds },
        'Specification deleted but operational propagation failed'
      );
    }
    this.publishCatalogTaxonomy(ctx.organizationId, 'spec_keys');
    return { deleted: true };
  }

  /** The admin catalog includes internal inventory placement.  Keep it in a
   * single query so a realtime update can reload one product, rather than
   * forcing the dashboard to refresh its whole product list. */
  private isCatalogContributor(ctx: RequestContext): boolean {
    return !ctx.isOwner && ctx.roles.includes('Unosilac kataloga');
  }

  private requireWorkforceManager(ctx: RequestContext): void {
    if (!ctx.isOwner && !ctx.permissions.includes('catalog.workforce.manage')) {
      throw new TenantAccessDeniedError();
    }
  }

  private async assertContributorOwnsProduct(ctx: RequestContext, productId: string): Promise<void> {
    if (!this.isCatalogContributor(ctx)) return;
    const result = await this.database.pool.query(
      `SELECT 1 FROM products WHERE organization_id = $1 AND id = $2 AND created_by_user_id = $3 AND deleted_at IS NULL`,
      [ctx.organizationId, productId, ctx.userId]
    );
    if (result.rowCount !== 1) throw new TenantAccessDeniedError();
  }

  private async productQuality(client: Pick<Database['pool'], 'query'>, organizationId: string, productId: string): Promise<{ missing: string[]; checks: Array<{ label: string; complete: boolean }> }> {
    const product = (await client.query<{
      name: string; description: string | null; department_id: string | null; brand_id: string | null; primary_category_id: string | null;
      barcode: string | null; current_price_amount: number | null; gender: string | null; specs_count: number; media_count: number;
      features_count: number; location_id: string | null; quantity: number | null;
    }>(
      `SELECT p.name, p.description, p.department_id, p.brand_id, p.primary_category_id, v.barcode, v.current_price_amount, v.gender,
              ${meaningfulSpecsSql}::int AS specs_count,
              jsonb_array_length(p.features)::int AS features_count,
              inventory.location_id, inventory.quantity,
              (SELECT count(*) FROM product_media pm JOIN media_assets ma ON ma.id = pm.media_asset_id AND ma.status = 'ready' WHERE pm.organization_id = p.organization_id AND pm.product_id = p.id)::int AS media_count
       FROM products p
       LEFT JOIN LATERAL (SELECT * FROM product_variants WHERE organization_id = p.organization_id AND product_id = p.id AND deleted_at IS NULL ORDER BY created_at LIMIT 1) v ON true
       LEFT JOIN LATERAL (
         SELECT location_id, quantity FROM inventory_balances
         WHERE organization_id = p.organization_id AND variant_id = v.id
         ORDER BY updated_at DESC LIMIT 1
       ) inventory ON true
       WHERE p.organization_id = $1 AND p.id = $2 AND p.deleted_at IS NULL`,
      [organizationId, productId]
    )).rows[0];
    if (!product) throw new TenantAccessDeniedError();
    const checks = [
      { label: 'Naziv', complete: Boolean(product.name?.trim()) },
      { label: 'Cena', complete: Number(product.current_price_amount) > 0 },
      { label: 'GTIN proizvoda', complete: Boolean(product.barcode?.trim()) },
      { label: 'Opis', complete: Boolean(product.description?.trim()) },
      { label: 'Odeljenje', complete: Boolean(product.department_id) },
      { label: 'Brend', complete: Boolean(product.brand_id) },
      { label: 'Kategorija', complete: Boolean(product.primary_category_id) },
      { label: 'Pol', complete: Boolean(product.gender?.trim()) },
      { label: 'Glavna lokacija', complete: Boolean(product.location_id) },
      { label: 'Količina', complete: Number(product.quantity) > 0 },
      { label: `Istaknute kartice (${Number(product.features_count)}/3)`, complete: Number(product.features_count) >= 3 },
      { label: `Specifikacije (${Number(product.specs_count)}/5)`, complete: Number(product.specs_count) >= 5 },
      { label: `Slike (${Number(product.media_count)}/1)`, complete: Number(product.media_count) >= 1 }
    ];
    return { checks, missing: checks.filter((check) => !check.complete).map((check) => check.label) };
  }

  private async adminProductRows(organizationId: string, productId?: string, contributorId?: string, includeDeleted = false) {
    const rows = (
      await this.database.pool.query(
        `SELECT p.id, p.name, p.slug, p.description, p.active, p.published, p.department_id AS "departmentId",
              p.brand_id AS "brandId", p.primary_category_id AS "primaryCategoryId", p.item_condition AS "itemCondition", p.seo, p.features,
              p.model_3d_url AS "model3DUrl", p.marketing_flags AS "marketingFlags", p.created_by_user_id AS "createdByUserId",
              supplier.url AS "supplierUrl", supplier.external_reference AS "supplierReference",
              CASE WHEN provider.paused_until > now() OR supplier.last_error IS NOT NULL THEN 'deferred'
                   WHEN supplier.missing_count > 0 AND supplier.check_status <> 'missing' THEN 'checking'
                   ELSE supplier.check_status END AS "supplierStatus",
              supplier.last_checked_at AS "supplierLastCheckedAt", GREATEST(supplier.next_check_at, provider.next_request_at, provider.paused_until) AS "supplierNextCheckAt", supplier.missing_count AS "supplierMissingCount", supplier.price_amount AS "supplierPriceAmount", supplier.price_currency AS "supplierPriceCurrency",
              bultime.url AS "bultimeUrl", bultime.stock_status AS "bultimeStockStatus", bultime.price_amount AS "bultimePriceAmount", bultime.price_currency AS "bultimePriceCurrency",
              CASE WHEN bultime_provider.paused_until > now() OR bultime.last_error IS NOT NULL THEN 'deferred'
                   WHEN bultime.missing_count > 0 AND bultime.check_status <> 'missing' THEN 'checking'
                   ELSE bultime.check_status END AS "bultimeStatus",
              bultime.last_checked_at AS "bultimeLastCheckedAt", GREATEST(bultime.next_check_at, bultime_provider.next_request_at, bultime_provider.paused_until) AS "bultimeNextCheckAt", bultime.missing_count AS "bultimeMissingCount",
              linkel.url AS "linkelUrl", linkel.stock_status AS "linkelStockStatus", linkel.price_amount AS "linkelPriceAmount", linkel.price_currency AS "linkelPriceCurrency",
              CASE WHEN linkel_provider.paused_until > now() OR linkel.last_error IS NOT NULL THEN 'deferred'
                   WHEN linkel.missing_count > 0 AND linkel.check_status <> 'missing' THEN 'checking'
                   ELSE linkel.check_status END AS "linkelStatus",
              linkel.last_checked_at AS "linkelLastCheckedAt", GREATEST(linkel.next_check_at, linkel_provider.next_request_at, linkel_provider.paused_until) AS "linkelNextCheckAt", linkel.missing_count AS "linkelMissingCount",
              milano.url AS "milanoUrl", milano.stock_status AS "milanoStockStatus", milano.price_amount AS "milanoPriceAmount", milano.price_currency AS "milanoPriceCurrency",
              CASE WHEN milano_provider.paused_until > now() OR milano.last_error IS NOT NULL THEN 'deferred' WHEN milano.missing_count > 0 AND milano.check_status <> 'missing' THEN 'checking' ELSE milano.check_status END AS "milanoStatus", milano.last_checked_at AS "milanoLastCheckedAt", GREATEST(milano.next_check_at, milano_provider.next_request_at, milano_provider.paused_until) AS "milanoNextCheckAt",
              timezone.url AS "timezoneUrl", timezone.stock_status AS "timezoneStockStatus", timezone.price_amount AS "timezonePriceAmount", timezone.price_currency AS "timezonePriceCurrency",
              CASE WHEN timezone_provider.paused_until > now() OR timezone.last_error IS NOT NULL THEN 'deferred' WHEN timezone.missing_count > 0 AND timezone.check_status <> 'missing' THEN 'checking' ELSE timezone.check_status END AS "timezoneStatus", timezone.last_checked_at AS "timezoneLastCheckedAt", GREATEST(timezone.next_check_at, timezone_provider.next_request_at, timezone_provider.paused_until) AS "timezoneNextCheckAt",
              qandq.url AS "qandqUrl", qandq.stock_status AS "qandqStockStatus", qandq.price_amount AS "qandqPriceAmount", qandq.price_currency AS "qandqPriceCurrency",
              CASE WHEN qandq_provider.paused_until > now() OR qandq.last_error IS NOT NULL THEN 'deferred' WHEN qandq.missing_count > 0 AND qandq.check_status <> 'missing' THEN 'checking' ELSE qandq.check_status END AS "qandqStatus", qandq.last_checked_at AS "qandqLastCheckedAt", GREATEST(qandq.next_check_at, qandq_provider.next_request_at, qandq_provider.paused_until) AS "qandqNextCheckAt",
              p.quality_review_status AS "qualityReviewStatus", p.quality_review_note AS "qualityReviewNote", p.quality_reviewed_at AS "qualityReviewedAt",
              (SELECT max(a.occurred_at) FROM audit_events a WHERE a.organization_id=p.organization_id
                AND a.aggregate_type='product' AND a.aggregate_id=p.id AND a.operation='quality_changes_requested') AS "lastReturnedAt",
              p.compensation_amount_minor AS "compensationAmountMinor", p.compensation_approved_at AS "compensationApprovedAt", p.created_at AS "createdAt", p.updated_at AS "updatedAt", p.deleted_at AS "deletedAt",
              d.slug AS department, b.name AS brand, c.name AS category,
              v.id AS "variantId", v.sku, v.barcode, v.mpn, v.name AS "variantName", v.current_price_amount AS "currentPriceAmount", v.currency,
              v.gender, v.attributes AS specs, v.active AS "variantActive", v.published AS "variantPublished",
              COALESCE(inventory.quantity, 0) AS quantity, inventory.location_id AS "locationId",
              inventory.zone_id AS "zoneId", inventory.bin_id AS "binId",
              tag.id AS "rfidTagId", tag.epc, tag.tid, tag.status AS "rfidTagStatus",
              media.public_url AS "primaryImageUrl", media.thumbnail_url AS "thumbnailUrl"
       FROM products p
       LEFT JOIN supplier_product_links supplier ON supplier.organization_id = p.organization_id AND supplier.product_id = p.id AND supplier.provider_code = 'ekka'
       LEFT JOIN supplier_provider_checks provider ON provider.provider_code = 'ekka'
       LEFT JOIN supplier_product_links bultime ON bultime.organization_id = p.organization_id AND bultime.product_id = p.id AND bultime.provider_code = 'bultime'
       LEFT JOIN supplier_provider_checks bultime_provider ON bultime_provider.provider_code = 'bultime'
       LEFT JOIN supplier_product_links linkel ON linkel.organization_id = p.organization_id AND linkel.product_id = p.id AND linkel.provider_code = 'linkel'
       LEFT JOIN supplier_provider_checks linkel_provider ON linkel_provider.provider_code = 'linkel'
       LEFT JOIN supplier_product_links milano ON milano.organization_id = p.organization_id AND milano.product_id = p.id AND milano.provider_code = 'milano'
       LEFT JOIN supplier_provider_checks milano_provider ON milano_provider.provider_code = 'milano'
       LEFT JOIN supplier_product_links timezone ON timezone.organization_id = p.organization_id AND timezone.product_id = p.id AND timezone.provider_code = 'timezone'
       LEFT JOIN supplier_provider_checks timezone_provider ON timezone_provider.provider_code = 'timezone'
       LEFT JOIN supplier_product_links qandq ON qandq.organization_id = p.organization_id AND qandq.product_id = p.id AND qandq.provider_code = 'qandq'
       LEFT JOIN supplier_provider_checks qandq_provider ON qandq_provider.provider_code = 'qandq'
       LEFT JOIN departments d ON d.id = p.department_id AND d.organization_id = p.organization_id
       LEFT JOIN brands b ON b.id = p.brand_id AND b.organization_id = p.organization_id
       LEFT JOIN categories c ON c.id = p.primary_category_id AND c.organization_id = p.organization_id
       LEFT JOIN LATERAL (
         SELECT * FROM product_variants WHERE product_id = p.id AND organization_id = p.organization_id AND deleted_at IS NULL
         ORDER BY created_at LIMIT 1
       ) v ON true
       LEFT JOIN LATERAL (
         SELECT quantity, location_id, zone_id, bin_id
         FROM inventory_balances
         WHERE organization_id = p.organization_id AND variant_id = v.id
         ORDER BY updated_at DESC
         LIMIT 1
       ) inventory ON true
       LEFT JOIN LATERAL (
         SELECT t.id, t.epc, t.tid, t.status
         FROM rfid_tags t
         LEFT JOIN inventory_items item
           ON item.id = t.inventory_item_id
          AND item.organization_id = t.organization_id
          AND item.deleted_at IS NULL
         WHERE t.organization_id = p.organization_id
           AND t.deleted_at IS NULL
           AND (t.variant_id = v.id OR item.variant_id = v.id)
         ORDER BY t.updated_at DESC
         LIMIT 1
       ) tag ON true
       LEFT JOIN LATERAL (
         SELECT ma.public_url, md.public_url AS thumbnail_url
         FROM product_media pm
         JOIN media_assets ma ON ma.id = pm.media_asset_id AND ma.status = 'ready'
         LEFT JOIN LATERAL (
           SELECT public_url FROM media_derivatives WHERE media_asset_id = ma.id ORDER BY width ASC LIMIT 1
         ) md ON true
         WHERE pm.organization_id = p.organization_id AND pm.product_id = p.id
         ORDER BY pm.is_primary DESC, pm.position ASC LIMIT 1
       ) media ON true
       WHERE p.organization_id = $1
         AND ($2::uuid IS NULL OR p.id = $2)
         AND ($3::uuid IS NULL OR p.created_by_user_id = $3)
         AND ($4::boolean OR p.deleted_at IS NULL)
       ORDER BY p.updated_at DESC`,
        [organizationId, productId ?? null, contributorId ?? null, includeDeleted]
      )
    ).rows;
    const states=await supplierStatesForProducts(this.database.pool,organizationId,rows.map(row=>String(row.id)));
    const fields=new Map<string,Record<string,unknown>>();
    for (const state of states) fields.set(String(state.productId),{...fields.get(String(state.productId)),...supplierStateFields(state)});
    return rows.map(row=>({...row,...fields.get(String(row.id))}));
  }

  private async invalidateCatalog(organizationId: string, ...slugs: Array<string | undefined>) {
    const validSlugs = slugs.filter((slug): slug is string => Boolean(slug));
    const keys = [
      `catalog:sitemap:${organizationId}`,
      `catalog:merchant-feed:${organizationId}`,
      ...validSlugs.map((slug) => `catalog:slug:${organizationId}:${slug}`)
    ];
    await this.redis.client.del(...keys);
    const products = await this.database.pool.query<{ id: string; slug: string }>(
      `SELECT id, slug FROM products
       WHERE organization_id = $1 AND slug = ANY($2::text[]) AND deleted_at IS NULL`,
      [organizationId, validSlugs]
    );
    const productIdBySlug = new Map(products.rows.map((product) => [product.slug, product.id]));
    // Storefront clients still use only the slug. Admin clients additionally
    // receive the ID and refresh only that product with its inventory fields.
    for (const slug of validSlugs) {
      this.realtime.publish({
        organizationId,
        event: 'product.updated',
        payload: {
          slug,
          ...(productIdBySlug.get(slug)
            ? { productId: productIdBySlug.get(slug) }
            : { deleted: true })
        }
      });
    }
  }

  /** Append canonical delta snapshots for changes that affect every variant, such as media. */
  private async publishProductSnapshots(ctx: RequestContext, productId: string): Promise<void> {
    const variants = await this.database.pool.query<{ id: string }>(
      `SELECT id FROM product_variants
       WHERE organization_id = $1 AND product_id = $2 AND deleted_at IS NULL`,
      [ctx.organizationId, productId]
    );
    const projector = new OperationalSyncProjector(this.database.pool);
    for (const variant of variants.rows) {
      await projector.publishProductChange(ctx, productId, variant.id);
    }
  }

  private async publishSpecificationAttributeChanges(ctx: RequestContext, productIds: string[]): Promise<void> {
    if (!productIds.length) return;
    const products = await this.database.pool.query<{ id: string; slug: string }>(
      `SELECT id, slug FROM products
       WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
      [ctx.organizationId, productIds]
    );
    for (const product of products.rows) {
      await this.publishProductSnapshots(ctx, product.id);
      await this.invalidateCatalog(ctx.organizationId, product.slug);
    }
  }

  private async assertActiveDepartment(organizationId: string, departmentId: string) {
    const result = await this.database.pool.query(
      `SELECT 1 FROM departments WHERE organization_id = $1 AND id = $2 AND active AND deleted_at IS NULL`,
      [organizationId, departmentId]
    );
    if (result.rowCount !== 1) throw new Error('Department does not exist or is inactive');
  }

  private async assertBrandInDepartment(
    organizationId: string,
    brandId: string | null,
    departmentId: string
  ) {
    if (!brandId) {
      await this.assertActiveDepartment(organizationId, departmentId);
      return;
    }
    const result = await this.database.pool.query(
      `SELECT 1 FROM brands WHERE organization_id = $1 AND id = $2 AND department_id = $3 AND active AND deleted_at IS NULL`,
      [organizationId, brandId, departmentId]
    );
    if (result.rowCount !== 1) throw new Error('Brand does not belong to the selected department');
  }
}

@Controller('media')
export class MediaController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(REDIS) private readonly redis: RedisConnection
  ) {}

  /** Downloads, optimizes and stores a direct image URL as a media asset. */
  @Post('external')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async registerExternal(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'media.upload');
    const input = parseWithSchema(
      z.object({
        url: z.string().url().max(2_000),
        productSlug: slugSchema.optional(),
        imageIndex: z.coerce.number().int().min(1).max(999).optional()
      }),
      body
    );
    return importRemoteImage({
      config: this.config,
      database: this.database,
      organizationId: ctx.organizationId,
      sourceUrl: input.url,
      ...(input.productSlug ? { productSlug: input.productSlug } : {}),
      ...(input.imageIndex ? { imageIndex: input.imageIndex } : {})
    });
  }

  @Post('uploads')
  async createUpload(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'media.upload');
    const input = parseWithSchema(
      z.object({
        mimeType: z.string(),
        sizeBytes: z.coerce.number().int().positive(),
        checksumSha256: z
          .string()
          .regex(/^[a-fA-F0-9]{64}$/)
          .optional(),
        originalFilename: z.string().max(240).optional(),
        productSlug: slugSchema.optional(),
        imageIndex: z.coerce.number().int().min(1).max(999).optional()
      }),
      body
    );
    return new MediaRepository(this.database.pool).createPendingUpload(
      ctx,
      input,
      new R2MediaStorageAdapter(this.config)
    );
  }

  @Post('uploads/:mediaId/complete')
  async completeUpload(@Req() request: Request, @Param('mediaId') mediaId: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'media.upload');
    const id = parseWithSchema(uuidSchema, mediaId);
    const result = await new TransactionManager(this.database.pool, this.logger).run(
      async (client) => {
        const result = await new MediaRepository(client).completeUpload(
          ctx,
          id,
          new R2MediaStorageAdapter(this.config)
        );
        await new OutboxRepository(client).append({
          ctx,
          eventType: 'MediaUploaded',
          aggregateType: 'media_asset',
          aggregateId: id,
          payload: { mediaId: id }
        });
        return result;
      }
    );
    const queue = new Queue('media-processing', { connection: this.redis.client });
    try {
      await queue.add('process-media', {
        organizationId: ctx.organizationId,
        mediaId: id
      });
    } finally {
      await queue.close();
    }
    return result;
  }

  /** Deletes a completed or pending upload that was never attached to a product. */
  @Delete('uploads/:mediaId')
  async discardUpload(@Req() request: Request, @Param('mediaId') mediaId: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'media.upload');
    const id = parseWithSchema(uuidSchema, mediaId);
    return new TransactionManager(this.database.pool, this.logger).run((client) =>
      new MediaRepository(client).discardUnreferenced(
        ctx,
        id,
        new R2MediaStorageAdapter(this.config)
      )
    );
  }
}

@Controller()
export class RfidController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(REDIS) private readonly redis: RedisConnection
  ) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('public/rfid/resolve/:epc')
  async resolve(@Req() request: Request, @Param('epc') epc: string) {
    const ctx = this.config.PUBLIC_ORGANIZATION_ID
      ? resolvePublicRequestContext(request, this.config.PUBLIC_ORGANIZATION_ID)
      : resolveRequestContext(request);
    const normalizedEpc = epc.replace(/[\s:._-]/g, '').toUpperCase();
    const cacheKey = `rfid:resolve:${ctx.organizationId}:${normalizedEpc}`;
    const cached = await this.redis.client.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as unknown;
    }
    const resolved = await new RfidRepository(this.database.pool).resolvePublic(ctx, epc);
    await this.redis.client.set(cacheKey, JSON.stringify(resolved), 'EX', 60);
    return resolved;
  }

  @Get('rfid/tags/:id')
  async tag(@Req() request: Request, @Param('id') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'rfid.read');
    return new RfidRepository(this.database.pool).getTagById(ctx, parseWithSchema(uuidSchema, id));
  }

  @Get('rfid/tags/by-epc/:epc')
  async tagByEpc(@Req() request: Request, @Param('epc') epc: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'rfid.read');
    return new RfidRepository(this.database.pool).getTagByEpc(ctx, epc);
  }

  @Post('rfid/tags')
  async createTag(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'rfid.assign');
    const input = parseWithSchema(
      z.object({
        epc: z.string(),
        tid: z.string().nullable().optional(),
        chipType: z.string().nullable().optional(),
        protocol: z.string().nullable().optional(),
        variantId: uuidSchema.nullable().optional()
      }),
      body
    );
    let tag;
    try {
      tag = await new TransactionManager(this.database.pool, this.logger).run(async (client) => {
        const created = await new RfidRepository(client).createTag(ctx, input);
        await new AuditRepository(client).append({
          ctx,
          aggregateType: 'rfid_tag',
          aggregateId: created.id,
          operation: 'create',
          afterPayload: created
        });
        await new OutboxRepository(client).append({
          ctx,
          eventType: 'RfidTagStatusChanged',
          aggregateType: 'rfid_tag',
          aggregateId: created.id,
          payload: { tagId: created.id, status: created.status }
        });
        return created;
      });
    } catch (error) {
      // Re-saving an item with its existing EPC is normal in admin flows.
      // Return the canonical tag instead of exposing an expected 409 to every
      // client, while preserving a real conflict at the later assignment step.
      if (!(error instanceof ResourceConflictError)) throw error;
      return new RfidRepository(this.database.pool).getTagByEpc(ctx, input.epc);
    }
    await this.invalidateRfid(ctx.organizationId, tag.epc);
    return tag;
  }

  @Post('rfid/tags/:id/assign')
  async assign(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'rfid.assign');
    const input = parseWithSchema(
      z.object({
        inventoryItemId: uuidSchema,
        expectedVersion: z.coerce.number().int().positive().optional(),
        reason: z.string().trim().min(1)
      }),
      body
    );
    const tag = await new TransactionManager(this.database.pool, this.logger).run(
      async (client) => {
        const tag = await new RfidRepository(client).assignTag(ctx, {
          tagId: parseWithSchema(uuidSchema, id),
          ...input
        });
        await new AuditRepository(client).append({
          ctx,
          aggregateType: 'rfid_tag',
          aggregateId: tag.id,
          operation: 'assign',
          afterPayload: tag,
          reason: input.reason
        });
        await new OutboxRepository(client).append({
          ctx,
          eventType: 'RfidTagAssigned',
          aggregateType: 'rfid_tag',
          aggregateId: tag.id,
          payload: { tagId: tag.id, inventoryItemId: input.inventoryItemId }
        });
        return tag;
      }
    );
    await this.invalidateRfid(ctx.organizationId, tag.epc);
    return tag;
  }

  @Post('rfid/tags/:id/unassign')
  async unassign(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'rfid.assign');
    const tagId = parseWithSchema(uuidSchema, id);
    const input = parseWithSchema(
      z.object({
        expectedVersion: z.coerce.number().int().positive().optional(),
        reason: z.string().trim().min(1)
      }),
      body
    );
    const result = await new TransactionManager(this.database.pool, this.logger).run(
      async (client) => {
        // Capture the owning variant before unassignTag clears both the direct
        // variant relation and the inventory-item relation. The resulting
        // catalog snapshot is what tells every RFID desktop client to remove
        // the EPC from its local item list.
        const owner = await client.query<{ productId: string; variantId: string }>(
          `SELECT v.product_id AS "productId", v.id AS "variantId"
           FROM rfid_tags t
           LEFT JOIN inventory_items item
             ON item.id = t.inventory_item_id
            AND item.organization_id = t.organization_id
            AND item.deleted_at IS NULL
           JOIN product_variants v
             ON v.id = COALESCE(t.variant_id, item.variant_id)
            AND v.organization_id = t.organization_id
            AND v.deleted_at IS NULL
           WHERE t.organization_id = $1 AND t.id = $2 AND t.deleted_at IS NULL`,
          [ctx.organizationId, tagId]
        );
        const tag = await new RfidRepository(client).unassignTag(ctx, {
          tagId,
          ...input
        });
        await new AuditRepository(client).append({
          ctx,
          aggregateType: 'rfid_tag',
          aggregateId: tag.id,
          operation: 'unassign',
          afterPayload: tag,
          reason: input.reason
        });
        await new OutboxRepository(client).append({
          ctx,
          eventType: 'RfidTagUnassigned',
          aggregateType: 'rfid_tag',
          aggregateId: tag.id,
          payload: { tagId: tag.id }
        });
        const variant = owner.rows[0];
        if (variant) {
          await new OperationalSyncProjector(client).publishProductChange(
            ctx,
            variant.productId,
            variant.variantId
          );
        }
        return tag;
      }
    );
    await this.invalidateRfid(ctx.organizationId, result.epc);
    return result;
  }

  @Patch('rfid/tags/:id/status')
  async status(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'rfid.assign');
    const input = parseWithSchema(
      z.object({
        status: z.string(),
        expectedVersion: z.coerce.number().int().positive().optional(),
        reason: z.string().trim().min(1).optional()
      }),
      body
    );
    const tag = await new TransactionManager(this.database.pool, this.logger).run(
      async (client) => {
        const tag = await new RfidRepository(client).updateStatus(ctx, {
          tagId: parseWithSchema(uuidSchema, id),
          ...input
        });
        await new AuditRepository(client).append({
          ctx,
          aggregateType: 'rfid_tag',
          aggregateId: tag.id,
          operation: 'status_change',
          afterPayload: tag,
          ...(input.reason ? { reason: input.reason } : {})
        });
        await new OutboxRepository(client).append({
          ctx,
          eventType: 'RfidTagStatusChanged',
          aggregateType: 'rfid_tag',
          aggregateId: tag.id,
          payload: { tagId: tag.id, status: input.status }
        });
        return tag;
      }
    );
    await this.invalidateRfid(ctx.organizationId, tag.epc);
    return tag;
  }

  @Get('rfid/tags/:id/events')
  async events(@Req() request: Request, @Param('id') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'rfid.read');
    return new RfidRepository(this.database.pool).listEvents(ctx, parseWithSchema(uuidSchema, id));
  }

  private async invalidateRfid(organizationId: string, epc: string) {
    await this.redis.client.del(`rfid:resolve:${organizationId}:${epc}`);
  }
}

@Controller('inventory')
export class InventoryController {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly productAlerts: ProductAlertService
  ) {}

  private isCatalogContributor(ctx: RequestContext): boolean {
    return !ctx.isOwner && ctx.roles.includes('Unosilac kataloga');
  }

  private async assertContributorOwnsVariant(ctx: RequestContext, variantId: string): Promise<void> {
    if (!this.isCatalogContributor(ctx)) return;
    const result = await this.database.pool.query(
      `SELECT 1
       FROM product_variants v
       JOIN products p ON p.id = v.product_id AND p.organization_id = v.organization_id
       WHERE v.organization_id = $1 AND v.id = $2 AND p.created_by_user_id = $3
         AND v.deleted_at IS NULL AND p.deleted_at IS NULL`,
      [ctx.organizationId, variantId, ctx.userId],
    );
    if (result.rowCount !== 1) throw new TenantAccessDeniedError();
  }

  @Get('locations')
  async locations(@Req() request: Request) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'inventory.read');
    return (
      await this.database.pool.query(
        `SELECT id, name, code FROM locations WHERE organization_id=$1 AND deleted_at IS NULL ORDER BY name`,
        [ctx.organizationId]
      )
    ).rows;
  }

  @Get('layout')
  async layout(@Req() request: Request) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'inventory.read');
    const [warehouses, zones, bins] = await Promise.all([
      this.database.pool.query(
        `SELECT id, location_id AS "locationId", code, name, active, version
         FROM warehouses
         WHERE organization_id = $1 AND deleted_at IS NULL
         ORDER BY code, name`,
        [ctx.organizationId]
      ),
      this.database.pool.query(
        `SELECT id, warehouse_id AS "warehouseId", code, name,
                display_order AS "displayOrder", active, version
         FROM warehouse_zones
         WHERE organization_id = $1 AND deleted_at IS NULL
         ORDER BY warehouse_id, display_order, code, name`,
        [ctx.organizationId]
      ),
      this.database.pool.query(
        `SELECT id, zone_id AS "zoneId", code, name, capacity,
                low_stock_threshold AS "lowStockThreshold", display_order AS "displayOrder",
                active, status, version
         FROM warehouse_bins
         WHERE organization_id = $1 AND deleted_at IS NULL
         ORDER BY zone_id, display_order, code, name`,
        [ctx.organizationId]
      )
    ]);
    return { warehouses: warehouses.rows, zones: zones.rows, bins: bins.rows };
  }

  @Post('items')
  async createItem(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'inventory.adjust');
    const input = parseWithSchema(
      z.object({
        variantId: uuidSchema,
        serialNumber: z.string().nullable().optional(),
        locationId: uuidSchema.nullable().optional(),
        zoneId: uuidSchema.nullable().optional(),
        binId: uuidSchema.nullable().optional(),
        status: z.string().optional()
      }),
      body
    );
    await this.assertContributorOwnsVariant(ctx, input.variantId);
    const item = await new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      const item = await new InventoryRepository(client).createItem(ctx, input);
      await new AuditRepository(client).append({
        ctx,
        aggregateType: 'inventory_item',
        aggregateId: item.id,
        operation: 'create',
        afterPayload: item
      });
      await new OutboxRepository(client).append({
        ctx,
        eventType: 'InventoryAdjusted',
        aggregateType: 'inventory_item',
        aggregateId: item.id,
        payload: {
          inventoryItemId: item.id,
          variantId: item.variantId,
          locationId: item.currentLocationId,
          ...(item.currentZoneId ? { zoneId: item.currentZoneId } : {}),
          ...(item.currentBinId ? { binId: item.currentBinId } : {})
        }
      });
      await new OperationalSyncProjector(client).publishVariantChange(ctx, item.variantId);
      return item;
    });
    await this.productAlerts.notifyBackInStock({
      organizationId: ctx.organizationId,
      variantId: item.variantId
    });
    return item;
  }

  @Post('adjustments')
  async adjust(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'inventory.adjust');
    const input = parseWithSchema(
      z.object({
        variantId: uuidSchema,
        inventoryItemId: uuidSchema.nullable().optional(),
        locationId: uuidSchema,
        zoneId: uuidSchema.nullable().optional(),
        binId: uuidSchema.nullable().optional(),
        quantityDelta: z.coerce.number().int(),
        sourceType: z.string().trim().min(1),
        sourceId: uuidSchema.nullable().optional(),
        metadata: z.record(z.string(), z.unknown()).optional()
      }),
      body
    );
    await this.assertContributorOwnsVariant(ctx, input.variantId);
    const balance = await new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      const balance = await new InventoryRepository(client).adjust(ctx, input);
      await new AuditRepository(client).append({
        ctx,
        aggregateType: 'inventory_balance',
        aggregateId: input.variantId,
        operation: 'adjust',
        beforePayload: {
          ...balance,
          quantity: balance.previousQuantity
        },
        afterPayload: {
          ...balance,
          quantityDelta: input.quantityDelta,
          sourceType: input.sourceType,
          metadata: input.metadata ?? {}
        },
        reason: input.sourceType
      });
      await new OutboxRepository(client).append({
        ctx,
        eventType: 'InventoryAdjusted',
        aggregateType: 'variant',
        aggregateId: input.variantId,
        payload: {
          variantId: input.variantId,
          locationId: input.locationId,
          ...(input.zoneId ? { zoneId: input.zoneId } : {}),
          ...(input.binId ? { binId: input.binId } : {}),
          quantityDelta: input.quantityDelta,
          quantity: balance.quantity
        }
      });
      await new OperationalSyncProjector(client).publishVariantChange(ctx, input.variantId);
      return balance;
    });
    if (input.quantityDelta > 0) {
      await this.productAlerts.notifyBackInStock({
        organizationId: ctx.organizationId,
        variantId: input.variantId
      });
    }
    return balance;
  }

  @Post('items/:id/move')
  async move(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'inventory.adjust');
    const input = parseWithSchema(
      z.object({ toLocationId: uuidSchema, reason: z.string().trim().min(1) }),
      body
    );
    if (this.isCatalogContributor(ctx)) {
      const ownership = await this.database.pool.query(
        `SELECT 1
         FROM inventory_items i
         JOIN product_variants v ON v.id = i.variant_id AND v.organization_id = i.organization_id
         JOIN products p ON p.id = v.product_id AND p.organization_id = v.organization_id
         WHERE i.organization_id = $1 AND i.id = $2 AND p.created_by_user_id = $3
           AND i.deleted_at IS NULL AND v.deleted_at IS NULL AND p.deleted_at IS NULL`,
        [ctx.organizationId, parseWithSchema(uuidSchema, id), ctx.userId],
      );
      if (ownership.rowCount !== 1) throw new TenantAccessDeniedError();
    }
    return new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      const moved = await new InventoryRepository(client).moveItem(ctx, {
        inventoryItemId: parseWithSchema(uuidSchema, id),
        ...input
      });
      await new AuditRepository(client).append({
        ctx,
        aggregateType: 'inventory_item',
        aggregateId: moved.inventoryItemId,
        operation: 'move',
        afterPayload: moved,
        reason: input.reason
      });
      await new OutboxRepository(client).append({
        ctx,
        eventType: 'InventoryMoved',
        aggregateType: 'inventory_item',
        aggregateId: moved.inventoryItemId,
        payload: moved
      });
      return moved;
    });
  }

  @Get('variants/:variantId/balances')
  async balances(@Req() request: Request, @Param('variantId') variantId: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'inventory.read');
    const parsedVariantId = parseWithSchema(uuidSchema, variantId);
    await this.assertContributorOwnsVariant(ctx, parsedVariantId);
    return new InventoryRepository(this.database.pool).balances(
      ctx,
      parsedVariantId
    );
  }
}

@Controller('imports')
export class ImportsController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(LOGGER) private readonly logger: Logger
  ) {}

  @Post('xlsx')
  async xlsx(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const input = parseWithSchema(
      z.object({
        sourceName: z.string().trim().min(1),
        dryRun: z.boolean().default(true),
        base64Xlsx: z.string().min(1)
      }),
      body
    );
    return new TransactionManager(this.database.pool, this.logger).run((client) =>
      new ImportRepository(client).createXlsxJob(ctx, {
        sourceName: input.sourceName,
        dryRun: input.dryRun,
        buffer: Buffer.from(input.base64Xlsx, 'base64')
      })
    );
  }

  @Post(':jobId/execute')
  async execute(@Req() request: Request, @Param('jobId') jobId: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    return new TransactionManager(this.database.pool, this.logger).run((client) =>
      new ImportRepository(client).executeJob(ctx, parseWithSchema(uuidSchema, jobId))
    );
  }

  @Get(':jobId/reconciliation')
  async reconciliation(@Req() request: Request, @Param('jobId') jobId: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.read');
    return new ImportRepository(this.database.pool).reconciliation(
      ctx,
      parseWithSchema(uuidSchema, jobId)
    );
  }

  @Post('firestore')
  async firestore(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const input = parseWithSchema(
      z.object({
        sourceName: z.string().trim().min(1),
        dryRun: z.boolean().default(true),
        checkpoint: z.record(z.string(), z.unknown()).optional(),
        collection: z.string().trim().min(1).optional(),
        documentId: z.string().trim().min(1).optional(),
        batchSize: z.coerce.number().int().positive().max(500).optional()
      }),
      body
    );
    return new ImportRepository(this.database.pool).createFirestoreJob(ctx, {
      ...input,
      serviceAccountJson: this.config.FIRESTORE_SERVICE_ACCOUNT_JSON || undefined,
      projectId: this.config.FIRESTORE_PROJECT_ID || undefined
    });
  }
}

function slugifyLocal(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return slug || `item-${Date.now()}`;
}

function specificationAttributeKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'specification';
}

function specificationAttributeKeys(name: string, slug: string): string[] {
  return [...new Set([specificationAttributeKey(name), slug.replace(/-/g, '_'), name])];
}
