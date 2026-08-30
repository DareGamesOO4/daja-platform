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
  displayName: string;
  active: boolean;
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
      `SELECT * FROM customers
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
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
    productId: string;
  }) {
    await this.client.query(
      `DELETE FROM customer_wishlist_items
       WHERE organization_id = $1 AND customer_id = $2 AND product_id = $3`,
      [input.organizationId, input.customerId, input.productId]
    );
    return this.listWishlist(input);
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

  async subscribeNewsletter(input: {
    organizationId: string;
    email: string;
    source?: string | undefined;
    verificationTokenHash: string;
    verificationExpiresAt: Date;
  }) {
    const result = await this.client.query(
      `INSERT INTO newsletter_subscribers (
         organization_id, email, source, active, verification_token_hash, verification_expires_at
       )
       VALUES ($1, $2, $3, false, $4, $5)
       ON CONFLICT (organization_id, normalized_email)
       DO UPDATE
       SET email = EXCLUDED.email,
           source = EXCLUDED.source,
           active = false,
           verification_token_hash = EXCLUDED.verification_token_hash,
           verification_expires_at = EXCLUDED.verification_expires_at,
           confirmed_at = NULL,
           updated_at = now()
       WHERE newsletter_subscribers.active = false
       RETURNING id, email, active`,
      [
        input.organizationId,
        input.email,
        input.source ?? 'site',
        input.verificationTokenHash,
        input.verificationExpiresAt
      ]
    );
    // The pg query overload is erased by the narrowed client type here.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const row: { id: string; email: string; active: boolean } | undefined = result.rows[0];
    if (!row) {
      throw new ResourceConflictError('Ova email adresa je već prijavljena na newsletter.');
    }
    return row;
  }

  async confirmNewsletterSubscription(input: {
    organizationId: string;
    verificationTokenHash: string;
  }): Promise<{ id: string; email: string }> {
    const result = await this.client.query<{ id: string; email: string }>(
      `UPDATE newsletter_subscribers
       SET active = true,
           confirmed_at = now(),
           verification_token_hash = NULL,
           verification_expires_at = NULL,
           updated_at = now()
       WHERE organization_id = $1
         AND active = false
         AND verification_token_hash = $2
         AND verification_expires_at > now()
       RETURNING id, email`,
      [input.organizationId, input.verificationTokenHash]
    );
    const row = result.rows[0];
    if (!row) {
      throw new ValidationFailedError('Newsletter confirmation link is invalid or expired.');
    }
    return row;
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
    displayName: row.display_name,
    active: row.active,
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
