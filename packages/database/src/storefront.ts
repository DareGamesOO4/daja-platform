import type pg from 'pg';
import type { QueryResultRow } from 'pg';
import {
  InvalidCredentialsError,
  InvalidTokenError,
  ResourceConflictError,
  ResourceNotFoundError,
  ValidationFailedError
} from '@daja/security';

export interface CustomerPrincipal {
  customerId: string;
  organizationId: string;
  email: string | null;
  phone: string | null;
  phoneVerified: boolean;
  displayName: string;
  active: boolean;
  hasPassword: boolean;
  googleLinked: boolean;
  sessionFamilyId: string;
  sessionId?: string;
}

export interface CustomerForLogin {
  id: string;
  organizationId: string;
  email: string | null;
  phone: string | null;
  displayName: string;
  passwordHash: string;
  active: boolean;
}

export interface CustomerPasswordIdentity {
  passwordHash: string;
}

export interface CustomerPasswordResetRecord {
  organizationId: string;
  customerId: string;
  email: string;
  phone: string | null;
}

export interface CustomerSessionRecord {
  id: string;
  familyId: string;
  organizationId: string;
  customerId: string;
  refreshTokenHash: string;
  refreshJti: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface OAuthCustomerRecord {
  id: string;
  organizationId: string;
}

export interface StorefrontItemSnapshot {
  id?: string;
  productId?: string;
  variantId?: string;
  name?: string;
  brand?: string;
  slug?: string;
  image?: string;
  thumb?: string;
  price?: number;
  [key: string]: unknown;
}

export interface CheckoutInput {
  customerId?: string | null;
  customer: Record<string, unknown>;
  items: Array<StorefrontItemSnapshot & { qty?: number; quantity?: number }>;
  subtotalAmount: number;
  discountAmount: number;
  shippingAmount: number;
  totalAmount: number;
  promoCode?: string | null;
  shippingMethod: 'courier' | 'pickup';
  paymentMethod: 'cod' | 'pickup';
}

export type ProductAlertType = 'back_in_stock' | 'price_change';
export type ProductAlertDeliveryChannel = 'email' | 'sms';

export interface ProductAlertSubscription {
  id: string;
  email: string | null;
  phone: string | null;
  deliveryChannel: ProductAlertDeliveryChannel;
  type: ProductAlertType;
  active: boolean;
  contactId: string | null;
}

export interface ProductAlertNotification {
  subscriptionId: string;
  email: string | null;
  phone: string | null;
  deliveryChannel: ProductAlertDeliveryChannel;
  productName: string;
  brand: string | null;
  slug: string;
  imageUrl: string | null;
  currency: string;
  currentPriceAmount: number;
  previousPriceAmount: number | null;
}

export class StorefrontRepository {
  constructor(private readonly client: Pick<pg.Pool | pg.PoolClient, 'query'>) {}

  async createPasswordCustomer(input: {
    organizationId: string;
    email?: string | null;
    phone?: string | null;
    displayName: string;
    passwordHash: string;
  }): Promise<CustomerPrincipal> {
    const identitySubject = normalizedIdentity(input.email ?? input.phone);
    if (!identitySubject) {
      throw new ValidationFailedError('Email or phone is required');
    }
    const customer = await this.client.query<CustomerRow>(
      `INSERT INTO customers (organization_id, email, phone, display_name, first_name, last_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.organizationId,
        input.email ?? null,
        input.phone ?? null,
        input.displayName,
        firstName(input.displayName),
        lastName(input.displayName)
      ]
    );
    const row = requireRow(customer);
    await this.client.query(
      `INSERT INTO customer_identities (
         organization_id, customer_id, provider, provider_subject, password_hash
       )
       VALUES ($1, $2, 'password', $3, $4)`,
      [input.organizationId, row.id, identitySubject, input.passwordHash]
    );
    return mapCustomerPrincipal(row, '');
  }

  async findPasswordCustomerForLogin(input: {
    organizationId: string;
    identity: string;
  }): Promise<CustomerForLogin | null> {
    const identity = normalizedIdentity(input.identity);
    if (!identity) {
      return null;
    }
    const result = await this.client.query<CustomerLoginRow>(
      `SELECT c.*, ci.password_hash
       FROM customer_identities ci
       JOIN customers c ON c.id = ci.customer_id
        AND c.organization_id = ci.organization_id
        AND c.deleted_at IS NULL
       WHERE ci.organization_id = $1
         AND ci.provider = 'password'
         AND ci.provider_subject = $2
         AND ci.active
       LIMIT 1`,
      [input.organizationId, identity]
    );
    const row = result.rows[0];
    if (!row?.password_hash) {
      return null;
    }
    return {
      id: row.id,
      organizationId: row.organization_id,
      email: row.email,
      phone: row.phone,
      displayName: row.display_name,
      passwordHash: row.password_hash,
      active: row.active
    };
  }

  async findPasswordIdentity(input: {
    organizationId: string;
    customerId: string;
  }): Promise<CustomerPasswordIdentity | null> {
    const result = await this.client.query<{ password_hash: string | null }>(
      `SELECT password_hash
       FROM customer_identities
       WHERE organization_id = $1
         AND customer_id = $2
         AND provider = 'password'
         AND active
       LIMIT 1`,
      [input.organizationId, input.customerId]
    );
    const row = result.rows[0];
    return row?.password_hash ? { passwordHash: row.password_hash } : null;
  }

  async savePasswordIdentity(input: {
    organizationId: string;
    customerId: string;
    email: string | null;
    phone: string | null;
    passwordHash: string;
  }): Promise<void> {
    const providerSubject = normalizedIdentity(input.email ?? input.phone);
    if (!providerSubject) {
      throw new ValidationFailedError('Email or phone is required to add a password');
    }

    const existing = await this.client.query<{ id: string; customer_id: string }>(
      `SELECT id, customer_id
       FROM customer_identities
       WHERE organization_id = $1
         AND provider = 'password'
         AND provider_subject = $2
       LIMIT 1`,
      [input.organizationId, providerSubject]
    );
    const identity = existing.rows[0];
    if (identity && identity.customer_id !== input.customerId) {
      throw new ResourceConflictError('This email or phone is already linked to another account');
    }

    if (identity) {
      await this.client.query(
        `UPDATE customer_identities
         SET password_hash = $3, active = TRUE, updated_at = now()
         WHERE id = $1 AND organization_id = $2`,
        [identity.id, input.organizationId, input.passwordHash]
      );
      return;
    }

    await this.client.query(
      `INSERT INTO customer_identities (
         organization_id, customer_id, provider, provider_subject, password_hash
       ) VALUES ($1, $2, 'password', $3, $4)`,
      [input.organizationId, input.customerId, providerSubject, input.passwordHash]
    );
  }

  async createCustomerPasswordReset(input: {
    organizationId: string;
    email: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<{ email: string } | null> {
    const customer = await this.client.query<{ id: string; email: string }>(
      `SELECT id, email
       FROM customers
       WHERE organization_id = $1
         AND lower(email) = lower($2)
         AND active
         AND deleted_at IS NULL
       LIMIT 1`,
      [input.organizationId, input.email]
    );
    const row = customer.rows[0];
    if (!row?.email) return null;

    await this.client.query(
      `INSERT INTO customer_password_reset_tokens (
         organization_id, customer_id, token_hash, expires_at
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id, customer_id) WHERE used_at IS NULL
       DO UPDATE SET token_hash = EXCLUDED.token_hash,
                     expires_at = EXCLUDED.expires_at,
                     created_at = now()`,
      [input.organizationId, row.id, input.tokenHash, input.expiresAt]
    );
    return { email: row.email };
  }

  async consumeCustomerPasswordReset(tokenHash: string): Promise<CustomerPasswordResetRecord> {
    const result = await this.client.query<{
      organization_id: string;
      customer_id: string;
      email: string;
      phone: string | null;
    }>(
      `WITH matched_token AS (
         UPDATE customer_password_reset_tokens
         SET used_at = now()
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
         RETURNING organization_id, customer_id
       )
       SELECT token.organization_id, token.customer_id, customer.email, customer.phone
       FROM matched_token token
       JOIN customers customer
         ON customer.organization_id = token.organization_id
        AND customer.id = token.customer_id
        AND customer.active
        AND customer.deleted_at IS NULL`,
      [tokenHash]
    );
    const row = result.rows[0];
    if (!row?.email) {
      throw new ValidationFailedError('Link za promenu lozinke nije važeći ili je istekao.');
    }
    return {
      organizationId: row.organization_id,
      customerId: row.customer_id,
      email: row.email,
      phone: row.phone
    };
  }

  async findOAuthCustomer(input: {
    organizationId: string;
    provider: 'google';
    providerSubject: string;
  }): Promise<OAuthCustomerRecord | null> {
    const result = await this.client.query<{ id: string; organization_id: string }>(
      `SELECT c.id, c.organization_id
       FROM customer_identities ci
       JOIN customers c ON c.id = ci.customer_id
        AND c.organization_id = ci.organization_id
        AND c.deleted_at IS NULL
       WHERE ci.organization_id = $1
         AND ci.provider = $2
         AND ci.provider_subject = $3
         AND ci.active
       LIMIT 1`,
      [input.organizationId, input.provider, input.providerSubject]
    );
    const row = result.rows[0];
    return row ? { id: row.id, organizationId: row.organization_id } : null;
  }

  async findCustomerByEmail(input: {
    organizationId: string;
    email: string;
  }): Promise<OAuthCustomerRecord | null> {
    const result = await this.client.query<{ id: string; organization_id: string }>(
      `SELECT id, organization_id
       FROM customers
       WHERE organization_id = $1
         AND normalized_email = lower($2)
         AND deleted_at IS NULL
       LIMIT 1`,
      [input.organizationId, input.email]
    );
    const row = result.rows[0];
    return row ? { id: row.id, organizationId: row.organization_id } : null;
  }

  async findCustomerByVerifiedPhone(input: {
    organizationId: string;
    phone: string;
  }): Promise<OAuthCustomerRecord | null> {
    const result = await this.client.query<{ id: string; organization_id: string }>(
      `SELECT id, organization_id
       FROM customers
       WHERE organization_id = $1
         AND normalized_phone = regexp_replace($2, '[^0-9+]', '', 'g')
         AND phone_verified = TRUE
         AND active
         AND deleted_at IS NULL
       LIMIT 1`,
      [input.organizationId, input.phone]
    );
    const row = result.rows[0];
    return row ? { id: row.id, organizationId: row.organization_id } : null;
  }

  async createGoogleCustomer(input: {
    organizationId: string;
    email: string;
    displayName: string;
    photoUrl?: string | null;
    providerSubject: string;
  }): Promise<OAuthCustomerRecord> {
    const result = await this.client.query<{ id: string; organization_id: string }>(
      `INSERT INTO customers (
         organization_id, email, display_name, first_name, last_name, photo_url, email_verified
       )
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       RETURNING id, organization_id`,
      [
        input.organizationId,
        input.email,
        input.displayName,
        firstName(input.displayName),
        lastName(input.displayName),
        input.photoUrl ?? null
      ]
    );
    const row = requireRow(result);
    await this.linkOAuthIdentity({
      organizationId: input.organizationId,
      customerId: row.id,
      provider: 'google',
      providerSubject: input.providerSubject
    });
    return { id: row.id, organizationId: row.organization_id };
  }

  async linkOAuthIdentity(input: {
    organizationId: string;
    customerId: string;
    provider: 'google';
    providerSubject: string;
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO customer_identities (
         organization_id, customer_id, provider, provider_subject
       )
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id, provider, provider_subject) DO UPDATE
       SET active = TRUE, updated_at = now()`,
      [input.organizationId, input.customerId, input.provider, input.providerSubject]
    );
  }

  async createSession(input: {
    organizationId: string;
    customerId: string;
    familyId: string;
    refreshTokenHash: string;
    refreshJti: string;
    expiresAt: Date;
    ipHash?: string | null;
    userAgentHash?: string | null;
  }): Promise<CustomerSessionRecord> {
    const result = await this.client.query<CustomerSessionRow>(
      `INSERT INTO customer_sessions (
         organization_id, customer_id, family_id, refresh_token_hash, refresh_jti,
         expires_at, ip_hash, user_agent_hash
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.organizationId,
        input.customerId,
        input.familyId,
        input.refreshTokenHash,
        input.refreshJti,
        input.expiresAt,
        input.ipHash ?? null,
        input.userAgentHash ?? null
      ]
    );
    return mapCustomerSession(requireRow(result));
  }

  async findActiveRefreshSession(input: {
    organizationId: string;
    customerId: string;
    familyId: string;
    refreshJti: string;
    refreshTokenHash: string;
  }): Promise<CustomerSessionRecord> {
    const result = await this.client.query<CustomerSessionRow>(
      `SELECT *
       FROM customer_sessions
       WHERE organization_id = $1 AND customer_id = $2 AND family_id = $3 AND refresh_jti = $4
       FOR UPDATE`,
      [input.organizationId, input.customerId, input.familyId, input.refreshJti]
    );
    const session = result.rows[0] ? mapCustomerSession(result.rows[0]) : null;
    if (!session || session.refreshTokenHash !== input.refreshTokenHash) {
      await this.revokeSessionFamily(
        input.organizationId,
        input.customerId,
        input.familyId,
        'refresh_reuse_detected'
      );
      throw new InvalidTokenError();
    }
    if (session.revokedAt || session.expiresAt <= new Date()) {
      await this.revokeSessionFamily(
        input.organizationId,
        input.customerId,
        input.familyId,
        'refresh_expired_or_revoked'
      );
      throw new InvalidTokenError();
    }
    return session;
  }

  async rotateRefreshSession(input: {
    sessionId: string;
    replacementRefreshTokenHash: string;
    replacementRefreshJti: string;
    expiresAt: Date;
  }): Promise<CustomerSessionRecord> {
    const currentResult = await this.client.query<CustomerSessionRow>(
      `SELECT * FROM customer_sessions WHERE id = $1 FOR UPDATE`,
      [input.sessionId]
    );
    const current = mapCustomerSession(requireRow(currentResult));
    if (current.revokedAt || current.expiresAt <= new Date()) {
      await this.revokeSessionFamily(
        current.organizationId,
        current.customerId,
        current.familyId,
        'refresh_expired_or_revoked'
      );
      throw new InvalidTokenError();
    }
    const replacement = await this.createSession({
      organizationId: current.organizationId,
      customerId: current.customerId,
      familyId: current.familyId,
      refreshTokenHash: input.replacementRefreshTokenHash,
      refreshJti: input.replacementRefreshJti,
      expiresAt: input.expiresAt
    });
    await this.client.query(
      `UPDATE customer_sessions
       SET revoked_at = now(), revoked_reason = 'rotated', replaced_by_session_id = $2
       WHERE id = $1`,
      [current.id, replacement.id]
    );
    return replacement;
  }

  async revokeSession(sessionId: string, reason: string): Promise<void> {
    await this.client.query(
      `UPDATE customer_sessions
       SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = $2
       WHERE id = $1`,
      [sessionId, reason]
    );
  }

  async revokeSessionFamily(
    organizationId: string,
    customerId: string,
    familyId: string,
    reason: string
  ): Promise<void> {
    await this.client.query(
      `UPDATE customer_sessions
       SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = $4
       WHERE organization_id = $1 AND customer_id = $2 AND family_id = $3 AND revoked_at IS NULL`,
      [organizationId, customerId, familyId, reason]
    );
  }

  async assertAccessSession(input: {
    organizationId: string;
    customerId: string;
    familyId: string;
    sessionId: string;
  }): Promise<void> {
    const result: pg.QueryResult<{ id: string; email: string; active: boolean }> =
      await this.client.query<{ id: string; email: string; active: boolean }>(
        `SELECT 1
       FROM customer_sessions
       WHERE id = $4 AND organization_id = $1 AND customer_id = $2 AND family_id = $3
         AND revoked_at IS NULL AND expires_at > now()`,
        [input.organizationId, input.customerId, input.familyId, input.sessionId]
      );
    if (result.rowCount !== 1) {
      throw new InvalidTokenError();
    }
  }

  async buildCustomerPrincipal(input: {
    organizationId: string;
    customerId: string;
    sessionFamilyId: string;
    sessionId?: string;
  }): Promise<CustomerPrincipal> {
    const result = await this.client.query<CustomerRow>(
      `SELECT c.*,
         EXISTS (
           SELECT 1 FROM customer_identities ci
           WHERE ci.organization_id = c.organization_id
             AND ci.customer_id = c.id
             AND ci.provider = 'password'
             AND ci.active
             AND ci.password_hash IS NOT NULL
         ) AS has_password,
         EXISTS (
           SELECT 1 FROM customer_identities ci
           WHERE ci.organization_id = c.organization_id
             AND ci.customer_id = c.id
             AND ci.provider = 'google'
             AND ci.active
         ) AS google_linked
       FROM customers c
       WHERE c.organization_id = $1 AND c.id = $2 AND c.deleted_at IS NULL`,
      [input.organizationId, input.customerId]
    );
    const row = result.rows[0];
    if (!row?.active) {
      throw new InvalidCredentialsError();
    }
    return mapCustomerPrincipal(row, input.sessionFamilyId, input.sessionId);
  }

  async getCustomer(input: { organizationId: string; customerId: string }) {
    const result = await this.client.query<CustomerRow>(
      `SELECT * FROM customers WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [input.organizationId, input.customerId]
    );
    return serializeCustomer(requireRow(result));
  }

  async updateCustomer(input: {
    organizationId: string;
    customerId: string;
    displayName?: string | undefined;
    phone?: string | null | undefined;
    photoUrl?: string | null | undefined;
  }) {
    const result = await this.client.query<CustomerRow>(
      `UPDATE customers
       SET display_name = COALESCE($3, display_name),
           phone = COALESCE($4, phone),
           photo_url = COALESCE($5, photo_url),
           updated_at = now(),
           version = version + 1
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
       RETURNING *`,
      [
        input.organizationId,
        input.customerId,
        input.displayName ?? null,
        input.phone ?? null,
        input.photoUrl ?? null
      ]
    );
    return serializeCustomer(requireRow(result));
  }

  async verifyCustomerPhone(input: {
    organizationId: string;
    customerId: string;
    phone: string;
  }) {
    const existing = await this.client.query<{ id: string }>(
      `SELECT id
       FROM customers
       WHERE organization_id = $1
         AND normalized_phone = regexp_replace($2, '[^0-9+]', '', 'g')
         AND id <> $3
         AND deleted_at IS NULL
       LIMIT 1`,
      [input.organizationId, input.phone, input.customerId]
    );
    if (existing.rowCount) {
      throw new ResourceConflictError('Ovaj broj telefona je već povezan sa drugim nalogom.');
    }
    const result = await this.client.query<CustomerRow>(
      `UPDATE customers
       SET phone = $3,
           phone_verified = TRUE,
           updated_at = now(),
           version = version + 1
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
       RETURNING *`,
      [input.organizationId, input.customerId, input.phone]
    );
    return serializeCustomer(requireRow(result));
  }

  async listAddresses(input: { organizationId: string; customerId: string }) {
    const result = await this.client.query<AddressRow>(
      `SELECT * FROM customer_addresses
       WHERE organization_id = $1 AND customer_id = $2 AND deleted_at IS NULL
       ORDER BY is_default DESC, created_at DESC`,
      [input.organizationId, input.customerId]
    );
    return result.rows.map(serializeAddress);
  }

  async createAddress(input: {
    organizationId: string;
    customerId: string;
    payload: AddressPayload;
  }) {
    const result = await this.client.query<AddressRow>(
      `INSERT INTO customer_addresses (
         organization_id, customer_id, label, icon, name, phone, address, city, zip, country_code, is_default
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        input.organizationId,
        input.customerId,
        input.payload.label ?? 'Kuća',
        input.payload.icon ?? 'home',
        input.payload.name,
        input.payload.phone,
        input.payload.address,
        input.payload.city,
        input.payload.zip ?? null,
        input.payload.countryCode ?? 'RS',
        input.payload.isDefault ?? false
      ]
    );
    return serializeAddress(requireRow(result));
  }

  async updateAddress(input: {
    organizationId: string;
    customerId: string;
    addressId: string;
    payload: AddressPatchPayload;
  }) {
    const existing = await this.client.query<AddressRow>(
      `SELECT * FROM customer_addresses
       WHERE organization_id = $1 AND customer_id = $2 AND id = $3 AND deleted_at IS NULL`,
      [input.organizationId, input.customerId, input.addressId]
    );
    const current = requireRow(existing);
    const payload = input.payload;
    const result = await this.client.query<AddressRow>(
      `UPDATE customer_addresses
       SET label = $4, icon = $5, name = $6, phone = $7, address = $8, city = $9,
           zip = $10, country_code = $11, is_default = $12, updated_at = now()
       WHERE organization_id = $1 AND customer_id = $2 AND id = $3
       RETURNING *`,
      [
        input.organizationId,
        input.customerId,
        input.addressId,
        payload.label ?? current.label,
        payload.icon ?? current.icon,
        payload.name ?? current.name,
        payload.phone ?? current.phone,
        payload.address ?? current.address,
        payload.city ?? current.city,
        payload.zip ?? current.zip,
        payload.countryCode ?? current.country_code,
        payload.isDefault ?? current.is_default
      ]
    );
    return serializeAddress(requireRow(result));
  }

  async deleteAddress(input: {
    organizationId: string;
    customerId: string;
    addressId: string;
  }): Promise<void> {
    const result: pg.QueryResult<{ id: string; email: string; active: boolean }> =
      await this.client.query<{ id: string; email: string; active: boolean }>(
        `UPDATE customer_addresses SET deleted_at = now()
       WHERE organization_id = $1 AND customer_id = $2 AND id = $3 AND deleted_at IS NULL`,
        [input.organizationId, input.customerId, input.addressId]
      );
    if (result.rowCount !== 1) {
      throw new ResourceNotFoundError('customer address');
    }
  }

  async replaceCart(input: {
    organizationId: string;
    customerId: string;
    items: Array<StorefrontItemSnapshot & { qty?: number; quantity?: number }>;
  }) {
    await this.client.query(
      `DELETE FROM customer_cart_items WHERE organization_id = $1 AND customer_id = $2`,
      [input.organizationId, input.customerId]
    );
    for (const item of input.items) {
      const productId = productIdFromItem(item);
      if (!productId) {
        continue;
      }
      await this.client.query(
        `INSERT INTO customer_cart_items (
           organization_id, customer_id, product_id, variant_id, quantity, item_snapshot
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          input.organizationId,
          input.customerId,
          productId,
          uuidOrNull(item.variantId),
          item.qty ?? item.quantity ?? 1,
          JSON.stringify(item)
        ]
      );
    }
    return this.getCart(input);
  }

  async getCart(input: { organizationId: string; customerId: string }) {
    const result = await this.client.query<CartItemRow>(
      `SELECT * FROM customer_cart_items
       WHERE organization_id = $1 AND customer_id = $2
       ORDER BY updated_at DESC`,
      [input.organizationId, input.customerId]
    );
    return result.rows.map((row) => ({ ...row.item_snapshot, qty: row.quantity }));
  }

  async listWishlist(input: { organizationId: string; customerId: string }) {
    const result = await this.client.query<WishlistItemRow>(
      `SELECT * FROM customer_wishlist_items
       WHERE organization_id = $1 AND customer_id = $2
       ORDER BY created_at DESC`,
      [input.organizationId, input.customerId]
    );
    return result.rows.map((row) => row.item_snapshot);
  }

  async addWishlistItem(input: {
    organizationId: string;
    customerId: string;
    item: StorefrontItemSnapshot;
  }) {
    const productId = productIdFromItem(input.item);
    if (!productId) {
      throw new ValidationFailedError('Wishlist item requires product id');
    }
    await this.client.query(
      `INSERT INTO customer_wishlist_items (
         organization_id, customer_id, product_id, item_snapshot
       )
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (organization_id, customer_id, product_id)
       DO UPDATE SET item_snapshot = EXCLUDED.item_snapshot`,
      [input.organizationId, input.customerId, productId, JSON.stringify(input.item)]
    );
    return this.listWishlist(input);
  }

  async removeWishlistItem(input: {
    organizationId: string;
    customerId: string;
    email?: string | null;
    productId: string;
  }) {
    const removedAlerts = await this.client.query<{ id: string }>(
      `WITH removed_wishlist_item AS (
         DELETE FROM customer_wishlist_items
         WHERE organization_id = $1 AND customer_id = $2 AND product_id = $3
         RETURNING product_id
       )
       SELECT alert.id
       FROM product_alert_subscriptions alert
       JOIN removed_wishlist_item removed ON alert.product_id = removed.product_id
       WHERE alert.organization_id = $1 AND alert.product_id = removed.product_id
         AND alert.active
         AND (
           alert.customer_id = $2
           OR ($4::text IS NOT NULL AND alert.normalized_email = lower($4))
         )`,
      [input.organizationId, input.customerId, input.productId, input.email ?? null]
    );
    return {
      wishlist: await this.listWishlist(input),
      alertIds: removedAlerts.rows.map((row) => row.id)
    };
  }

  /**
   * Cart and wishlist entries keep a display snapshot of a product. Remove
   * those snapshots only when the catalog product is deleted.
   */
  async removeProductFromCustomerLists(input: {
    organizationId: string;
    productId: string;
  }): Promise<void> {
    await this.client.query(
      `DELETE FROM customer_cart_items
       WHERE organization_id = $1 AND product_id = $2`,
      [input.organizationId, input.productId]
    );
    await this.client.query(
      `DELETE FROM customer_wishlist_items
       WHERE organization_id = $1 AND product_id = $2`,
      [input.organizationId, input.productId]
    );
  }

  async revokeCustomerSessions(
    organizationId: string,
    customerId: string,
    reason: string
  ): Promise<void> {
    await this.client.query(
      `UPDATE customer_sessions
       SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = $3
       WHERE organization_id = $1 AND customer_id = $2 AND revoked_at IS NULL`,
      [organizationId, customerId, reason]
    );
  }

  /** Remove alert subscriptions for one customer or for a deleted product. */
  async removeProductAlerts(input: {
    organizationId: string;
    productId: string;
    customerId?: string;
    email?: string | null;
  }): Promise<void> {
    await this.client.query(
      `DELETE FROM product_alert_subscriptions
       WHERE organization_id = $1 AND product_id = $2
         AND (
           ($3::uuid IS NULL AND $4::text IS NULL)
           OR customer_id = $3
           OR ($4::text IS NOT NULL AND normalized_email = lower($4))
         )`,
      [
        input.organizationId,
        input.productId,
        input.customerId ?? null,
        input.email ?? null
      ]
    );
  }

  /** Keep the product snapshots shown in carts and wishlists current. */
  async refreshProductSnapshots(input: {
    organizationId: string;
    productId: string;
  }): Promise<void> {
    const snapshotResult = await this.client.query<CustomerListProductSnapshotRow>(
      `SELECT p.id AS product_id, p.name, p.slug, b.name AS brand,
              variant.id AS variant_id,
              COALESCE(active_sale.amount_minor, variant.current_price_amount)::double precision / 100 AS price,
              primary_asset.public_url AS image, thumb.public_url AS thumb
       FROM products p
       LEFT JOIN LATERAL (
         SELECT pv.id, pv.current_price_amount
         FROM product_variants pv
         WHERE pv.organization_id = p.organization_id
           AND pv.product_id = p.id AND pv.deleted_at IS NULL
         ORDER BY pv.current_price_amount, pv.id
         LIMIT 1
       ) variant ON true
       LEFT JOIN LATERAL (
         SELECT vp.amount_minor
         FROM variant_prices vp
         WHERE vp.organization_id = p.organization_id AND vp.variant_id = variant.id
           AND vp.price_type = 'sale' AND vp.valid_from <= now()
           AND (vp.valid_until IS NULL OR vp.valid_until > now())
         ORDER BY vp.valid_from DESC, vp.created_at DESC
         LIMIT 1
       ) active_sale ON true
       LEFT JOIN brands b ON b.id = p.brand_id AND b.organization_id = p.organization_id
       LEFT JOIN LATERAL (
         SELECT ma.public_url
         FROM product_media pm
         JOIN media_assets ma ON ma.id = pm.media_asset_id AND ma.status = 'ready'
         WHERE pm.organization_id = p.organization_id AND pm.product_id = p.id
         ORDER BY pm.is_primary DESC, pm.position ASC, pm.id
         LIMIT 1
       ) primary_asset ON true
       LEFT JOIN LATERAL (
         SELECT md.public_url
         FROM product_media pm
         JOIN media_derivatives md ON md.media_asset_id = pm.media_asset_id
         WHERE pm.organization_id = p.organization_id AND pm.product_id = p.id
         ORDER BY pm.is_primary DESC, pm.position ASC, md.width ASC
         LIMIT 1
       ) thumb ON true
       WHERE p.organization_id = $1 AND p.id = $2 AND p.deleted_at IS NULL`,
      [input.organizationId, input.productId]
    );
    const snapshot = snapshotResult.rows[0];
    if (!snapshot) return;

    const itemSnapshot = JSON.stringify({
      id: snapshot.product_id,
      productId: snapshot.product_id,
      variantId: snapshot.variant_id,
      name: snapshot.name,
      brand: snapshot.brand,
      slug: snapshot.slug,
      image: snapshot.image,
      thumb: snapshot.thumb,
      price: snapshot.price
    });
    await this.client.query(
      `UPDATE customer_cart_items
       SET variant_id = $3, item_snapshot = item_snapshot || $4::jsonb, updated_at = now()
       WHERE organization_id = $1 AND product_id = $2`,
      [input.organizationId, input.productId, snapshot.variant_id, itemSnapshot]
    );
    await this.client.query(
      `UPDATE customer_wishlist_items
       SET item_snapshot = item_snapshot || $3::jsonb
       WHERE organization_id = $1 AND product_id = $2`,
      [input.organizationId, input.productId, itemSnapshot]
    );
  }

  async createOrder(organizationId: string, input: CheckoutInput) {
    const displayId = await this.createDisplayId(organizationId);
    const customer = input.customer;
    const email = stringValue(customer.email);
    const phone = stringValue(customer.phone);
    const orderResult = await this.client.query<OrderRow>(
      `INSERT INTO orders (
         organization_id, display_id, customer_id, customer_email, customer_phone,
         customer_payload, shipping_payload, items_payload, subtotal_amount, discount_amount,
         shipping_amount, total_amount, promo_code, shipping_method, payment_method, status
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, 'Na čekanju')
       RETURNING *`,
      [
        organizationId,
        displayId,
        input.customerId ?? null,
        email,
        phone,
        JSON.stringify(customer),
        JSON.stringify({
          method: input.shippingMethod,
          address: customer.address,
          city: customer.city,
          postalCode: customer.postalCode
        }),
        JSON.stringify(input.items),
        input.subtotalAmount,
        input.discountAmount,
        input.shippingAmount,
        input.totalAmount,
        input.promoCode ?? null,
        input.shippingMethod,
        input.paymentMethod
      ]
    );
    const order = requireRow(orderResult);
    for (const item of input.items) {
      const quantity = item.qty ?? item.quantity ?? 1;
      const unitAmount = amountMinorFromMajor(item.price);
      await this.client.query(
        `INSERT INTO order_items (
           organization_id, order_id, product_id, variant_id, name, brand, slug, image_url,
           unit_amount, quantity, total_amount, item_snapshot
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
        [
          organizationId,
          order.id,
          productIdFromItem(item),
          uuidOrNull(item.variantId),
          item.name ?? 'Proizvod',
          item.brand ?? null,
          item.slug ?? null,
          item.image ?? item.thumb ?? null,
          unitAmount,
          quantity,
          unitAmount * quantity,
          JSON.stringify(item)
        ]
      );
    }
    await this.client.query(
      `INSERT INTO order_status_history (organization_id, order_id, status)
       VALUES ($1, $2, $3)`,
      [organizationId, order.id, order.status]
    );
    return serializeOrder(order);
  }

  async listCustomerOrders(input: {
    organizationId: string;
    customerId?: string | null;
    email?: string | null;
  }) {
    const params: unknown[] = [input.organizationId];
    const where = ['organization_id = $1', 'deleted_at IS NULL'];
    if (input.customerId) {
      params.push(input.customerId);
      where.push(`customer_id = $${params.length}`);
    } else if (input.email) {
      params.push(input.email.toLowerCase());
      where.push(`lower(customer_email) = $${params.length}`);
    } else {
      return [];
    }
    const result = await this.client.query<OrderRow>(
      `SELECT * FROM orders
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT 100`,
      params
    );
    return result.rows.map(serializeOrder);
  }

  async listAdminOrders(organizationId: string) {
    const result = await this.client.query<OrderRow>(
      `SELECT * FROM orders
       WHERE organization_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 200`,
      [organizationId]
    );
    return result.rows.map(serializeOrder);
  }

  async getOrder(input: { organizationId: string; orderIdOrDisplayId: string }) {
    const result = await this.client.query<OrderRow>(
      `SELECT * FROM orders
       WHERE organization_id = $1 AND (id::text = $2 OR display_id = $2) AND deleted_at IS NULL
       LIMIT 1`,
      [input.organizationId, input.orderIdOrDisplayId]
    );
    return serializeOrder(requireRow(result));
  }

  async updateOrderStatus(input: {
    organizationId: string;
    orderIdOrDisplayId: string;
    status: string;
    userId?: string;
  }) {
    const order = await this.client.query<OrderRow>(
      `UPDATE orders
       SET status = $3, updated_at = now(), version = version + 1
       WHERE organization_id = $1 AND (id::text = $2 OR display_id = $2) AND deleted_at IS NULL
       RETURNING *`,
      [input.organizationId, input.orderIdOrDisplayId, input.status]
    );
    const row = requireRow(order);
    await this.client.query(
      `INSERT INTO order_status_history (organization_id, order_id, status, changed_by_user_id)
       VALUES ($1, $2, $3, $4)`,
      [input.organizationId, row.id, input.status, input.userId ?? null]
    );
    return serializeOrder(row);
  }

  async markOrderRead(input: { organizationId: string; orderIdOrDisplayId: string }) {
    const result = await this.client.query<OrderRow>(
      `UPDATE orders
       SET is_read = true, updated_at = now()
       WHERE organization_id = $1 AND (id::text = $2 OR display_id = $2) AND deleted_at IS NULL
       RETURNING *`,
      [input.organizationId, input.orderIdOrDisplayId]
    );
    return serializeOrder(requireRow(result));
  }

  async listReviews(organizationId: string, productId: string) {
    const result = await this.client.query<ReviewRow>(
      `SELECT * FROM product_reviews
       WHERE organization_id = $1 AND product_id = $2 AND status = 'published' AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [organizationId, productId]
    );
    return result.rows.map(serializeReview);
  }

  async addReview(input: {
    organizationId: string;
    productId: string;
    customerId?: string | null;
    userName: string;
    rating: number;
    comment: string;
  }) {
    const result = await this.client.query<ReviewRow>(
      `INSERT INTO product_reviews (
         organization_id, product_id, customer_id, user_name, rating, comment
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.organizationId,
        input.productId,
        input.customerId ?? null,
        input.userName,
        input.rating,
        input.comment
      ]
    );
    return serializeReview(requireRow(result));
  }

  async subscribeProductAlert(input: {
    organizationId: string;
    productId: string;
    variantId: string;
    customerId?: string | null;
    contactId?: string | null;
    email?: string | null;
    phone?: string | null;
    deliveryChannel: ProductAlertDeliveryChannel;
    type: ProductAlertType;
  }): Promise<ProductAlertSubscription> {
    const product = await this.client.query<{
      current_price_amount: number;
      available_quantity: number;
    }>(
      `SELECT v.current_price_amount,
              COALESCE(SUM(balance.quantity), 0)::int AS available_quantity
       FROM products p
       JOIN product_variants v
         ON v.id = $3
        AND v.product_id = p.id
        AND v.organization_id = p.organization_id
        AND v.deleted_at IS NULL
        AND v.active
        AND v.published
       LEFT JOIN inventory_balances balance
         ON balance.organization_id = v.organization_id
        AND balance.variant_id = v.id
       WHERE p.organization_id = $1
         AND p.id = $2
         AND p.deleted_at IS NULL
         AND p.active
         AND p.published
       GROUP BY v.current_price_amount`,
      [input.organizationId, input.productId, input.variantId]
    );
    const current = product.rows[0];
    if (!current) throw new ResourceNotFoundError('product variant');
    if (input.type === 'back_in_stock' && current.available_quantity > 0) {
      throw new ResourceConflictError('Ovaj proizvod je već na stanju.');
    }

    const result = await this.client.query<{
      id: string;
      email: string | null;
      phone: string | null;
      delivery_channel: ProductAlertDeliveryChannel;
      alert_type: ProductAlertType;
      active: boolean;
      contact_id: string | null;
    }>(
      `INSERT INTO product_alert_subscriptions (
         organization_id, product_id, variant_id, customer_id, contact_id, delivery_channel,
         email, phone, alert_type, requested_price_amount
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (organization_id, variant_id, delivery_channel, contact_key, alert_type) DO UPDATE
       SET customer_id = COALESCE(EXCLUDED.customer_id, product_alert_subscriptions.customer_id),
           contact_id = COALESCE(EXCLUDED.contact_id, product_alert_subscriptions.contact_id),
           active = TRUE,
           revoked_at = NULL,
           consent_status = CASE
             WHEN EXCLUDED.contact_id IS NOT NULL THEN 'explicit'
             ELSE product_alert_subscriptions.consent_status
           END,
           requested_price_amount = EXCLUDED.requested_price_amount,
           notified_at = NULL,
           updated_at = now()
       RETURNING id, email, phone, delivery_channel, alert_type, active, contact_id`,
      [
        input.organizationId,
        input.productId,
        input.variantId,
        input.customerId ?? null,
        input.contactId ?? null,
        input.deliveryChannel,
        input.deliveryChannel === 'email' ? input.email?.trim().toLowerCase() ?? null : null,
        input.deliveryChannel === 'sms' ? input.phone?.trim() ?? null : null,
        input.type,
        input.type === 'price_change' ? current.current_price_amount : null
      ]
    );
    const row = requireRow(result);
    return {
      id: row.id,
      email: row.email,
      phone: row.phone,
      deliveryChannel: row.delivery_channel,
      type: row.alert_type,
      active: row.active,
      contactId: row.contact_id
    };
  }

  async listActiveProductAlertTypes(input: {
    organizationId: string;
    productId: string;
    variantId: string;
    customerId?: string | null;
    email?: string | null;
    phone?: string | null;
  }): Promise<ProductAlertType[]> {
    const result = await this.client.query<{ alert_type: ProductAlertType }>(
      `SELECT alert_type
       FROM product_alert_subscriptions
       WHERE organization_id = $1
         AND product_id = $2
         AND variant_id = $3
         AND (
           customer_id = $4
           OR normalized_email = lower($5)
           OR normalized_phone = regexp_replace($6, '[^0-9+]', '', 'g')
         )
         AND active = TRUE
       ORDER BY alert_type`,
      [
        input.organizationId,
        input.productId,
        input.variantId,
        input.customerId ?? null,
        input.email ?? null,
        input.phone ?? null
      ]
    );
    return result.rows.map((row) => row.alert_type);
  }

  async subscribeSmsMarketing(input: {
    organizationId: string;
    customerId?: string | null;
    phone: string;
    policyVersion?: string | undefined;
    source: string;
  }): Promise<void> {
    await this.client.query(
      `INSERT INTO sms_marketing_subscribers (
         organization_id, customer_id, phone, consent_version, source
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (organization_id, normalized_phone) DO UPDATE
       SET customer_id = COALESCE(EXCLUDED.customer_id, sms_marketing_subscribers.customer_id),
           phone = EXCLUDED.phone,
           active = TRUE,
           consent_version = EXCLUDED.consent_version,
           consented_at = now(),
           revoked_at = NULL,
           source = EXCLUDED.source,
           updated_at = now()`,
      [
        input.organizationId,
        input.customerId ?? null,
        input.phone,
        input.policyVersion ?? null,
        input.source
      ]
    );
  }

  /** Remove one alert type without touching another alert for the same product. */
  async unsubscribeProductAlert(input: {
    organizationId: string;
    productId: string;
    variantId: string;
    customerId?: string | null;
    email: string;
    type: ProductAlertType;
  }): Promise<void> {
    await this.client.query(
      `DELETE FROM product_alert_subscriptions
       WHERE organization_id = $1
         AND product_id = $2
         AND variant_id = $3
         AND alert_type = $4
         AND (
           customer_id = $5
           OR normalized_email = lower($6)
         )`,
      [
        input.organizationId,
        input.productId,
        input.variantId,
        input.type,
        input.customerId ?? null,
        input.email
      ]
    );
  }

  async claimBackInStockProductAlerts(input: {
    organizationId: string;
    variantId: string;
  }): Promise<ProductAlertNotification[]> {
    const result = await this.client.query<ProductAlertNotificationRow>(
      `WITH inventory AS (
         SELECT COALESCE(SUM(quantity), 0)::int AS available_quantity
         FROM inventory_balances
         WHERE organization_id = $1 AND variant_id = $2
       )
       UPDATE product_alert_subscriptions alert
       SET active = FALSE, notified_at = now(), updated_at = now()
       FROM product_variants variant
       JOIN products product
         ON product.id = variant.product_id
        AND product.organization_id = variant.organization_id
       LEFT JOIN brands brand
         ON brand.id = product.brand_id
        AND brand.organization_id = product.organization_id
       LEFT JOIN LATERAL (
         SELECT media_asset.public_url
         FROM product_media media
         JOIN media_assets media_asset
           ON media_asset.id = media.media_asset_id
          AND media_asset.status = 'ready'
         WHERE media.organization_id = product.organization_id
           AND media.product_id = product.id
         ORDER BY media.is_primary DESC, media.position ASC, media.id
         LIMIT 1
       ) primary_asset ON true
       CROSS JOIN inventory
       WHERE alert.organization_id = $1
         AND alert.variant_id = $2
         AND alert.alert_type = 'back_in_stock'
         AND alert.active
         AND variant.id = alert.variant_id
         AND variant.organization_id = alert.organization_id
         AND variant.deleted_at IS NULL
         AND variant.active
         AND variant.published
         AND product.deleted_at IS NULL
         AND product.active
         AND product.published
         AND inventory.available_quantity > 0
       RETURNING alert.id AS subscription_id, alert.email, alert.phone, alert.delivery_channel,
                 product.name AS product_name, brand.name AS brand, product.slug, primary_asset.public_url AS image_url,
                 variant.currency, variant.current_price_amount,
                 NULL::integer AS previous_price_amount`,
      [input.organizationId, input.variantId]
    );
    return result.rows.map(mapProductAlertNotification);
  }

  async claimPriceChangeProductAlerts(input: {
    organizationId: string;
    variantId: string;
    previousPriceAmount: number;
    currentPriceAmount: number;
  }): Promise<ProductAlertNotification[]> {
    const result = await this.client.query<ProductAlertNotificationRow>(
      `UPDATE product_alert_subscriptions alert
       SET notified_at = now(), updated_at = now()
       FROM product_variants variant
       JOIN products product
         ON product.id = variant.product_id
        AND product.organization_id = variant.organization_id
       LEFT JOIN brands brand
         ON brand.id = product.brand_id
        AND brand.organization_id = product.organization_id
       LEFT JOIN LATERAL (
         SELECT media_asset.public_url
         FROM product_media media
         JOIN media_assets media_asset
           ON media_asset.id = media.media_asset_id
          AND media_asset.status = 'ready'
         WHERE media.organization_id = product.organization_id
           AND media.product_id = product.id
         ORDER BY media.is_primary DESC, media.position ASC, media.id
         LIMIT 1
       ) primary_asset ON true
       WHERE alert.organization_id = $1
         AND alert.variant_id = $2
         AND alert.alert_type = 'price_change'
         AND alert.active
         AND variant.id = alert.variant_id
         AND variant.organization_id = alert.organization_id
         AND variant.deleted_at IS NULL
         AND variant.active
         AND variant.published
         AND product.deleted_at IS NULL
         AND product.active
         AND product.published
       RETURNING alert.id AS subscription_id, alert.email, alert.phone, alert.delivery_channel,
                 product.name AS product_name, brand.name AS brand, product.slug, primary_asset.public_url AS image_url,
                 variant.currency, $3::integer AS previous_price_amount,
                 $4::integer AS current_price_amount`,
      [
        input.organizationId,
        input.variantId,
        input.previousPriceAmount,
        input.currentPriceAmount
      ]
    );
    return result.rows.map(mapProductAlertNotification);
  }

  async subscribeNewsletter(input: {
    organizationId: string;
    email: string;
    source?: string | undefined;
  }) {
    const result = await this.client.query<{ id: string; email: string; active: boolean }>(
      `INSERT INTO newsletter_subscribers (organization_id, email, source, active)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (organization_id, normalized_email) DO NOTHING
       RETURNING id, email, active`,
      [input.organizationId, input.email, input.source ?? 'site']
    );
    // The pg query overload is erased by the narrowed client type here.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const row: { id: string; email: string; active: boolean } | undefined = result.rows[0];
    if (!row) {
      throw new ResourceConflictError('Ova email adresa je već prijavljena na newsletter.');
    }
    return row;
  }

  async createCustomerEmailVerification(input: {
    organizationId: string;
    customerId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<{ email: string; alreadyVerified: boolean }> {
    const customer = await this.client.query<{ email: string | null; email_verified: boolean }>(
      `SELECT email, email_verified
       FROM customers
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [input.organizationId, input.customerId]
    );
    const row = requireRow(customer);
    if (!row.email) throw new ValidationFailedError('This account does not have an email address.');
    if (row.email_verified) return { email: row.email, alreadyVerified: true };

    await this.client.query(
      `INSERT INTO customer_email_verification_tokens (
         organization_id, customer_id, token_hash, expires_at
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id, customer_id) WHERE used_at IS NULL
       DO UPDATE SET token_hash = EXCLUDED.token_hash,
                     expires_at = EXCLUDED.expires_at,
                     created_at = now()`,
      [input.organizationId, input.customerId, input.tokenHash, input.expiresAt]
    );
    return { email: row.email, alreadyVerified: false };
  }

  async confirmCustomerEmailVerification(
    tokenHash: string
  ): Promise<{ email: string; customerId: string; organizationId: string }> {
    const result = await this.client.query<{
      email: string;
      customer_id: string;
      organization_id: string;
    }>(
      `WITH matched_token AS (
         UPDATE customer_email_verification_tokens
         SET used_at = now()
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
         RETURNING organization_id, customer_id
       )
       UPDATE customers c
       SET email_verified = true, updated_at = now(), version = version + 1
       FROM matched_token token
       WHERE c.organization_id = token.organization_id
         AND c.id = token.customer_id
         AND c.deleted_at IS NULL
       RETURNING c.email, c.id AS customer_id, c.organization_id`,
      [tokenHash]
    );
    const row = result.rows[0];
    if (!row?.email) throw new ValidationFailedError('Verification link is invalid or expired.');
    return { email: row.email, customerId: row.customer_id, organizationId: row.organization_id };
  }

  private async createDisplayId(organizationId: string): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const displayId = `DAJA-${Math.floor(100000 + Math.random() * 900000)}`;
      const existing = await this.client.query(
        `SELECT 1 FROM orders WHERE organization_id = $1 AND display_id = $2`,
        [organizationId, displayId]
      );
      if (existing.rowCount === 0) {
        return displayId;
      }
    }
    throw new ValidationFailedError('Could not generate order id');
  }
}

export interface AddressPayload {
  label?: string | undefined;
  icon?: string | undefined;
  name: string;
  phone: string;
  address: string;
  city: string;
  zip?: string | null | undefined;
  countryCode?: string | undefined;
  isDefault?: boolean | undefined;
}

export type AddressPatchPayload = {
  [K in keyof AddressPayload]?: AddressPayload[K] | undefined;
};

interface CustomerRow {
  id: string;
  organization_id: string;
  email: string | null;
  phone: string | null;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  photo_url: string | null;
  active: boolean;
  email_verified: boolean;
  phone_verified: boolean;
  created_at: Date;
  updated_at: Date;
  has_password?: boolean;
  google_linked?: boolean;
}

interface CustomerLoginRow extends CustomerRow {
  password_hash: string | null;
}

interface CustomerSessionRow {
  id: string;
  family_id: string;
  organization_id: string;
  customer_id: string;
  refresh_token_hash: string;
  refresh_jti: string;
  expires_at: Date;
  revoked_at: Date | null;
}

interface AddressRow {
  id: string;
  label: string;
  icon: string;
  name: string;
  phone: string;
  address: string;
  city: string;
  zip: string | null;
  country_code: string;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

interface CartItemRow {
  quantity: number;
  item_snapshot: StorefrontItemSnapshot;
}

interface WishlistItemRow {
  item_snapshot: StorefrontItemSnapshot;
}

interface CustomerListProductSnapshotRow {
  product_id: string;
  variant_id: string | null;
  name: string;
  slug: string;
  brand: string | null;
  price: number | null;
  image: string | null;
  thumb: string | null;
}

interface OrderRow {
  id: string;
  display_id: string;
  customer_id: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  customer_payload: Record<string, unknown>;
  shipping_payload: Record<string, unknown>;
  items_payload: unknown[];
  subtotal_amount: number;
  discount_amount: number;
  shipping_amount: number;
  total_amount: number;
  currency: string;
  promo_code: string | null;
  shipping_method: string;
  payment_method: string;
  status: string;
  is_read: boolean;
  created_at: Date;
  updated_at: Date;
}

interface ReviewRow {
  id: string;
  product_id: string;
  customer_id: string | null;
  user_name: string;
  rating: number;
  comment: string;
  created_at: Date;
}

interface ProductAlertNotificationRow {
  subscription_id: string;
  email: string | null;
  phone: string | null;
  delivery_channel: ProductAlertDeliveryChannel;
  product_name: string;
  brand: string | null;
  slug: string;
  image_url: string | null;
  currency: string;
  current_price_amount: number;
  previous_price_amount: number | null;
}

function mapCustomerPrincipal(
  row: CustomerRow,
  sessionFamilyId: string,
  sessionId?: string
): CustomerPrincipal {
  return {
    customerId: row.id,
    organizationId: row.organization_id,
    email: row.email,
    phone: row.phone,
    phoneVerified: row.phone_verified,
    displayName: row.display_name,
    active: row.active,
    hasPassword: Boolean(row.has_password),
    googleLinked: Boolean(row.google_linked),
    sessionFamilyId,
    ...(sessionId ? { sessionId } : {})
  };
}

function mapCustomerSession(row: CustomerSessionRow): CustomerSessionRecord {
  return {
    id: row.id,
    familyId: row.family_id,
    organizationId: row.organization_id,
    customerId: row.customer_id,
    refreshTokenHash: row.refresh_token_hash,
    refreshJti: row.refresh_jti,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at
  };
}

function serializeCustomer(row: CustomerRow) {
  return {
    id: row.id,
    uid: row.id,
    email: row.email,
    phoneNumber: row.phone,
    displayName: row.display_name,
    photoURL: row.photo_url,
    emailVerified: row.email_verified,
    phoneVerified: row.phone_verified,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function serializeAddress(row: AddressRow) {
  return {
    id: row.id,
    label: row.label,
    icon: row.icon,
    name: row.name,
    phone: row.phone,
    address: row.address,
    city: row.city,
    zip: row.zip,
    countryCode: row.country_code,
    isDefault: row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function serializeOrder(row: OrderRow) {
  return {
    id: row.display_id,
    docId: row.id,
    displayId: row.display_id,
    customer: row.customer_payload,
    items: row.items_payload,
    subtotal: row.subtotal_amount / 100,
    discountAmount: row.discount_amount / 100,
    shippingCost: row.shipping_amount / 100,
    finalTotal: row.total_amount / 100,
    currency: row.currency,
    promoCode: row.promo_code,
    shippingMethod: row.shipping_method,
    paymentMethod: row.payment_method,
    status: row.status,
    isRead: row.is_read,
    date: row.created_at.toLocaleDateString('sr-RS'),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function serializeReview(row: ReviewRow) {
  return {
    id: row.id,
    productId: row.product_id,
    userId: row.customer_id,
    userName: row.user_name,
    rating: row.rating,
    comment: row.comment,
    createdAt: row.created_at
  };
}

function mapProductAlertNotification(row: ProductAlertNotificationRow): ProductAlertNotification {
  return {
    subscriptionId: row.subscription_id,
    email: row.email,
    phone: row.phone,
    deliveryChannel: row.delivery_channel,
    productName: row.product_name,
    brand: row.brand,
    slug: row.slug,
    imageUrl: row.image_url,
    currency: row.currency,
    currentPriceAmount: row.current_price_amount,
    previousPriceAmount: row.previous_price_amount
  };
}

function requireRow<T extends QueryResultRow>(result: pg.QueryResult<T>): T {
  const row = result.rows[0];
  if (!row) {
    throw new ResourceNotFoundError('storefront resource');
  }
  return row;
}

function normalizedIdentity(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.includes('@') ? trimmed.toLowerCase() : trimmed.replace(/[^0-9+]/g, '');
}

function firstName(displayName: string): string | null {
  return displayName.trim().split(/\s+/)[0] ?? null;
}

function lastName(displayName: string): string | null {
  const parts = displayName.trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(' ') : null;
}

function uuidOrNull(value: unknown): string | null {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function productIdFromItem(item: StorefrontItemSnapshot): string | null {
  return uuidOrNull(item.productId ?? item.id);
}

function amountMinorFromMajor(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : 0;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
