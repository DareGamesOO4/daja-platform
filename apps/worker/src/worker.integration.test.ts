import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@daja/config';
import { createRedisConnection } from '@daja/database';
import { createLogger } from '@daja/observability';
import { createFoundationWorker } from './worker.js';

describe('foundation worker', () => {
  const config = loadConfig();
  const logger = createLogger(config, 'worker-test');
  const redis = createRedisConnection(config, logger);

  afterAll(async () => {
    await redis.close();
  });

  it('starts against real Redis and shuts down cleanly', async () => {
    await redis.ping();
    const runtime = createFoundationWorker(redis.client, logger, {
      queueName: `daja-foundation-test-${Date.now()}`,
      concurrency: 1
    });

    await runtime.worker.waitUntilReady();
    await runtime.queueEvents.waitUntilReady();
    expect(runtime.worker.isRunning()).toBe(true);
    await runtime.close();
    expect(runtime.worker.isRunning()).toBe(false);
  });
});
