import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { prepareProductVariants } from '../packages/database/src/image-encoder-core.js';

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

async function encode(source: Buffer, quality = 95) {
  const { avif, webp } = await prepareProductVariants(source, quality);
  return {
    avif: { ...avif.original, mime: avif.mimeType, filename: 'slika.avif' },
    webp: { ...webp.original, mime: webp.mimeType, filename: 'slika.webp' },
    avifThumb: { ...avif.thumbnail, mime: avif.mimeType, filename: 'slika-thumb.avif' },
    webpThumb: { ...webp.thumbnail, mime: webp.mimeType, filename: 'slika-thumb.webp' }
  };
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
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('DAJA API je vratio HTTP ' + response.status + '.');
  }
  return response;
}

async function requireR2Success(response: Response): Promise<void> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('R2 je vratio HTTP ' + response.status + '.');
  }
}

async function handleClaim(config: Config, claim: Claim, shutdown: AbortSignal) {
  const remaining = Date.parse(claim.expiresAt) - Date.now() - 3_000;
  if (remaining <= 0) throw new Error('Rezervacija posla je istekla.');
  const signal = AbortSignal.any([shutdown, AbortSignal.timeout(Math.min(remaining, 300_000))]);
  const source = await fetch(r2Url(claim.source.url), { signal, redirect: 'error' });
  await requireR2Success(source);
  if (!source.body) throw new Error('Izvorna slika je prazna.');
  const bytes = await readImage(source.body);
  if (checksum(bytes) !== claim.source.sha256) throw new Error('Kontrolni zbir originala se ne poklapa.');

  const outputs = await encode(bytes);
  const files = [];
  for (const variant of VARIANTS) {
    signal.throwIfAborted();
    const image = outputs[variant];
    const response = await fetch(r2Url(claim.uploads[variant]), {
      method: 'PUT',
      body: new Uint8Array(image.data),
      headers: {
        'content-type': image.mime,
        'cache-control': 'public, max-age=31536000, immutable',
        'if-none-match': '*'
      },
      redirect: 'error',
      signal
    });
    await requireR2Success(response);
    await response.body?.cancel();
    files.push({
      variant,
      width: image.width,
      height: image.height,
      bytes: image.data.length,
      sha256: checksum(image.data)
    });
  }
  const response = await api(config, 'complete', { id: claim.id, leaseToken: claim.leaseToken, files }, signal);
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
  await mkdir(outputDirectory);
  for (const variant of VARIANTS) {
    const { filename, data, width, height } = outputs[variant];
    await writeFile(join(outputDirectory, filename), data, { flag: 'wx' });
    console.log(filename + ' | ' + width + ' × ' + height + ' px | ' + data.length + ' B');
  }
}

const [mode, first, second, quality] = process.argv.slice(2);
try {
  if (mode === 'local' && first && second) {
    await local(first, second, z.number().int().min(1).max(100).parse(quality === undefined ? 95 : Number(quality)));
  } else if (mode === 'run' && first) await work(first, second);
  else throw new Error('Upotreba: worker.mjs local <original> <novi-folder> | worker.mjs run <config.json>');
} catch (error) {
  console.error(mode === 'run' ? 'Worker nije pokrenut. Proveri konfiguraciju.' : error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
