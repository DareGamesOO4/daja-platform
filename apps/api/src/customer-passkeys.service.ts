import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON
} from '@simplewebauthn/server';
import type { AppConfig } from '@daja/config';
import { StorefrontRepository, TransactionManager, type CustomerPrincipal, type Database } from '@daja/database';
import type { Logger } from '@daja/observability';
import { AppError, ERROR_CODES, InvalidCredentialsError, sha256Hex, ValidationFailedError } from '@daja/security';
import { CONFIG, DATABASE, LOGGER } from './tokens.js';
import { CustomerAuthService } from './customer-auth.service.js';
import { consumeLoginAttempt } from './login-attempts.js';

interface Challenge {
  kind: 'register' | 'login';
  organizationId: string;
  challenge: string;
  origin: string;
  rpId: string;
  customerId?: string;
  familyId?: string;
  name?: string;
}
interface CredentialRow {
  id: string;
  customer_id: string;
  credential_id: string;
  public_key: string;
  counter: string;
  user_handle: string;
  transports: string[];
  device_type: string;
}

@Injectable()
export class CustomerPasskeysService implements OnModuleDestroy {
  private redis: Redis | undefined;
  private connecting: Promise<void> | undefined;
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(CustomerAuthService) private readonly auth: CustomerAuthService
  ) {}

  onModuleDestroy() { this.redis?.disconnect(); }

  context(origin: unknown) {
    const url = new URL(this.config.STOREFRONT_PUBLIC_BASE_URL);
    if (url.protocol !== 'https:' || origin !== url.origin) throw new InvalidCredentialsError();
    return { origin: url.origin, rpId: url.hostname };
  }

  private requireRecent(customer: CustomerPrincipal) {
    const age = Math.floor(Date.now() / 1000) - Number(customer.authenticatedAt ?? 0);
    if (age < 0 || age > 600) {
      throw new ValidationFailedError('Za upravljanje passkey ključevima prijavite se ponovo, pa pokušajte u roku od 10 minuta.');
    }
    if (!customer.emailVerified) throw new ValidationFailedError('Potvrdite email adresu pre dodavanja passkey ključa.');
  }

  private async state<T>(operation: (client: Redis) => Promise<T>): Promise<T> {
    this.redis ??= new Redis(this.config.REDIS_URL, {
      lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1,
      connectTimeout: 2000, commandTimeout: 2000, retryStrategy: () => null
    });
    if (!this.redis.listenerCount('error')) this.redis.on('error', () => {});
    try {
      if (this.redis.status === 'wait' || this.redis.status === 'end') {
        this.connecting ??= this.redis.connect().finally(() => { this.connecting = undefined; });
      }
      if (this.connecting) await this.connecting;
      return await operation(this.redis);
    } catch {
      throw new AppError(ERROR_CODES.unavailable, 'Service temporarily unavailable', 503);
    }
  }

  private async save(nonce: string, value: Challenge) {
    const saved = await this.state(client => client.set(`auth:passkey:${sha256Hex(nonce)}`, JSON.stringify(value), 'EX', 300, 'NX'));
    if (saved !== 'OK') throw new AppError(ERROR_CODES.unavailable, 'Service temporarily unavailable', 503);
  }

  private async consume(nonce: string, kind: Challenge['kind'], organizationId: string, origin: unknown) {
    const context = this.context(origin);
    if (!/^[a-f0-9]{64}$/.test(nonce)) throw new InvalidCredentialsError();
    // Outside the DB transaction: failure/rollback must not resurrect a challenge.
    const raw = await this.state(client => client.getdel(`auth:passkey:${sha256Hex(nonce)}`));
    if (!raw) throw new InvalidCredentialsError();
    const value = JSON.parse(raw) as Challenge;
    if (value.kind !== kind || value.organizationId !== organizationId
      || value.origin !== context.origin || value.rpId !== context.rpId) throw new InvalidCredentialsError();
    return value;
  }

  async registerStart(customer: CustomerPrincipal, name: string, nonce: string, origin: unknown) {
    this.requireRecent(customer);
    const context = this.context(origin);
    return new TransactionManager(this.database.pool, this.logger).run(async client => {
      const repo = new StorefrontRepository(client);
      await repo.lockCustomerForAuthentication(customer.organizationId, customer.customerId);
      await repo.assertAccessSession({ organizationId: customer.organizationId, customerId: customer.customerId,
        familyId: customer.sessionFamilyId, sessionId: customer.sessionId! });
      const keys = await client.query<{ credential_id: string }>(
        'SELECT credential_id FROM webauthn_credentials WHERE organization_id=$1 AND customer_id=$2 AND rp_id=$3',
        [customer.organizationId, customer.customerId, context.rpId]);
      if (keys.rowCount! >= 10) throw new ValidationFailedError('Možete imati najviše 10 passkey ključeva.');
      const options = await generateRegistrationOptions({
        rpName: 'DajaShop', rpID: context.rpId,
        userID: new Uint8Array(Buffer.from(customer.customerId)),
        userName: customer.email!, userDisplayName: customer.displayName,
        attestationType: 'none', timeout: 60_000,
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        excludeCredentials: keys.rows.map(key => ({ id: key.credential_id }))
      });
      await this.save(nonce, { kind: 'register', organizationId: customer.organizationId,
        customerId: customer.customerId, familyId: customer.sessionFamilyId, name,
        challenge: options.challenge, ...context });
      return options;
    });
  }

  async registerFinish(customer: CustomerPrincipal, response: RegistrationResponseJSON, nonce: string, origin: unknown) {
    const pending = await this.consume(nonce, 'register', customer.organizationId, origin);
    this.requireRecent(customer);
    if (pending.customerId !== customer.customerId || pending.familyId !== customer.sessionFamilyId) throw new InvalidCredentialsError();
    const result = await verifyRegistrationResponse({ response, expectedChallenge: pending.challenge,
      expectedOrigin: pending.origin, expectedRPID: pending.rpId, requireUserVerification: true }).catch(() => { throw new InvalidCredentialsError(); });
    if (!result.verified || !result.registrationInfo) throw new InvalidCredentialsError();
    const info = result.registrationInfo;
    return new TransactionManager(this.database.pool, this.logger).run(async client => {
      const repo = new StorefrontRepository(client);
      await repo.lockCustomerForAuthentication(customer.organizationId, customer.customerId);
      await repo.assertAccessSession({ organizationId: customer.organizationId, customerId: customer.customerId,
        familyId: customer.sessionFamilyId, sessionId: customer.sessionId! });
      const count = await client.query<{ count: string }>(
        'SELECT count(*) FROM webauthn_credentials WHERE organization_id=$1 AND customer_id=$2 AND rp_id=$3',
        [customer.organizationId, customer.customerId, pending.rpId]);
      if (Number(count.rows[0]?.count) >= 10) throw new ValidationFailedError('Možete imati najviše 10 passkey ključeva.');
      const inserted = await client.query(
        `INSERT INTO webauthn_credentials (organization_id,customer_id,credential_id,public_key,counter,
          display_name,rp_id,user_handle,transports,device_type,backed_up)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id`,
        [customer.organizationId,customer.customerId,info.credential.id,
          Buffer.from(info.credential.publicKey).toString('base64url'),info.credential.counter,pending.name,
          pending.rpId,Buffer.from(customer.customerId).toString('base64url'),info.credential.transports ?? [],
          info.credentialDeviceType,info.credentialBackedUp]);
      if (inserted.rowCount !== 1) throw new ValidationFailedError('Ovaj passkey ključ je već registrovan.');
      return { registered: true };
    });
  }

  async loginStart(organizationId: string, nonce: string, origin: unknown) {
    const context = this.context(origin);
    const options = await generateAuthenticationOptions({ rpID: context.rpId, userVerification: 'required', timeout: 60_000 });
    await this.save(nonce, { kind: 'login', organizationId, challenge: options.challenge, ...context });
    return options;
  }

  async loginFinish(organizationId: string, response: AuthenticationResponseJSON, nonce: string, origin: unknown) {
    const pending = await this.consume(nonce, 'login', organizationId, origin);
    const found = await this.database.pool.query<{ customer_id: string }>(
      'SELECT customer_id FROM webauthn_credentials WHERE organization_id=$1 AND credential_id=$2 AND rp_id=$3',
      [organizationId, response.id, pending.rpId]);
    const customerId = found.rows[0]?.customer_id;
    if (!customerId) throw new InvalidCredentialsError();
    await consumeLoginAttempt(this.config, `customer:${organizationId}:${customerId}`);
    return new TransactionManager(this.database.pool, this.logger).run(async client => {
      const repo = new StorefrontRepository(client);
      await repo.lockCustomerForAuthentication(organizationId, customerId);
      const selected = await client.query<CredentialRow>(
        'SELECT * FROM webauthn_credentials WHERE organization_id=$1 AND customer_id=$2 AND credential_id=$3 AND rp_id=$4 FOR UPDATE',
        [organizationId, customerId, response.id, pending.rpId]);
      const key = selected.rows[0];
      if (!key || response.response.userHandle !== key.user_handle) throw new InvalidCredentialsError();
      const result = await verifyAuthenticationResponse({ response, expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin, expectedRPID: pending.rpId, requireUserVerification: true,
        credential: { id: key.credential_id, publicKey: new Uint8Array(Buffer.from(key.public_key, 'base64url')),
          counter: Number(key.counter) }
      }).catch(() => { throw new InvalidCredentialsError(); });
      if (!result.verified || key.device_type !== result.authenticationInfo.credentialDeviceType) throw new InvalidCredentialsError();
      await client.query('UPDATE webauthn_credentials SET counter=$2,last_used_at=now(),backed_up=$3 WHERE id=$1',
        [key.id, result.authenticationInfo.newCounter, result.authenticationInfo.credentialBackedUp]);
      return this.auth.completePasskeyLogin(client, organizationId, customerId);
    });
  }

  async list(customer: CustomerPrincipal) {
    const keys = await this.database.pool.query(
      `SELECT id,display_name AS name,created_at AS "createdAt",last_used_at AS "lastUsedAt"
       FROM webauthn_credentials WHERE organization_id=$1 AND customer_id=$2 AND rp_id=$3 ORDER BY created_at`,
      [customer.organizationId,customer.customerId,new URL(this.config.STOREFRONT_PUBLIC_BASE_URL).hostname]);
    return { items: keys.rows };
  }

  async remove(customer: CustomerPrincipal, id: string) {
    this.requireRecent(customer);
    return new TransactionManager(this.database.pool, this.logger).run(async client => {
      const repo = new StorefrontRepository(client);
      await repo.lockCustomerForAuthentication(customer.organizationId, customer.customerId);
      await repo.assertAccessSession({ organizationId: customer.organizationId, customerId: customer.customerId,
        familyId: customer.sessionFamilyId, sessionId: customer.sessionId! });
      const removed = await client.query('DELETE FROM webauthn_credentials WHERE id=$1 AND organization_id=$2 AND customer_id=$3 RETURNING id',
        [id,customer.organizationId,customer.customerId]);
      if (removed.rowCount !== 1) throw new InvalidCredentialsError();
      await repo.revokeCustomerSessions(customer.organizationId,customer.customerId,'passkey_removed');
      return { removed: true, reauthenticationRequired: true };
    });
  }
}
