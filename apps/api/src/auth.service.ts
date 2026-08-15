import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { argon2id, hash, verify } from 'argon2';
import type { AppConfig } from '@daja/config';
import {
  AuthRepository,
  TransactionManager,
  type Database,
  type StaffPrincipal,
  type CustomerPrincipal
} from '@daja/database';
import type { Logger } from '@daja/observability';
import {
  InvalidCredentialsError,
  InvalidTokenError,
  PermissionDeniedError,
  sha256Hex,
  signJwt,
  verifyJwt
} from '@daja/security';
import type { RequestContext } from '@daja/shared';
import { createRequestId } from '@daja/shared';
import { CONFIG, DATABASE, LOGGER } from './tokens.js';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshExpiresIn: number;
}

export interface AuthenticatedStaff {
  principal: StaffPrincipal;
  tokens: TokenPair;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(LOGGER) private readonly logger: Logger
  ) {}

  async login(input: {
    organizationId: string;
    email: string;
    password: string;
    deviceId: string;
    requestId?: string | undefined;
    correlationId?: string | undefined;
  }): Promise<AuthenticatedStaff> {
    return new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      const repo = new AuthRepository(client);
      const user = await repo.findStaffUserForLogin(input);
      if (!user || !user.active) {
        throw new InvalidCredentialsError();
      }
      const passwordOk = await verify(user.passwordHash, input.password);
      if (!passwordOk) {
        throw new InvalidCredentialsError();
      }
      const familyId = randomUUID();
      const refreshJti = randomUUID();
      const refreshExpiresAt = expiresAt(this.config.REFRESH_TOKEN_TTL_SECONDS);
      await repo.ensureLoginDevice({
        organizationId: user.organizationId,
        userId: user.id,
        deviceId: input.deviceId,
        offlineAuthorizationExpiresAt: refreshExpiresAt
      });
      const refreshPayload = {
        typ: 'refresh' as const,
        sub: user.id,
        org: user.organizationId,
        fam: familyId,
        jti: refreshJti,
        dev: input.deviceId
      };
      const refreshToken = signJwt(
        refreshPayload,
        this.config.JWT_REFRESH_SECRET,
        this.config.REFRESH_TOKEN_TTL_SECONDS
      );
      const session = await repo.createSession({
        organizationId: user.organizationId,
        userId: user.id,
        deviceId: input.deviceId,
        familyId,
        refreshJti,
        refreshTokenHash: sha256Hex(refreshToken),
        expiresAt: refreshExpiresAt
      });
      const principal = await repo.buildPrincipal({
        organizationId: user.organizationId,
        userId: user.id,
        deviceId: input.deviceId,
        sessionFamilyId: familyId,
        sessionId: session.id
      });
      await repo.auditAuthEvent({
        organizationId: principal.organizationId,
        userId: principal.userId,
        deviceId: principal.deviceId,
        sessionId: session.id,
        operation: 'auth.login',
        requestId: input.requestId ?? createRequestId(),
        correlationId: input.correlationId ?? input.requestId ?? createRequestId(),
        payload: { familyId }
      });
      return { principal, tokens: this.issueTokenPair(principal, refreshToken) };
    });
  }

  /**
   * Exchanges an already authenticated storefront customer for a staff session.
   * The email is checked against a server-side allowlist before a staff user is
   * provisioned, so a frontend build variable can never grant API permissions.
   */
  async loginConfiguredStorefrontAdmin(input: {
    customer: CustomerPrincipal;
    deviceId: string;
    requestId?: string | undefined;
    correlationId?: string | undefined;
  }): Promise<AuthenticatedStaff> {
    const email = input.customer.email?.trim().toLowerCase();
    if (!email || !this.storefrontAdminEmails().includes(email)) {
      throw new PermissionDeniedError('admin.access');
    }

    return new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      const googleIdentity = await client.query(
        `SELECT 1 FROM oauth_accounts
         WHERE organization_id = $1 AND customer_id = $2 AND provider = 'google'
         LIMIT 1`,
        [input.customer.organizationId, input.customer.customerId]
      );
      if (googleIdentity.rowCount !== 1) {
        throw new PermissionDeniedError('admin.google_identity');
      }
      const user = await this.provisionStorefrontAdmin(client, {
        organizationId: input.customer.organizationId,
        email,
        displayName: input.customer.displayName
      });
      const repo = new AuthRepository(client);
      const familyId = randomUUID();
      const refreshJti = randomUUID();
      const refreshExpiresAt = expiresAt(this.config.REFRESH_TOKEN_TTL_SECONDS);
      await repo.ensureLoginDevice({
        organizationId: user.organizationId,
        userId: user.id,
        deviceId: input.deviceId,
        offlineAuthorizationExpiresAt: refreshExpiresAt
      });
      const refreshToken = signJwt(
        {
          typ: 'refresh' as const,
          sub: user.id,
          org: user.organizationId,
          fam: familyId,
          jti: refreshJti,
          dev: input.deviceId
        },
        this.config.JWT_REFRESH_SECRET,
        this.config.REFRESH_TOKEN_TTL_SECONDS
      );
      const session = await repo.createSession({
        organizationId: user.organizationId,
        userId: user.id,
        deviceId: input.deviceId,
        familyId,
        refreshJti,
        refreshTokenHash: sha256Hex(refreshToken),
        expiresAt: refreshExpiresAt
      });
      const principal = await repo.buildPrincipal({
        organizationId: user.organizationId,
        userId: user.id,
        deviceId: input.deviceId,
        sessionFamilyId: familyId,
        sessionId: session.id
      });
      await repo.auditAuthEvent({
        organizationId: principal.organizationId,
        userId: principal.userId,
        deviceId: principal.deviceId,
        sessionId: session.id,
        operation: 'auth.storefront_admin_login',
        requestId: input.requestId ?? createRequestId(),
        correlationId: input.correlationId ?? input.requestId ?? createRequestId(),
        payload: { customerId: input.customer.customerId }
      });
      return { principal, tokens: this.issueTokenPair(principal, refreshToken) };
    });
  }

  async refresh(input: { refreshToken: string }): Promise<AuthenticatedStaff> {
    const payload = verifyJwt(input.refreshToken, this.config.JWT_REFRESH_SECRET, 'refresh');
    const familyId = payload.fam;
    const deviceId = payload.dev;
    if (!familyId || !deviceId) {
      throw new InvalidTokenError();
    }
    return new TransactionManager(this.database.pool, this.logger).run(async (client) => {
      const repo = new AuthRepository(client);
      const current = await repo.findActiveRefreshSession({
        organizationId: payload.org,
        userId: payload.sub,
        deviceId,
        familyId,
        refreshJti: payload.jti,
        refreshTokenHash: sha256Hex(input.refreshToken)
      });
      const replacementJti = randomUUID();
      const refreshToken = signJwt(
        {
          typ: 'refresh',
          sub: payload.sub,
          org: payload.org,
          fam: familyId,
          jti: replacementJti,
          dev: deviceId
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
      const principal = await repo.buildPrincipal({
        organizationId: payload.org,
        userId: payload.sub,
        deviceId,
        sessionFamilyId: familyId,
        sessionId: replacement.id
      });
      return { principal, tokens: this.issueTokenPair(principal, refreshToken) };
    });
  }

  async logout(ctx: RequestContext): Promise<void> {
    if (!('sessionId' in ctx) || typeof ctx.sessionId !== 'string') {
      return;
    }
    await new AuthRepository(this.database.pool).revokeSession(ctx.sessionId, 'logout');
  }

  async authenticateAccessToken(
    token: string,
    input: { deviceId?: string | undefined; locationId?: string | undefined } = {}
  ): Promise<RequestContext & { sessionId?: string }> {
    const payload = verifyJwt(token, this.config.JWT_ACCESS_SECRET, 'access');
    if (!payload.dev || !payload.fam) {
      throw new InvalidTokenError();
    }
    if (input.deviceId && input.deviceId !== payload.dev) {
      throw new PermissionDeniedError('device.match');
    }
    const repo = new AuthRepository(this.database.pool);
    if (typeof payload.sid === 'string') {
      await repo.assertAccessSession({
        organizationId: payload.org,
        userId: payload.sub,
        deviceId: payload.dev,
        familyId: payload.fam,
        sessionId: payload.sid
      });
    }
    const principalInput = {
      organizationId: payload.org,
      userId: payload.sub,
      deviceId: payload.dev,
      sessionFamilyId: payload.fam,
      ...(typeof payload.sid === 'string' ? { sessionId: payload.sid } : {})
    };
    const principal = await repo.buildPrincipal(principalInput);
    if (input.locationId) {
      await repo.assertLocationAccess({
        organizationId: principal.organizationId,
        userId: principal.userId,
        locationId: input.locationId
      });
    }
    return {
      requestId: createRequestId(),
      correlationId: createRequestId(),
      organizationId: principal.organizationId,
      userId: principal.userId,
      deviceId: principal.deviceId,
      ...(input.locationId ? { locationId: input.locationId } : {}),
      roles: principal.roles,
      permissions: principal.permissions,
      ...(principal.sessionId ? { sessionId: principal.sessionId } : {})
    };
  }

  async hashPassword(password: string): Promise<string> {
    return hash(password, { type: argon2id });
  }

  private issueTokenPair(principal: StaffPrincipal, refreshToken: string): TokenPair {
    const accessToken = signJwt(
      {
        typ: 'access',
        sub: principal.userId,
        org: principal.organizationId,
        fam: principal.sessionFamilyId,
        jti: randomUUID(),
        dev: principal.deviceId,
        sid: principal.sessionId
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

  private storefrontAdminEmails(): string[] {
    return this.config.STOREFRONT_ADMIN_EMAILS.split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);
  }

  private async provisionStorefrontAdmin(
    client: Pick<Database['pool'], 'query'>,
    input: { organizationId: string; email: string; displayName: string }
  ): Promise<{ id: string; organizationId: string }> {
    const existingUser = await client.query<{ id: string; organization_id: string }>(
      `SELECT id, organization_id FROM users
       WHERE organization_id = $1 AND normalized_email = lower($2)
       FOR UPDATE`,
      [input.organizationId, input.email]
    );
    let user = existingUser.rows[0];
    if (!user) {
      const created = await client.query<{ id: string; organization_id: string }>(
        `INSERT INTO users (organization_id, email, display_name, active)
         VALUES ($1, $2, $3, true)
         RETURNING id, organization_id`,
        [input.organizationId, input.email, input.displayName || input.email]
      );
      user = created.rows[0];
    } else {
      await client.query(
        `UPDATE users SET active = true, display_name = $3, updated_at = now()
         WHERE id = $1 AND organization_id = $2`,
        [user.id, input.organizationId, input.displayName || input.email]
      );
    }

    const existingRole = await client.query<{ id: string }>(
      `SELECT id FROM roles WHERE organization_id = $1 AND lower(name) = 'storefront_admin' FOR UPDATE`,
      [input.organizationId]
    );
    let roleId = existingRole.rows[0]?.id;
    if (!roleId) {
      const created = await client.query<{ id: string }>(
        `INSERT INTO roles (organization_id, name, description, system_role)
         VALUES ($1, 'storefront_admin', 'Full administrator provisioned from the storefront allowlist', true)
         RETURNING id`,
        [input.organizationId]
      );
      roleId = created.rows[0]?.id;
    }
    if (!user || !roleId) {
      throw new InvalidCredentialsError();
    }
    await client.query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT $1, id FROM permissions
       ON CONFLICT DO NOTHING`,
      [roleId]
    );
    await client.query(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [user.id, roleId]
    );
    return { id: user.id, organizationId: user.organization_id };
  }
}

function expiresAt(ttlSeconds: number): Date {
  return new Date(Date.now() + ttlSeconds * 1000);
}
