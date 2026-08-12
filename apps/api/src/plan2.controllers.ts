/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Queue } from 'bullmq';
import { z } from 'zod';
import type { AppConfig } from '@daja/config';
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
import { requirePermission } from '@daja/security';
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

const productCreateSchema = z.object({
  name: z.string().trim().min(1).max(240),
  slug: slugSchema,
  description: z.string().max(20_000).nullable().optional(),
  brandId: uuidSchema.nullable().optional(),
  primaryCategoryId: uuidSchema.nullable().optional(),
  active: z.boolean().optional(),
  published: z.boolean().optional(),
  legacyFirestoreId: z.string().trim().min(1).max(240).nullable().optional(),
  externalId: z.string().trim().min(1).max(240).nullable().optional()
});

const productPatchSchema = productCreateSchema.partial().extend({
  expectedVersion: z.coerce.number().int().positive().optional()
});

const variantCreateSchema = z.object({
  sku: z.string().trim().min(1).max(120),
  barcode: z.string().trim().min(1).max(120).nullable().optional(),
  name: z.string().trim().min(1).max(240).nullable().optional(),
  gender: z.string().trim().min(1).max(80).nullable().optional(),
  currentPriceAmount: amountMinorSchema,
  currency: currencySchema,
  attributes: attributesSchema.optional(),
  active: z.boolean().optional(),
  published: z.boolean().optional()
});

const variantPatchSchema = variantCreateSchema.partial().extend({
  expectedVersion: z.coerce.number().int().positive().optional()
});

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

  @Get('products/:slug')
  async productBySlug(@Req() request: Request, @Param('slug') slug: string) {
    const ctx = this.publicContext(request);
    const normalizedSlug = parseWithSchema(slugSchema, slug);
    const cacheKey = `catalog:slug:${ctx.organizationId}:${normalizedSlug}`;
    const cached = await this.redis.client.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as unknown;
    }
    const product = await new CatalogRepository(this.database.pool).getPublicProductBySlug(
      ctx,
      normalizedSlug
    );
    await this.redis.client.set(cacheKey, JSON.stringify(product), 'EX', 120);
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
    @Inject(DATABASE) private readonly database: Database,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(REDIS) private readonly redis: RedisConnection
  ) {}

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

  @Get('products/:id')
  async getProduct(@Req() request: Request, @Param('id') id: string) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'catalog.read');
    return new CatalogRepository(this.database.pool).getProduct(
      ctx,
      parseWithSchema(uuidSchema, id)
    );
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
        await new AuditRepository(client).append({
          ctx,
          aggregateType: 'product',
          aggregateId: productId,
          operation: 'update',
          beforePayload: before,
          afterPayload: after
        });
        await new OutboxRepository(client).append({
          ctx,
          eventType: 'ProductUpdated',
          aggregateType: 'product',
          aggregateId: productId,
          payload: { productId, slug: after.slug, published: after.published }
        });
        return { beforeSlug: before.slug, after };
      }
    );
    await this.invalidateCatalog(ctx.organizationId, patched.beforeSlug, patched.after.slug);
    return patched.after;
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
        const { before, after, priceChanged } = await repository.patchVariant(
          ctx,
          variantId,
          input
        );
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
        return { productSlug: product.slug, after };
      }
    );
    await this.invalidateCatalog(ctx.organizationId, patched.productSlug);
    return patched.after;
  }

  private async invalidateCatalog(organizationId: string, ...slugs: Array<string | undefined>) {
    const keys = slugs
      .filter((slug): slug is string => Boolean(slug))
      .map((slug) => `catalog:slug:${organizationId}:${slug}`);
    if (keys.length > 0) {
      await this.redis.client.del(...keys);
    }
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
        originalFilename: z.string().max(240).optional()
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
    const input = parseWithSchema(
      z.object({
        expectedVersion: z.coerce.number().int().positive().optional(),
        reason: z.string().trim().min(1)
      }),
      body
    );
    const tag = await new TransactionManager(this.database.pool, this.logger).run(
      async (client) => {
        const tag = await new RfidRepository(client).unassignTag(ctx, {
          tagId: parseWithSchema(uuidSchema, id),
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
        return tag;
      }
    );
    await this.invalidateRfid(ctx.organizationId, tag.epc);
    return tag;
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

  @Post('items')
  async createItem(@Req() request: Request, @Body() body: unknown) {
    const ctx = resolveRequestContext(request);
    requirePermission(ctx, 'inventory.adjust');
    const input = parseWithSchema(
      z.object({
        variantId: uuidSchema,
        serialNumber: z.string().nullable().optional(),
        locationId: uuidSchema.nullable().optional(),
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
          locationId: item.currentLocationId
        }
      });
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
          quantityDelta: input.quantityDelta,
          quantity: balance.quantity
        }
      });
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
