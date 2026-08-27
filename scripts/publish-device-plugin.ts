import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { Client } from 'pg';

interface ReleaseRow {
  name: string;
  vendor: string;
  kind: string;
  summary: string;
  description: string;
  models: unknown;
  platforms: unknown;
  capabilities: unknown;
  min_app_version: string | null;
}

interface Options {
  archivePath: string;
  pluginId: string;
  version: string;
  releaseNotes: string;
}

const PLUGIN_ID = /^[a-z][a-z0-9-]{1,79}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parseOptions(arguments_: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (!option?.startsWith('--')) throw new Error(`Unexpected argument: ${option}`);
    const value = arguments_[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
    values.set(option, value);
    index += 1;
  }

  const archivePath = values.get('--archive');
  const pluginId = values.get('--plugin-id');
  const version = values.get('--version');
  if (!archivePath || !pluginId || !version) {
    throw new Error(
      'Usage: publish-device-plugin --archive <zip> --plugin-id <id> --version <version>'
    );
  }
  if (!PLUGIN_ID.test(pluginId)) throw new Error('Plugin ID is not valid.');
  if (!VERSION.test(version)) throw new Error('Plugin version is not valid.');
  const releaseNotes =
    values.get('--release-notes') ??
    'Updated device plugin runtime.';
  if (releaseNotes.length > 2_000) throw new Error('Plugin release notes are too long.');
  return { archivePath: resolve(archivePath), pluginId, version, releaseNotes };
}

async function sha256(path: string): Promise<string> {
  return await new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const source = createReadStream(path);
    source.once('error', reject);
    source.on('data', (chunk) => hash.update(chunk));
    source.once('end', () => resolveHash(hash.digest('hex')));
  });
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const archive = await stat(options.archivePath);
  if (!archive.isFile() || archive.size < 4) throw new Error('Plugin archive is not a valid file.');
  const checksum = await sha256(options.archivePath);

  const database = new Client({
    connectionString: requiredEnvironment('DATABASE_URL'),
    ssl: { rejectUnauthorized: false }
  });
  const storage = new S3Client({
    region: 'auto',
    endpoint: requiredEnvironment('R2_ENDPOINT'),
    forcePathStyle: true,
    credentials: {
      accessKeyId: requiredEnvironment('R2_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnvironment('R2_SECRET_ACCESS_KEY')
    }
  });
  const bucket = requiredEnvironment('R2_BUCKET');
  const releaseId = randomUUID();
  const storageKey = `platform/device-plugins/${options.pluginId}/${options.version}/${releaseId}.zip`;
  let archiveUploaded = false;

  await database.connect();
  try {
    const baseline = (
      await database.query<ReleaseRow>(
        `SELECT name, vendor, kind, summary, description, models, platforms, capabilities, min_app_version
         FROM device_plugin_releases
         WHERE plugin_id = $1
         ORDER BY published_at DESC NULLS LAST, created_at DESC
         LIMIT 1`,
        [options.pluginId]
      )
    ).rows[0];
    if (!baseline) throw new Error(`No existing release found for ${options.pluginId}.`);

    const alreadyExists = await database.query(
      'SELECT 1 FROM device_plugin_releases WHERE plugin_id = $1 AND version = $2',
      [options.pluginId, options.version]
    );
    if (alreadyExists.rowCount) {
      throw new Error(
        `${options.pluginId}@${options.version} already exists and will not be overwritten.`
      );
    }

    const owner = (
      await database.query<{ organization_id: string; user_id: string }>(
        `SELECT created_by_organization_id AS organization_id, created_by_user_id AS user_id
         FROM device_plugin_releases
         WHERE plugin_id = $1
         ORDER BY published_at DESC NULLS LAST, created_at DESC
         LIMIT 1`,
        [options.pluginId]
      )
    ).rows[0];
    if (!owner) throw new Error(`No release owner found for ${options.pluginId}.`);

    await database.query('BEGIN');
    await database.query(
      `INSERT INTO device_plugin_releases (
         id, plugin_id, name, vendor, kind, version, summary, description, models, platforms,
         capabilities, min_app_version, release_notes, package_storage_key, package_size_bytes,
         package_checksum_sha256, created_by_organization_id, created_by_user_id
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb,
         $11::jsonb, $12, $13, $14, $15, $16, $17, $18
       )`,
      [
        releaseId,
        options.pluginId,
        baseline.name,
        baseline.vendor,
        baseline.kind,
        options.version,
        baseline.summary,
        baseline.description,
        JSON.stringify(baseline.models),
        JSON.stringify(baseline.platforms),
        JSON.stringify(baseline.capabilities),
        baseline.min_app_version,
        options.releaseNotes,
        storageKey,
        archive.size,
        checksum,
        owner.organization_id,
        owner.user_id
      ]
    );
    await database.query('COMMIT');

    await storage.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: storageKey,
        Body: createReadStream(options.archivePath),
        ContentType: 'application/zip',
        ContentLength: archive.size,
        Metadata: { sha256: checksum }
      })
    );
    archiveUploaded = true;
    const uploaded = await storage.send(new HeadObjectCommand({ Bucket: bucket, Key: storageKey }));
    if (
      uploaded.ContentLength !== archive.size ||
      uploaded.ContentType !== 'application/zip' ||
      uploaded.Metadata?.sha256 !== checksum
    ) {
      throw new Error('R2 verification of the uploaded plugin archive failed.');
    }

    const published = await database.query(
      `UPDATE device_plugin_releases
       SET status = 'published', published_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'draft'`,
      [releaseId]
    );
    if (published.rowCount !== 1) throw new Error('Plugin release could not be published.');

    console.log(
      JSON.stringify({
        pluginId: options.pluginId,
        version: options.version,
        archive: basename(options.archivePath),
        packageSizeBytes: archive.size,
        packageChecksumSha256: checksum,
        storageKey,
        status: 'published'
      })
    );
  } catch (error) {
    await database.query('ROLLBACK').catch(() => undefined);
    if (archiveUploaded) {
      await storage
        .send(new DeleteObjectCommand({ Bucket: bucket, Key: storageKey }))
        .catch(() => undefined);
    }
    await database
      .query('DELETE FROM device_plugin_releases WHERE id = $1 AND status = $2', [
        releaseId,
        'draft'
      ])
      .catch(() => undefined);
    throw error;
  } finally {
    await database.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
