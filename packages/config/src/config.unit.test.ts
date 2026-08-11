import { describe, expect, it } from 'vitest';
import { loadConfig } from './index.js';

describe('loadConfig', () => {
  it('fails fast for invalid environment', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(
      /Invalid environment configuration/
    );
  });
});
