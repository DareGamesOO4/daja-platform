import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './index.js';

describe('production log redaction', () => {
  it('does not serialize passwords, tokens or SQL exception details', () => {
    let output = '';
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        output += chunk.toString();
        callback();
      }
    });
    const logger = createLogger(
      { NODE_ENV: 'production', LOG_LEVEL: 'info' },
      'security-test',
      destination
    );
    const error = Object.assign(new Error('SELECT private_password FROM customers'), {
      code: '23505'
    });
    logger.error(
      {
        err: error,
        password: 'fake-password',
        accessToken: 'fake-access',
        nested: { refreshToken: 'fake-refresh', secret: 'fake-secret' }
      },
      'Operation failed'
    );
    for (const secret of [
      'private_password',
      'fake-password',
      'fake-access',
      'fake-refresh',
      'fake-secret'
    ])
      expect(output).not.toContain(secret);
    expect(output).toContain('23505');
    expect(output).toContain('[REDACTED]');
  });
});
