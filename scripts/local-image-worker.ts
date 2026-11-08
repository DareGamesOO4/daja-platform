import { createHash, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ProductImageProfile } from '../packages/database/src/image-encoder-core.js';
import {
  defaultMediaWorkerProfile, mediaWorkerProfileSchema as profileSchema
} from '../packages/validation/src/media-worker-profile.js';

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
  customSizes: z.boolean().optional(),
  profile: profileSchema.optional(),
  source: z.object({ url: z.url(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  uploads: z.object({ avif: z.url(), webp: z.url(), avifThumb: z.url(), webpThumb: z.url() })
});
type Config = z.infer<typeof configSchema>;
type Claim = z.infer<typeof claimSchema>;

function checksum(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readImage(chunks: AsyncIterable<Uint8Array>, maximum = MAX_BYTES): Promise<Buffer> {
  const buffers: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of chunks) {
    length += chunk.byteLength;
    if (length > maximum) throw new Error('Prekoračena je maksimalna veličina zahteva.');
    buffers.push(chunk);
  }
  return Buffer.concat(buffers, length);
}

async function encodeInChild(source: Buffer, quality: number, profile?: ProductImageProfile) {
  const { prepareProductVariants } = await import('../packages/database/src/image-encoder-core.js');
  const { avif, webp } = await prepareProductVariants(source, quality, profile);
  return {
    avif: { ...avif.original, mime: avif.mimeType, filename: 'slika.avif' },
    webp: { ...webp.original, mime: webp.mimeType, filename: 'slika.webp' },
    avifThumb: { ...avif.thumbnail, mime: avif.mimeType, filename: 'slika-thumb.avif' },
    webpThumb: { ...webp.thumbnail, mime: webp.mimeType, filename: 'slika-thumb.webp' }
  };
}

type Encoded = Awaited<ReturnType<typeof encodeInChild>>;

function encode(source: Buffer, quality = 95, jobSignal?: AbortSignal, profile?: ProductImageProfile): Promise<Encoded> {
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
    child.send({ source, quality, profile }, error => { if (error) finish(error); });
  });
}

function runEncoderChild() {
  process.once('disconnect', () => process.exit(0));
  process.once('message', (message: { source: Buffer; quality: number; profile?: ProductImageProfile }) => {
    void encodeInChild(message.source, message.quality, message.profile).then(
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

async function handleClaim(config: Config, claim: Claim, shutdown: AbortSignal, profile?: ProductImageProfile) {
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

  const outputProfile = profile && (claim.customSizes ? profile : {
    avif: { ...profile.avif, size: 2048 }, webp: { ...profile.webp, size: 2048 },
    avifThumb: { ...profile.avifThumb, size: 512 }, webpThumb: { ...profile.webpThumb, size: 512 }
  });
  const outputs = await encode(bytes, 95, signal, outputProfile);
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
      maxSize: claim.customSizes ? outputProfile?.[variant].size : undefined,
      bytes: image.data.length,
      sha256: checksum(image.data)
    });
  }
  const response = await retryTransfer(() =>
    api(config, 'complete', { id: claim.id, leaseToken: claim.leaseToken, files }, leaseSignal), leaseSignal);
  await response.body?.cancel();
}

async function loadConfig(configPath: string) {
  const config = configSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
  const endpoint = new URL(config.apiBaseUrl);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('DAJA API mora da koristi HTTPS adresu.');
  }
  config.apiBaseUrl = endpoint.href.replace(/\/+$/, '');
  return config;
}

async function work(configPath: string, statusPath?: string) {
  const config = await loadConfig(configPath);
  const shutdown = new AbortController();
  process.once('SIGINT', () => shutdown.abort());
  process.once('SIGTERM', () => shutdown.abort());
  const status = { phase: 'connecting', job: '', completed: '', error: '' };
  if (basename(configPath) === 'worker-user.json') {
    if (existsSync(join(dirname(configPath), 'studio', 'index.html'))) {
      startPanel(config, dirname(configPath), status, shutdown.signal);
    }
  }
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
      const response = await api(config, 'claim', { profile: 'avif95-v1', managed: true }, shutdown.signal);
      if (response.status !== 204) {
        const claim = claimSchema.parse(await response.json());
        Object.assign(status, { phase: 'working', job: claim.id, error: '' });
        await publishStatus();
        await handleClaim(config, claim, shutdown.signal, claim.profile);
        status.completed = new Date().toISOString();
        console.log('Obrađene su četiri verzije slike.');
        pause = 0;
      }
      Object.assign(status, { phase: response.headers.get('X-Daja-Worker-Paused') === '1' ? 'paused' : 'ready', job: '', error: '' });
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

async function queue(configPath: string, page: number, cachedKeys: string[]) {
  const config = await loadConfig(configPath);
  const response = await api(config, 'queue', { page }, AbortSignal.timeout(15_000));
  const snapshot = z.object({
    total: z.number().int().nonnegative(),
    items: z.array(z.object({
      id: z.uuid(), slug: z.string().nullable(), image: z.string().nullable(), attempts: z.number(),
      state: z.string(), bytes: z.number().nonnegative(), key: z.string(), preview: z.url()
    })).max(8)
  }).parse(await response.json());
  const { default: sharp } = await import('sharp');
  sharp.concurrency(1);
  sharp.cache(false);
  async function preview(url: string) {
    try {
      const image = await fetch(r2Url(url), { signal: AbortSignal.timeout(5_000), redirect: 'error' });
      await requireR2Success(image);
      if (!image.body) return undefined;
      const input = await readImage(image.body);
      return (await sharp(input, { limitInputPixels: 24_000_000 })
        .rotate().resize(96, 96, { fit: 'inside', withoutEnlargement: true }).png().toBuffer()).toString('base64');
    } catch { return undefined; }
  }
  const items = [];
  for (let i = 0; i < snapshot.items.length; i += 2) {
    items.push(...await Promise.all(snapshot.items.slice(i, i + 2).map(async ({ preview: url, ...item }) => ({
      ...item, thumbnail: cachedKeys.includes(item.key) ? undefined : await preview(url)
    }))));
  }
  return { total: snapshot.total, items };
}

function startPanel(config: Config, folder: string, status: unknown, shutdown: AbortSignal) {
  const host = '127.0.0.1:41627';
  const origin = 'http://' + host;
  let encoding = false;
  let render: unknown = null;
  let nextStatus = 0;
  let checking = false;
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const reply = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
    };
    if (req.headers.host !== host || (req.method === 'POST' &&
        (req.headers.origin !== origin || req.headers['x-daja-panel'] !== '1'))) {
      reply(403, { error: 'Otvori panel direktno na ' + origin });
      return;
    }
    const route = req.url ?? '';
    const assets: Record<string, [string, string]> = {
      '/': ['index.html', 'text/html'], '/panel.js': ['panel.js', 'text/javascript'], '/panel.css': ['panel.css', 'text/css']
    };
    try {
      const asset = Object.hasOwn(assets, route) ? assets[route] : undefined;
      if (req.method === 'GET' && asset) {
        const data = await readFile(join(folder, 'studio', asset[0]));
        res.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8' }).end(data);
      } else if (req.method === 'GET' && route === '/state') {
        if (!checking && Date.now() >= nextStatus) {
          checking = true;
          try {
            const response = await api(config, 'status', {}, shutdown);
            render = await response.json();
          } catch { render = null; }
          finally { checking = false; nextStatus = Date.now() + 30_000; }
        }
        reply(200, { status, render });
      } else if (req.method === 'POST' && route === '/convert') {
        if (encoding) return reply(409, { error: 'Lokalna proba je već u toku.' });
        if (Number(req.headers['content-length']) > MAX_BYTES) return reply(413, { error: 'Najviše 25 MiB po slici.' });
        encoding = true;
        try {
          const source = await readImage(req);
          const id = randomUUID();
          const output = join(folder, 'Rezultati', id);
          await mkdir(dirname(output), { recursive: true });
          const result = await saveOutputs(source, output, 95, defaultMediaWorkerProfile);
          reply(200, { id, output, ...result });
        } finally { encoding = false; }
      } else {
        const result = /^\/result\/([a-f0-9-]{36})\/(slika(?:-thumb)?\.(?:avif|webp))$/.exec(route);
        if (req.method !== 'GET' || !result || !z.uuid().safeParse(result[1]).success) {
          return reply(404, { error: 'Stranica nije pronađena.' });
        }
        const file = await readFile(join(folder, 'Rezultati', result[1], result[2]));
        res.writeHead(200, { 'Content-Type': 'image/' + result[2].split('.').pop(),
          'Content-Disposition': 'attachment; filename="' + result[2] + '"' }).end(file);
      }
    } catch (error) {
      if (!res.headersSent && !res.destroyed) reply(400, { error:
        error instanceof HttpFailure ? error.message : 'Zahtev nije obrađen. Proveri sliku, profil ili vezu.' });
    }
  });
  server.on('error', () => console.error('Lokalni panel nije mogao da se pokrene na ' + origin));
  server.listen(41627, '127.0.0.1');
  shutdown.addEventListener('abort', () => server.close(), { once: true });
}

async function local(inputPath: string, outputDirectory: string, quality: number, profile?: ProductImageProfile) {
  const result = await saveOutputs(await readImage(createReadStream(inputPath)), outputDirectory, quality, profile);
  for (const { filename, width, height, bytes, savings } of result.files) {
    console.log(filename + '  ·  ' + width + ' × ' + height + ' px  ·  ' + (bytes / 1024).toFixed(1) + ' KiB  ·  ušteda ' + savings.toFixed(1) + '%');
  }
  console.log('Original: ' + (result.original / 1024).toFixed(1) + ' KiB  ·  Obrada: ' + result.seconds.toFixed(1) + ' s');
}

async function saveOutputs(source: Buffer, outputDirectory: string, quality: number, profile?: ProductImageProfile) {
  const started = Date.now();
  const outputs = await encode(source, quality, undefined, profile);
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
  const files = VARIANTS.map(variant => {
    const { filename, data, width, height } = outputs[variant];
    return { filename, width, height, bytes: data.length, savings: 100 * (1 - data.length / source.length) };
  });
  return { files, original: source.length, seconds: (Date.now() - started) / 1000 };
}

const [mode, first, second, quality] = process.argv.slice(2);
try {
  if (mode === 'encode-child') runEncoderChild();
  else if (mode === 'local' && first && second) {
    await local(first, second, z.number().int().min(1).max(100).parse(quality === undefined ? 95 : Number(quality)));
  } else if (mode === 'local-profile' && first && second && quality) {
    await local(first, second, 95, profileSchema.parse(JSON.parse(Buffer.from(quality, 'base64').toString('utf8'))));
  } else if (mode === 'queue' && first && second) {
    const keys = z.array(z.string()).max(8).parse(JSON.parse(Buffer.from(quality ?? 'W10=', 'base64').toString('utf8')));
    console.log(JSON.stringify(await queue(first, z.coerce.number().int().min(0).max(10000).parse(second), keys)));
  } else if (mode === 'run' && first) await work(first, second);
  else throw new Error('Upotreba: worker.mjs local <original> <novi-folder> | worker.mjs run <config.json>');
} catch (error) {
  console.error(mode === 'run' ? 'Worker nije pokrenut. Proveri konfiguraciju.' : error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
