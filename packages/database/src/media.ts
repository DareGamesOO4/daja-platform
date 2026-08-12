import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AppConfig } from '@daja/config';
import { ResourceNotFoundError, ValidationFailedError } from '@daja/security';
import type { RequestContext } from '@daja/shared';

export interface MediaStorageAdapter {
  createPresignedPut(input: {
    key: string;
    mimeType: string;
    sizeBytes: number;
    checksumSha256?: string;
  }): Promise<{ uploadUrl: string; expiresAt: Date }>;
  headObject(
    key: string
  ): Promise<{ sizeBytes: number; mimeType?: string; checksumSha256?: string }>;
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

  async headObject(
    key: string
  ): Promise<{ sizeBytes: number; mimeType?: string; checksumSha256?: string }> {
    const response = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucketName, Key: key })
    );
    return {
      sizeBytes: response.ContentLength ?? 0,
      ...(response.ContentType ? { mimeType: response.ContentType } : {}),
      ...(response.ChecksumSHA256 ? { checksumSha256: response.ChecksumSHA256 } : {})
    };
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
    },
    storage: MediaStorageAdapter
  ): Promise<{ mediaId: string; storageKey: string; uploadUrl: string; expiresAt: Date }> {
    validateUploadMetadata(input);
    const mediaId = randomUUID();
    const extension = extensionForMime(input.mimeType);
    const storageKey = `org/${ctx.organizationId}/media/${mediaId}/original${extension}`;
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
        storage.publicUrl(storageKey),
        input.mimeType,
        input.sizeBytes,
        input.checksumSha256 ?? null,
        JSON.stringify({ originalFilename: input.originalFilename ?? null })
      ]
    );
    return { mediaId, storageKey, ...presign };
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
  }): Promise<void> {
    await this.client.query(
      `UPDATE media_assets
       SET status = 'ready', width = $3, height = $4, version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2`,
      [input.organizationId, input.mediaId, input.width, input.height]
    );
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
  }

  async markFailed(organizationId: string, mediaId: string, reason: string): Promise<void> {
    await this.client.query(
      `UPDATE media_assets
       SET status = 'failed', metadata = metadata || $3::jsonb, version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2`,
      [organizationId, mediaId, JSON.stringify({ failureReason: reason })]
    );
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
