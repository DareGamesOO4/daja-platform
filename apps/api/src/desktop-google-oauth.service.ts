import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@daja/config';
import type { CustomerPrincipal, Database } from '@daja/database';
import type { Logger } from '@daja/observability';
import { InvalidTokenError, PermissionDeniedError, ValidationFailedError } from '@daja/security';
import { AuthService } from './auth.service.js';
import { CustomerAuthService } from './customer-auth.service.js';
import { CONFIG, DATABASE, LOGGER } from './tokens.js';

const GRANT_TTL_MS = 5 * 60_000;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function callbackUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationFailedError('Desktop callback URL is invalid');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/callback' ||
    !url.port ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new ValidationFailedError('Desktop callback must be http://127.0.0.1:<port>/callback');
  }
  return url;
}

@Injectable()
export class DesktopGoogleOAuthService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(CustomerAuthService) private readonly customerAuth: CustomerAuthService,
    @Inject(AuthService) private readonly staffAuth: AuthService
  ) {}

  async start(input: {
    organizationId: string;
    deviceId: string;
    callbackUrl: string;
    state: string;
  }): Promise<{ authorizationUrl: string }> {
    callbackUrl(input.callbackUrl);
    const id = randomUUID();
    const providerState = `${id}.${input.state}`;
    await this.database.pool.query(
      `INSERT INTO desktop_google_oauth_grants (
         id, organization_id, device_id, callback_url, state_hash, provider_state_hash, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        input.organizationId,
        input.deviceId,
        input.callbackUrl,
        hash(input.state),
        hash(providerState),
        new Date(Date.now() + GRANT_TTL_MS)
      ]
    );
    return { authorizationUrl: this.customerAuth.googleAuthorizationUrl(providerState) };
  }

  async isDesktopGoogleCallback(state: string | undefined): Promise<boolean> {
    if (!state) return false;
    const result = await this.database.pool.query(
      `SELECT 1 FROM desktop_google_oauth_grants WHERE provider_state_hash = $1 LIMIT 1`,
      [hash(state)]
    );
    return result.rowCount === 1;
  }

  async complete(input: { state: string; code?: string; error?: string }): Promise<string> {
    const transaction = await this.findByState(input.state);
    const [, desktopState] = input.state.split('.', 2);
    if (!desktopState || transaction.state_hash !== hash(desktopState)) {
      throw new InvalidTokenError();
    }
    if (transaction.expires_at <= new Date()) {
      await this.audit(transaction, 'auth.desktop_google_grant_expired');
      return this.redirect(transaction.callback_url, desktopState, { error: 'expired' });
    }
    if (input.error || !input.code) {
      return this.redirect(transaction.callback_url, desktopState, { error: 'access_denied' });
    }

    try {
      const customer = await this.customerAuth.resolveDesktopGoogleCustomer({
        organizationId: transaction.organization_id,
        code: input.code
      });
      if (!customer.email || !this.adminEmails().includes(customer.email.toLowerCase())) {
        await this.audit(transaction, 'auth.desktop_google_email_denied');
        return this.redirect(transaction.callback_url, desktopState, { error: 'access_denied' });
      }
      const grant = randomBytes(32).toString('base64url');
      await this.database.pool.query(
        `UPDATE desktop_google_oauth_grants
         SET grant_hash = $2, customer_id = $3, completed_at = now()
         WHERE id = $1 AND completed_at IS NULL AND expires_at > now()`,
        [transaction.id, hash(grant), customer.customerId]
      );
      await this.audit(transaction, 'auth.desktop_google_grant_created');
      return this.redirect(transaction.callback_url, desktopState, { grant });
    } catch (error) {
      this.logger.warn({ err: error, grantId: transaction.id }, 'Desktop Google callback failed');
      return this.redirect(transaction.callback_url, desktopState, { error: 'identity_failed' });
    }
  }

  async exchange(input: { organizationId: string; deviceId: string; grant: string }) {
    const grantHash = hash(input.grant);
    const known = await this.database.pool.query<DesktopGrantRow>(
      `SELECT id, organization_id, device_id, customer_id, callback_url, state_hash,
              provider_state_hash, expires_at, consumed_at
       FROM desktop_google_oauth_grants WHERE grant_hash = $1 LIMIT 1`,
      [grantHash]
    );
    const consumed = await this.database.pool.query<DesktopGrantRow>(
      `UPDATE desktop_google_oauth_grants
       SET consumed_at = now()
       WHERE grant_hash = $1 AND organization_id = $2 AND device_id = $3
         AND completed_at IS NOT NULL AND consumed_at IS NULL AND expires_at > now()
       RETURNING id, organization_id, device_id, customer_id, callback_url, state_hash,
                 provider_state_hash, expires_at, consumed_at`,
      [grantHash, input.organizationId, input.deviceId]
    );
    const transaction = consumed.rows[0];
    if (!transaction?.customer_id) {
      const prior = known.rows[0];
      if (prior) {
        await this.audit(
          prior,
          prior.consumed_at ? 'auth.desktop_google_grant_reused' : 'auth.desktop_google_grant_expired'
        );
      }
      throw new InvalidTokenError();
    }
    const customer = await this.customer(transaction.organization_id, transaction.customer_id);
    if (!customer.active) throw new PermissionDeniedError('admin.access');
    const staff = await this.staffAuth.loginConfiguredStorefrontAdmin({
      customer,
      deviceId: input.deviceId,
      requestId: `desktop-google:${transaction.id}`,
      correlationId: transaction.id
    });
    await this.audit(transaction, 'auth.desktop_google_grant_exchanged');
    return {
      ...staff.tokens,
      user: {
        userId: staff.principal.userId,
        organizationId: staff.principal.organizationId,
        email: staff.principal.email,
        displayName: staff.principal.displayName,
        roles: staff.principal.roles
      }
    };
  }

  private async findByState(state: string): Promise<DesktopGrantRow> {
    const result = await this.database.pool.query<DesktopGrantRow>(
      `SELECT id, organization_id, device_id, customer_id, callback_url, state_hash,
              provider_state_hash, expires_at, consumed_at
       FROM desktop_google_oauth_grants WHERE provider_state_hash = $1 LIMIT 1`,
      [hash(state)]
    );
    const row = result.rows[0];
    if (!row) throw new InvalidTokenError();
    return row;
  }

  private async customer(organizationId: string, customerId: string): Promise<CustomerPrincipal> {
    const result = await this.database.pool.query<CustomerRow>(
      `SELECT id, organization_id, email, phone, display_name, active
       FROM customers WHERE id = $1 AND organization_id = $2`,
      [customerId, organizationId]
    );
    const row = result.rows[0];
    if (!row) throw new InvalidTokenError();
    return {
      customerId: row.id,
      organizationId: row.organization_id,
      email: row.email,
      phone: row.phone,
      displayName: row.display_name,
      active: row.active,
      sessionFamilyId: randomUUID()
    };
  }

  private redirect(
    callback: string,
    state: string,
    input: { grant?: string; error?: string }
  ): string {
    const url = callbackUrl(callback);
    url.searchParams.set('state', state);
    if (input.grant) url.searchParams.set('grant', input.grant);
    if (input.error) url.searchParams.set('error', input.error);
    return url.toString();
  }

  private adminEmails(): string[] {
    return this.config.STOREFRONT_ADMIN_EMAILS.split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);
  }

  private async audit(transaction: DesktopGrantRow, operation: string): Promise<void> {
    await this.database.pool.query(
      `INSERT INTO audit_events (
         organization_id, actor_user_id, device_id, aggregate_type, aggregate_id,
         operation, correlation_id, request_id
       ) VALUES ($1, NULL, $2, 'desktop_google_oauth_grant', $3, $4, $3::text, $5)`,
      [
        transaction.organization_id,
        transaction.device_id,
        transaction.id,
        operation,
        `desktop-google:${transaction.id}`
      ]
    );
  }
}

interface DesktopGrantRow {
  id: string;
  organization_id: string;
  device_id: string;
  customer_id: string | null;
  callback_url: string;
  state_hash: string;
  provider_state_hash: string;
  expires_at: Date;
  consumed_at: Date | null;
}

interface CustomerRow {
  id: string;
  organization_id: string;
  email: string | null;
  phone: string | null;
  display_name: string;
  active: boolean;
}
