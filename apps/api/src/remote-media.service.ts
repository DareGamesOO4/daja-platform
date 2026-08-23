import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { get as getHttp, type IncomingMessage, type RequestOptions } from 'node:http';
import { get as getHttps } from 'node:https';
import { isIP } from 'node:net';
import sharp from 'sharp';
import type { AppConfig } from '@daja/config';
import { R2MediaStorageAdapter, sha256, type Database } from '@daja/database';
import { ValidationFailedError } from '@daja/security';

const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_INPUT_PIXELS = 80_000_000;
const MAX_IMAGE_DIMENSION = 12_000;
const MAX_MAIN_WIDTH = 2048;
const THUMBNAIL_WIDTH = 512;
const MAX_REDIRECTS = 3;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const ACCEPTED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif'
]);

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

/**
 * Imports a direct image URL into our own R2 bucket. The database only keeps
 * metadata and R2 keys; it never stores image blobs in PostgreSQL.
 */
export async function importRemoteImage(input: {
  config: AppConfig;
  database: Database;
  organizationId: string;
  sourceUrl: string;
}): Promise<RemoteMediaImportResult> {
  const downloaded = await downloadRemoteImage(input.sourceUrl);
  const processed = await createWebpVariants(downloaded.buffer);
  const mediaId = randomUUID();
  const storage = new R2MediaStorageAdapter(input.config);
  const originalKey = `org/${input.organizationId}/media/${mediaId}/original.webp`;
  const originalUrl = requiredPublicUrl(storage, originalKey);
  const storedKeys = [originalKey];
  try {
    await storage.putObject({
      key: originalKey,
      body: processed.data,
      contentType: 'image/webp',
      cacheControl: CACHE_CONTROL
    });

    const client = await input.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO media_assets (
           id, organization_id, storage_provider, storage_bucket, storage_key,
           public_url, mime_type, width, height, size_bytes, checksum_sha256,
           status, metadata
         )
         VALUES ($1, $2, 'r2', $3, $4, $5, 'image/webp', $6, $7, $8, $9, 'ready', $10::jsonb)`,
        [
          mediaId,
          input.organizationId,
          storage.bucket(),
          originalKey,
          originalUrl,
          processed.width,
          processed.height,
          processed.data.length,
          sha256(processed.data),
          JSON.stringify({
            sourceUrl: input.sourceUrl,
            sourceMimeType: downloaded.contentType,
            sourceSizeBytes: downloaded.buffer.length,
            importedAt: new Date().toISOString()
          })
        ]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    await Promise.all(storedKeys.map((key) => storage.deleteObject(key).catch(() => undefined)));
    throw error;
  }

  return {
    id: mediaId,
    mediaId,
    publicUrl: originalUrl,
    mainImageUrl: originalUrl,
    // A gallery item does not receive a derivative. The client may use the
    // optimized main image until this asset becomes a product's primary image.
    thumbnailUrl: originalUrl,
    storageKey: originalKey,
    width: processed.width,
    height: processed.height
  };
}

export async function ensurePrimaryMediaThumbnail(input: {
  config: AppConfig;
  database: Database;
  organizationId: string;
  mediaId: string;
}): Promise<string> {
  const existing = await input.database.pool.query<{ public_url: string }>(
    `SELECT public_url FROM media_derivatives
     WHERE organization_id = $1 AND media_asset_id = $2
     ORDER BY width ASC
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
  const output = await sharp(original, { limitInputPixels: MAX_INPUT_PIXELS })
    .resize({ width: THUMBNAIL_WIDTH, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80, effort: 4, smartSubsample: true })
    .toBuffer({ resolveWithObject: true });
  if (!output.info.width || !output.info.height) {
    throw new ValidationFailedError('Thumbnail dimensions could not be determined');
  }
  const key = `org/${input.organizationId}/media/${input.mediaId}/derivatives/${output.info.width}.webp`;
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
       ON CONFLICT (media_asset_id, width) DO UPDATE
       SET height = EXCLUDED.height, mime_type = EXCLUDED.mime_type,
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

async function createWebpVariants(source: Buffer): Promise<{
  data: Buffer;
  width: number;
  height: number;
}> {
  let originalData: Buffer | undefined;
  let width: number | undefined;
  let height: number | undefined;
  try {
    const original = await sharp(source, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({
        width: MAX_MAIN_WIDTH,
        height: MAX_MAIN_WIDTH,
        fit: 'inside',
        withoutEnlargement: true
      })
      .webp({ quality: 84, effort: 4, smartSubsample: true })
      .toBuffer({ resolveWithObject: true });
    originalData = original.data;
    width = original.info.width;
    height = original.info.height;
  } catch {
    throw new ValidationFailedError(
      'The URL does not point to a supported image (JPEG, PNG, WebP, or AVIF)'
    );
  }

  if (
    !originalData ||
    !width ||
    !height ||
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION
  ) {
    throw new ValidationFailedError('Image dimensions are unsupported');
  }

  return {
    data: originalData,
    width,
    height
  };
}

async function downloadRemoteImage(value: string): Promise<DownloadedRemoteImage> {
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
      throw new ValidationFailedError(`Remote image could not be downloaded (HTTP ${response.statusCode})`);
    }

    const contentType = contentTypeFrom(response);
    if (contentType && contentType !== 'application/octet-stream' && !ACCEPTED_CONTENT_TYPES.has(contentType)) {
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
    const request = (url.protocol === 'https:' ? getHttps : getHttp)(url, options, resolve);
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
  return contentType ? contentType.split(';', 1)[0]?.trim().toLowerCase() ?? null : null;
}

function requiredPublicUrl(storage: R2MediaStorageAdapter, key: string): string {
  const url = storage.publicUrl(key);
  if (!url) throw new ValidationFailedError('MEDIA_PUBLIC_BASE_URL is required for remote image imports');
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
