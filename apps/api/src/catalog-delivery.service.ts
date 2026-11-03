import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';
import type pg from 'pg';
import { OutboxRepository, TransactionManager, type Database } from '@daja/database';
import type { AppConfig } from '@daja/config';
import type { Logger } from '@daja/observability';
import type { RequestContext } from '@daja/shared';
import { CONFIG, DATABASE, LOGGER } from './tokens.js';
import { OperationalSyncProjector } from './operational-sync-projector.js';
import { invalidateCatalogSearch } from './catalog-search.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { apiUnderLoad } from './runtime/abuse-protection.js';

export async function enqueueCatalogDelivery(
  client: pg.PoolClient,
  ctx: RequestContext,
  productId: string,
  slugs: string[],
  cacheKeys: string[] = []
) {
  await client.query(
    `INSERT INTO catalog_deliveries (organization_id, product_id, context, slugs, cache_keys) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb)`,
    [
      ctx.organizationId,
      productId,
      JSON.stringify(ctx),
      JSON.stringify([...new Set(slugs)]),
      JSON.stringify(cacheKeys)
    ]
  );
}

@Injectable()
export class CatalogDeliveryService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly cache: Redis;
  private connecting: Promise<void> | undefined;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(CONFIG) config: AppConfig,
    @Inject(RealtimeGateway) private readonly realtime: RealtimeGateway
  ) {
    this.cache = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: 1500,
      connectTimeout: 1500,
      retryStrategy: () => null
    });
    this.cache.on('error', () => {});
  }

  onModuleInit() {
    this.schedule();
  }
  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.cache.disconnect();
  }
  private schedule() {
    if (!this.stopped) {
      this.timer = setTimeout(() => {
        void this.tick();
      }, 500);
      this.timer.unref();
    }
  }
  async invalidateKeys(keys: string[]) {
    if (this.cache.status === 'wait' || this.cache.status === 'end') {
      this.connecting ??= this.cache.connect().finally(() => {
        this.connecting = undefined;
      });
    }
    if (this.connecting) await this.connecting;
    await this.cache.del(...keys);
  }
  async refreshProductReviews(organizationId: string, productId: string) {
    // Review writes have already succeeded. Cache failure must not make the
    // customer retry and submit a duplicate; public entries also expire.
    try {
      const result = await this.database.pool.query<{ slug: string }>(
        `UPDATE products SET updated_at=now()
         WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING slug`,
        [organizationId, productId]
      );
      const slug = result.rows[0]?.slug;
      if (!slug) return;
      try {
        await this.invalidateKeys([
          ...['slug', 'slug:public-v2', 'slug:public-v3'].map(key => `catalog:${key}:${organizationId}:${slug}`),
          `catalog:sitemap:v8:${organizationId}`,
        ]);
      } catch (error) {
        this.logger.warn({ err: error, productId }, 'Review cache refresh deferred to cache expiry');
      }
      this.realtime.publish({ organizationId, event: 'product.updated', payload: { productId, slug } });
    } catch (error) {
      this.logger.warn({ err: error, productId }, 'Review saved; product refresh deferred to cache expiry');
    }
  }
  private async tick() {
    try {
      if (apiUnderLoad()) return;
      await new TransactionManager(this.database.pool, this.logger).run(async (client) => {
        await client.query(`SET LOCAL statement_timeout = '10s'`);
        const row = (
          await client.query<{
            id: string;
            organization_id: string;
            product_id: string;
            context: RequestContext;
            slugs: string[];
            cache_keys: string[];
            attempts: number;
          }>(
            `SELECT * FROM catalog_deliveries WHERE completed_at IS NULL AND available_at <= now()
           ORDER BY available_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`
          )
        ).rows[0];
        if (!row) return;
        await client.query('SAVEPOINT delivery');
        try {
          const variants = await client.query<{ id: string }>(
            `SELECT id FROM product_variants
            WHERE organization_id=$1 AND product_id=$2 AND deleted_at IS NULL
              AND EXISTS (SELECT 1 FROM products p WHERE p.organization_id=$1 AND p.id=$2 AND p.deleted_at IS NULL)
            ORDER BY id`,
            [row.organization_id, row.product_id]
          );
          const projector = new OperationalSyncProjector(client);
          for (const variant of variants.rows)
            await projector.publishProductChange(row.context, row.product_id, variant.id);
          await new OutboxRepository(client).append({
            ctx: row.context,
            eventType: 'ProductUpdated',
            aggregateType: 'product',
            aggregateId: row.product_id,
            payload: { productId: row.product_id }
          });
          const prefix = row.organization_id;
          await this.invalidateKeys([
            ...row.cache_keys,
            ...[
              'sitemap',
              'sitemap:v2',
              'sitemap:v3',
              'sitemap:v4',
              'sitemap:v5',
              'sitemap:v6',
              'sitemap:v7',
              'sitemap:v8',
              'merchant-feed',
              'merchant-feed:v2',
              'merchant-feed:v3'
            ].map((k) => `catalog:${k}:${prefix}`),
            ...row.slugs.flatMap((slug) =>
              ['slug', 'slug:public-v2', 'slug:public-v3'].map(
                (k) => `catalog:${k}:${prefix}:${slug}`
              )
            )
          ]);
          invalidateCatalogSearch(prefix);
          await client.query(
            'UPDATE catalog_deliveries SET completed_at=now(), last_error_code=NULL WHERE id=$1',
            [row.id]
          );
          // Notifications may be repeated after a crash; clients reload canonical state.
          for (const slug of row.slugs)
            this.realtime.publish({
              organizationId: prefix,
              event: 'product.updated',
              payload: { productId: row.product_id, slug }
            });
        } catch {
          await client.query('ROLLBACK TO SAVEPOINT delivery');
          await client.query(
            `UPDATE catalog_deliveries SET attempts=attempts+1, last_error_code='DELIVERY_RETRY',
            available_at=now()+($2 * interval '1 second') WHERE id=$1`,
            [row.id, Math.min(300, 2 ** Math.min(row.attempts + 1, 8))]
          );
        }
      });
    } catch (error) {
      this.logger.warn({ err: error }, 'Catalog delivery will retry');
    } finally {
      this.schedule();
    }
  }
}
