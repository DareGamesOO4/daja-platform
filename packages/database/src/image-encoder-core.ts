import sharp, { type Channels } from 'sharp';
import { ValidationFailedError } from '@daja/security';
sharp.concurrency(1);
sharp.cache(false);

const MAX_INPUT_PIXELS = 24_000_000;
const MAX_IMAGE_DIMENSION = 12_000;
const MAX_MAIN_WIDTH = 2048;
const THUMBNAIL_WIDTH = 512;

export interface ImageOutputOptions {
  format?: 'webp' | 'avif';
  quality?: number;
}

type Raster = { data: Buffer; width: number; height: number; channels: Channels };

async function decodeImage(source: Buffer): Promise<Raster> {
  const metadata = await sharp(source, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width > MAX_IMAGE_DIMENSION ||
    metadata.height > MAX_IMAGE_DIMENSION ||
    (metadata.pages ?? 1) > 1
  )
    throw new ValidationFailedError('Image dimensions or animation are unsupported');
  // Decode and orient the original once. Every output reuses this bounded raster
  // (at most 2048 x 2048), not a second decode of a 24-megapixel source.
  const { data, info } = await sharp(source, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize({
      width: MAX_MAIN_WIDTH,
      height: MAX_MAIN_WIDTH,
      fit: 'inside',
      withoutEnlargement: true
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

async function encodeVariants(raster: Raster, options: ImageOutputOptions = {}) {
  const format = options.format ?? 'webp';
  const quality = options.quality ?? (format === 'avif' ? 65 : 84);
  if (
    !['webp', 'avif'].includes(format) ||
    !Number.isInteger(quality) ||
    quality < 1 ||
    quality > 100
  ) {
    throw new ValidationFailedError(
      'Image output must be WebP or AVIF with quality between 1 and 100'
    );
  }
  const encode = (width: number) => {
    const pipeline = sharp(raster.data, {
      raw: { width: raster.width, height: raster.height, channels: raster.channels }
    }).resize({ width, height: width, fit: 'inside', withoutEnlargement: true });
    return (
      format === 'avif'
        ? pipeline.avif({ quality, effort: 4 })
        : pipeline.webp({ quality, effort: 4, smartSubsample: true })
    ).toBuffer({ resolveWithObject: true });
  };
  const original = await encode(MAX_MAIN_WIDTH);
  const thumbnail = await encode(THUMBNAIL_WIDTH);
  return {
    format,
    mimeType: format === 'avif' ? ('image/avif' as const) : ('image/webp' as const),
    extension: format === 'avif' ? ('.avif' as const) : ('.webp' as const),
    original: { data: original.data, width: original.info.width, height: original.info.height },
    thumbnail: { data: thumbnail.data, width: thumbnail.info.width, height: thumbnail.info.height }
  };
}

export async function prepareImageVariants(source: Buffer, options: ImageOutputOptions = {}) {
  return encodeVariants(await decodeImage(source), options);
}

export async function prepareProductVariants(source: Buffer) {
  const raster = await decodeImage(source);
  return {
    webp: await encodeVariants(raster, { format: 'webp', quality: 75 }),
    avif: await encodeVariants(raster, { format: 'avif', quality: 65 })
  };
}
