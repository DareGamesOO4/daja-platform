import { Redis } from 'ioredis';
import type { AppConfig } from '@daja/config';
import type { Logger } from '@daja/observability';

export interface RedisConnection {
  client: Redis;
  ping(): Promise<string>;
  close(): Promise<void>;
}

export function createRedisConnection(config: AppConfig, logger: Logger): RedisConnection {
  const client = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableReadyCheck: true
  });

  client.on('error', (error: Error) => {
    logger.error({ err: error }, 'Redis connection error');
  });

  client.on('close', () => {
    logger.warn('Redis connection closed');
  });

  return {
    client,
    ping: async () => {
      if (client.status === 'wait') {
        await client.connect();
      }
      return client.ping();
    },
    close: async () => {
      await client.quit();
    }
  };
}
