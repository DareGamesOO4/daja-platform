import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { get as getHttp, type IncomingMessage, type RequestOptions } from 'node:http';
import { get as getHttps } from 'node:https';
import { isIP } from 'node:net';
import type { AppConfig } from '@daja/config';
import {
  R2MediaStorageAdapter,
  MediaRepository,
  type MediaAssetRow,
  productMediaStorageKey,
  productMediaThumbnailStorageKey,
  sha256,
  prepareImageVariants,
  runMediaProcessing,
  recordMediaFailure,
  resolveMediaFailures,
  type ImageOutputOptions,
  type Database,
  TransactionManager
} from '@daja/database';
import { AppError, ValidationFailedError } from '@daja/security';
import { createLogger } from '@daja/observability';

const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const ACCEPTED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

export interface RemoteMediaImportResult {
  id: string;
  mediaId: string;
  publicUrl: string;
  mainImageUrl: string;
  thumbnailUrl: string;
  storageKey: string;
  width: number;
  height: number;
}

interface DownloadedRemoteImage {
  buffer: Buffer;
  contentType: string | null;
}

export { prepareImageVariants, type ImageOutputOptions } from '@daja/database';

/** Prepares the same image variants for uploads and offline catalogue packages. */
export async function prepareRemoteImage(sourceUrl: string, options: ImageOutputOptions = {}) {
  const downloaded = await downloadRemoteImage(sourceUrl);
  const processed = await prepareImageVariants(downloaded.buffer, options);
  return {
    ...processed,
    sourceContentType: downloaded.contentType,
    sourceSizeBytes: downloaded.buffer.length
  };
}

export function importRemoteImage(input: Parameters<typeof importRemoteImageNow>[0]): Promise<RemoteMediaImportResult> {
  return runMediaProcessing(input.config, () => importRemoteImageNow(input));
}

export function ensurePrimaryMediaThumbnail(input: Parameters<typeof ensurePrimaryMediaThumbnailNow>[0]): Promise<string> {
  return runMediaProcessing(input.config, () => ensurePrimaryMediaThumbnailNow(input));
}

/**
 * Imports a direct image URL into our own R2 bucket. The database only keeps
 * metadata and R2 keys; it never stores image blobs in PostgreSQL.
 */
async function importRemoteImageNow(input: {
  config: AppConfig;
  database: Database;
  organizationId: string;
  sourceUrl: string;
  productSlug?: string;
  imageIndex?: number;
  clientRequestId?: string;
}): Promise<RemoteMediaImportResult> {
  const repository = new MediaRepository(input.database.pool);
  if (input.clientRequestId) {
    const existing = (await input.database.pool.query<{ id: string; status: string; source_url: string | null }>(
      `SELECT id,status,metadata->>'sourceUrl' AS source_url FROM media_assets
       WHERE organization_id=$1 AND metadata->>'clientRequestId'=$2 LIMIT 1`,
      [input.organizationId, input.clientRequestId]
    )).rows[0];
    if (existing && existing.source_url !== input.sourceUrl)
      throw new ValidationFailedError('Image retry key was already used for a different source');
    if (existing?.status === 'ready') {
      const ready = await repository.readyUpload({ organizationId: input.organizationId }, existing.id);
      if (ready) return {
        id: existing.id, mediaId: existing.id, publicUrl: ready.publicUrl,
        mainImageUrl: ready.mainImageUrl, thumbnailUrl: ready.thumbnailUrl,
        storageKey: ready.storageKey, width: ready.width, height: ready.height
      };
    }
    if (existing) await new TransactionManager(input.database.pool, createLogger(input.config, 'remote-media')).run(async client => {
      await client.query(
        `UPDATE media_assets SET metadata=COALESCE(metadata,'{}'::jsonb)-'clientRequestId',
         status=CASE WHEN deleted_at IS NULL THEN 'failed' ELSE status END,updated_at=now()
         WHERE organization_id=$1 AND id=$2`,
        [input.organizationId, existing.id]
      );
      await resolveMediaFailures(client,input.organizationId,existing.id,undefined,'removed');
      await client.query(
        `INSERT INTO media_storage_deletions(organization_id,storage_key)
         SELECT organization_id,storage_key FROM media_assets WHERE organization_id=$1 AND id=$2
         AND storage_provider='r2' AND NOT EXISTS (SELECT 1 FROM media_derivative_jobs WHERE organization_id=$1 AND media_asset_id=$2)
         ON CONFLICT DO NOTHING`,
        [input.organizationId,existing.id]
      );
    });
  }
  const downloaded = await downloadRemoteImage(input.sourceUrl);
  const mediaId = randomUUID();
  const storage = new R2MediaStorageAdapter(input.config);
  const sourceKey = productMediaStorageKey({
    organizationId: input.organizationId, mediaId,
    productSlug: input.productSlug, imageIndex: input.imageIndex, extension: '.source'
  });
  const createdKeys = new Set<string>();
  const startedAt = Date.now();
  let stage = 'insert_asset';
  try {
    const inserted = await input.database.pool.query<MediaAssetRow>(
      `INSERT INTO media_assets (id, organization_id, storage_provider, storage_bucket, storage_key,
        public_url, mime_type, size_bytes, checksum_sha256, status, metadata)
       VALUES ($1,$2,'r2',$3,$4,$5,$6,$7,$8,'uploaded',$9::jsonb) RETURNING *`,
      [mediaId, input.organizationId, storage.bucket(), sourceKey, requiredPublicUrl(storage, sourceKey),
        downloaded.contentType || 'image/jpeg', downloaded.buffer.length, sha256(downloaded.buffer),
        JSON.stringify({ sourceUrl: input.sourceUrl, sourceMimeType: downloaded.contentType,
          sourceSizeBytes: downloaded.buffer.length, productSlug: input.productSlug ?? null,
          imageIndex: input.imageIndex ?? null, importedAt: new Date().toISOString(),
          ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}) })]
    );
    const asset = inserted.rows[0]!;
    // Remote sources also need a durable original for the three overnight files.
    createdKeys.add(sourceKey);
    stage = 'store_source';
    await storage.putObject({ key: sourceKey, body: downloaded.buffer,
      contentType: asset.mime_type, cacheControl: 'private, no-store' });
    stage = 'prepare_image';
    const prepared = await repository.stageUploadedImage(
      { organizationId: input.organizationId }, mediaId, storage, createdKeys, { asset, bytes: downloaded.buffer });
    stage = 'publish_image';
    const result = await new TransactionManager(input.database.pool, createLogger(input.config, 'remote-media')).run(client =>
      new MediaRepository(client).optimizeUploadedImage(
        { organizationId: input.organizationId }, mediaId, storage, createdKeys, undefined, prepared));
    return { id: mediaId, mediaId, publicUrl: result.publicUrl, mainImageUrl: result.mainImageUrl,
      thumbnailUrl: result.thumbnailUrl, storageKey: result.storageKey, width: result.width, height: result.height };
  } catch (error) {
    // Correlate the admin alert with the failing operation, without logging
    // source/signed URLs, SQL, file contents or provider exception messages.
    const details = error instanceof AppError ? error.details : {};
    createLogger(input.config, 'remote-media').error({
      err: error, mediaId, productSlug: input.productSlug, imageIndex: input.imageIndex,
      stage, elapsedMs: Date.now() - startedAt, sourceBytes: downloaded.buffer.length,
      encoderFailure: ['spawn', 'exit'].includes(String(details.encoderFailure)) ? details.encoderFailure : undefined,
      exitCode: typeof details.exitCode === 'number' ? details.exitCode : undefined,
      terminationSignal: typeof details.terminationSignal === 'string' && /^SIG[A-Z]+$/.test(details.terminationSignal) ? details.terminationSignal : undefined,
      systemError: typeof details.systemError === 'string' && /^[A-Z0-9_]{1,40}$/.test(details.systemError) ? details.systemError : undefined,
    }, 'Remote image import failed');
    await input.database.pool.query(`UPDATE media_assets SET status='failed', updated_at=now()
      WHERE organization_id=$1 AND id=$2 AND status='uploaded'`, [input.organizationId, mediaId]).catch(() => undefined);
    await recordMediaFailure(input.database.pool,input.organizationId,mediaId,'upload',error).catch(() => undefined);
    await repository.cleanupAttempt({ organizationId: input.organizationId }, mediaId, storage, createdKeys).catch(() => undefined);
    await input.database.pool.query(
      `INSERT INTO media_storage_deletions (organization_id,storage_key)
       SELECT organization_id,storage_key FROM media_assets WHERE organization_id=$1 AND id=$2 AND status='failed'
       AND NOT EXISTS (SELECT 1 FROM media_derivative_jobs WHERE organization_id=$1 AND media_asset_id=$2)
       ON CONFLICT DO NOTHING`, [input.organizationId, mediaId]).catch(() => undefined);
    throw error;
  }
}

async function ensurePrimaryMediaThumbnailNow(input: {
  config: AppConfig;
  database: Database;
  organizationId: string;
  mediaId: string;
}): Promise<string> {
  const deferred = await input.database.pool.query<{ public_url: string }>(
    `SELECT a.public_url FROM media_assets a JOIN media_derivative_jobs j
     ON j.organization_id=a.organization_id AND j.media_asset_id=a.id
     WHERE a.organization_id=$1 AND a.id=$2 AND a.status='ready' AND a.deleted_at IS NULL`,
    [input.organizationId, input.mediaId]);
  if (deferred.rows[0]) return deferred.rows[0].public_url;
  const existing = await input.database.pool.query<{ public_url: string }>(
    `SELECT public_url FROM media_derivatives
     WHERE organization_id = $1 AND media_asset_id = $2
     ORDER BY (mime_type = 'image/webp') DESC, width ASC
     LIMIT 1`,
    [input.organizationId, input.mediaId]
  );
  if (existing.rows[0]?.public_url) return existing.rows[0].public_url;

  const asset = await input.database.pool.query<{
    storage_key: string;
    storage_provider: string;
  }>(
    `SELECT storage_key, storage_provider
     FROM media_assets
     WHERE organization_id = $1 AND id = $2
       AND status IN ('uploaded', 'processing', 'ready') AND deleted_at IS NULL`,
    [input.organizationId, input.mediaId]
  );
  const row = asset.rows[0];
  if (!row || row.storage_provider !== 'r2') {
    throw new ValidationFailedError('Primary image is not available in R2 storage');
  }

  const storage = new R2MediaStorageAdapter(input.config);
  const original = await storage.getObject(row.storage_key);
  const { thumbnail } = await prepareImageVariants(original, { format: 'webp', quality: 75 });
  const output = { data: thumbnail.data, info: { width: thumbnail.width, height: thumbnail.height } };
  if (!output.info.width || !output.info.height) {
    throw new ValidationFailedError('Thumbnail dimensions could not be determined');
  }
  const key = productMediaThumbnailStorageKey({
    originalKey: row.storage_key,
    organizationId: input.organizationId,
    mediaId: input.mediaId,
    width: output.info.width
  });
  const publicUrl = requiredPublicUrl(storage, key);
  try {
    await storage.putObject({
      key,
      body: output.data,
      contentType: 'image/webp',
      cacheControl: CACHE_CONTROL
    });
    await input.database.pool.query(
      `INSERT INTO media_derivatives (
         organization_id, media_asset_id, width, height, mime_type,
         storage_key, public_url, size_bytes, checksum_sha256
       )
       VALUES ($1, $2, $3, $4, 'image/webp', $5, $6, $7, $8)
       ON CONFLICT (media_asset_id, storage_key) DO UPDATE
       SET width = EXCLUDED.width, height = EXCLUDED.height, mime_type = EXCLUDED.mime_type,
           storage_key = EXCLUDED.storage_key, public_url = EXCLUDED.public_url,
           size_bytes = EXCLUDED.size_bytes, checksum_sha256 = EXCLUDED.checksum_sha256`,
      [
        input.organizationId,
        input.mediaId,
        output.info.width,
        output.info.height,
        key,
        publicUrl,
        output.data.length,
        sha256(output.data)
      ]
    );
  } catch (error) {
    await storage.deleteObject(key).catch(() => undefined);
    throw error;
  }
  return publicUrl;
}

export async function downloadRemoteImage(value: string): Promise<DownloadedRemoteImage> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationFailedError('Image URL must be valid');
  }

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const address = await resolvePublicAddress(url);
    const response = await requestRemoteUrl(url, address.address, address.family);
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
      const location = response.headers.location;
      response.resume();
      if (!location || Array.isArray(location)) {
        throw new ValidationFailedError('Remote image redirect is invalid');
      }
      if (redirectCount === MAX_REDIRECTS) {
        throw new ValidationFailedError('Remote image has too many redirects');
      }
      try {
        url = new URL(location, url);
      } catch {
        throw new ValidationFailedError('Remote image redirect is invalid');
      }
      continue;
    }
    if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
      response.resume();
      throw new ValidationFailedError(
        `Remote image could not be downloaded (HTTP ${response.statusCode})`
      );
    }

    const contentType = contentTypeFrom(response);
    if (
      contentType &&
      contentType !== 'application/octet-stream' &&
      !ACCEPTED_CONTENT_TYPES.has(contentType)
    ) {
      response.resume();
      throw new ValidationFailedError('Remote URL did not return a supported image');
    }
    return { buffer: await readLimitedResponse(response), contentType };
  }

  throw new ValidationFailedError('Remote image has too many redirects');
}

async function resolvePublicAddress(url: URL): Promise<{ address: string; family: 4 | 6 }> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new ValidationFailedError('Image URL must use a public http(s) address');
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new ValidationFailedError('Image URL must use port 80 or 443');
  }

  const literalFamily = isIP(url.hostname);
  if (literalFamily) {
    if (!isPublicIpAddress(url.hostname)) {
      throw new ValidationFailedError('Image URL must not target a private network');
    }
    return { address: url.hostname, family: literalFamily as 4 | 6 };
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new ValidationFailedError('Image host could not be resolved');
  }
  if (!addresses.length || addresses.some((entry) => !isPublicIpAddress(entry.address))) {
    throw new ValidationFailedError('Image URL must not target a private network');
  }
  // Render services normally have IPv4 egress. Prefer it when a CDN publishes
  // both records; the URL host and TLS SNI remain unchanged by the pinned lookup.
  const first = addresses.find((entry) => entry.family === 4) ?? addresses[0];
  if (!first || (first.family !== 4 && first.family !== 6)) {
    throw new ValidationFailedError('Image host could not be resolved');
  }
  return { address: first.address, family: first.family };
}

function requestRemoteUrl(url: URL, address: string, family: 4 | 6): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const options: RequestOptions & { autoSelectFamily?: boolean } = {
      // We deliberately pin one address after validating it above. Node's
      // automatic multi-address selection expects a different lookup callback
      // shape and otherwise raises ERR_INVALID_IP_ADDRESS on Render.
      family,
      autoSelectFamily: false,
      headers: {
        Accept: 'image/avif,image/webp,image/png,image/jpeg;q=0.9,*/*;q=0.1',
        'User-Agent': 'DajaShopMediaImporter/1.0'
      },
      lookup: (_hostname, _options, callback) => callback(null, address, family)
    };
    const request = (url.protocol === 'https:' ? getHttps : getHttp)(url, options, response => {
      // Redirect/unsupported responses may be drained without a body reader.
      // Their stream errors must never become an uncaught process exception.
      response.on('error', () => {});
      resolve(response);
    });
    const deadline = setTimeout(() => request.destroy(new Error('Remote image total download time exceeded')), 20_000);
    request.once('close', () => clearTimeout(deadline));
    request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy(new Error('Remote image request timed out'));
    });
    request.once('error', (error) => reject(remoteDownloadError(error)));
  });
}

function remoteDownloadError(error: unknown): ValidationFailedError {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null;
  const detail = code ? ` (${code})` : '';
  return new ValidationFailedError(
    `Remote image could not be downloaded${detail}. The source site may block server downloads.`
  );
}

async function readLimitedResponse(response: IncomingMessage): Promise<Buffer> {
  const lengthHeader = response.headers['content-length'];
  const declaredLength = Number(Array.isArray(lengthHeader) ? lengthHeader[0] : lengthHeader);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_SOURCE_BYTES) {
    response.resume();
    throw new ValidationFailedError('Remote image must be 25 MiB or smaller');
  }

  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of response) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buffer.length;
      if (size > MAX_SOURCE_BYTES) {
        response.destroy();
        throw new ValidationFailedError('Remote image must be 25 MiB or smaller');
      }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof ValidationFailedError) throw error;
    throw new ValidationFailedError('Remote image could not be downloaded');
  }
  if (!size) throw new ValidationFailedError('Remote image is empty');
  return Buffer.concat(chunks, size);
}

function contentTypeFrom(response: IncomingMessage): string | null {
  const value = response.headers['content-type'];
  const contentType = Array.isArray(value) ? value[0] : value;
  return contentType ? (contentType.split(';', 1)[0]?.trim().toLowerCase() ?? null) : null;
}

function requiredPublicUrl(storage: R2MediaStorageAdapter, key: string): string {
  const url = storage.publicUrl(key);
  if (!url)
    throw new ValidationFailedError('MEDIA_PUBLIC_BASE_URL is required for remote image imports');
  return url;
}

function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number);
    const first = parts[0];
    const second = parts[1];
    if (first === undefined || second === undefined) return false;
    return !(
      first === 0 ||
      first === 10 ||
      first === 127 ||
      first >= 224 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPublicIpAddress(mapped[1]);
    return !(
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    );
  }
  return false;
}
