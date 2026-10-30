import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { resetDatabase } from '../test/helpers.js';
import { databaseConnectionOptions } from './pool.js';
import { validateMediaBytes } from './media.js';

describe('database transport boundary', () => {
  it('refuses remote test database resets before opening a query', async () => {
    const query = vi.fn();
    const pool = {
      query,
      options: { connectionString: 'postgres://fake:fake@remote.example/daja_platform' }
    } as unknown as pg.Pool;
    await expect(resetDatabase(pool)).rejects.toThrow('isolated local test');
    expect(query).not.toHaveBeenCalled();
  });
  it('supports a loopback Docker port-forward while checking the live test database name', async () => {
    const query = vi
      .fn()
      .mockResolvedValue({ rows: [{ name: 'daja_platform', address: '172.17.0.2' }] });
    await resetDatabase({ query, options: { host: 'localhost' } } as unknown as pg.Pool);
    expect(query.mock.calls.some((call) => String(call[0]).startsWith('DROP SCHEMA'))).toBe(true);
  });
  it('never drops a production schema just because NODE_ENV=test is set', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ name: 'daja', address: '10.0.0.2' }] });
    await expect(
      resetDatabase({ query, options: { host: '127.0.0.1' } } as unknown as pg.Pool)
    ).rejects.toThrow('isolated local test');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).not.toContain('DROP');
  });
  it('verifies public database certificates even when the URL requests weak SSL', () => {
    for (const mode of ['require', 'no-verify', 'disable', 'verify-full']) {
      const result = databaseConnectionOptions(
        `postgres://fake:fake@database.example/db?sslmode=${mode}`
      );
      expect(result.ssl).toEqual({ rejectUnauthorized: true });
      expect(result.connectionString).not.toContain('sslmode');
    }
  });
  it('keeps local development and internal Render connections compatible', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]', 'dpg-example-a']) {
      expect(databaseConnectionOptions(`postgres://fake:fake@${host}/db`).ssl).toBe(false);
    }
  });
});

describe('media content validation', () => {
  it('rejects executable content disguised as each allowed media type', () => {
    for (const type of [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/avif',
      'application/pdf',
      'text/html'
    ]) {
      expect(() =>
        validateMediaBytes(Buffer.from('<html><script>alert(1)</script>'), type)
      ).toThrow();
    }
  });
  it('accepts signatures of allowed images and PDFs and rejects empty files', () => {
    const examples: [string, Buffer][] = [
      ['image/jpeg', Buffer.from([255, 216, 255, 224])],
      ['image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
      ['image/webp', Buffer.from('RIFF0000WEBPVP8 ')],
      ['image/avif', Buffer.from('\x00\x00\x00\x20ftypavif0000')],
      ['application/pdf', Buffer.from('%PDF-1.7')]
    ];
    for (const [type, bytes] of examples) {
      expect(() => validateMediaBytes(bytes, type)).not.toThrow();
      expect(() => validateMediaBytes(Buffer.alloc(0), type)).toThrow();
    }
  });
});
