import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const MAX_BYTES = 25 * 1024 * 1024;
const VARIANTS = ['avif', 'webp', 'avifThumb', 'webpThumb'] as const;
const configSchema = z.object({
  apiBaseUrl: z.url(),
  token: z.string().min(32).regex(/^[A-Za-z0-9._~-]+$/)
});
const claimSchema = z.object({
  id: z.uuid(),
  leaseToken: z.uuid(),
  expiresAt: z.iso.datetime(),
  source: z.object({ url: z.url(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  uploads: z.object({ avif: z.url(), webp: z.url(), avifThumb: z.url(), webpThumb: z.url() })
});
type Config = z.infer<typeof configSchema>;
type Claim = z.infer<typeof claimSchema>;

function checksum(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readImage(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const buffers: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of chunks) {
    length += chunk.byteLength;
    if (length > MAX_BYTES) throw new Error('Slika je veća od 25 MiB.');
    buffers.push(chunk);
  }
  return Buffer.concat(buffers, length);
}

async function encodeInChild(source: Buffer, quality: number) {
  const { prepareProductVariants } = await import('../packages/database/src/image-encoder-core.js');
  const { avif, webp } = await prepareProductVariants(source, quality);
  return {
    avif: { ...avif.original, mime: avif.mimeType, filename: 'slika.avif' },
    webp: { ...webp.original, mime: webp.mimeType, filename: 'slika.webp' },
    avifThumb: { ...avif.thumbnail, mime: avif.mimeType, filename: 'slika-thumb.avif' },
    webpThumb: { ...webp.thumbnail, mime: webp.mimeType, filename: 'slika-thumb.webp' }
  };
}

type Encoded = Awaited<ReturnType<typeof encodeInChild>>;

function encode(source: Buffer, quality = 95, jobSignal?: AbortSignal): Promise<Encoded> {
  const deadline = AbortSignal.timeout(90_000);
  const signal = jobSignal ? AbortSignal.any([jobSignal, deadline]) : deadline;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), ['encode-child'], {
      execArgv: [], serialization: 'advanced', windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    let settled = false;
    function finish(error?: Error, result?: Encoded) {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      child.kill();
      if (result) resolve(result);
      else reject(error ?? new Error('Enkoder nije napravio rezultat.'));
    }
    const abort = () => finish(new Error('Isteklo je vreme za lokalno kodiranje.'));
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', error => finish(error));
    child.once('exit', () => finish(new Error('Proces za lokalno kodiranje je prekinut.')));
    child.once('message', (message: { result?: Encoded }) => finish(undefined, message.result));
    child.send({ source, quality }, error => { if (error) finish(error); });
  });
}

function runEncoderChild() {
  process.once('disconnect', () => process.exit(0));
  process.once('message', (message: { source: Buffer; quality: number }) => {
    void encodeInChild(message.source, message.quality).then(
      result => process.send?.({ result }),
      () => process.send?.({})
    );
  });
}

class HttpFailure extends Error {
  constructor(service: string, readonly status: number) {
    super(service + ' je vratio HTTP ' + status + '.');
  }
}

async function retryTransfer<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof HttpFailure && error.status < 500 && error.status !== 429) throw error;
    await delay(1_000, undefined, { signal });
    return operation();
  }
}

function r2Url(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' || url.username || url.password || url.port ||
    !url.hostname.endsWith('.r2.cloudflarestorage.com') ||
    !url.searchParams.has('X-Amz-Signature')
  ) {
    throw new Error('Server nije poslao potpisan R2 link.');
  }
  return url;
}

async function api(config: Config, route: string, payload: unknown, signal: AbortSignal) {
  const response = await fetch(config.apiBaseUrl + '/media/local-worker/' + route, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(route === 'complete' ? 65_000 : 15_000)])
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpFailure('DAJA API', response.status);
  }
  return response;
}

async function requireR2Success(response: Response): Promise<void> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpFailure('R2', response.status);
  }
}

async function handleClaim(config: Config, claim: Claim, shutdown: AbortSignal) {
  const remaining = Date.parse(claim.expiresAt) - Date.now() - 3_000;
  if (remaining <= 0) throw new Error('Rezervacija posla je istekla.');
  const leaseSignal = AbortSignal.any([shutdown, AbortSignal.timeout(Math.min(remaining, 300_000))]);
  const signal = AbortSignal.any([leaseSignal, AbortSignal.timeout(220_000)]);
  const source = await fetch(r2Url(claim.source.url), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]), redirect: 'error'
  });
  await requireR2Success(source);
  if (!source.body) throw new Error('Izvorna slika je prazna.');
  const bytes = await readImage(source.body);
  if (checksum(bytes) !== claim.source.sha256) throw new Error('Kontrolni zbir originala se ne poklapa.');

  const outputs = await encode(bytes, 95, signal);
  const files = [];
  for (const variant of VARIANTS) {
    signal.throwIfAborted();
    const image = outputs[variant];
    const url = r2Url(claim.uploads[variant]);
    await retryTransfer(async () => {
      const response = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(image.data),
        headers: {
          'content-type': image.mime,
          'cache-control': 'public, max-age=31536000, immutable',
          'if-none-match': '*'
        },
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)])
      });
      // A prior PUT may have succeeded even if its response was lost.
      if (response.status !== 412) await requireR2Success(response);
      await response.body?.cancel();
    }, signal);
    files.push({
      variant,
      width: image.width,
      height: image.height,
      bytes: image.data.length,
      sha256: checksum(image.data)
    });
  }
  const response = await retryTransfer(() =>
    api(config, 'complete', { id: claim.id, leaseToken: claim.leaseToken, files }, leaseSignal), leaseSignal);
  await response.body?.cancel();
}

async function work(configPath: string, statusPath?: string) {
  const config = configSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
  const endpoint = new URL(config.apiBaseUrl);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('DAJA API mora da koristi HTTPS adresu.');
  }
  config.apiBaseUrl = endpoint.href.replace(/\/+$/, '');

  const shutdown = new AbortController();
  process.once('SIGINT', () => shutdown.abort());
  process.once('SIGTERM', () => shutdown.abort());
  const status = { phase: 'connecting', job: '', completed: '', error: '' };
  let pendingWrite = false;
  async function publishStatus() {
    if (!statusPath || pendingWrite) return;
    pendingWrite = true;
    try {
      await writeFile(statusPath + '.tmp', JSON.stringify({ ...status, updated: new Date().toISOString() }));
      await rename(statusPath + '.tmp', statusPath);
    } catch {
      // A temporarily unavailable status file must not interrupt a leased job.
    } finally {
      pendingWrite = false;
    }
  }
  await publishStatus();
  const heartbeat = setInterval(() => void publishStatus(), 3_000);
  heartbeat.unref();
  console.log('DAJA worker čeka posao.');
  while (!shutdown.signal.aborted) {
    let pause = 3_000;
    try {
      const response = await api(config, 'claim', { profile: 'avif95-v1' }, shutdown.signal);
      if (response.status !== 204) {
        const claim = claimSchema.parse(await response.json());
        Object.assign(status, { phase: 'working', job: claim.id, error: '' });
        await publishStatus();
        await handleClaim(config, claim, shutdown.signal);
        status.completed = new Date().toISOString();
        console.log('Obrađene su četiri verzije slike.');
        pause = 0;
      }
      Object.assign(status, { phase: 'ready', job: '', error: '' });
    } catch (error) {
      if (shutdown.signal.aborted) return;
      const reason = error instanceof Error && /^(DAJA API|R2) je vratio HTTP \d+\.$/.test(error.message)
        ? error.message
        : 'Posao ili veza nisu dostupni.';
      console.error(reason + ' Novi pokušaj za 15 sekundi.');
      Object.assign(status, { phase: 'error', job: '', error: reason });
      pause = 15_000;
    }
    await publishStatus();
    await delay(pause, undefined, { signal: shutdown.signal }).catch(() => {});
  }
}

async function local(inputPath: string, outputDirectory: string, quality: number) {
  const outputs = await encode(await readImage(createReadStream(inputPath)), quality);
  const target = resolve(outputDirectory);
  const stage = await mkdtemp(target + '.tmp-');
  try {
    for (const variant of VARIANTS) {
      const { filename, data } = outputs[variant];
      await writeFile(join(stage, filename), data, { flag: 'wx' });
    }
    await rename(stage, target);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  for (const variant of VARIANTS) {
    const { filename, data, width, height } = outputs[variant];
    console.log(filename + ' | ' + width + ' × ' + height + ' px | ' + data.length + ' B');
  }
}

const [mode, first, second, quality] = process.argv.slice(2);
try {
  if (mode === 'encode-child') runEncoderChild();
  else if (mode === 'local' && first && second) {
    await local(first, second, z.number().int().min(1).max(100).parse(quality === undefined ? 95 : Number(quality)));
  } else if (mode === 'run' && first) await work(first, second);
  else throw new Error('Upotreba: worker.mjs local <original> <novi-folder> | worker.mjs run <config.json>');
} catch (error) {
  console.error(mode === 'run' ? 'Worker nije pokrenut. Proveri konfiguraciju.' : error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
