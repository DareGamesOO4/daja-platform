import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Database, RedisConnection } from '@daja/database';
import { DATABASE, REDIS } from './tokens.js';

@Controller('health')
export class HealthController {
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
    try {
      await this.database.query('SELECT 1 AS ready');
      await this.redis.ping();
      return { status: 'ok', checks: { postgres: 'ok', redis: 'ok' } };
    } catch {
      throw new ServiceUnavailableException('Service dependencies are not ready');
    }
  }
}
