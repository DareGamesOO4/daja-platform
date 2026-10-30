import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { resolveRequestContext } from './request-context.js';
import { allowedCorsOrigins, allowedRealtimeOrigin } from './cors-policy.js';

afterEach(() => vi.unstubAllEnvs());

describe('production authentication boundaries', () => {
  it('rejects forged identity headers in production and staging even if the switch is enabled', () => {
    const request = {
      headers: { 'x-user-id': 'attacker', 'x-organization-id': 'tenant', 'x-permissions': '*' }
    } as unknown as Request;
    vi.stubEnv('TRUSTED_IDENTITY_HEADERS', 'true');
    for (const environment of ['production', 'staging', '']) {
      vi.stubEnv('NODE_ENV', environment);
      expect(() => resolveRequestContext(request)).toThrow('Authentication is required');
    }
  });
  it('does not treat arbitrary origins as trusted WebSocket clients', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CORS_ALLOWED_ORIGINS', 'https://dajashop.rs,http://localhost:5173');
    expect(allowedRealtimeOrigin('https://attacker.example')).toBe(false);
    expect(allowedRealtimeOrigin('null')).toBe(false);
    expect(allowedRealtimeOrigin('http://localhost:5173')).toBe(false);
    expect(allowedRealtimeOrigin('https://dajashop.rs')).toBe(true);
    expect(allowedRealtimeOrigin('https://localhost')).toBe(true);
    expect(allowedRealtimeOrigin(undefined)).toBe(true);
    expect(allowedCorsOrigins(['*'], 'production')).not.toContain('*');
  });
});
