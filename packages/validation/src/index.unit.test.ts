import { describe, expect, it } from 'vitest';
import { ValidationFailedError } from '@daja/security';
import { normalizeEpc, syncAggregateTypeSchema } from './index.js';

describe('normalizeEpc', () => {
  it('stores a canonical EPC after removing a prefix, separators and casing', () => {
    expect(normalizeEpc(' 0x30-08:33_b2.dd 01 ')).toBe('300833B2DD01');
  });

  it.each(['', '300833B', '300833B2D', '300833ZZ', 'AA'.repeat(33)])(
    'rejects malformed EPC %j',
    (value) => {
      expect(() => normalizeEpc(value)).toThrow(ValidationFailedError);
    }
  );
});

describe('syncAggregateTypeSchema', () => {
  it.each(['catalog_brand', 'catalog_specification'])(
    'accepts desktop catalog aggregate %s',
    (aggregateType) => {
      expect(syncAggregateTypeSchema.parse(aggregateType)).toBe(aggregateType);
    }
  );
});
