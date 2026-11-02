import { createHash } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import type pg from 'pg';
import { z } from 'zod';
import {
  AuthRepository,
  AuditRepository,
  CatalogRepository,
  StorefrontRepository,
  TransactionManager,
  type Database
} from '@daja/database';
import {
  AppError,
  requirePermission,
  ResourceConflictError,
  TenantAccessDeniedError,
  VersionConflictError,
  ValidationFailedError
} from '@daja/security';
import type { Logger } from '@daja/observability';
import type { RequestContext } from '@daja/shared';
import { amountMinorSchema, attributesSchema, currencySchema, uuidSchema } from '@daja/validation';
import { DATABASE, LOGGER } from './tokens.js';
import { enqueueCatalogDelivery } from './catalog-delivery.service.js';
import { apiUnderLoad } from './runtime/abuse-protection.js';

const productChanges = z
  .object({
    name: z.string().trim().min(1).max(240).optional(),
    description: z.string().max(20_000).nullable().optional(),
    itemCondition: z.enum(['new', 'used', 'refurbished']).optional(),
    departmentId: uuidSchema.nullable().optional(),
    brandId: uuidSchema.nullable().optional(),
    primaryCategoryId: uuidSchema.nullable().optional(),
    seo: z.record(z.string().max(120), z.string().max(2000)).optional(),
    features: z
      .array(
        z.object({ title: z.string().min(1).max(160), subtitle: z.string().max(320).optional() })
      )
      .max(50)
      .optional(),
    marketingFlags: z.array(z.string().max(80)).max(30).optional(),
    active: z.boolean().optional(),
    published: z.boolean().optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one product field is required');
const variantChanges = z
  .object({
    sku: z.string().trim().min(1).max(160).nullable().optional(),
    barcode: z.string().trim().min(1).max(160).nullable().optional(),
    mpn: z.string().trim().min(1).max(160).nullable().optional(),
    name: z.string().trim().max(240).nullable().optional(),
    gender: z.string().max(80).nullable().optional(),
    currentPriceAmount: amountMinorSchema.optional(),
    currency: currencySchema.optional(),
    attributes: attributesSchema.optional(),
    active: z.boolean().optional(),
    published: z.boolean().optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one variant field is required');
const specs = z
  .array(z.object({ specKeyId: uuidSchema, value: z.string().trim().min(1).max(1000) }).strict())
  .max(100)
  .refine(
    (values) => new Set(values.map((v) => v.specKeyId)).size === values.length,
    'Duplicate specification'
  );
export const bulkItemSchema = z
  .object({
    productId: uuidSchema,
    expectedProductVersion: z.number().int().positive(),
    product: productChanges.optional(),
    variantId: uuidSchema.optional(),
    expectedVariantVersion: z.number().int().positive().optional(),
    variant: variantChanges.optional(),
    pricePercent: z.number().min(-100).max(1000).optional(),
    specifications: specs.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    const variantChange =
      value.variant !== undefined ||
      value.pricePercent !== undefined ||
      value.specifications !== undefined;
    if (!value.product && !variantChange)
      ctx.addIssue({ code: 'custom', message: 'No changes supplied' });
    if (variantChange && (!value.variantId || !value.expectedVariantVersion))
      ctx.addIssue({ code: 'custom', message: 'Variant ID and expected version are required' });
    if (value.pricePercent !== undefined && value.variant?.currentPriceAmount !== undefined)
      ctx.addIssue({ code: 'custom', message: 'Choose a price or a percentage, not both' });
  });
export const bulkRequestSchema = z
  .object({ requestId: uuidSchema, items: z.array(bulkItemSchema).min(1).max(1000) })
  .strict()
  .refine(
    (value) => new Set(value.items.map((item) => item.productId)).size === value.items.length,
    'Each product may occur only once per job'
  );
type BulkItem = z.infer<typeof bulkItemSchema>;
type BulkRequest = z.infer<typeof bulkRequestSchema>;
type Job = {
  id: string;
  organization_id: string;
  requested_by: string;
  payload_hash: string;
  context: RequestContext;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  status: string;
};

@Injectable()
export class CatalogBulkService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(LOGGER) private readonly logger: Logger
  ) {}
  onModuleInit() {
    this.schedule();
  }
  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
  private schedule() {
    if (!this.stopped) {
      this.timer = setTimeout(() => {
        void this.tick();
      }, 500);
      this.timer.unref();
    }
  }

  async create(ctx: RequestContext, input: BulkRequest) {
    requirePermission(ctx, 'catalog.write');
    if (!ctx.deviceId) throw new ValidationFailedError('A verified staff device is required');
    const hash = createHash('sha256').update(JSON.stringify(input.items)).digest('hex');
    return new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      // Serializes only job creation for this tenant, including idempotent replays.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `catalog-bulk:${ctx.organizationId}`
      ]);
      const old = (
        await client.query<Job>(
          'SELECT * FROM catalog_bulk_jobs WHERE organization_id=$1 AND request_id=$2',
          [ctx.organizationId, input.requestId]
        )
      ).rows[0];
      if (old) {
        if (old.payload_hash !== hash || old.requested_by !== ctx.userId)
          throw new ResourceConflictError('Request ID was already used for different changes');
        return this.summary(old);
      }
      const active = await client.query(
        `SELECT 1 FROM catalog_bulk_jobs WHERE organization_id=$1 AND status IN ('queued','running')`,
        [ctx.organizationId]
      );
      if (active.rowCount)
        throw new ResourceConflictError('An organization can have only one active catalog job');
      const recent = (
        await client.query<{ count: string; retry: number }>(
          `SELECT count(*),
        GREATEST(1, ceil(extract(epoch FROM min(created_at)+interval '60 seconds'-now())))::integer AS retry
        FROM catalog_bulk_jobs WHERE organization_id=$1 AND created_at>now()-interval '60 seconds'`,
          [ctx.organizationId]
        )
      ).rows[0]!;
      if (Number(recent.count) >= 2)
        throw new AppError('RATE_LIMITED', 'Too many catalog jobs', 429, {
          retryAfterSeconds: recent.retry
        });
      // Check tenant ownership now, and again with fresh permissions before every item.
      const owned = await client.query(
        `SELECT id FROM products WHERE organization_id=$1 AND id=ANY($2::uuid[])
        AND deleted_at IS NULL AND ($3::boolean OR created_by_user_id=$4)`,
        [
          ctx.organizationId,
          input.items.map((item) => item.productId),
          ctx.isOwner === true || !ctx.roles.includes('Unosilac kataloga'),
          ctx.userId
        ]
      );
      if (owned.rowCount !== input.items.length) throw new TenantAccessDeniedError();
      const row = (
        await client.query<Job>(
          `INSERT INTO catalog_bulk_jobs
        (organization_id, requested_by, request_id, payload_hash, context, total) VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING *`,
          [
            ctx.organizationId,
            ctx.userId,
            input.requestId,
            hash,
            JSON.stringify(ctx),
            input.items.length
          ]
        )
      ).rows[0]!;
      await client.query(
        `INSERT INTO catalog_bulk_items(job_id,position,input)
        SELECT $1, ordinality::integer-1, value FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY`,
        [row.id, JSON.stringify(input.items)]
      );
      await new AuditRepository(client).append({
        ctx,
        aggregateType: 'catalog_bulk_job',
        aggregateId: row.id,
        operation: 'create',
        afterPayload: { count: input.items.length, requestId: input.requestId }
      });
      return this.summary(row);
    });
  }

  async get(ctx: RequestContext, id: string, after: number) {
    requirePermission(ctx, 'catalog.write');
    const row = (
      await this.database.pool.query<Job>(
        `SELECT * FROM catalog_bulk_jobs WHERE organization_id=$1 AND id=$2
      AND (requested_by=$3 OR $4::boolean)`,
        [ctx.organizationId, id, ctx.userId, ctx.isOwner === true]
      )
    ).rows[0];
    if (!row) throw new TenantAccessDeniedError();
    const items = (
      await this.database.pool.query(
        `SELECT position, input->>'productId' AS "productId", status, result
      FROM catalog_bulk_items WHERE job_id=$1 AND position>$2 ORDER BY position LIMIT 50`,
        [id, after]
      )
    ).rows;
    const pendingDelivery = await this.database.pool.query<{ count: string }>(
      `SELECT count(*) FROM catalog_deliveries
      WHERE organization_id=$1 AND context->>'correlationId'=$2 AND completed_at IS NULL`,
      [ctx.organizationId, id]
    );
    return {
      ...this.summary(row),
      pendingSync: Number(pendingDelivery.rows[0]!.count),
      items,
      nextAfter: items.length === 50 ? items[items.length - 1]!.position : null
    };
  }

  async cancel(ctx: RequestContext, id: string) {
    requirePermission(ctx, 'catalog.write');
    const row = (
      await this.database.pool.query<Job>(
        `UPDATE catalog_bulk_jobs SET status='cancelled', updated_at=now()
      WHERE organization_id=$1 AND id=$2 AND (requested_by=$3 OR $4::boolean)
      AND status IN ('queued','running') RETURNING *`,
        [ctx.organizationId, id, ctx.userId, ctx.isOwner === true]
      )
    ).rows[0];
    if (!row) throw new ResourceConflictError('Job is missing or has already finished');
    return this.summary(row);
  }

  private summary(row: Job) {
    return {
      id: row.id,
      status: row.status,
      total: row.total,
      processed: row.processed,
      succeeded: row.succeeded,
      failed: row.failed,
      batchSize: 25,
      currentBatch: Math.min(Math.floor(row.processed / 25) + 1, Math.ceil(row.total / 25)),
      batches: Math.ceil(row.total / 25)
    };
  }

  private async assertProduct(
    client: pg.PoolClient,
    ctx: RequestContext,
    productId: string,
    lock: boolean
  ) {
    const row = (
      await client.query<{ version: string; created_by_user_id: string | null }>(
        `SELECT version, created_by_user_id
      FROM products WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
        [ctx.organizationId, productId]
      )
    ).rows[0];
    if (
      !row ||
      (!ctx.isOwner &&
        ctx.roles.includes('Unosilac kataloga') &&
        row.created_by_user_id !== ctx.userId)
    )
      throw new TenantAccessDeniedError();
    return row;
  }

  private async apply(client: pg.PoolClient, ctx: RequestContext, item: BulkItem) {
    const locked = await this.assertProduct(client, ctx, item.productId, true);
    if (Number(locked.version) !== item.expectedProductVersion) throw new VersionConflictError();
    const repo = new CatalogRepository(client);
    const before = await repo.getProduct(ctx, item.productId);
    let after = before;
    if (item.product)
      after = await repo.patchProduct(ctx, item.productId, {
        ...item.product,
        expectedVersion: item.expectedProductVersion
      });
    let variantResult: unknown;
    if (
      item.variantId &&
      (item.variant || item.pricePercent !== undefined || item.specifications)
    ) {
      const valid = await client.query(
        `SELECT id FROM product_variants WHERE organization_id=$1 AND id=$2 AND product_id=$3 AND deleted_at IS NULL FOR UPDATE`,
        [ctx.organizationId, item.variantId, item.productId]
      );
      if (valid.rowCount !== 1) throw new TenantAccessDeniedError();
      const old = await repo.getVariant(ctx, item.variantId);
      if (old.version !== item.expectedVariantVersion) throw new VersionConflictError();
      const price =
        item.pricePercent === undefined
          ? {}
          : {
              currentPriceAmount: Math.round(old.currentPriceAmount * (1 + item.pricePercent / 100))
            };
      if (
        'currentPriceAmount' in price &&
        !amountMinorSchema.safeParse(price.currentPriceAmount).success
      ) {
        throw new ValidationFailedError('Calculated price is outside the supported range');
      }
      const changed = await repo.patchVariant(ctx, item.variantId, {
        ...item.variant,
        ...price,
        expectedVersion: item.expectedVariantVersion
      });
      variantResult = changed.after;
      if (item.specifications) {
        const keys = item.specifications.map((v) => v.specKeyId);
        const validSpecs = await client.query(
          `SELECT id FROM spec_keys WHERE organization_id=$1 AND id=ANY($2::uuid[])
          AND active AND deleted_at IS NULL AND ($3::uuid IS NULL OR department_id=$3)`,
          [ctx.organizationId, keys, after.departmentId]
        );
        if (validSpecs.rowCount !== keys.length)
          throw new ValidationFailedError(
            'Specification does not belong to this product department'
          );
        await client.query(
          'DELETE FROM variant_specification_values WHERE organization_id=$1 AND variant_id=$2',
          [ctx.organizationId, item.variantId]
        );
        for (const spec of item.specifications)
          await client.query(
            `INSERT INTO variant_specification_values
          (organization_id,variant_id,spec_key_id,value) VALUES ($1,$2,$3,$4)`,
            [ctx.organizationId, item.variantId, spec.specKeyId, spec.value]
          );
      }
      await new AuditRepository(client).append({
        ctx,
        aggregateType: 'variant',
        aggregateId: item.variantId,
        operation: changed.priceChanged ? 'price_change' : 'update',
        beforePayload: old,
        afterPayload: changed.after
      });
    }
    // Variant-only edits must also advance the product version for the next job.
    if (!item.product)
      after = await repo.patchProduct(ctx, item.productId, {
        expectedVersion: item.expectedProductVersion
      });
    await client.query(
      `UPDATE products SET quality_review_status='pending', quality_review_note=NULL,
      quality_reviewed_by_user_id=NULL, quality_reviewed_at=NULL WHERE organization_id=$1 AND id=$2`,
      [ctx.organizationId, item.productId]
    );
    await new StorefrontRepository(client).refreshProductSnapshots({
      organizationId: ctx.organizationId,
      productId: item.productId
    });
    await new AuditRepository(client).append({
      ctx,
      aggregateType: 'product',
      aggregateId: item.productId,
      operation: 'update',
      beforePayload: before,
      afterPayload: after
    });
    await enqueueCatalogDelivery(client, ctx, item.productId, [after.slug]);
    return { product: after, ...(variantResult ? { variant: variantResult } : {}) };
  }

  private async tick() {
    try {
      if (apiUnderLoad()) return;
      await new TransactionManager(this.database.pool, this.logger).run(async (client) => {
        await client.query(`SET LOCAL statement_timeout = '10s'`);
        // A transaction lock and next_run_at prevent overlapping replicas from accelerating one job.
        const job = (
          await client.query<Job>(`SELECT * FROM catalog_bulk_jobs WHERE status IN ('queued','running') AND next_run_at<=now()
          ORDER BY next_run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`)
        ).rows[0];
        if (!job) return;
        const queued = (
          await client.query<{ position: number; input: BulkItem; attempts: number }>(
            `SELECT position,input,attempts FROM catalog_bulk_items
          WHERE job_id=$1 AND status='pending' ORDER BY position LIMIT 1 FOR UPDATE`,
            [job.id]
          )
        ).rows[0];
        if (!queued) return;
        const saved = job.context;
        await client.query('SAVEPOINT catalog_item');
        let status = 'succeeded';
        let result: unknown;
        try {
          const principal = await new AuthRepository(client).buildPrincipal({
            organizationId: job.organization_id,
            userId: job.requested_by,
            deviceId: saved.deviceId!,
            sessionFamilyId: ''
          });
          const ctx: RequestContext = { ...saved, ...principal, correlationId: job.id };
          requirePermission(ctx, 'catalog.write');
          result = await this.apply(client, ctx, queued.input);
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT catalog_item');
          // Infrastructure faults roll back the entire item and retry; no partial price change can commit.
          if (!(error instanceof AppError) || error.statusCode >= 500) {
            if (queued.attempts < 4) {
              await client.query(
                'UPDATE catalog_bulk_items SET attempts=attempts+1 WHERE job_id=$1 AND position=$2',
                [job.id, queued.position]
              );
              await client.query(
                `UPDATE catalog_bulk_jobs SET next_run_at=now()+($2 * interval '1 second') WHERE id=$1`,
                [job.id, 2 ** (queued.attempts + 1)]
              );
              return;
            }
            status = 'failed';
            result = {
              code: 'PROCESSING_FAILED',
              message: 'Item could not be processed after five attempts'
            };
            this.logger.warn(
              { jobId: job.id, position: queued.position, err: error },
              'Catalog bulk item failed'
            );
          } else {
            status = error.statusCode === 409 ? 'conflict' : 'failed';
            result = { code: error.code, message: error.message };
          }
        }
        await client.query(
          'UPDATE catalog_bulk_items SET status=$3,result=$4::jsonb WHERE job_id=$1 AND position=$2',
          [job.id, queued.position, status, JSON.stringify(result)]
        );
        await client.query(
          `UPDATE catalog_bulk_jobs SET processed=processed+1, succeeded=succeeded+$2, failed=failed+$3,
          status=CASE WHEN processed+1=total THEN CASE WHEN failed+$3>0 THEN 'completed_with_errors' ELSE 'completed' END ELSE 'running' END,
          next_run_at=clock_timestamp()+interval '500 milliseconds', updated_at=now() WHERE id=$1`,
          [job.id, status === 'succeeded' ? 1 : 0, status === 'succeeded' ? 0 : 1]
        );
      });
    } catch (error) {
      this.logger.warn({ err: error }, 'Catalog bulk item will retry');
    } finally {
      this.schedule();
    }
  }
}
