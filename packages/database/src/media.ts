import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import type { AppConfig } from '@daja/config';
import { ResourceNotFoundError, ValidationFailedError } from '@daja/security';
import type { RequestContext } from '@daja/shared';

export interface MediaStorageAdapter {
  createPresignedGet(input: { key: string }): Promise<{ downloadUrl: string; expiresAt: Date }>;
  createPresignedPut(input: {
    key: string;
    mimeType: string;
    sizeBytes: number;
    checksumSha256?: string;
  }): Promise<{ uploadUrl: string; expiresAt: Date }>;
  headObject(key: string): Promise<{
    sizeBytes: number;
    mimeType?: string;
    checksumSha256?: string;
    metadata?: Record<string, string>;
  }>;
  getObject(key: string): Promise<Buffer>;
  putObject(input: {
    key: string;
    body: Buffer | Readable;
    contentType: string;
    cacheControl?: string;
    sizeBytes?: number;
    metadata?: Record<string, string>;
  }): Promise<void>;
  copyObject(sourceKey: string, destinationKey: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
  bucket(): string;
  publicUrl(key: string): string | null;
}

export class R2MediaStorageAdapter implements MediaStorageAdapter {
  private readonly client: S3Client;
  private readonly bucketName: string;

  constructor(
    private readonly config: Pick<
      AppConfig,
      | 'R2_ACCOUNT_ID'
      | 'R2_BUCKET'
      | 'R2_ACCESS_KEY_ID'
      | 'R2_SECRET_ACCESS_KEY'
      | 'R2_ENDPOINT'
      | 'MEDIA_PUBLIC_BASE_URL'
    >
  ) {
    if (
      !config.R2_ACCOUNT_ID ||
      !config.R2_BUCKET ||
      !config.R2_ACCESS_KEY_ID ||
      !config.R2_SECRET_ACCESS_KEY
    ) {
      throw new ValidationFailedError('R2 credentials are required for media storage operations');
    }
    this.bucketName = config.R2_BUCKET;
    this.client = new S3Client({
      region: 'auto',
      endpoint: config.R2_ENDPOINT || `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      forcePathStyle: Boolean(config.R2_ENDPOINT),
      credentials: {
        accessKeyId: config.R2_ACCESS_KEY_ID,
        secretAccessKey: config.R2_SECRET_ACCESS_KEY
      }
    });
  }

  async createPresignedPut(input: {
    key: string;
    mimeType: string;
    sizeBytes: number;
    checksumSha256?: string;
  }): Promise<{ uploadUrl: string; expiresAt: Date }> {
    const expiresIn = 900;
    const uploadUrl = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: input.key,
        ContentType: input.mimeType,
        ContentLength: input.sizeBytes,
        ChecksumSHA256: input.checksumSha256
      }),
      { expiresIn }
    );
    return { uploadUrl, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }

  async createPresignedGet(input: {
    key: string;
  }): Promise<{ downloadUrl: string; expiresAt: Date }> {
    const expiresIn = 900;
    const downloadUrl = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucketName, Key: input.key }),
      { expiresIn }
    );
    return { downloadUrl, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }

  async headObject(key: string): Promise<{
    sizeBytes: number;
    mimeType?: string;
    checksumSha256?: string;
    metadata?: Record<string, string>;
  }> {
    const response = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucketName, Key: key })
    );
    return {
      sizeBytes: response.ContentLength ?? 0,
      ...(response.ContentType ? { mimeType: response.ContentType } : {}),
      ...(response.ChecksumSHA256 ? { checksumSha256: response.ChecksumSHA256 } : {}),
      ...(response.Metadata ? { metadata: response.Metadata } : {})
    };
  }

  async getObject(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucketName, Key: key })
    );
    if (!response.Body) throw new ValidationFailedError('Media object body is empty');
    return readObjectBody(response.Body);
  }

  async putObject(input: {
    key: string;
    body: Buffer | Readable;
    contentType: string;
    cacheControl?: string;
    sizeBytes?: number;
    metadata?: Record<string, string>;
  }): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        ...(input.cacheControl ? { CacheControl: input.cacheControl } : {}),
        ...(input.sizeBytes === undefined ? {} : { ContentLength: input.sizeBytes }),
        ...(input.metadata === undefined ? {} : { Metadata: input.metadata })
      })
    );
  }

  async copyObject(sourceKey: string, destinationKey: string): Promise<void> {
    if (sourceKey === destinationKey) return;
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucketName,
        Key: destinationKey,
        // CopySource is a URL path. Encode each key while keeping the path
        // separators so R2 copies an object from the same bucket safely.
        CopySource: `${this.bucketName}/${encodeURIComponent(sourceKey).replace(/%2F/g, '/')}`
      })
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: key }));
  }

  bucket(): string {
    return this.bucketName;
  }

  publicUrl(key: string): string | null {
    return this.config.MEDIA_PUBLIC_BASE_URL
      ? `${this.config.MEDIA_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`
      : null;
  }
}

export class MediaRepository {
  constructor(private readonly client: Pick<pg.Pool | pg.PoolClient, 'query'>) {}

  async createPendingUpload(
    ctx: RequestContext,
    input: {
      mimeType: string;
      sizeBytes: number;
      checksumSha256?: string | undefined;
      originalFilename?: string | undefined;
      productSlug?: string | undefined;
      imageIndex?: number | undefined;
    },
    storage: MediaStorageAdapter
  ): Promise<{
    mediaId: string;
    storageKey: string;
    publicUrl: string | null;
    uploadUrl: string;
    expiresAt: Date;
  }> {
    validateUploadMetadata(input);
    const mediaId = randomUUID();
    const extension = extensionForMime(input.mimeType);
    const storageKey = productMediaStorageKey({
      organizationId: ctx.organizationId,
      mediaId,
      productSlug: input.productSlug,
      imageIndex: input.imageIndex,
      extension
    });
    const publicUrl = storage.publicUrl(storageKey);
    const presign = await storage.createPresignedPut({
      key: storageKey,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      ...(input.checksumSha256 ? { checksumSha256: input.checksumSha256 } : {})
    });
    await this.client.query(
      `INSERT INTO media_assets (id, organization_id, storage_provider, storage_bucket, storage_key, public_url, mime_type, size_bytes, checksum_sha256, status, metadata)
       VALUES ($1, $2, 'r2', $3, $4, $5, $6, $7, $8, 'pending_upload', $9::jsonb)`,
      [
        mediaId,
        ctx.organizationId,
        storage.bucket(),
        storageKey,
        publicUrl,
        input.mimeType,
        input.sizeBytes,
        input.checksumSha256 ?? null,
        JSON.stringify({
          originalFilename: input.originalFilename ?? null,
          productSlug: input.productSlug ?? null,
          imageIndex: input.imageIndex ?? null
        })
      ]
    );
    return { mediaId, storageKey, publicUrl, ...presign };
  }

  async completeUpload(ctx: RequestContext, mediaId: string, storage: MediaStorageAdapter) {
    const asset = await this.getForUpdate(ctx, mediaId);
    if (asset.status !== 'pending_upload') {
      throw new ValidationFailedError('Media asset is not pending upload');
    }
    const object = await storage.headObject(asset.storage_key);
    if (asset.size_bytes !== null && object.sizeBytes !== Number(asset.size_bytes)) {
      throw new ValidationFailedError('Uploaded object size does not match requested size');
    }
    await this.client.query(
      `UPDATE media_assets
       SET status = 'uploaded', mime_type = COALESCE($3, mime_type), size_bytes = $4,
           checksum_sha256 = COALESCE($5, checksum_sha256), version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2`,
      [
        ctx.organizationId,
        mediaId,
        object.mimeType,
        object.sizeBytes,
        object.checksumSha256 ?? null
      ]
    );
    return { mediaId, status: 'uploaded' };
  }

  async markProcessing(
    ctx: Pick<RequestContext, 'organizationId'>,
    mediaId: string
  ): Promise<MediaAssetRow> {
    const result = await this.client.query<MediaAssetRow>(
      `UPDATE media_assets
       SET status = 'processing', version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND status IN ('uploaded', 'processing')
       RETURNING *`,
      [ctx.organizationId, mediaId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new ResourceNotFoundError('media asset');
    }
    return row;
  }

  async markReady(input: {
    organizationId: string;
    mediaId: string;
    width: number;
    height: number;
    derivatives: Array<{
      width: number;
      height: number;
      mimeType: string;
      storageKey: string;
      publicUrl: string;
      sizeBytes: number;
      checksumSha256?: string;
    }>;
  }): Promise<boolean> {
    const updated = await this.client.query<{ id: string }>(
      `UPDATE media_assets
       SET status = 'ready', width = $3, height = $4, version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
       RETURNING id`,
      [input.organizationId, input.mediaId, input.width, input.height]
    );
    // A user may remove an image while the worker is generating thumbnails.
    // Do not recreate derivative metadata for an asset already discarded.
    if (updated.rowCount !== 1) return false;
    for (const derivative of input.derivatives) {
      await this.client.query(
        `INSERT INTO media_derivatives (organization_id, media_asset_id, width, height, mime_type, storage_key, public_url, size_bytes, checksum_sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (media_asset_id, width) DO UPDATE
         SET height = EXCLUDED.height, mime_type = EXCLUDED.mime_type, storage_key = EXCLUDED.storage_key,
             public_url = EXCLUDED.public_url, size_bytes = EXCLUDED.size_bytes, checksum_sha256 = EXCLUDED.checksum_sha256`,
        [
          input.organizationId,
          input.mediaId,
          derivative.width,
          derivative.height,
          derivative.mimeType,
          derivative.storageKey,
          derivative.publicUrl,
          derivative.sizeBytes,
          derivative.checksumSha256 ?? null
        ]
      );
    }
    return true;
  }

  async markFailed(organizationId: string, mediaId: string, reason: string): Promise<void> {
    await this.client.query(
      `UPDATE media_assets
       SET status = 'failed', metadata = metadata || $3::jsonb, version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [organizationId, mediaId, JSON.stringify({ failureReason: reason })]
    );
  }

  /**
   * R2 has object keys rather than real folders. When a product slug changes,
   * copy each linked R2 asset and derivative under the new readable prefix and
   * update the canonical DB references in the active transaction. The caller
   * deletes the old keys only after that transaction commits.
   */
  async relocateProductMedia(
    ctx: Pick<RequestContext, 'organizationId'>,
    input: { productId: string; previousSlug: string; nextSlug: string },
    createStorage: () => MediaStorageAdapter
  ): Promise<{ sourceKeys: string[] }> {
    if (input.previousSlug === input.nextSlug) return { sourceKeys: [] };

    const assets = await this.client.query<{
      mediaId: string;
      storageKey: string;
      mimeType: string;
      position: number;
    }>(
      `SELECT DISTINCT ON (asset.id)
         asset.id AS "mediaId", asset.storage_key AS "storageKey", asset.mime_type AS "mimeType", link.position
       FROM product_media link
       JOIN media_assets asset ON asset.id = link.media_asset_id
       WHERE link.organization_id = $1 AND link.product_id = $2
         AND asset.organization_id = $1 AND asset.storage_provider = 'r2' AND asset.deleted_at IS NULL
       ORDER BY asset.id, link.position ASC`,
      [ctx.organizationId, input.productId]
    );
    if (!assets.rowCount) return { sourceKeys: [] };

    const storage = createStorage();
    const copiedKeys = new Set<string>();
    const sourceKeys = new Set<string>();
    try {
      for (const asset of assets.rows) {
        const originalKey = productMediaStorageKey({
          organizationId: ctx.organizationId,
          mediaId: asset.mediaId,
          productSlug: input.nextSlug,
          imageIndex: Math.max(1, Number(asset.position) + 1),
          extension: extensionFromStorageKey(asset.storageKey, asset.mimeType)
        });
        const derivatives = await this.client.query<{
          id: string;
          width: number;
          storageKey: string;
        }>(
          `SELECT id, width, storage_key AS "storageKey"
           FROM media_derivatives
           WHERE organization_id = $1 AND media_asset_id = $2`,
          [ctx.organizationId, asset.mediaId]
        );

        if (asset.storageKey !== originalKey) {
          await storage.copyObject(asset.storageKey, originalKey);
          copiedKeys.add(originalKey);
          sourceKeys.add(asset.storageKey);
        }
        await this.client.query(
          `UPDATE media_assets
           SET storage_key = $3, public_url = $4,
               metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{productSlug}', to_jsonb($5::text), true),
               version = version + 1, updated_at = now()
           WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
          [
            ctx.organizationId,
            asset.mediaId,
            originalKey,
            storage.publicUrl(originalKey),
            input.nextSlug
          ]
        );

        for (const derivative of derivatives.rows) {
          const derivativeKey = productMediaThumbnailStorageKey({
            originalKey,
            organizationId: ctx.organizationId,
            mediaId: asset.mediaId,
            width: Number(derivative.width)
          });
          if (derivative.storageKey !== derivativeKey) {
            await storage.copyObject(derivative.storageKey, derivativeKey);
            copiedKeys.add(derivativeKey);
            sourceKeys.add(derivative.storageKey);
          }
          await this.client.query(
            `UPDATE media_derivatives
             SET storage_key = $4, public_url = $5
             WHERE organization_id = $1 AND id = $2 AND media_asset_id = $3`,
            [
              ctx.organizationId,
              derivative.id,
              asset.mediaId,
              derivativeKey,
              requiredPublicUrl(storage, derivativeKey)
            ]
          );
        }
      }
      return { sourceKeys: [...sourceKeys] };
    } catch (error) {
      await Promise.allSettled([...copiedKeys].map((key) => storage.deleteObject(key)));
      throw error;
    }
  }

  async deleteStorageObjects(storage: MediaStorageAdapter, keys: Iterable<string>): Promise<void> {
    for (const key of new Set(keys)) await storage.deleteObject(key);
  }

  /**
   * Removes an uploaded asset only when nothing in the catalog still refers to it.
   * The R2 deletes are deliberately performed before the database tombstone: an
   * intermittent storage error leaves the asset available for a later retry
   * instead of making an undeletable orphan invisible to the application.
   */
  async discardUnreferenced(
    ctx: Pick<RequestContext, 'organizationId'>,
    mediaId: string,
    storage: MediaStorageAdapter
  ): Promise<{ deleted: boolean }> {
    const asset = await this.getForUpdate(ctx, mediaId);
    const references = await this.client.query<{ referenced: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM product_media WHERE organization_id = $1 AND media_asset_id = $2
         UNION ALL
         SELECT 1 FROM brands WHERE organization_id = $1 AND logo_media_id = $2 AND deleted_at IS NULL
       ) AS referenced`,
      [ctx.organizationId, mediaId]
    );
    if (references.rows[0]?.referenced) return { deleted: false };

    const derivatives = await this.client.query<{ storage_key: string }>(
      `SELECT storage_key FROM media_derivatives
       WHERE organization_id = $1 AND media_asset_id = $2`,
      [ctx.organizationId, mediaId]
    );
    if (asset.storage_provider === 'r2') {
      const keys = new Set([asset.storage_key, ...derivatives.rows.map((row) => row.storage_key)]);
      for (const key of keys) await storage.deleteObject(key);
    }
    await this.client.query(
      `DELETE FROM media_derivatives WHERE organization_id = $1 AND media_asset_id = $2`,
      [ctx.organizationId, mediaId]
    );
    await this.client.query(
      `UPDATE media_assets
       SET status = 'deleted', deleted_at = now(), version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [ctx.organizationId, mediaId]
    );
    return { deleted: true };
  }

  private async getForUpdate(
    ctx: Pick<RequestContext, 'organizationId'>,
    mediaId: string
  ): Promise<MediaAssetRow> {
    const result = await this.client.query<MediaAssetRow>(
      `SELECT * FROM media_assets WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [ctx.organizationId, mediaId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new ResourceNotFoundError('media asset');
    }
    return row;
  }
}

export interface MediaAssetRow {
  id: string;
  organization_id: string;
  storage_provider: string;
  storage_bucket: string;
  storage_key: string;
  public_url: string | null;
  mime_type: string;
  width: number | null;
  height: number | null;
  size_bytes: string | null;
  checksum_sha256: string | null;
  status: string;
}

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function validateUploadMetadata(input: { mimeType: string; sizeBytes: number }): void {
  if (
    !['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'application/pdf'].includes(
      input.mimeType
    )
  ) {
    throw new ValidationFailedError('Unsupported media MIME type');
  }
  if (
    !Number.isInteger(input.sizeBytes) ||
    input.sizeBytes <= 0 ||
    input.sizeBytes > 25 * 1024 * 1024
  ) {
    throw new ValidationFailedError('Media size must be between 1 byte and 25 MiB');
  }
}

function extensionForMime(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/avif':
      return '.avif';
    case 'application/pdf':
      return '.pdf';
    default:
      return '';
  }
}

function extensionFromStorageKey(storageKey: string, mimeType: string): string {
  const extension = storageKey.match(/(\.[a-z0-9]{1,10})$/i)?.[1];
  return extension?.toLowerCase() ?? extensionForMime(mimeType);
}

function requiredPublicUrl(storage: MediaStorageAdapter, key: string): string {
  const publicUrl = storage.publicUrl(key);
  if (!publicUrl) throw new ValidationFailedError('A public media URL is required for product media');
  return publicUrl;
}

export function productMediaStorageKey(input: {
  organizationId: string;
  mediaId: string;
  productSlug?: string | undefined;
  imageIndex?: number | undefined;
  extension: string;
}): string {
  if (input.productSlug && input.imageIndex) {
    // The human-readable folder stays stable, but the object itself must be
    // unique. Otherwise an async delete of a replaced image can erase a newer
    // upload that reused the same product/index path.
    return `${input.productSlug}/${input.productSlug}-${input.imageIndex}-${input.mediaId}${input.extension}`;
  }
  return `org/${input.organizationId}/media/${input.mediaId}/original${input.extension}`;
}

export function productMediaThumbnailStorageKey(input: {
  originalKey: string;
  organizationId: string;
  mediaId: string;
  width: number;
}): string {
  // Preserve the layout of existing objects. Newly uploaded product assets use
  // one flat product-slug folder for both originals and thumbnails.
  if (input.originalKey.startsWith('org/')) {
    return `org/${input.organizationId}/media/${input.mediaId}/derivatives/${input.width}.webp`;
  }
  return input.originalKey.replace(/\.[^/.]+$/, '-thumb.webp');
}

async function readObjectBody(body: unknown): Promise<Buffer> {
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  }
  throw new ValidationFailedError('Unsupported media object stream');
}
