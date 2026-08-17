import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { argon2id, hash, verify } from 'argon2';
import type { AppConfig } from '@daja/config';
import {
  StorefrontRepository,
  TransactionManager,
  type CustomerPrincipal,
  type Database
} from '@daja/database';
import type { Logger } from '@daja/observability';
import {
  AuthenticationRequiredError,
  InvalidCredentialsError,
  InvalidTokenError,
  sha256Hex,
  signJwt,
  ValidationFailedError,
  verifyJwt
} from '@daja/security';
import { CONFIG, DATABASE, LOGGER } from './tokens.js';

export interface CustomerTokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshExpiresIn: number;
}

@Injectable()
export class CustomerAuthService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(LOGGER) private readonly logger: Logger
  ) {}

  async register(input: {
    organizationId: string;
    identity: string;
    password: string;
    name: string;
  }) {
    return new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      const repo = new StorefrontRepository(client);
      const principal = await repo.createPasswordCustomer({
        organizationId: input.organizationId,
        email: input.identity.includes('@') ? input.identity : null,
        phone: input.identity.includes('@') ? null : input.identity,
        displayName: input.name,
        passwordHash: await hash(input.password, { type: argon2id })
      });
      const session = await this.createSession(
        repo,
        principal.organizationId,
        principal.customerId
      );
      const hydrated = await repo.buildCustomerPrincipal({
        organizationId: principal.organizationId,
        customerId: principal.customerId,
        sessionFamilyId: session.familyId,
        sessionId: session.id
      });
      return {
        user: serializeCustomerPrincipal(hydrated),
        ...this.issueTokenPair(hydrated, session.refreshToken)
      };
    });
  }

  async login(input: { organizationId: string; identity: string; password: string }) {
    return new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      const repo = new StorefrontRepository(client);
      const customer = await repo.findPasswordCustomerForLogin({
        organizationId: input.organizationId,
        identity: input.identity
      });
      if (!customer?.active || !(await verify(customer.passwordHash, input.password))) {
        throw new InvalidCredentialsError();
      }
      const session = await this.createSession(repo, customer.organizationId, customer.id);
      const principal = await repo.buildCustomerPrincipal({
        organizationId: customer.organizationId,
        customerId: customer.id,
        sessionFamilyId: session.familyId,
        sessionId: session.id
      });
      return {
        user: serializeCustomerPrincipal(principal),
        ...this.issueTokenPair(principal, session.refreshToken)
      };
    });
  }

  startGoogleOAuth(organizationId: string): string {
    this.assertGoogleOAuthConfigured();
    const state = signJwt(
      {
        typ: 'access',
        sub: 'google-oauth-state',
        org: organizationId,
        jti: randomUUID(),
        provider: 'google'
      },
      this.config.JWT_ACCESS_SECRET,
      600
    );
    return this.googleAuthorizationUrl(state);
  }

  /** Reuses the configured Google client and its existing callback URI. */
  googleAuthorizationUrl(state: string): string {
    this.assertGoogleOAuthConfigured();
    const authorizationUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorizationUrl.search = new URLSearchParams({
      client_id: this.config.GOOGLE_OAUTH_CLIENT_ID,
      redirect_uri: this.googleCallbackUrl(),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account'
    }).toString();
    return authorizationUrl.toString();
  }

  async loginWithGoogle(input: { organizationId: string; code: string; state: string }) {
    this.assertGoogleOAuthConfigured();
    const state = verifyJwt(input.state, this.config.JWT_ACCESS_SECRET, 'access');
    if (
      state.sub !== 'google-oauth-state' ||
      state.org !== input.organizationId ||
      state.provider !== 'google'
    ) {
      throw new InvalidTokenError();
    }

    const identity = await this.verifyGoogleIdentity(input.code);
    const googleSubject = identity.subject;
    const googleEmail = identity.email;

    return new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      const repo = new StorefrontRepository(client);
      let customer = await repo.findOAuthCustomer({
        organizationId: input.organizationId,
        provider: 'google',
        providerSubject: googleSubject
      });
      if (!customer) {
        customer = await repo.findCustomerByEmail({
          organizationId: input.organizationId,
          email: googleEmail
        });
        if (customer) {
          await repo.linkOAuthIdentity({
            organizationId: input.organizationId,
            customerId: customer.id,
            provider: 'google',
            providerSubject: googleSubject
          });
        } else {
          customer = await repo.createGoogleCustomer({
            organizationId: input.organizationId,
            email: googleEmail,
            displayName: identity.displayName,
            photoUrl: identity.photoUrl,
            providerSubject: googleSubject
          });
        }
      }
      const session = await this.createSession(repo, customer.organizationId, customer.id);
      const principal = await repo.buildCustomerPrincipal({
        organizationId: customer.organizationId,
        customerId: customer.id,
        sessionFamilyId: session.familyId,
        sessionId: session.id
      });
      return {
        user: serializeCustomerPrincipal(principal),
        ...this.issueTokenPair(principal, session.refreshToken)
      };
    });
  }

  /**
   * Establishes the same verified Google customer identity without exposing a
   * customer token. The desktop flow later exchanges it for a staff session.
   */
  async resolveDesktopGoogleCustomer(input: {
    organizationId: string;
    code: string;
  }): Promise<CustomerPrincipal> {
    const identity = await this.verifyGoogleIdentity(input.code);
    return new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      const repo = new StorefrontRepository(client);
      let customer = await repo.findOAuthCustomer({
        organizationId: input.organizationId,
        provider: 'google',
        providerSubject: identity.subject
      });
      if (!customer) {
        customer = await repo.findCustomerByEmail({
          organizationId: input.organizationId,
          email: identity.email
        });
        if (customer) {
          await repo.linkOAuthIdentity({
            organizationId: input.organizationId,
            customerId: customer.id,
            provider: 'google',
            providerSubject: identity.subject
          });
        } else {
          customer = await repo.createGoogleCustomer({
            organizationId: input.organizationId,
            email: identity.email,
            displayName: identity.displayName,
            photoUrl: identity.photoUrl,
            providerSubject: identity.subject
          });
        }
      }
      return repo.buildCustomerPrincipal({
        organizationId: customer.organizationId,
        customerId: customer.id,
        sessionFamilyId: randomUUID()
      });
    });
  }

  private async verifyGoogleIdentity(
    code: string
  ): Promise<{ subject: string; email: string; displayName: string; photoUrl: string | null }> {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.config.GOOGLE_OAUTH_CLIENT_ID,
        client_secret: this.config.GOOGLE_OAUTH_CLIENT_SECRET,
        redirect_uri: this.googleCallbackUrl(),
        grant_type: 'authorization_code'
      })
    });
    const token = (await tokenResponse.json().catch(() => null)) as {
      access_token?: unknown;
    } | null;
    if (!tokenResponse.ok || typeof token?.access_token !== 'string') {
      throw new ValidationFailedError('Google sign-in could not be completed');
    }

    const profileResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { authorization: `Bearer ${token.access_token}` }
    });
    const profile = (await profileResponse.json().catch(() => null)) as GoogleProfile | null;
    if (
      !profileResponse.ok ||
      !profile ||
      typeof profile.sub !== 'string' ||
      typeof profile.email !== 'string' ||
      profile.email_verified !== true
    ) {
      throw new ValidationFailedError('Google account must have a verified email address');
    }
    return {
      subject: profile.sub,
      email: profile.email.trim().toLowerCase(),
      displayName: googleDisplayName(profile),
      photoUrl: typeof profile.picture === 'string' ? profile.picture : null
    };
  }

  oauthSuccessRedirect(tokens: CustomerTokenPair): string {
    const url = new URL(this.oauthFrontendRedirectUrl());
    url.hash = new URLSearchParams({
      oauth: 'success',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken
    }).toString();
    return url.toString();
  }

  oauthErrorRedirect(): string {
    const url = new URL(this.oauthFrontendRedirectUrl());
    url.searchParams.set('oauth_error', 'google_sign_in_failed');
    return url.toString();
  }

  async refresh(input: { refreshToken: string }) {
    const payload = verifyJwt(input.refreshToken, this.config.JWT_REFRESH_SECRET, 'refresh');
    if (payload.kind !== 'customer' || !payload.fam) {
      throw new InvalidTokenError();
    }
    return new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      const repo = new StorefrontRepository(client);
      const current = await repo.findActiveRefreshSession({
        organizationId: payload.org,
        customerId: payload.sub,
        familyId: String(payload.fam),
        refreshJti: payload.jti,
        refreshTokenHash: sha256Hex(input.refreshToken)
      });
      const replacementJti = randomUUID();
      const refreshToken = signJwt(
        {
          typ: 'refresh',
          sub: payload.sub,
          org: payload.org,
          fam: current.familyId,
          jti: replacementJti,
          kind: 'customer'
        },
        this.config.JWT_REFRESH_SECRET,
        this.config.REFRESH_TOKEN_TTL_SECONDS
      );
      const replacement = await repo.rotateRefreshSession({
        sessionId: current.id,
        replacementRefreshTokenHash: sha256Hex(refreshToken),
        replacementRefreshJti: replacementJti,
        expiresAt: expiresAt(this.config.REFRESH_TOKEN_TTL_SECONDS)
      });
      const principal = await repo.buildCustomerPrincipal({
        organizationId: payload.org,
        customerId: payload.sub,
        sessionFamilyId: current.familyId,
        sessionId: replacement.id
      });
      return {
        user: serializeCustomerPrincipal(principal),
        ...this.issueTokenPair(principal, refreshToken)
      };
    });
  }

  async authenticateAccessToken(token: string): Promise<CustomerPrincipal> {
    const payload = verifyJwt(token, this.config.JWT_ACCESS_SECRET, 'access');
    if (payload.kind !== 'customer' || !payload.fam || typeof payload.sid !== 'string') {
      throw new InvalidTokenError();
    }
    const repo = new StorefrontRepository(this.database.pool);
    await repo.assertAccessSession({
      organizationId: payload.org,
      customerId: payload.sub,
      familyId: String(payload.fam),
      sessionId: payload.sid
    });
    return repo.buildCustomerPrincipal({
      organizationId: payload.org,
      customerId: payload.sub,
      sessionFamilyId: String(payload.fam),
      sessionId: payload.sid
    });
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) {
      return;
    }
    const principal = await this.authenticateAccessToken(token);
    if (principal.sessionId) {
      await new StorefrontRepository(this.database.pool).revokeSession(
        principal.sessionId,
        'logout'
      );
    }
  }

  requireCustomer(token: string | undefined): Promise<CustomerPrincipal> {
    if (!token) {
      throw new AuthenticationRequiredError();
    }
    return this.authenticateAccessToken(token);
  }

  private async createSession(
    repo: StorefrontRepository,
    organizationId: string,
    customerId: string
  ): Promise<{ id: string; familyId: string; refreshToken: string }> {
    const familyId = randomUUID();
    const refreshJti = randomUUID();
    const refreshToken = signJwt(
      {
        typ: 'refresh',
        sub: customerId,
        org: organizationId,
        fam: familyId,
        jti: refreshJti,
        kind: 'customer'
      },
      this.config.JWT_REFRESH_SECRET,
      this.config.REFRESH_TOKEN_TTL_SECONDS
    );
    const session = await repo.createSession({
      organizationId,
      customerId,
      familyId,
      refreshTokenHash: sha256Hex(refreshToken),
      refreshJti,
      expiresAt: expiresAt(this.config.REFRESH_TOKEN_TTL_SECONDS)
    });
    return { id: session.id, familyId, refreshToken };
  }

  private issueTokenPair(principal: CustomerPrincipal, refreshToken: string): CustomerTokenPair {
    const accessToken = signJwt(
      {
        typ: 'access',
        sub: principal.customerId,
        org: principal.organizationId,
        fam: principal.sessionFamilyId,
        jti: randomUUID(),
        sid: principal.sessionId,
        kind: 'customer'
      },
      this.config.JWT_ACCESS_SECRET,
      this.config.ACCESS_TOKEN_TTL_SECONDS
    );
    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS,
      refreshExpiresIn: this.config.REFRESH_TOKEN_TTL_SECONDS
    };
  }

  private assertGoogleOAuthConfigured(): void {
    if (!this.config.GOOGLE_OAUTH_CLIENT_ID || !this.config.GOOGLE_OAUTH_CLIENT_SECRET) {
      throw new ValidationFailedError('Google OAuth is not configured');
    }
  }

  private googleCallbackUrl(): string {
    return new URL(
      '/api/v1/customer-auth/oauth/google/callback',
      this.config.API_PUBLIC_BASE_URL
    ).toString();
  }

  private oauthFrontendRedirectUrl(): string {
    if (!this.config.OAUTH_FRONTEND_REDIRECT_URL) {
      throw new ValidationFailedError('OAUTH_FRONTEND_REDIRECT_URL is not configured');
    }
    return this.config.OAUTH_FRONTEND_REDIRECT_URL;
  }
}

interface GoogleProfile {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  given_name?: unknown;
  family_name?: unknown;
  picture?: unknown;
}

function googleDisplayName(profile: GoogleProfile): string {
  if (typeof profile.name === 'string' && profile.name.trim()) {
    return profile.name.trim().slice(0, 240);
  }
  return (String(profile.email).split('@')[0] ?? 'Google user').slice(0, 240);
}

export function serializeCustomerPrincipal(principal: CustomerPrincipal) {
  return {
    id: principal.customerId,
    uid: principal.customerId,
    email: principal.email,
    phoneNumber: principal.phone,
    displayName: principal.displayName,
    active: principal.active,
    organizationId: principal.organizationId
  };
}

function expiresAt(ttlSeconds: number): Date {
  return new Date(Date.now() + ttlSeconds * 1000);
}
