import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type { AppConfig } from '@daja/config';
import { AppError } from '@daja/security';

const context = new AsyncLocalStorage<AbortSignal>();
const waiting: Array<() => void> = [];
let active = false;
let connection: Redis | undefined;
const LOCK = 'daja:media-processing:v1';
const LEASE_MS = 300_000;
const releaseScript =
  "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";
const renewScript =
  "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('pexpire',KEYS[1],ARGV[2]) else return 0 end";

function busy() {
  return new AppError('IMAGE_PROCESSING_BUSY', 'Image processing is busy. Retry shortly.', 503, {
    retryAfterSeconds: 3
  });
}

export function mediaProcessingActive(): boolean {
  return active;
}
export function mediaProcessingSignal(): AbortSignal | undefined {
  return context.getStore();
}

/** Queue callbacks, not image buffers. Never call this while holding a DB transaction. */
export async function runMediaProcessing<T>(
  config: AppConfig,
  operation: () => Promise<T>,
  options: { background?: boolean; stopAt?: number } = {}
): Promise<T> {
  const parent = context.getStore();
  if (parent) {
    parent.throwIfAborted();
    return operation();
  }
  const deadline = Date.now() + 20_000;
  if (active) {
    if (options.background) throw busy();
    if (waiting.length >= 4) throw busy();
    await new Promise<void>((resolve, reject) => {
      const resume = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = waiting.indexOf(resume);
        if (index >= 0) waiting.splice(index, 1);
        reject(busy());
      }, 20_000);
      waiting.push(resume);
    });
  } else active = true;
  const token = randomUUID();
  const controller = new AbortController();
  let owned = false;
  let renewal: ReturnType<typeof setInterval> | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let renewing = false;
  try {
    connection ??= new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 0,
      commandTimeout: 1500,
      connectTimeout: 1500,
      enableOfflineQueue: false,
      lazyConnect: true,
      retryStrategy: () => 1000
    });
    // This dedicated connection fails closed; it never logs URLs or credentials.
    if (connection.listenerCount('error') === 0) connection.on('error', () => {});
    if (connection.status === 'wait' || connection.status === 'end') await connection.connect();
    while (Date.now() < deadline) {
      if ((await connection.set(LOCK, token, 'PX', LEASE_MS, 'NX')) === 'OK') {
        owned = true;
        break;
      }
      if (options.background) throw busy();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!owned) throw busy();
    if (options.stopAt !== undefined) {
      if (options.stopAt <= Date.now()) throw busy();
      stopTimer = setTimeout(() => controller.abort(busy()), options.stopAt - Date.now());
      stopTimer.unref();
    }
    renewal = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void connection!
        .eval(renewScript, 1, LOCK, token, String(LEASE_MS))
        .then((result) => {
          if (result !== 1) controller.abort(busy());
        })
        .catch(() => controller.abort(busy()))
        .finally(() => {
          renewing = false;
        });
    }, 10_000);
    renewal.unref();
    return await context.run(controller.signal, operation);
  } catch (error) {
    if (!owned && !(error instanceof AppError)) throw busy();
    throw error;
  } finally {
    if (renewal) clearInterval(renewal);
    if (stopTimer) clearTimeout(stopTimer);
    // SET may have succeeded even if its reply timed out. Compare the token
    // before deleting so this cannot release another process's lease.
    await connection?.eval(releaseScript, 1, LOCK, token).catch(() => undefined);
    const next = waiting.shift();
    if (next) next();
    else {
      active = false;
      connection?.disconnect();
    }
  }
}
