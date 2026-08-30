/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
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
  TransactionManager,
  type Database
} from '@daja/database';
import type { Logger } from '@daja/observability';
import { requirePermission, TenantAccessDeniedError, ValidationFailedError } from '@daja/security';
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

const productCreateSchema = z.object({
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
  limit: z.coerce.number().int().min(1).max(100).optional()
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

@Controller('public/catalog')
export class PublicCatalogController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(REDIS) private readonly redis: RedisConnection
  ) {}

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
    const configuredSiteUrl = this.config.OAUTH_FRONTEND_REDIRECT_URL ||
      this.config.CORS_ALLOWED_ORIGINS.find((origin) => !origin.includes('localhost')) ||
      'https://dajashop.rs';
    const siteUrl = configuredSiteUrl.replace(/\/$/, '');
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
    const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">${entries}</urlset>`;
    await this.redis.client.set(cacheKey, xml, 'EX', 3600);
    response
      .type('application/xml')
      .setHeader('Cache-Control', 'public, max-age=3600')
      .send(xml);
  }

  @Get('products/:slug')
  async productBySlug(@Req() request: Request, @Param('slug') slug: string) {
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
    private readonly realtime: RealtimeGateway
  ) {}

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
    return this.adminProductRows(ctx.organizationId);
  }

  @Get('products/:id')
  async getProduct(@Req() request: Request, @Param('id') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.read');
    const productId = parseWithSchema(uuidSchema, id);
    const product = (await this.adminProductRows(ctx.organizationId, productId))[0];
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
             audit.aggregate_type = 'variant' AND variant.product_id = $${values.length}
           )
         )`
      : '';
    values.push(input.limit ?? 50);

    return (
      await this.database.pool.query(
        `SELECT audit.id,
                audit.aggregate_type AS "aggregateType",
                audit.aggregate_id AS "aggregateId",
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
             ON audit.aggregate_type = 'variant'
            AND variant.organization_id = audit.organization_id
            AND variant.id = audit.aggregate_id
           LEFT JOIN products product
             ON product.organization_id = audit.organization_id
            AND product.id = CASE
              WHEN audit.aggregate_type = 'product' THEN audit.aggregate_id
              ELSE variant.product_id
            END
          WHERE audit.organization_id = $1
            AND audit.aggregate_type IN ('product', 'variant')
            ${productFilter}
          ORDER BY audit.occurred_at DESC, audit.id DESC
          LIMIT $${values.length}`,
        values
      )
    ).rows;
  }

  @Patch('products/:id')
  async patchProduct(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const productId = parseWithSchema(uuidSchema, id);
    const input = parseWithSchema(productPatchSchema, body);
    const patched = await new TransactionManager(this.database.pool, this.logger).run(
      async (client) => {
        const repository = new CatalogRepository(client);
        const before = await repository.getProduct(ctx, productId);
        const after = await repository.patchProduct(ctx, productId, input);
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
        return { productSlug: product.slug, after };
      }
    );
    await this.invalidateCatalog(ctx.organizationId, patched.productSlug);
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
    if (input.isPrimary)
      await this.database.pool.query(
        `UPDATE product_media SET is_primary = false WHERE organization_id = $1 AND product_id = $2`,
        [ctx.organizationId, productId]
      );
    const result = await this.database.pool.query(
      `INSERT INTO product_media (organization_id, product_id, variant_id, media_asset_id, role, position, is_primary, alt_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, media_asset_id AS "mediaId", role, position, is_primary AS "isPrimary", alt_text AS "altText"`,
      [
        ctx.organizationId,
        productId,
        input.variantId ?? null,
        input.mediaId,
        input.role ?? 'gallery',
        input.position ?? 0,
        input.isPrimary ?? false,
        input.altText ?? null
      ]
    );
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
        `SELECT media_asset_id AS media_id FROM product_media
         WHERE organization_id = $1 AND product_id = $2 AND id = $3`,
        [ctx.organizationId, productId, linkId]
      );
      const mediaId = media.rows[0]?.media_id;
      if (!mediaId) throw new TenantAccessDeniedError();
      await ensurePrimaryMediaThumbnail({
        config: this.config,
        database: this.database,
        organizationId: ctx.organizationId,
        mediaId
      });
      await this.database.pool.query(
        `UPDATE product_media SET is_primary = false WHERE organization_id = $1 AND product_id = $2`,
        [ctx.organizationId, productId]
      );
    }
    const result = await this.database.pool.query(
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
    if (result.rowCount !== 1) throw new TenantAccessDeniedError();
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
        const deleted = await client.query<{ media_asset_id: string }>(
          `DELETE FROM product_media
         WHERE organization_id = $1 AND product_id = $2 AND id = $3
         RETURNING media_asset_id`,
          [ctx.organizationId, productId, linkId]
        );
        if (deleted.rowCount !== 1) throw new TenantAccessDeniedError();
        await new MediaRepository(client).discardUnreferenced(
          ctx,
          deleted.rows[0]!.media_asset_id,
          new R2MediaStorageAdapter(this.config)
        );
        return deleted;
      }
    );
    if (result.rowCount !== 1) throw new TenantAccessDeniedError();
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
        `SELECT id, amount_minor AS "amountMinor", currency, price_type AS "priceType", valid_from AS "validFrom", valid_until AS "validUntil", created_at AS "createdAt" FROM variant_prices WHERE organization_id=$1 AND variant_id=$2 ORDER BY valid_from DESC`,
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
    await new OperationalSyncProjector(this.database.pool).publishProductChange(
      ctx,
      product.id,
      variantId
    );
    await this.invalidateCatalog(ctx.organizationId, product.slug);
    return result.rows[0];
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

  @Get('spec_keys')
  async listSpecKeys(@Req() request: Request) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.read');
    const result = await this.database.pool.query(
      `SELECT id, name, slug, department_id AS "departmentId", unit, data_type AS "dataType", active, version,
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
    const result = await this.database.pool.query(
      `INSERT INTO spec_keys (organization_id, name, slug, department_id, unit, data_type, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, slug, department_id AS "departmentId", unit, data_type AS "dataType", active, version,
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        ctx.organizationId,
        input.name,
        input.slug ?? slugifyLocal(input.name),
        input.departmentId,
        input.unit ?? null,
        input.dataType ?? 'text',
        input.active ?? true
      ]
    );
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
      `SELECT name, slug, department_id, unit, data_type, active
       FROM spec_keys WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [ctx.organizationId, specKeyId]
    );
    if (current.rowCount !== 1) {
      throw new TenantAccessDeniedError();
    }
    const row = current.rows[0];
    await this.assertActiveDepartment(ctx.organizationId, input.departmentId ?? row.department_id);
    const result = await this.database.pool.query(
      `UPDATE spec_keys
       SET name = $3, slug = $4, department_id = $5, unit = $6, data_type = $7, active = $8,
           version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
       RETURNING id, name, slug, department_id AS "departmentId", unit, data_type AS "dataType", active, version,
                 created_at AS "createdAt", updated_at AS "updatedAt"`,
      [
        ctx.organizationId,
        specKeyId,
        input.name ?? row.name,
        input.slug ?? row.slug,
        input.departmentId ?? row.department_id,
        input.unit === undefined ? row.unit : input.unit,
        input.dataType ?? row.data_type,
        input.active ?? row.active
      ]
    );
    this.publishCatalogTaxonomy(ctx.organizationId, 'spec_keys');
    return result.rows[0];
  }

  @Delete('spec_keys/:id')
  async deleteSpecKey(@Req() request: Request, @Param('id') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.write');
    const result = await this.database.pool.query(
      `UPDATE spec_keys
       SET deleted_at = now(), active = false, version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [ctx.organizationId, parseWithSchema(uuidSchema, id)]
    );
    if (result.rowCount !== 1) {
      throw new TenantAccessDeniedError();
    }
    this.publishCatalogTaxonomy(ctx.organizationId, 'spec_keys');
    return { deleted: true };
  }

  /** The admin catalog includes internal inventory placement.  Keep it in a
   * single query so a realtime update can reload one product, rather than
   * forcing the dashboard to refresh its whole product list. */
  private async adminProductRows(organizationId: string, productId?: string) {
    return (
      await this.database.pool.query(
        `SELECT p.id, p.name, p.slug, p.description, p.active, p.published, p.department_id AS "departmentId",
              p.brand_id AS "brandId", p.primary_category_id AS "primaryCategoryId", p.item_condition AS "itemCondition", p.seo, p.features,
              p.model_3d_url AS "model3DUrl", p.marketing_flags AS "marketingFlags", d.slug AS department, b.name AS brand, c.name AS category,
              v.id AS "variantId", v.sku, v.barcode, v.mpn, v.current_price_amount AS "currentPriceAmount", v.currency,
              v.gender, v.attributes AS specs, v.active AS "variantActive", v.published AS "variantPublished",
              COALESCE(inventory.quantity, 0) AS quantity, inventory.location_id AS "locationId",
              inventory.zone_id AS "zoneId", inventory.bin_id AS "binId",
              tag.id AS "rfidTagId", tag.epc, tag.tid, tag.status AS "rfidTagStatus",
              media.public_url AS "primaryImageUrl", media.thumbnail_url AS "thumbnailUrl"
       FROM products p
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
       WHERE p.organization_id = $1 AND p.deleted_at IS NULL
       ${productId ? 'AND p.id = $2' : ''}
       ORDER BY p.updated_at DESC`,
        productId ? [organizationId, productId] : [organizationId]
      )
    ).rows;
  }

  private async invalidateCatalog(organizationId: string, ...slugs: Array<string | undefined>) {
    const validSlugs = slugs.filter((slug): slug is string => Boolean(slug));
    const keys = [
      `catalog:sitemap:${organizationId}`,
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
          ...(productIdBySlug.get(slug) ? { productId: productIdBySlug.get(slug) } : {})
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
    const tag = await new TransactionManager(this.database.pool, this.logger).run(
      async (client) => {
        const tag = await new RfidRepository(client).createTag(ctx, input);
        await new AuditRepository(client).append({
          ctx,
          aggregateType: 'rfid_tag',
          aggregateId: tag.id,
          operation: 'create',
          afterPayload: tag
        });
        await new OutboxRepository(client).append({
          ctx,
          eventType: 'RfidTagStatusChanged',
          aggregateType: 'rfid_tag',
          aggregateId: tag.id,
          payload: { tagId: tag.id, status: tag.status }
        });
        return tag;
      }
    );
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
    @Inject(LOGGER) private readonly logger: Logger
  ) {}

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
    return new TransactionManager(this.database.pool, this.logger).run(async (client) => {
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
    return new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      const balance = await new InventoryRepository(client).adjust(ctx, input);
      await new AuditRepository(client).append({
        ctx,
        aggregateType: 'inventory_balance',
        aggregateId: input.variantId,
        operation: 'adjust',
        afterPayload: balance,
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
  }

  @Post('items/:id/move')
  async move(@Req() request: Request, @Param('id') id: string, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'inventory.adjust');
    const input = parseWithSchema(
      z.object({ toLocationId: uuidSchema, reason: z.string().trim().min(1) }),
      body
    );
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
    return new InventoryRepository(this.database.pool).balances(
      ctx,
      parseWithSchema(uuidSchema, variantId)
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
