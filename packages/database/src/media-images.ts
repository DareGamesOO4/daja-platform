import sharp from 'sharp';
import { AppError, ValidationFailedError } from '@daja/security';

// Keep libvips/AVIF work bounded on the 512 MB API instance. The queue contains
// only a few upload buffers, and does not consume a PostgreSQL connection.
sharp.concurrency(1);
sharp.cache({ memory: 16, files: 0, items: 32 });
let encoding = false;
const waiting: Array<() => void> = [];

async function serializeImage<T>(operation: () => Promise<T>): Promise<T> {
  if (encoding) {
    if (waiting.length >= 4) throw new AppError('SERVICE_UNAVAILABLE', 'Image processing is busy. Please retry shortly.', 503, { retryAfterSeconds: 3 });
    await new Promise<void>(resolve => waiting.push(resolve));
  } else encoding = true;
  try { return await operation(); }
  finally {
    const next = waiting.shift();
    if (next) next();
    else encoding = false;
  }
}

const MAX_INPUT_PIXELS = 80_000_000;
const MAX_IMAGE_DIMENSION = 12_000;
const MAX_MAIN_WIDTH = 2048;
const THUMBNAIL_WIDTH = 512;

export interface ImageOutputOptions {
  format?: 'webp' | 'avif';
  quality?: number;
}

export async function prepareImageVariants(source: Buffer, options: ImageOutputOptions = {}): Promise<{
  format: 'webp' | 'avif';
  mimeType: 'image/webp' | 'image/avif';
  extension: '.webp' | '.avif';
  original: { data: Buffer; width: number; height: number };
  thumbnail: { data: Buffer; width: number; height: number };
}> {
  const format = options.format ?? 'webp';
  const quality = options.quality ?? (format === 'avif' ? 65 : 84);
  if (!['webp', 'avif'].includes(format) || !Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw new ValidationFailedError('Image output must be WebP or AVIF with quality between 1 and 100');
  }
  let originalData: Buffer | undefined;
  let width: number | undefined;
  let height: number | undefined;
  try {
    const pipeline = sharp(source, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({
        width: MAX_MAIN_WIDTH,
        height: MAX_MAIN_WIDTH,
        fit: 'inside',
        withoutEnlargement: true
      });
    const original = await (format === 'avif'
      ? pipeline.avif({ quality, effort: 4 })
      : pipeline.webp({ quality, effort: 4, smartSubsample: true }))
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

  const thumbnailPipeline = sharp(source, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize({ width: Math.min(THUMBNAIL_WIDTH, width), fit: 'inside', withoutEnlargement: true });
  const thumbnail = await (format === 'avif'
    ? thumbnailPipeline.avif({ quality, effort: 4 })
    : thumbnailPipeline.webp({ quality, effort: 4, smartSubsample: true }))
    .toBuffer({ resolveWithObject: true });
  if (!thumbnail.info.width || !thumbnail.info.height) {
    throw new ValidationFailedError('Thumbnail dimensions could not be determined');
  }

  return {
    format,
    mimeType: format === 'avif' ? 'image/avif' : 'image/webp',
    extension: format === 'avif' ? '.avif' : '.webp',
    original: { data: originalData, width, height },
    thumbnail: {
      data: thumbnail.data,
      width: thumbnail.info.width,
      height: thumbnail.info.height
    }
  };
}

/** Independent encodes from the source, serialized to bound native memory/CPU. */
export async function prepareProductImageVariants(source: Buffer) {
  return serializeImage(async () => {
    const webp = await prepareImageVariants(source, { format: 'webp', quality: 75 });
    const avif = await prepareImageVariants(source, { format: 'avif', quality: 65 });
    return { avif, webp };
  });
}
