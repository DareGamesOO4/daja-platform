import { describe, expect, it } from 'vitest';
import type { AppConfig } from '@daja/config';
import type { Database } from '@daja/database';
import { DevicePluginsService } from './device-plugins.service.js';

describe('DevicePluginsService', () => {
  it('returns the published plugin manifest expected by the RFIDDaja desktop client', async () => {
    const database = {
      pool: {
        query: async () => ({
          rows: [
            {
              id: '00000000-0000-4000-8000-000000000018',
              plugin_id: 'yrm100-reader',
              name: 'YRM100 RFID Reader',
              vendor: 'YRM',
              kind: 'rfid_reader',
              version: '1.0.0',
              summary: 'YRM100 reader SDK.',
              description: 'Serial driver package for the YRM100.',
              models: ['YRM100'],
              platforms: ['win32'],
              capabilities: ['serial'],
              min_app_version: null,
              release_notes: null,
              status: 'published',
              package_storage_key: 'platform/device-plugins/yrm100-reader/1.0.0/test.zip',
              package_size_bytes: '12345',
              package_checksum_sha256:
                '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
              published_at: new Date('2026-08-23T12:00:00.000Z'),
              unpublished_at: null,
              created_at: new Date('2026-08-23T12:00:00.000Z'),
              updated_at: new Date('2026-08-23T12:00:00.000Z')
            }
          ]
        })
      }
    } as unknown as Database;
    const service = new DevicePluginsService({} as AppConfig, database);

    await expect(service.catalog()).resolves.toMatchObject({
      schemaVersion: 1,
      plugins: [
        {
          id: 'yrm100-reader',
          version: '1.0.0',
          packageSizeBytes: 12345,
          packageChecksumSha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        }
      ]
    });
  });
});
