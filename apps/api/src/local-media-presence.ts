import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import type { AppConfig } from '@daja/config';
import { AppError } from '@daja/security';
import { CONFIG } from './tokens.js';

@Injectable()
export class LocalMediaPresence implements OnModuleDestroy {
  private readonly client: Redis;
  private connecting: Promise<void> | undefined;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.client = new Redis(config.REDIS_URL, {
      lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0,
      connectTimeout: 1_500, commandTimeout: 1_500, retryStrategy: () => null
    });
    this.client.on('error', () => {});
  }

  onModuleDestroy() { this.client.disconnect(); }

  private async ready(): Promise<Redis> {
    if (this.client.status === 'wait' || this.client.status === 'end') {
      if (!this.connecting) {
        const deadline = setTimeout(() => this.client.disconnect(), 1_500);
        this.connecting = this.client.connect().finally(() => {
          clearTimeout(deadline);
          this.connecting = undefined;
        });
      }
    }
    await this.connecting;
    return this.client;
  }

  async announce(organizationId: string): Promise<void> {
    try {
      await (await this.ready()).set(this.key(organizationId), '1', 'EX', 20);
    } catch {
      throw new AppError('IMAGE_WORKER_UNAVAILABLE', 'Image queue is temporarily unavailable', 503);
    }
  }

  async isOnline(organizationId: string): Promise<boolean> {
    try {
      return Boolean(await (await this.ready()).get(this.key(organizationId)));
    } catch {
      // During a Redis outage, avoid starting a competing fallback.
      return true;
    }
  }

  private key(organizationId: string) { return 'daja:media:local-worker:' + organizationId; }
}
