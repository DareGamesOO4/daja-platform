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
  effort?: number;
  lossless?: boolean;
  chromaSubsampling?: '4:4:4' | '4:2:0';
  smartSubsample?: boolean;
}

type VariantOptions = Omit<ImageOutputOptions, 'format'> & { size: number };
export type ProductImageProfile = Record<'avif' | 'webp' | 'avifThumb' | 'webpThumb', VariantOptions>;

type Raster = { data: Buffer; width: number; height: number; channels: Channels };

export async function inspectImageSource(source: Buffer) {
  const metadata = await sharp(source, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width > MAX_IMAGE_DIMENSION ||
    metadata.height > MAX_IMAGE_DIMENSION || metadata.width * metadata.height > MAX_INPUT_PIXELS ||
    (metadata.pages ?? 1) > 1
  )
    throw new ValidationFailedError('Image dimensions or animation are unsupported');
  const dimensions = metadata.autoOrient ?? { width: metadata.width, height: metadata.height };
  return { width: dimensions.width, height: dimensions.height, format: metadata.format };
}

async function decodeImage(source: Buffer): Promise<Raster> {
  await inspectImageSource(source);
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

async function encodeRaster(raster: Raster, width: number, options: ImageOutputOptions) {
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
  const pipeline = sharp(raster.data, {
    raw: { width: raster.width, height: raster.height, channels: raster.channels }
  }).resize({ width, height: width, fit: 'inside', withoutEnlargement: true });
  const { data, info } = await (
    format === 'avif'
      ? pipeline.avif({
          quality, effort: options.effort ?? 4, lossless: options.lossless ?? false,
          chromaSubsampling: options.lossless ? '4:4:4' : options.chromaSubsampling ?? '4:4:4'
        })
      : pipeline.webp({
          quality, effort: options.effort ?? 4, lossless: options.lossless ?? false,
          smartSubsample: options.smartSubsample ?? true
        })
  ).toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function encodeVariants(
  raster: Raster,
  options: ImageOutputOptions = {},
  mainQuality = options.quality
) {
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
  const encode = (width: number) => encodeRaster(raster, width, options);
  const original = await encodeRaster(
    raster,
    MAX_MAIN_WIDTH,
    mainQuality === undefined ? options : { ...options, quality: mainQuality }
  );
  const thumbnail = await encode(THUMBNAIL_WIDTH);
  return {
    format,
    mimeType: format === 'avif' ? ('image/avif' as const) : ('image/webp' as const),
    extension: format === 'avif' ? ('.avif' as const) : ('.webp' as const),
    original,
    thumbnail
  };
}

export async function prepareImageVariants(source: Buffer, options: ImageOutputOptions = {}) {
  return encodeVariants(await decodeImage(source), options);
}

export async function prepareProductVariants(source: Buffer, mainAvifQuality = 65, profile?: ProductImageProfile) {
  const raster = await decodeImage(source);
  if (profile) {
    const encode = async (format: 'webp' | 'avif', main: VariantOptions, thumb: VariantOptions) => ({
      original: await encodeRaster(raster, main.size, { ...main, format }),
      thumbnail: await encodeRaster(raster, thumb.size, { ...thumb, format })
    });
    return {
      webp: { ...await encode('webp', profile.webp, profile.webpThumb), mimeType: 'image/webp' as const },
      avif: { ...await encode('avif', profile.avif, profile.avifThumb), mimeType: 'image/avif' as const }
    };
  }
  return {
    webp: await encodeVariants(raster, { format: 'webp', quality: 75 }),
    avif: await encodeVariants(raster, { format: 'avif', quality: 65 }, mainAvifQuality)
  };
}

/** The only output generated during an interactive image upload. */
export async function prepareAvifMain(source: Buffer) {
  return encodeRaster(await decodeImage(source), MAX_MAIN_WIDTH, { format: 'avif', quality: 65 });
}

/** Exactly three remaining files; never re-encode the already published AVIF. */
export async function prepareRemainingVariants(source: Buffer) {
  const raster = await decodeImage(source);
  const webp = await encodeVariants(raster, { format: 'webp', quality: 75 });
  const avifThumbnail = await encodeRaster(raster, THUMBNAIL_WIDTH, {
    format: 'avif',
    quality: 65
  });
  return { webp, avifThumbnail };
}
