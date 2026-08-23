import { createHash, randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@daja/config';
import { R2MediaStorageAdapter, type Database } from '@daja/database';
import {
  ResourceConflictError,
  ResourceNotFoundError,
  ValidationFailedError,
  requirePermission
} from '@daja/security';
import type { RequestContext } from '@daja/shared';
import { z } from 'zod';
import { CONFIG, DATABASE } from './tokens.js';

const MAX_PACKAGE_BYTES = 500 * 1024 * 1024;
const pluginIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,79}$/);
const pluginVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const checksumSchema = z.string().regex(/^[a-f0-9]{64}$/);
const platformSchema = z.enum(['win32', 'darwin', 'linux', 'android', 'ios']);
const kindSchema = z.enum(['rfid_reader', 'barcode_scanner', 'printer', 'gateway', 'integration']);

const pluginDescriptorSchema = z.object({
  schemaVersion: z.literal(1),
  id: pluginIdSchema,
  name: z.string().trim().min(1).max(120),
  vendor: z.string().trim().min(1).max(120),
  kind: kindSchema,
  version: pluginVersionSchema,
  summary: z.string().trim().min(1).max(240),
  description: z.string().trim().min(1).max(2_000),
  models: z.array(z.string().trim().min(1).max(120)).min(1).max(30),
  platforms: z.array(platformSchema).min(1),
  capabilities: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
  minAppVersion: pluginVersionSchema.optional(),
  releaseNotes: z.string().trim().max(2_000).optional()
});

export const createDevicePluginReleaseSchema = pluginDescriptorSchema.extend({
  packageSizeBytes: z.number().int().min(1).max(MAX_PACKAGE_BYTES),
  packageChecksumSha256: checksumSchema
});

const pluginManifestSchema = pluginDescriptorSchema.extend({
  publishedAt: z.string().datetime({ offset: true }),
  packageSizeBytes: z.number().int().min(1).max(MAX_PACKAGE_BYTES),
  packageChecksumSha256: checksumSchema
});

export type CreateDevicePluginRelease = z.infer<typeof createDevicePluginReleaseSchema>;
export type DevicePluginManifest = z.infer<typeof pluginManifestSchema>;

export interface DevicePluginAdminRelease {
  id: string;
  version: string;
  name: string;
  vendor: string;
  status: 'draft' | 'published' | 'unpublished';
  packageSizeBytes: number;
  packageChecksumSha256: string;
  publishedAt?: string;
  unpublishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DevicePluginReleaseUpload {
  release: DevicePluginAdminRelease;
  upload: {
    path: string;
    method: 'PUT';
    headers: { 'content-type': 'application/zip' };
  };
}

interface PluginReleaseRow {
  id: string;
  plugin_id: string;
  name: string;
  vendor: string;
  kind: string;
  version: string;
  summary: string;
  description: string;
  models: unknown;
  platforms: unknown;
  capabilities: unknown;
  min_app_version: string | null;
  release_notes: string | null;
  status: 'draft' | 'published' | 'unpublished';
  package_storage_key: string;
  package_size_bytes: string;
  package_checksum_sha256: string;
  published_at: Date | null;
  unpublished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const releaseColumns = `
  id, plugin_id, name, vendor, kind, version, summary, description, models, platforms, capabilities,
  min_app_version, release_notes, status, package_storage_key, package_size_bytes,
  package_checksum_sha256, published_at, unpublished_at, created_at, updated_at
`;

@Injectable()
export class DevicePluginsService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database
  ) {}

  async catalog(): Promise<{
    schemaVersion: 1;
    generatedAt: string;
    plugins: DevicePluginManifest[];
  }> {
    const result = await this.database.pool.query<PluginReleaseRow>(
      `SELECT DISTINCT ON (plugin_id) ${releaseColumns}
       FROM device_plugin_releases
       WHERE status = 'published'
       ORDER BY plugin_id, published_at DESC, created_at DESC`
    );
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      plugins: result.rows
        .map((release) => manifestFromRow(release))
        .sort((left, right) => left.name.localeCompare(right.name))
    };
  }

  async listReleases(ctx: RequestContext): Promise<DevicePluginAdminRelease[]> {
    this.requirePublisher(ctx);
    const result = await this.database.pool.query<PluginReleaseRow>(
      `SELECT ${releaseColumns}
       FROM device_plugin_releases
       ORDER BY updated_at DESC, plugin_id, version DESC`
    );
    return result.rows.map((release) => adminReleaseFromRow(release));
  }

  async createRelease(
    ctx: RequestContext,
    input: CreateDevicePluginRelease
  ): Promise<DevicePluginReleaseUpload> {
    this.requirePublisher(ctx);
    const release = createDevicePluginReleaseSchema.parse(input);
    const id = randomUUID();
    const storageKey = `platform/device-plugins/${release.id}/${release.version}/${id}.zip`;

    try {
      const result = await this.database.pool.query<PluginReleaseRow>(
        `INSERT INTO device_plugin_releases (
           id, plugin_id, name, vendor, kind, version, summary, description, models, platforms,
           capabilities, min_app_version, release_notes, package_storage_key, package_size_bytes,
           package_checksum_sha256, created_by_organization_id, created_by_user_id
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb,
           $11::jsonb, $12, $13, $14, $15, $16, $17, $18
         )
         RETURNING ${releaseColumns}`,
        [
          id,
          release.id,
          release.name,
          release.vendor,
          release.kind,
          release.version,
          release.summary,
          release.description,
          JSON.stringify(release.models),
          JSON.stringify(release.platforms),
          JSON.stringify(release.capabilities),
          release.minAppVersion ?? null,
          release.releaseNotes ?? null,
          storageKey,
          release.packageSizeBytes,
          release.packageChecksumSha256,
          ctx.organizationId,
          ctx.userId
        ]
      );
      const row = result.rows[0];
      if (!row) throw new Error('Plugin release insert returned no row');
      return {
        release: adminReleaseFromRow(row),
        upload: {
          path: `/api/v1/plugins/admin/releases/${release.id}/${release.version}/archive`,
          method: 'PUT',
          headers: {
            'content-type': 'application/zip'
          }
        }
      };
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ResourceConflictError('A plugin release with this ID and version already exists');
      }
      throw error;
    }
  }

  async uploadReleaseArchive(
    ctx: RequestContext,
    pluginIdInput: string,
    versionInput: string,
    source: Readable
  ): Promise<DevicePluginAdminRelease> {
    this.requirePublisher(ctx);
    const pluginId = pluginIdSchema.parse(pluginIdInput);
    const version = pluginVersionSchema.parse(versionInput);
    const release = await this.requireRelease(pluginId, version);
    if (release.status !== 'draft') {
      throw new ResourceConflictError('Only a draft plugin release can receive an SDK archive');
    }

    const expectedSizeBytes = Number(release.package_size_bytes);
    let receivedSizeBytes = 0;
    const digest = createSha256Transform(expectedSizeBytes, (sizeBytes) => {
      receivedSizeBytes = sizeBytes;
    });
    const storage = this.storage();
    const upload = storage.putObject({
      key: release.package_storage_key,
      body: digest,
      contentType: 'application/zip',
      sizeBytes: expectedSizeBytes,
      metadata: { sha256: release.package_checksum_sha256 }
    });
    try {
      await pipeline(source, digest);
      await upload;
      if (
        receivedSizeBytes !== expectedSizeBytes ||
        !digest.isZip() ||
        digest.checksum() !== release.package_checksum_sha256
      ) {
        throw new ValidationFailedError(
          'The uploaded SDK archive does not match the plugin release'
        );
      }
    } catch (error) {
      await Promise.all([
        upload.catch(() => undefined),
        storage.deleteObject(release.package_storage_key).catch(() => undefined)
      ]);
      throw error;
    }
    return adminReleaseFromRow(release);
  }

  async publishRelease(
    ctx: RequestContext,
    pluginIdInput: string,
    versionInput: string
  ): Promise<DevicePluginManifest> {
    this.requirePublisher(ctx);
    const pluginId = pluginIdSchema.parse(pluginIdInput);
    const version = pluginVersionSchema.parse(versionInput);
    const release = await this.requireRelease(pluginId, version);
    if (release.status !== 'draft') {
      throw new ResourceConflictError('Only a draft plugin release can be published');
    }

    const object = await this.storage().headObject(release.package_storage_key);
    if (
      object.sizeBytes !== Number(release.package_size_bytes) ||
      object.mimeType !== 'application/zip' ||
      object.metadata?.sha256 !== release.package_checksum_sha256
    ) {
      throw new ValidationFailedError('The uploaded SDK archive does not match the plugin release');
    }

    const result = await this.database.pool.query<PluginReleaseRow>(
      `UPDATE device_plugin_releases
       SET status = 'published', published_at = now(), unpublished_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'draft'
       RETURNING ${releaseColumns}`,
      [release.id]
    );
    const published = result.rows[0];
    if (!published) {
      throw new ResourceConflictError('Plugin release changed before it could be published');
    }
    return manifestFromRow(published);
  }

  async unpublishRelease(
    ctx: RequestContext,
    pluginIdInput: string,
    versionInput: string
  ): Promise<void> {
    this.requirePublisher(ctx);
    const pluginId = pluginIdSchema.parse(pluginIdInput);
    const version = pluginVersionSchema.parse(versionInput);
    const result = await this.database.pool.query(
      `UPDATE device_plugin_releases
       SET status = 'unpublished', unpublished_at = now(), updated_at = now()
       WHERE plugin_id = $1 AND version = $2 AND status = 'published'`,
      [pluginId, version]
    );
    if (result.rowCount !== 1) {
      throw new ResourceConflictError('Only a published plugin release can be unpublished');
    }
  }

  async download(pluginIdInput: string, versionInput: string): Promise<{ downloadUrl: string }> {
    const pluginId = pluginIdSchema.parse(pluginIdInput);
    const version = pluginVersionSchema.parse(versionInput);
    const result = await this.database.pool.query<PluginReleaseRow>(
      `SELECT ${releaseColumns}
       FROM device_plugin_releases
       WHERE plugin_id = $1 AND version = $2 AND status = 'published'`,
      [pluginId, version]
    );
    const release = result.rows[0];
    if (!release) throw new ResourceNotFoundError('plugin package');
    const signed = await this.storage().createPresignedGet({ key: release.package_storage_key });
    return { downloadUrl: signed.downloadUrl };
  }

  private async requireRelease(pluginId: string, version: string): Promise<PluginReleaseRow> {
    const result = await this.database.pool.query<PluginReleaseRow>(
      `SELECT ${releaseColumns}
       FROM device_plugin_releases
       WHERE plugin_id = $1 AND version = $2`,
      [pluginId, version]
    );
    const release = result.rows[0];
    if (!release) throw new ResourceNotFoundError('plugin release');
    return release;
  }

  private requirePublisher(ctx: RequestContext): void {
    requirePermission(ctx, 'catalog.write');
    requirePermission(ctx, 'admin.users');
  }

  private storage(): R2MediaStorageAdapter {
    return new R2MediaStorageAdapter(this.config);
  }
}

function manifestFromRow(release: PluginReleaseRow): DevicePluginManifest {
  return pluginManifestSchema.parse({
    schemaVersion: 1,
    id: release.plugin_id,
    name: release.name,
    vendor: release.vendor,
    kind: release.kind,
    version: release.version,
    summary: release.summary,
    description: release.description,
    models: release.models,
    platforms: release.platforms,
    capabilities: release.capabilities,
    ...(release.min_app_version ? { minAppVersion: release.min_app_version } : {}),
    ...(release.release_notes ? { releaseNotes: release.release_notes } : {}),
    publishedAt: release.published_at?.toISOString(),
    packageSizeBytes: Number(release.package_size_bytes),
    packageChecksumSha256: release.package_checksum_sha256
  });
}

function adminReleaseFromRow(release: PluginReleaseRow): DevicePluginAdminRelease {
  return {
    id: release.plugin_id,
    version: release.version,
    name: release.name,
    vendor: release.vendor,
    status: release.status,
    packageSizeBytes: Number(release.package_size_bytes),
    packageChecksumSha256: release.package_checksum_sha256,
    ...(release.published_at ? { publishedAt: release.published_at.toISOString() } : {}),
    ...(release.unpublished_at ? { unpublishedAt: release.unpublished_at.toISOString() } : {}),
    createdAt: release.created_at.toISOString(),
    updatedAt: release.updated_at.toISOString()
  };
}

function createSha256Transform(
  maxSizeBytes: number,
  onSize: (sizeBytes: number) => void
): Transform & { checksum(): string; isZip(): boolean } {
  const hash = createHash('sha256');
  const header = Buffer.alloc(4);
  let headerLength = 0;
  let sizeBytes = 0;
  const transform = new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      if (headerLength < header.byteLength) {
        const copyLength = Math.min(header.byteLength - headerLength, chunk.byteLength);
        chunk.copy(header, headerLength, 0, copyLength);
        headerLength += copyLength;
      }
      sizeBytes += chunk.byteLength;
      if (sizeBytes > maxSizeBytes) {
        callback(new ValidationFailedError('SDK archive exceeds the maximum allowed size'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback): void {
      onSize(sizeBytes);
      callback();
    }
  }) as Transform & { checksum(): string; isZip(): boolean };
  let checksum: string | undefined;
  transform.checksum = () => {
    checksum ??= hash.digest('hex');
    return checksum;
  };
  transform.isZip = () => headerLength >= 2 && header[0] === 0x50 && header[1] === 0x4b;
  return transform;
}
