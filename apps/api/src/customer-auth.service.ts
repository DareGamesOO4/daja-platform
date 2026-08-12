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
