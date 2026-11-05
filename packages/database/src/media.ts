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
import { prepareAvifMainImage } from './media-images.js';
import { resolveMediaFailures } from './media-alerts.js';

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
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 3_000, requestTimeout: 15_000 },
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
        ChecksumSHA256: input.checksumSha256 ? Buffer.from(input.checksumSha256, 'hex').toString('base64') : undefined
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
    const signal = AbortSignal.timeout(20_000);
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucketName, Key: key }), { abortSignal: signal }
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

  /** A lost COMMIT response is ambiguous. Never erase keys referenced by a
   * successful commit; if PostgreSQL is unavailable leave cleanup for later. */
  async cleanupAttempt(ctx: Pick<RequestContext, 'organizationId'>, mediaId: string, storage: MediaStorageAdapter, keys: Iterable<string>) {
    const referenced = await this.client.query<{ storage_key: string }>(
      `SELECT storage_key FROM media_assets WHERE organization_id=$1 AND id=$2
       UNION ALL SELECT storage_key FROM media_derivatives WHERE organization_id=$1 AND media_asset_id=$2
       UNION ALL SELECT source_key AS storage_key FROM media_derivative_jobs WHERE organization_id=$1 AND media_asset_id=$2`,
      [ctx.organizationId, mediaId]);
    const keep = new Set(referenced.rows.map(row => row.storage_key));
    await Promise.all([...new Set(keys)].filter(key => !keep.has(key)).map(async key => {
      try {
        await storage.deleteObject(key);
      } catch {
        // Each processing attempt writes unique immutable keys. A failed
        // immediate cleanup can therefore be retried durably without racing a
        // later attempt that might reuse the same object name.
        await this.client.query(
          `INSERT INTO media_storage_deletions(organization_id,storage_key) VALUES ($1,$2)
           ON CONFLICT (organization_id,storage_key) DO NOTHING`,
          [ctx.organizationId, key]
        ).catch(() => undefined);
      }
    }));
  }

  async readyUpload(ctx: Pick<RequestContext, 'organizationId'>, mediaId: string) {
    const row = (await this.client.query<{ public_url: string; storage_key: string; width: number; height: number; thumbnail_url: string | null }>(
      `SELECT ma.public_url,ma.storage_key,ma.width,ma.height,
        (SELECT public_url FROM media_derivatives WHERE media_asset_id=ma.id AND mime_type='image/webp' ORDER BY width LIMIT 1) AS thumbnail_url
       FROM media_assets ma WHERE ma.organization_id=$1 AND ma.id=$2 AND ma.status='ready' AND ma.deleted_at IS NULL`,
      [ctx.organizationId, mediaId])).rows[0];
    return row ? { mediaId, status: 'ready', publicUrl: row.public_url, mainImageUrl: row.public_url,
      thumbnailUrl: row.thumbnail_url ?? row.public_url, storageKey: row.storage_key,
      width: row.width, height: row.height, obsoleteStorageKeys: [] as string[] } : null;
  }

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
    thumbnailUrl?: string;
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
          imageIndex: input.imageIndex ?? null,
          storageLayout: 'flat-v1'
        })
      ]
    );
    if (input.mimeType.startsWith('image/')) {
      const mainKey = uploadedImageStorageKey(storageKey);
      const thumbnailKey = productMediaThumbnailStorageKey({
        originalKey: mainKey, organizationId: ctx.organizationId, mediaId, width: 512
      });
      return {
        mediaId, storageKey, ...presign,
        publicUrl: requiredPublicUrl(storage, mainKey),
        thumbnailUrl: requiredPublicUrl(storage, thumbnailKey)
      };
    }
    return { mediaId, storageKey, publicUrl, ...presign };
  }

  /** Reissue a short-lived PUT URL so a browser can resume the same asset after
   * losing its connection or being restarted. Ready assets are idempotent. */
  async resumePendingUpload(ctx: Pick<RequestContext, 'organizationId'>, mediaId: string, storage: MediaStorageAdapter) {
    const ready = await this.readyUpload(ctx, mediaId);
    if (ready) {
      const { storageKey: _storageKey, obsoleteStorageKeys: _obsoleteStorageKeys, ...response } = ready;
      return response;
    }
    const asset = (await this.client.query<MediaAssetRow>(
      `SELECT * FROM media_assets WHERE organization_id=$1 AND id=$2 AND status='pending_upload'
       AND deleted_at IS NULL AND created_at>=now()-interval '23 hours' FOR UPDATE`,
      [ctx.organizationId, mediaId]
    )).rows[0];
    if (!asset) throw new ResourceNotFoundError('resumable media upload');
    if (asset.status !== 'pending_upload') throw new ValidationFailedError('Media upload can no longer be resumed');
    const presign = await storage.createPresignedPut({
      key: asset.storage_key,
      mimeType: asset.mime_type,
      sizeBytes: Number(asset.size_bytes),
      ...(asset.checksum_sha256 ? { checksumSha256: asset.checksum_sha256 } : {})
    });
    const mainKey = uploadedImageStorageKey(asset.storage_key);
    return {
      mediaId,
      status: 'pending_upload',
      storageKey: asset.storage_key,
      publicUrl: asset.mime_type.startsWith('image/') ? requiredPublicUrl(storage, mainKey) : asset.public_url,
      ...(asset.mime_type.startsWith('image/') ? { thumbnailUrl: requiredPublicUrl(storage,
        productMediaThumbnailStorageKey({ originalKey: mainKey, organizationId: ctx.organizationId,
          mediaId, width: 512 })) } : {}),
      ...presign
    };
  }

  /** Read/validate R2 bytes without holding a database transaction or row lock. */
  async readUploadedSource(ctx: Pick<RequestContext, 'organizationId'>, mediaId: string, storage: MediaStorageAdapter) {
    const asset = await this.getForUpdate(ctx, mediaId);
    if (asset.status !== 'pending_upload') throw new ValidationFailedError('Media asset is not pending upload');
    const object = await storage.headObject(asset.storage_key);
    validateUploadMetadata({ mimeType: object.mimeType || '', sizeBytes: object.sizeBytes });
    if (object.mimeType !== asset.mime_type) {
      throw new ValidationFailedError('Uploaded object MIME type does not match requested type');
    }
    if (asset.size_bytes !== null && object.sizeBytes !== Number(asset.size_bytes)) {
      throw new ValidationFailedError('Uploaded object size does not match requested size');
    }
    const bytes = await storage.getObject(asset.storage_key);
    if (bytes.length !== object.sizeBytes) throw new ValidationFailedError('Uploaded content size changed');
    validateMediaBytes(bytes, asset.mime_type);
    if (asset.checksum_sha256 && sha256(bytes) !== asset.checksum_sha256.toLowerCase()) {
      throw new ValidationFailedError('Uploaded content checksum does not match');
    }
    return { asset, bytes, object };
  }

  async completeUpload(ctx: RequestContext, mediaId: string, storage: MediaStorageAdapter, createdKeys: Set<string>,
    prepared?: Awaited<ReturnType<MediaRepository['stageUploadedImage']>>,
    validated?: Awaited<ReturnType<MediaRepository['readUploadedSource']>>) {
    const asset = await this.getForUpdate(ctx, mediaId);
    if (asset.status === 'ready') {
      const ready = await this.readyUpload(ctx, mediaId);
      if (ready) return { ...ready, obsoleteStorageKeys: [...createdKeys] };
    }
    if (asset.status !== 'pending_upload') throw new ValidationFailedError('Media asset is not pending upload');
    if (prepared) return this.optimizeUploadedImage(ctx, mediaId, storage, createdKeys, undefined, prepared);
    // Enforce preparation before BEGIN; never silently reintroduce slow I/O here.
    if (!validated || validated.asset.storage_key !== asset.storage_key || asset.mime_type.startsWith('image/')) {
      throw new ValidationFailedError('Upload must be prepared before its database transaction');
    }
    const { bytes, object } = validated;
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
        sha256(bytes)
      ]
    );
    return { mediaId, status: 'uploaded', obsoleteStorageKeys: [] as string[] };
  }

  /** CPU encoding and R2 writes happen outside the metadata transaction. */
  async stageUploadedImage(ctx: Pick<RequestContext, 'organizationId'>, mediaId: string,
    storage: MediaStorageAdapter, createdKeys: Set<string>, source?: { asset: MediaAssetRow; bytes: Buffer }) {
    const asset = source?.asset ?? await this.getForUpdate(ctx, mediaId);
    if (!['pending_upload', 'uploaded', 'processing'].includes(asset.status)) {
      throw new ValidationFailedError('Media asset is not awaiting image processing');
    }
    const bytes = source?.bytes ?? await storage.getObject(asset.storage_key);
    const original = await prepareAvifMainImage(bytes);
    const mainKey = productMediaVariantKeys(asset, randomUUID()).avif;
    const publicUrl = requiredPublicUrl(storage, mainKey);
    const processed = { original, mimeType: 'image/avif' as const };
    const objects = [{ key: mainKey, image: original, mimeType: 'image/avif' as const }];
    createdKeys.add(mainKey);
    await storage.putObject({ key: mainKey, body: original.data, contentType: 'image/avif',
      cacheControl: 'public, max-age=31536000, immutable' });
    return { asset, processed, mainKey, publicUrl, thumbnailUrl: publicUrl, objects,
      sourceChecksum: sha256(bytes) };
  }

  /** Caller owns only the short database metadata transaction. */
  async optimizeUploadedImage(ctx: Pick<RequestContext, 'organizationId'>, mediaId: string,
    storage: MediaStorageAdapter, createdKeys: Set<string>, source?: { asset: MediaAssetRow; bytes: Buffer },
    prepared?: Awaited<ReturnType<MediaRepository['stageUploadedImage']>>) {
    const asset = await this.getForUpdate(ctx, mediaId);
    if (!['pending_upload', 'uploaded', 'processing'].includes(asset.status)) {
      throw new ValidationFailedError('Media asset is not awaiting image processing');
    }
    if (prepared && (prepared.asset.storage_key !== asset.storage_key || prepared.asset.checksum_sha256 !== asset.checksum_sha256)) {
      throw new ValidationFailedError('Media asset changed during processing');
    }
    if (!prepared) throw new ValidationFailedError('Image must be prepared before its database transaction');
    const { processed, mainKey, publicUrl, thumbnailUrl, objects } = prepared;
    const previous = await this.client.query<{ storage_key: string }>(
      'SELECT storage_key FROM media_derivatives WHERE organization_id = $1 AND media_asset_id = $2',
      [ctx.organizationId, mediaId]);
    const ready = await this.markReady({
      organizationId: ctx.organizationId, mediaId,
      width: processed.original.width, height: processed.original.height,
      original: { storageKey: mainKey, publicUrl, mimeType: processed.mimeType,
        sizeBytes: processed.original.data.length, checksumSha256: sha256(processed.original.data) },
      replaceDerivatives: true,
      derivatives: objects.slice(1).map(({ key, image, mimeType }) => ({
        width: image.width, height: image.height, mimeType, storageKey: key,
        publicUrl: requiredPublicUrl(storage, key), sizeBytes: image.data.length,
        checksumSha256: sha256(image.data)
      }))
    });
    if (!ready) throw new ResourceNotFoundError('media asset');
    await resolveMediaFailures(this.client,ctx.organizationId,mediaId,'upload');
    // Persist the original and its deferred work atomically with the visible AVIF.
    await this.client.query(
      `INSERT INTO media_derivative_jobs
       (organization_id,media_asset_id,source_key,source_checksum,avif_main_key)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (organization_id,media_asset_id) DO NOTHING`,
      [ctx.organizationId, mediaId, asset.storage_key, prepared.sourceChecksum, mainKey]
    );
    return {
      mediaId, status: 'ready', publicUrl, mainImageUrl: publicUrl, thumbnailUrl, storageKey: mainKey,
      width: processed.original.width, height: processed.original.height,
      obsoleteStorageKeys: [...new Set([asset.storage_key, ...previous.rows.map(row => row.storage_key)])]
        .filter(key => key !== asset.storage_key && !objects.some(object => object.key === key))
    };
  }

  async markProcessing(
    ctx: Pick<RequestContext, 'organizationId'>,
    mediaId: string
  ): Promise<MediaAssetRow> {
    const result = await this.client.query<MediaAssetRow>(
      `UPDATE media_assets
       SET status = 'processing', version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL AND status IN ('uploaded', 'processing', 'failed')
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
    original?: {
      storageKey: string; publicUrl: string; mimeType: string; sizeBytes: number; checksumSha256: string;
    };
    replaceDerivatives?: boolean;
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
       SET status = 'ready', width = $3, height = $4,
           storage_key = COALESCE($5, storage_key), public_url = COALESCE($6, public_url),
           mime_type = COALESCE($7, mime_type), size_bytes = COALESCE($8, size_bytes),
           checksum_sha256 = COALESCE($9, checksum_sha256), version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
       RETURNING id`,
      [input.organizationId, input.mediaId, input.width, input.height,
        input.original?.storageKey ?? null, input.original?.publicUrl ?? null,
        input.original?.mimeType ?? null, input.original?.sizeBytes ?? null, input.original?.checksumSha256 ?? null]
    );
    // A user may remove an image while the worker is generating thumbnails.
    // Do not recreate derivative metadata for an asset already discarded.
    if (updated.rowCount !== 1) return false;
    if (input.replaceDerivatives) {
      await this.client.query('DELETE FROM media_derivatives WHERE organization_id = $1 AND media_asset_id = $2',
        [input.organizationId, input.mediaId]);
    }
    for (const derivative of input.derivatives) {
      await this.client.query(
        `INSERT INTO media_derivatives (organization_id, media_asset_id, width, height, mime_type, storage_key, public_url, size_bytes, checksum_sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (media_asset_id, storage_key) DO UPDATE
         SET width = EXCLUDED.width, height = EXCLUDED.height, mime_type = EXCLUDED.mime_type, storage_key = EXCLUDED.storage_key,
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
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL AND status <> 'ready'`,
      [organizationId, mediaId, JSON.stringify({ failureReason: reason })]
    );
  }

  /** Slug changes must not copy R2 objects inside a catalog transaction.
   * Existing immutable URLs remain valid; new uploads use the new slug prefix. */
  async relocateProductMedia(
    _ctx: Pick<RequestContext, 'organizationId'>,
    _input: { productId: string; previousSlug: string; nextSlug: string },
    _createStorage: () => MediaStorageAdapter
  ): Promise<{ sourceKeys: string[] }> {
    return { sourceKeys: [] };
  }

  async deleteStorageObjects(storage: MediaStorageAdapter, keys: Iterable<string>): Promise<void> {
    for (const key of new Set(keys)) await storage.deleteObject(key);
  }

  /**
   * Removes an uploaded asset only when nothing in the catalog still refers to it.
   * Persist storage cleanup in the same short transaction as the tombstone.
   * A failed R2 deletion is retried by the API cleanup consumer.
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
    const deferred = await this.client.query<{ source_key: string }>(
      'DELETE FROM media_derivative_jobs WHERE organization_id=$1 AND media_asset_id=$2 RETURNING source_key',
      [ctx.organizationId, mediaId]
    );
    // A failed temporary upload being discarded is still an issue for the
    // administrator; keep its notification until it is explicitly closed.
    await resolveMediaFailures(this.client,ctx.organizationId,mediaId,asset.status === 'ready' ? undefined : 'overnight','removed');
    if (asset.storage_provider === 'r2') {
      const keys = new Set([asset.storage_key, ...derivatives.rows.map((row) => row.storage_key),
        ...deferred.rows.map(row => row.source_key)]);
      for (const key of keys) await this.client.query(
        `INSERT INTO media_storage_deletions (organization_id, storage_key, available_at) VALUES ($1,$2,
         CASE WHEN $3::boolean THEN now()+interval '16 minutes' ELSE now() END)
         ON CONFLICT (organization_id, storage_key) DO NOTHING`,
        [ctx.organizationId, key, asset.status === 'pending_upload' && key === asset.storage_key]);
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
  metadata?: Record<string, unknown>;
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

export function validateMediaBytes(bytes: Buffer, mimeType: string): void {
  const head = bytes.subarray(0, 32);
  const valid = mimeType === 'image/jpeg' ? head.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
    : mimeType === 'image/png' ? head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mimeType === 'image/webp' ? head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP'
    : mimeType === 'image/avif' ? head.toString('ascii', 4, 8) === 'ftyp' && ['avif', 'avis'].some(brand => head.includes(Buffer.from(brand)))
    : mimeType === 'application/pdf' && head.toString('ascii', 0, 5) === '%PDF-';
  if (!valid) throw new ValidationFailedError('File content does not match the declared media type');
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
    // Keep the picture folder readable; unique filenames prevent replacement
    // cleanup from deleting another asset that uses the same picture index.
    const name = `${input.productSlug}-slika-${input.imageIndex}`;
    return `${input.productSlug}/${name}/${name}-${input.mediaId}-source${input.extension}`;
  }
  return `org/${input.organizationId}/media/${input.mediaId}/original${input.extension}`;
}

function uploadedImageStorageKey(sourceKey: string): string {
  if (sourceKey.includes('/source/')) return sourceKey.replace(/\/source\/([^/]+)\.[^/.]+$/, '/preview/$1.webp');
  // A fresh URL avoids caching the unprocessed upload as the optimized image.
  return sourceKey.replace(/(?:-avif65-webp75-main)?\.[^/.]+$/, '') + '-avif65-webp75-main.webp';
}

/** New assets use flat picture folders with immutable per-attempt filenames. */
export function productMediaVariantKeys(asset: MediaAssetRow, revision: string) {
  const metadata = asset.metadata ?? {};
  const slug = typeof metadata.productSlug === 'string'
    ? metadata.productSlug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') : '';
  const index = Number(metadata.imageIndex);
  const name = `${slug || 'image'}-${Number.isSafeInteger(index) && index > 0 ? index : 1}`;
  if (slug && metadata.storageLayout === 'flat-v1') {
    const picture = `${slug}-slika-${Number.isSafeInteger(index) && index > 0 ? index : 1}`;
    const base = `${slug}/${picture}/${picture}-${asset.id}-${revision}`;
    return { avif: `${base}.avif`, webp: `${base}.webp`, avifThumb: `${base}-thumb.avif`, webpThumb: `${base}-thumb.webp` };
  }
  const folder = slug ? `${slug}/${asset.id}/${revision}` : `org/${asset.organization_id}/media/${asset.id}/${revision}`;
  const base = `${folder}/${name}`;
  return { avif: `${base}.avif`, webp: `${base}.webp`, avifThumb: `${base}-thumb.avif`, webpThumb: `${base}-thumb.webp` };
}

export function productMediaThumbnailStorageKey(input: {
  originalKey: string;
  organizationId: string;
  mediaId: string;
  width: number;
}): string {
  if (input.originalKey.endsWith('-avif65-webp75-main.webp')) {
    return input.originalKey.replace(/-main\.webp$/, '-thumb.webp');
  }
  // Preserve the layout of existing org assets. Product versions keep the
  // thumbnail beside their main file with a short -thumb suffix.
  if (input.originalKey.startsWith('org/')) {
    return `org/${input.organizationId}/media/${input.mediaId}/derivatives/${input.width}.webp`;
  }
  return input.originalKey.replace(/\.[^/.]+$/, '-thumb.webp');
}

async function readObjectBody(body: unknown): Promise<Buffer> {
  const maximum = 25 * 1024 * 1024;
  if (body instanceof Uint8Array) {
    if (body.byteLength > maximum) throw new ValidationFailedError('Media exceeds 25 MiB');
    return Buffer.from(body);
  }
  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
      let size = 0;
    for await (const chunk of body) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += bytes.length;
        if (size > maximum) throw new ValidationFailedError('Media exceeds 25 MiB');
        chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  }
  throw new ValidationFailedError('Unsupported media object stream');
}
