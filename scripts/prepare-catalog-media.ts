/**
 * Offline only: downloads and processes catalogue images without database or R2 writes.
 * Usage: npx tsx scripts/prepare-catalog-media.ts input.json output-dir [excel-preview-dir]
 * Input: { products: [{ source_id, sku?, image_url }] }
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { prepareRemoteImage } from '../apps/api/src/remote-media.service.js';

interface SourceProduct {
  source_id: string;
  sku?: string;
  image_url: string;
}

const [inputFile, outputDirectory, previewDirectory] = process.argv.slice(2);
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
    processor: 'daja-platform/apps/api/src/remote-media.service.ts#prepareRemoteImage',
    presets: { main: { maxWidth: 2048, maxHeight: 2048, quality: 84 }, thumbnail: { maxWidth: 512, quality: 80 }, format: 'webp', withoutEnlargement: true },
    sourceCount: products.length,
    processedCount: files.length,
    files: [...files].sort((a, b) => String(a.sourceId).localeCompare(String(b.sourceId), undefined, { numeric: true })),
    errors
  }, null, 2) + '\n');
}

for (let offset = 0; offset < products.length; offset += 2) {
  await Promise.all(products.slice(offset, offset + 2).map(async product => {
    try {
      const processed = await prepareRemoteImage(product.image_url);
      const imagePath = `images/${product.stem}.webp`;
      const thumbnailPath = `thumbnails/${product.stem}.webp`;
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
        sourceUrl: product.image_url, sourceContentType: processed.sourceContentType,
        sourceSizeBytes: processed.sourceSizeBytes,
        image: { path: imagePath, mimeType: 'image/webp', width: processed.original.width, height: processed.original.height, sizeBytes: processed.original.data.length, sha256: checksum(processed.original.data) },
        thumbnail: { path: thumbnailPath, mimeType: 'image/webp', width: processed.thumbnail.width, height: processed.thumbnail.height, sizeBytes: processed.thumbnail.data.length, sha256: checksum(processed.thumbnail.data) }
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
