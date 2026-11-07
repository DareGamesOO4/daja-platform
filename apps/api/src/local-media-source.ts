import type { AppConfig } from '@daja/config';
import { sha256, validateMediaBytes } from '@daja/database';
import { ValidationFailedError } from '@daja/security';

const sourceMimeTypes: Record<string, string> = {
  jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heif: 'image/avif'
};

export const localWorkerPresenceKey = (organizationId: string) => `daja:media:local-worker:${organizationId}`;

export function localMediaEnabled(config: AppConfig, organizationId: string, productSlug: unknown): boolean {
  return Boolean(config.MEDIA_LOCAL_WORKER_TOKEN_HASH &&
    config.PUBLIC_ORGANIZATION_ID === organizationId &&
    typeof productSlug === 'string' && productSlug);
}

export async function inspectLocalMediaSource(bytes: Buffer) {
  const { default: sharp } = await import('sharp');
  const metadata = await sharp(bytes, { limitInputPixels: 24_000_000 }).metadata().catch(() => {
    throw new ValidationFailedError('Unsupported, damaged or oversized image');
  });
  const { width, height } = metadata.autoOrient ?? metadata;
  const mimeType = sourceMimeTypes[metadata.format ?? ''];
  if (!mimeType || !width || !height || width > 12_000 || height > 12_000 ||
    width * height > 24_000_000 || (metadata.pages ?? 1) > 1) {
    throw new ValidationFailedError('Unsupported image format, dimensions or animation');
  }
  validateMediaBytes(bytes, mimeType);
  return { width, height, mimeType, sizeBytes: bytes.length, checksumSha256: sha256(bytes) };
}
