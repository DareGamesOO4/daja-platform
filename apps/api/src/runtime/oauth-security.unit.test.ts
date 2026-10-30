import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@daja/config';
import type { Database } from '@daja/database';
import { createLogger } from '@daja/observability';
import { signJwt, verifyJwt } from '@daja/security';
import { CustomerAuthService } from '../customer-auth.service.js';
import type { NovostiEmailService } from '../novosti-email.service.js';
import { CustomerAuthController } from '../storefront.controller.js';

afterEach(() => vi.unstubAllGlobals());

describe('Google OAuth browser-state binding', () => {
  const config = loadConfig({
    ...process.env,
    GOOGLE_OAUTH_CLIENT_ID: 'fake-client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'fake-client-secret',
    OAUTH_FRONTEND_REDIRECT_URL: 'https://dajashop.rs'
  });
  const service = new CustomerAuthService(
    config,
    {} as Database,
    createLogger(config, 'oauth-test'),
    {} as NovostiEmailService
  );
  const organizationId = '00000000-0000-4000-8000-000000000101';
  const browserState = 'a'.repeat(64);
  const tokens = {
    accessToken: 'fake-access',
    refreshToken: 'fake-refresh',
    tokenType: 'Bearer',
    expiresIn: 60,
    refreshExpiresIn: 120
  };

  it('enforces the displayed registration password requirements before reaching authentication storage', () => {
    const controller = Object.create(CustomerAuthController.prototype) as CustomerAuthController;
    Object.assign(controller, {
      config,
      auth: {
        register() {
          throw new Error('validated-registration');
        }
      }
    });
    for (const password of ['Abc123', 'lowercase123', 'UPPERCASEONLY']) {
      expect(() =>
        controller.register({
          identity: 'fixture@example.test',
          name: 'Security fixture',
          password
        })
      ).toThrow('Validation failed');
    }
    expect(() =>
      controller.register({
        identity: 'fixture@example.test',
        name: 'Security fixture',
        password: 'StrongFixture123'
      })
    ).toThrow('validated-registration');
  });

  it('signs the browser nonce into state and returns the same nonce to the initiating frontend', () => {
    const url = new URL(
      service.startGoogleOAuth(organizationId, browserState, 'https://dajashop.rs/en/catalog')
    );
    const state = url.searchParams.get('state')!;
    expect(verifyJwt(state, config.JWT_ACCESS_SECRET, 'access').browserState).toBe(browserState);
    const callback = new URL(service.oauthSuccessRedirect(tokens, state));
    expect(callback.pathname).toBe('/en/catalog');
    expect(new URLSearchParams(callback.hash.slice(1)).get('browserState')).toBe(browserState);
    expect(() => service.startGoogleOAuth(organizationId, '')).toThrow();
    expect(() => service.oauthSuccessRedirect(tokens, state + 'tampered')).toThrow();
  });

  it('rejects signed legacy state without a browser nonce before contacting Google', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const state = signJwt(
      {
        sub: 'google-oauth-state',
        org: organizationId,
        jti: 'fake-id',
        typ: 'access',
        provider: 'google'
      },
      config.JWT_ACCESS_SECRET,
      60
    );
    await expect(
      service.loginWithGoogle({ organizationId, code: 'fake-code', state })
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
