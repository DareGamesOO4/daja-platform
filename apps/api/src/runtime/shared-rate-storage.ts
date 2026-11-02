import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { AppConfig } from '@daja/config';
import { AppError, ERROR_CODES } from '@daja/security';

/** Atomic counters use Redis time and expiry, shared by all API processes. */
export class SharedRateStorage implements ThrottlerStorage {
  private readonly client: Redis;
  private connecting: Promise<void> | undefined;

  constructor(config: AppConfig) {
    this.client = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1500,
      commandTimeout: 1500,
      retryStrategy: () => null
    });
    this.client.on('error', () => {});
  }

  onModuleDestroy() {
    this.client.disconnect();
  }

  private async eval(script: string, key: string, ...args: number[]): Promise<number[]> {
    try {
      if (this.client.status === 'wait' || this.client.status === 'end') {
        this.connecting ??= this.client.connect().finally(() => {
          this.connecting = undefined;
        });
      }
      if (this.connecting) await this.connecting;
      const hashed = createHash('sha256').update(key).digest('hex');
      const result = await this.client.eval(script, 1, `api:rate:v2:${hashed}`, ...args);
      if (
        !Array.isArray(result) ||
        !result.every((n) => typeof n === 'number' && Number.isFinite(n))
      ) {
        throw new Error('Invalid rate counter');
      }
      return result as number[];
    } catch {
      throw new AppError(ERROR_CODES.unavailable, 'Service temporarily unavailable', 503);
    }
  }

  async window(key: string, limit: number, ttl: number) {
    const [hits = 0, remainingMs = ttl, allowed = 0] = await this.eval(
      `
      local hits = tonumber(redis.call('GET', KEYS[1]) or '0')
      if hits < tonumber(ARGV[1]) then
        hits = redis.call('INCR', KEYS[1])
        if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
        return {hits, redis.call('PTTL', KEYS[1]), 1}
      end
      return {hits, redis.call('PTTL', KEYS[1]), 0}
    `,
      key,
      limit,
      ttl
    );
    return {
      hits,
      allowed: allowed === 1,
      retryAfter: Math.max(1, Math.ceil(remainingMs / 1000)),
      remainingMs
    };
  }

  async increment(key: string, ttl: number, limit: number, _blockDuration: number, name: string) {
    const values = await this.eval(
      `
      local hits = redis.call('INCR', KEYS[1])
      if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
      return {hits, redis.call('PTTL', KEYS[1])}
    `,
      `${name}:${key}`,
      ttl
    );
    const totalHits = values[0]!;
    const seconds = Math.max(1, Math.ceil(values[1]! / 1000));
    return {
      totalHits,
      timeToExpire: seconds,
      isBlocked: totalHits > limit,
      timeToBlockExpire: totalHits > limit ? seconds : 0
    };
  }

  async tokenBucket(key: string, perMinute: number, capacity: number) {
    const values = await this.eval(
      `
      local clock = redis.call('TIME')
      local now = tonumber(clock[1]) * 1000 + tonumber(clock[2]) / 1000
      local state = redis.call('HMGET', KEYS[1], 'tokens', 'at')
      local rate = tonumber(ARGV[1]) / 60000
      local capacity = tonumber(ARGV[2])
      local tokens = math.min(capacity, tonumber(state[1] or capacity) + math.max(0, now - tonumber(state[2] or now)) * rate)
      local allowed = 0
      if tokens >= 1 then tokens = tokens - 1; allowed = 1 end
      redis.call('HSET', KEYS[1], 'tokens', tokens, 'at', now)
      redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / rate))
      return {allowed, math.floor(tokens), math.ceil(math.max(0, 1 - tokens) / rate), math.ceil((capacity - tokens) / rate)}
    `,
      `bucket:${key}`,
      perMinute,
      capacity
    );
    return {
      allowed: values[0] === 1,
      remaining: values[1]!,
      retryAfter: Math.max(1, Math.ceil(values[2]! / 1000)),
      resetSeconds: Math.ceil(values[3]! / 1000)
    };
  }
}
