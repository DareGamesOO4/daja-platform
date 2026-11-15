import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { AppConfig } from '@daja/config';
import { databaseConnectionOptions, type Database } from '@daja/database';
import type { Logger } from '@daja/observability';
import pg from 'pg';
import { invalidateCatalogPages, prepareNewestBrandPages, publicCatalogPage } from './catalog-page.js';
import { publicListingParams } from './catalog-page-params.js';
import { apiUnderLoad } from './runtime/abuse-protection.js';
import { CONFIG, DATABASE, LOGGER } from './tokens.js';

const REFRESH_INTERVAL = 5 * 60_000;
const CHANGE_DELAY = 500;
const CHANNEL = 'public_catalog_changed';
type Query = Parameters<typeof publicCatalogPage>[2];
type BrandPages = Awaited<ReturnType<typeof prepareNewestBrandPages>>;

@Injectable()
export class PublicBrandCacheService implements OnModuleInit, OnModuleDestroy {
  private listener: pg.Client | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private warming: AbortController | undefined;
  private cache: BrandPages | undefined;
  private listening = false;
  private stopped = false;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(LOGGER) private readonly logger: Logger
  ) {}

  onModuleInit() {
    if (this.config.PUBLIC_ORGANIZATION_ID) void this.listen();
  }

  async onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.refreshTimer);
    this.warming?.abort();
    await this.listener?.end().catch(() => {});
  }

  get(organizationId: string, input: Query) {
    const cache = this.cache;
    if (!cache || cache.expiresAt <= Date.now() || organizationId !== this.config.PUBLIC_ORGANIZATION_ID ||
        input.department !== 'satovi' || input.prepareOnly === '1' || input.fixedGender ||
        input.page > 2 || !input.pathname) return undefined;

    const pathname = input.pathname.replace(/\/$/, '');
    let pages: ReturnType<BrandPages['pages']['get']>;
    if (pathname.startsWith('/brend/') && (input.params === '' || input.params === 'sort=newest')) {
      pages = cache.pages.get(pathname);
    } else if (pathname === '/catalog') {
      // Home banners and older links can still select a brand using a query parameter.
      const raw = new URLSearchParams(input.params);
      if ([...raw.keys()].some(key => key !== 'brand' && key !== 'brend' && key !== 'sort') ||
          [ ...raw.getAll('brand'), ...raw.getAll('brend') ].length !== 1 ||
          (raw.has('sort') && raw.get('sort') !== 'newest')) return undefined;
      raw.delete('sort');
      const canonical = publicListingParams(raw, cache.configuration, pathname);
      canonical.sort();
      pages = cache.byFilter.get(canonical.toString());
    }
    const page = pages?.get(input.page);
    if (!page) return undefined;
    return {
      ...page,
      pathname: input.pathname,
      ...(input.configurationVersion === page.configurationVersion ? {} : { configuration: cache.configuration })
    };
  }

  private async listen() {
    if (this.stopped) return;
    const client = new pg.Client({
      ...databaseConnectionOptions(this.config.DATABASE_URL),
      application_name: 'daja-public-catalog-listener',
      connectionTimeoutMillis: 5000,
      keepAlive: true
    });
    this.listener = client;
    const reconnect = (error?: Error) => {
      if (this.stopped || this.listener !== client) return;
      this.listener = undefined;
      this.listening = false;
      this.invalidate();
      if (error) this.logger.warn({ err: error }, 'Public catalog cache listener disconnected');
      void client.end().catch(() => {});
      this.reconnectTimer = setTimeout(() => { void this.listen(); }, 5000).unref();
    };
    client.on('error', reconnect);
    client.on('end', reconnect);
    client.on('notification', message => {
      if (message.channel === CHANNEL && message.payload === this.config.PUBLIC_ORGANIZATION_ID) this.invalidate();
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      if (this.stopped || this.listener !== client) return;
      this.listening = true;
      this.invalidate();
    } catch (error) {
      reconnect(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private invalidate() {
    if (this.config.PUBLIC_ORGANIZATION_ID) invalidateCatalogPages(this.config.PUBLIC_ORGANIZATION_ID);
    this.cache = undefined;
    this.warming?.abort();
    this.schedule(CHANGE_DELAY);
  }

  private schedule(delay: number) {
    clearTimeout(this.refreshTimer);
    if (this.listening && !this.stopped) {
      this.refreshTimer = setTimeout(() => { void this.refresh(); }, delay).unref();
    }
  }

  private async refresh() {
    const organizationId = this.config.PUBLIC_ORGANIZATION_ID;
    if (!organizationId || !this.listening || this.stopped) return;
    if (this.warming || apiUnderLoad()) {
      this.schedule(1000);
      return;
    }
    const controller = new AbortController();
    this.warming = controller;
    try {
      const upcoming = await this.database.pool.query<{ starts_at: Date | null }>(`
        SELECT MIN(valid_from) AS starts_at FROM variant_prices
        WHERE organization_id = $1 AND price_type = 'sale'
          AND cancelled_at IS NULL AND valid_from > now()
      `, [organizationId]);
      const startsAt = upcoming.rows[0]?.starts_at?.getTime() ?? Infinity;
      controller.signal.throwIfAborted();
      const cache = await prepareNewestBrandPages(this.database.pool, organizationId, controller.signal);
      controller.signal.throwIfAborted();
      const saleBoundary = Math.min(startsAt, cache.expiresAt);
      const now = Date.now();
      if (saleBoundary > now) {
        this.cache = { ...cache, expiresAt: Math.min(saleBoundary, now + REFRESH_INTERVAL + 60_000) };
      }
      this.schedule(Math.min(REFRESH_INTERVAL, Math.max(0, saleBoundary - now)));
    } catch (error) {
      if (!controller.signal.aborted) {
        this.logger.warn({ err: error }, 'Public brand catalog cache refresh failed');
        this.schedule(5000);
      }
    } finally {
      this.warming = undefined;
    }
  }
}
