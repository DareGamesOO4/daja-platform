import type { AppConfig } from '@daja/config';
import { inspectImageSourceMetadata, sha256, validateMediaBytes } from '@daja/database';
import { ValidationFailedError } from '@daja/security';

const sourceMimeTypes: Record<string, string> = {
  jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heif: 'image/avif'
};

export function localMediaEnabled(config: AppConfig, organizationId: string, productSlug: unknown): boolean {
  return Boolean(config.MEDIA_LOCAL_WORKER_TOKEN_HASH &&
    config.PUBLIC_ORGANIZATION_ID === organizationId &&
    typeof productSlug === 'string' && productSlug);
}

export async function inspectLocalMediaSource(bytes: Buffer, deadline?: AbortSignal) {
  const { width, height, format } = await inspectImageSourceMetadata(bytes, deadline);
  const mimeType = sourceMimeTypes[format ?? ''];
  if (!mimeType) throw new ValidationFailedError('Unsupported image format');
  validateMediaBytes(bytes, mimeType);
  return { width, height, mimeType, sizeBytes: bytes.length, checksumSha256: sha256(bytes) };
}
