import { fork } from 'node:child_process';
import { setPriority, constants } from 'node:os';
import { AppError, ValidationFailedError } from '@daja/security';
import { mediaProcessingSignal } from './media-processing.js';
import type { ImageOutputOptions } from './image-encoder-core.js';
export type { ImageOutputOptions } from './image-encoder-core.js';

type ImageVariants = Awaited<
  ReturnType<typeof import('./image-encoder-core.js').prepareImageVariants>
>;
type ProductVariants = { webp: ImageVariants; avif: ImageVariants };
let active = false;
const waiting: Array<() => void> = [];

async function isolatedEncode<T>(
  source: Buffer,
  product: boolean | 'avif-main' | 'remaining',
  options?: ImageOutputOptions
): Promise<T> {
  if (!source.length || source.length > 25 * 1024 * 1024)
    throw new ValidationFailedError('Image must be 25 MiB or smaller');
  if (active) {
    if (waiting.length >= 2) throw busy();
    await new Promise<void>((resolve, reject) => {
      const resume = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = waiting.indexOf(resume);
        if (index >= 0) waiting.splice(index, 1);
        reject(busy());
      }, 15_000);
      waiting.push(resume);
    });
  } else active = true;
  try {
    const signal = mediaProcessingSignal();
    signal?.throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
      // A native codec crash/abort or JS heap failure terminates only this child.
      const child = fork(new URL('./image-encoder.js', import.meta.url), [], {
        serialization: 'advanced',
        execArgv: ['--max-old-space-size=128'],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: {
          ...Object.fromEntries(
            ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR'].flatMap((key) =>
              process.env[key] ? [[key, process.env[key]!]] : []
            )
          ),
          UV_THREADPOOL_SIZE: '1',
          OMP_NUM_THREADS: '1'
        }
      });
      // Render's 0.5-CPU API must retain headroom for requests and DB callbacks.
      // Linux duty cycle: at most 40 ms runnable per 200 ms (not a cgroup quota).
      let pause: ReturnType<typeof setTimeout> | undefined;
      let cycle: ReturnType<typeof setInterval> | undefined;
      if (process.platform === 'linux') {
        try {
          if (child.pid) setPriority(child.pid, constants.priority.PRIORITY_LOW);
        } catch {
          /* sandbox may deny nice */
        }
        const runSlice = () => {
          child.kill('SIGCONT');
          pause = setTimeout(() => child.kill('SIGSTOP'), 40);
        };
        runSlice();
        cycle = setInterval(runSlice, 200);
      }
      let settled = false;
      const abort = () =>
        finish(
          new AppError(
            'IMAGE_PROCESSING_BUSY',
            'Image processing lease was lost. Please retry.',
            503
          )
        );
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (pause) clearTimeout(pause);
        if (cycle) clearInterval(cycle);
        signal?.removeEventListener('abort', abort);
        child.kill('SIGKILL');
        if (error) reject(error);
        else resolve(value!);
      };
      const timer = setTimeout(
        () =>
          finish(
            new AppError(
              'IMAGE_PROCESSING_TIMEOUT',
              'Image processing timed out. Try a smaller image.',
              503
            )
          ),
        45_000
      );
      signal?.addEventListener('abort', abort, { once: true });
      child.once('error', () =>
        finish(
          new AppError(
            'IMAGE_PROCESSING_FAILED',
            'Image processing is temporarily unavailable',
            503
          )
        )
      );
      child.once('exit', () =>
        finish(
          new AppError('IMAGE_PROCESSING_FAILED', 'Image processor stopped. Please retry.', 503)
        )
      );
      child.once('message', (message: { ok?: boolean; result?: T }) => {
        if (message.ok && message.result) finish(undefined, message.result);
        else
          finish(
            new ValidationFailedError(
              'Unsupported, damaged or oversized image (maximum 24 megapixels, 12000 px per side; no animation)'
            )
          );
      });
      child.send({ source, product, options }, (error) => {
        if (error) finish(error);
      });
    });
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active = false;
  }
}
function busy() {
  return new AppError('IMAGE_PROCESSING_BUSY', 'Image processing is busy. Retry shortly.', 503, {
    retryAfterSeconds: 3
  });
}
export function prepareImageVariants(
  source: Buffer,
  options: ImageOutputOptions = {}
): Promise<ImageVariants> {
  return isolatedEncode(source, false, options);
}
export function prepareProductImageVariants(source: Buffer): Promise<ProductVariants> {
  return isolatedEncode(source, true);
}

export function prepareAvifMainImage(
  source: Buffer
): Promise<Awaited<ReturnType<typeof import('./image-encoder-core.js').prepareAvifMain>>> {
  return isolatedEncode(source, 'avif-main');
}
export function prepareRemainingImageVariants(
  source: Buffer
): Promise<Awaited<ReturnType<typeof import('./image-encoder-core.js').prepareRemainingVariants>>> {
  return isolatedEncode(source, 'remaining');
}
