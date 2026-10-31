import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Database, RedisConnection } from '@daja/database';
import { DATABASE, REDIS } from './tokens.js';

@Controller('health')
export class HealthController {
  private checkedAt = 0;
  private healthy = false;
  private checking = false;
  private pending: Promise<boolean> | undefined;
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(REDIS) private readonly redis: RedisConnection
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    if (Date.now() - this.checkedAt >= 2000) {
      this.pending ??= this.checkDependencies().then(healthy => {
        this.healthy = healthy;
        this.checkedAt = Date.now();
        return healthy;
      }).finally(() => { this.pending = undefined; });
      await this.pending;
    }
    if (!this.healthy) throw new ServiceUnavailableException('Service dependencies are not ready');
    return { status: 'ok', checks: { postgres: 'ok', redis: 'ok' } };
  }

  private async checkDependencies(): Promise<boolean> {
    // Do not queue more Redis commands if an earlier probe is still waiting
    // for a disconnected store. Concurrent probes share the bounded result.
    if (this.checking) return false;
    this.checking = true;
    const work = Promise.all([this.database.query('SELECT 1 AS ready'), this.redis.ping()])
      .then(() => true, () => false).finally(() => { this.checking = false; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), 2000);
      })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
