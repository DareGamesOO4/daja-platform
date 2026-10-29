/**
 * Offline only: downloads and processes catalogue images without database or R2 writes.
 * Usage: npx tsx scripts/prepare-catalog-media.ts input.json output-dir [excel-preview-dir]
 *        [--format webp|avif] [--quality 1-100] [--compare-webp]
 * Input: { products: [{ source_id, sku?, image_url }] }
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { downloadRemoteImage, prepareImageVariants } from '../apps/api/src/remote-media.service.js';

interface SourceProduct {
  source_id: string;
  sku?: string;
  image_url: string;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    format: { type: 'string', default: 'webp' },
    quality: { type: 'string' },
    'compare-webp': { type: 'boolean', default: false }
  }
});
const [inputFile, outputDirectory, previewDirectory] = positionals;
const format = values.format;
if (format !== 'webp' && format !== 'avif') throw new Error('Format must be webp or avif');
const quality = values.quality === undefined ? (format === 'avif' ? 65 : 84) : Number(values.quality);
if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error('Quality must be between 1 and 100');
if (!inputFile || !outputDirectory) {
  throw new Error('Usage: tsx scripts/prepare-catalog-media.ts input.json output-dir [excel-preview-dir]');
}
const input = JSON.parse(await readFile(inputFile, 'utf8')) as { products: SourceProduct[] };
if (!Array.isArray(input.products) || !input.products.length) {
  throw new Error('Input must contain a non-empty products array');
}
const output = path.resolve(outputDirectory);
await mkdir(path.join(output, 'images'), { recursive: true });
await mkdir(path.join(output, 'thumbnails'), { recursive: true });
if (previewDirectory) await mkdir(path.resolve(previewDirectory), { recursive: true });

function safeSegment(value: string) {
  return value.normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100).toLowerCase();
}
function checksum(data: Buffer) {
  return createHash('sha256').update(data).digest('hex');
}

const files: Array<Record<string, unknown>> = [];
const errors: Array<{ sourceId: string; message: string }> = [];
const stems = new Set<string>();
const products = input.products.map(product => {
  if (!product.source_id || !product.image_url) throw new Error('Each product needs source_id and image_url');
  const stem = safeSegment(`${String(product.source_id)}-${product.sku ?? ''}`);
  if (!stem || stems.has(stem)) throw new Error(`Duplicate or invalid image filename: ${stem}`);
  stems.add(stem);
  return { ...product, stem };
});
async function saveManifest() {
  await writeFile(path.join(output, 'media-manifest.json'), JSON.stringify({
    schemaVersion: 'daja.catalog-media.v1',
    createdAt: new Date().toISOString(),
    processor: 'daja-platform/apps/api/src/remote-media.service.ts#prepareImageVariants',
    presets: { main: { maxWidth: 2048, maxHeight: 2048, quality }, thumbnail: { maxWidth: 512, quality: format === 'avif' ? quality : 80 }, format, effort: 4, withoutEnlargement: true },
    measurement: { timingIncludes: 'main image and thumbnail encoding', timingExcludes: 'network download, file writes and Excel preview', concurrency: values['compare-webp'] ? 1 : 2 },
    sourceCount: products.length,
    processedCount: files.length,
    files: [...files].sort((a, b) => String(a.sourceId).localeCompare(String(b.sourceId), undefined, { numeric: true })),
    errors
  }, null, 2) + '\n');
}

const batchSize = values['compare-webp'] ? 1 : 2;
for (let offset = 0; offset < products.length; offset += batchSize) {
  await Promise.all(products.slice(offset, offset + batchSize).map(async product => {
    try {
      const downloadStarted = performance.now();
      const downloaded = await downloadRemoteImage(product.image_url);
      const downloadMs = Math.round(performance.now() - downloadStarted);
      const processingStarted = performance.now();
      const processed = await prepareImageVariants(downloaded.buffer, { format, quality });
      const processingMs = Math.round(performance.now() - processingStarted);
      let webp84: { imageBytes: number; thumbnailBytes: number; processingMs: number } | undefined;
      if (values['compare-webp'] && format === 'avif') {
        const comparisonStarted = performance.now();
        const comparison = await prepareImageVariants(downloaded.buffer, { format: 'webp', quality: 84 });
        webp84 = { imageBytes: comparison.original.data.length, thumbnailBytes: comparison.thumbnail.data.length, processingMs: Math.round(performance.now() - comparisonStarted) };
      }
      const imagePath = `images/${product.stem}${processed.extension}`;
      const thumbnailPath = `thumbnails/${product.stem}${processed.extension}`;
      await writeFile(path.join(output, imagePath), processed.original.data);
      await writeFile(path.join(output, thumbnailPath), processed.thumbnail.data);
      if (previewDirectory) {
        await sharp(processed.thumbnail.data)
          .resize({ width: 104, height: 104, fit: 'contain', background: '#ffffff' })
          .png()
          .toFile(path.join(path.resolve(previewDirectory), `${product.stem}.png`));
      }
      files.push({
        sourceId: String(product.source_id), sku: product.sku ?? null,
        sourceUrl: product.image_url, sourceContentType: downloaded.contentType,
        sourceSizeBytes: downloaded.buffer.length,
        downloadMs, processingMs, ...(webp84 ? { webp84 } : {}),
        image: { path: imagePath, mimeType: processed.mimeType, width: processed.original.width, height: processed.original.height, sizeBytes: processed.original.data.length, sha256: checksum(processed.original.data) },
        thumbnail: { path: thumbnailPath, mimeType: processed.mimeType, width: processed.thumbnail.width, height: processed.thumbnail.height, sizeBytes: processed.thumbnail.data.length, sha256: checksum(processed.thumbnail.data) }
      });
      console.log(`Prepared ${product.source_id} ${product.sku ?? ''}`);
    } catch (error) {
      errors.push({ sourceId: String(product.source_id), message: error instanceof Error ? error.message : String(error) });
      console.error(`Failed ${product.source_id}: ${errors.at(-1)?.message}`);
    }
  }));
  await saveManifest();
  // Avoid spending the whole batch on an unavailable source.
  if (!files.length && errors.length >= 2) break;
}
console.log(JSON.stringify({ source: products.length, processed: files.length, failed: errors.length, output }));
if (errors.length || files.length !== products.length) process.exitCode = 1;
