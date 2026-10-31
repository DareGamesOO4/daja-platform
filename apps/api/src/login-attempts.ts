import { Redis } from 'ioredis';
import type { AppConfig } from '@daja/config';
import { AppError, ERROR_CODES, sha256Hex } from '@daja/security';

let client: Redis | undefined;
let connecting: Promise<void> | undefined;

/** One shared account budget across IP addresses and API instances. */
export async function consumeLoginAttempt(config: AppConfig, account: string): Promise<void> {
  client ??= new Redis(config.REDIS_URL, {
    lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1,
    connectTimeout: 2000, commandTimeout: 2000, retryStrategy: () => null
  });
  // Errors become a safe 503 below; never log connection strings or identities.
  if (client.listenerCount('error') === 0) client.on('error', () => {});
  let hits: number;
  try {
    if (client.status === 'wait' || client.status === 'end') {
      connecting ??= client.connect().finally(() => { connecting = undefined; });
    }
    if (connecting) await connecting;
    hits = Number(await client.eval(`
      local hits = redis.call('INCR', KEYS[1])
      if hits == 1 then redis.call('EXPIRE', KEYS[1], 900) end
      return hits
    `, 1, `auth:login-budget:${sha256Hex(account)}`));
    if (!Number.isSafeInteger(hits) || hits < 1) throw new Error('Invalid counter');
  } catch {
    // Never disable brute-force protection when its shared store is unavailable.
    throw new AppError(ERROR_CODES.unavailable, 'Service temporarily unavailable', 503);
  }
  if (hits > 20) throw new AppError('RATE_LIMITED', 'Too many login attempts. Try again later.', 429);
}
