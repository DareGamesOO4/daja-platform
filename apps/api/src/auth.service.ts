import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { argon2id, hash, verify } from 'argon2';
import type { AppConfig } from '@daja/config';
import {
  AuthRepository,
  TransactionManager,
  type Database,
  type StaffPrincipal
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
}

function expiresAt(ttlSeconds: number): Date {
  return new Date(Date.now() + ttlSeconds * 1000);
}
