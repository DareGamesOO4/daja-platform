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
          ...['slug', 'slug:public-v2', 'slug:public-v3', 'slug:public-v4'].map(
            (key) => `catalog:${key}:${organizationId}:${slug}`
          ),
          `catalog:sitemap:v8:${organizationId}`,
          `catalog:sitemap:v9:${organizationId}`,
          `catalog:sitemap:v10:${organizationId}`,
          `catalog:sitemap:v11:${organizationId}`
        ]);
      } catch (error) {
        this.logger.warn(
          { err: error, productId },
          'Review cache refresh deferred to cache expiry'
        );
      }
      this.realtime.publish({
        organizationId,
        event: 'product.updated',
        payload: { productId, slug }
      });
    } catch (error) {
      this.logger.warn(
        { err: error, productId },
        'Review saved; product refresh deferred to cache expiry'
      );
    }
  }
  private async tick() {
    try {
      if (apiUnderLoad()) return;
      const delivered = await new TransactionManager(this.database.pool, this.logger).run(
        async (client) => {
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
              projected_at: Date | null;
            }>(
              `SELECT * FROM catalog_deliveries WHERE completed_at IS NULL AND available_at <= now()
           ORDER BY available_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`
            )
          ).rows[0];
          if (!row) return;
          if (row.projected_at) return row;
          await client.query('SAVEPOINT projection');
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
            await client.query('UPDATE catalog_deliveries SET projected_at=now() WHERE id=$1', [
              row.id
            ]);
            return row;
          } catch (error) {
            await client.query('ROLLBACK TO SAVEPOINT projection');
            await client.query(
              `UPDATE catalog_deliveries SET attempts=attempts+1, last_error_code='DELIVERY_RETRY',
             available_at=now()+($2 * interval '1 second') WHERE id=$1`,
              [row.id, Math.min(300, 2 ** Math.min(row.attempts + 1, 8))]
            );
            this.logger.warn({ err: error }, 'Catalog projection will retry');
            return undefined;
          }
        }
      );
      if (!delivered) return;
      try {
        const prefix = delivered.organization_id;
        await this.invalidateKeys([
          ...delivered.cache_keys,
          ...[
            'sitemap',
            'sitemap:v2',
            'sitemap:v3',
            'sitemap:v4',
            'sitemap:v5',
            'sitemap:v6',
            'sitemap:v7',
            'sitemap:v8',
            'sitemap:v9',
            'sitemap:v10',
            'sitemap:v11',
            'merchant-feed',
            'merchant-feed:v2',
            'merchant-feed:v3'
          ].map((k) => `catalog:${k}:${prefix}`),
          ...delivered.slugs.flatMap((slug) =>
            ['slug', 'slug:public-v2', 'slug:public-v3', 'slug:public-v4'].map(
              (k) => `catalog:${k}:${prefix}:${slug}`
            )
          )
        ]);
        invalidateCatalogSearch(prefix);
        await this.database.pool.query(
          'UPDATE catalog_deliveries SET completed_at=now(), last_error_code=NULL WHERE id=$1 AND completed_at IS NULL',
          [delivered.id]
        );
        // Cache/network calls run after COMMIT; no DB connection waits on Redis.
        // A crash can repeat invalidation/notifications, but not the persisted projection.
        for (const slug of delivered.slugs)
          this.realtime.publish({
            organizationId: prefix,
            event: 'product.updated',
            payload: { productId: delivered.product_id, slug }
          });
      } catch (error) {
        await this.database.pool.query(
          `UPDATE catalog_deliveries SET attempts=attempts+1, last_error_code='DELIVERY_RETRY',
             available_at=now()+($2 * interval '1 second') WHERE id=$1 AND completed_at IS NULL`,
          [delivered.id, Math.min(300, 2 ** Math.min(delivered.attempts + 1, 8))]
        );
        this.logger.warn({ err: error }, 'Catalog cache delivery will retry');
      }
    } catch (error) {
      this.logger.warn({ err: error }, 'Catalog delivery will retry');
    } finally {
      this.schedule();
    }
  }
}
