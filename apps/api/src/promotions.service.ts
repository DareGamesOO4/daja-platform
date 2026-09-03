import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import type { CustomerPrincipal, Database } from '@daja/database';
import { ValidationFailedError } from '@daja/security';
import { DATABASE } from './tokens.js';

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;
type CustomerTargetType = 'include' | 'exclude';
type DiscountType = 'percentage' | 'fixed' | 'free_shipping';

export interface PromotionScope {
  productIds: string[];
  variantIds: string[];
  categoryIds: string[];
  brandIds: string[];
  departmentIds: string[];
  specifications: Array<{
    specKeyId: string;
    specKeySlug?: string;
    specKeyName?: string;
    value: string;
    operator: 'equals' | 'contains';
  }>;
}

export interface PromotionInput {
  code: string;
  name: string;
  description?: string | null;
  internalNote?: string | null;
  active?: boolean;
  discountType: DiscountType;
  discountValue: number;
  maxDiscountAmount?: number | null;
  appliesTo?: 'eligible_items' | 'order';
  minOrderAmount?: number | null;
  minEligibleQuantity?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
  totalUsageLimit?: number | null;
  perCustomerUsageLimit?: number | null;
  loginRequirement?: 'any' | 'authenticated' | 'guest';
  requiresVerifiedEmail?: boolean;
  requiresNewsletter?: boolean;
  firstOrderOnly?: boolean;
  minCustomerOrderCount?: number | null;
  maxCustomerOrderCount?: number | null;
  minCustomerLifetimeSpend?: number | null;
  allowedShippingMethods?: Array<'courier' | 'pickup'>;
  allowedPaymentMethods?: Array<'cod' | 'pickup'>;
  productRules?: { include?: Partial<PromotionScope>; exclude?: Partial<PromotionScope> };
  customerTargets?: { include?: string[]; exclude?: string[] };
}

interface PromotionRow {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  description: string;
  internal_note: string;
  active: boolean;
  discount_type: DiscountType;
  discount_value: number;
  max_discount_amount: number | null;
  applies_to: 'eligible_items' | 'order';
  min_order_amount: number;
  min_eligible_quantity: number;
  starts_at: Date | string | null;
  ends_at: Date | string | null;
  total_usage_limit: number | null;
  uses_count: number;
  per_customer_usage_limit: number | null;
  login_requirement: 'any' | 'authenticated' | 'guest';
  requires_verified_email: boolean;
  requires_newsletter: boolean;
  first_order_only: boolean;
  min_customer_order_count: number | null;
  max_customer_order_count: number | null;
  min_customer_lifetime_spend: number | null;
  allowed_shipping_methods: unknown;
  allowed_payment_methods: unknown;
  product_rules: unknown;
  created_by_user_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  customer_targets?: unknown;
}

interface CanonicalCartLine {
  productId: string;
  variantId: string;
  categoryId: string | null;
  brandId: string | null;
  departmentId: string | null;
  priceMinor: number;
  quantity: number;
  attributes: Record<string, unknown>;
  specificationValues: Record<string, unknown>;
}

export interface PromotionResolution {
  promotionId: string | null;
  code: string | null;
  discountAmount: number;
  discountAmountMinor: number;
  freeShipping: boolean;
  subtotalAmount: number | null;
  subtotalAmountMinor: number | null;
  eligibleSubtotalAmount: number | null;
  eligibleSubtotalAmountMinor: number | null;
}

@Injectable()
export class PromotionsService {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async list(organizationId: string) {
    const result = await this.database.pool.query<PromotionRow>(
      `SELECT p.*, COALESCE(targets.customer_targets, '[]'::jsonb) AS customer_targets
       FROM promotions p
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(
                  jsonb_build_object(
                    'customerId', target.customer_id,
                    'type', target.target_type,
                    'displayName', customer.display_name,
                    'email', customer.email
                  ) ORDER BY target.target_type, customer.display_name, customer.email
                ) AS customer_targets
         FROM promotion_customer_targets target
         LEFT JOIN customers customer
           ON customer.id = target.customer_id
          AND customer.organization_id = p.organization_id
         WHERE target.promotion_id = p.id
       ) targets ON true
       WHERE p.organization_id = $1 AND p.deleted_at IS NULL
       ORDER BY p.created_at DESC, p.name ASC`,
      [organizationId]
    );
    return result.rows.map(serializePromotion);
  }

  async audience(organizationId: string, limit = 500) {
    const result = await this.database.pool.query(
      `SELECT c.id,
              c.display_name AS "displayName",
              c.email,
              c.active,
              c.email_verified AS "emailVerified",
              c.created_at AS "createdAt",
              EXISTS (
                SELECT 1 FROM newsletter_subscribers newsletter
                WHERE newsletter.organization_id = c.organization_id
                  AND newsletter.normalized_email = c.normalized_email
                  AND newsletter.active
              ) AS "newsletterSubscribed",
              COALESCE(order_stats.order_count, 0)::integer AS "orderCount",
              COALESCE(order_stats.lifetime_spend, 0)::integer AS "lifetimeSpendMinor"
       FROM customers c
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::integer AS order_count,
                COALESCE(SUM(total_amount), 0)::integer AS lifetime_spend
         FROM orders customer_orders
         WHERE customer_orders.organization_id = c.organization_id
           AND customer_orders.deleted_at IS NULL
           AND (customer_orders.customer_id = c.id OR lower(customer_orders.customer_email) = c.normalized_email)
       ) order_stats ON true
       WHERE c.organization_id = $1 AND c.deleted_at IS NULL
       ORDER BY c.created_at DESC
       LIMIT $2`,
      [organizationId, Math.max(1, Math.min(limit, 1_000))]
    );
    return result.rows;
  }

  async create(organizationId: string, actorUserId: string | undefined, input: PromotionInput) {
    const prepared = preparePromotion(input);
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertCustomerTargets(client, organizationId, prepared.customerTargets);
      const result = await client.query<PromotionRow>(
        `INSERT INTO promotions (
           organization_id, code, name, description, internal_note, active,
           discount_type, discount_value, max_discount_amount, applies_to,
           min_order_amount, min_eligible_quantity, starts_at, ends_at,
           total_usage_limit, per_customer_usage_limit, login_requirement,
           requires_verified_email, requires_newsletter, first_order_only,
           min_customer_order_count, max_customer_order_count, min_customer_lifetime_spend,
           allowed_shipping_methods, allowed_payment_methods, product_rules, created_by_user_id
         )
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
           $15, $16, $17, $18, $19, $20, $21, $22, $23, $24::jsonb, $25::jsonb, $26::jsonb, $27
         )
         RETURNING *`,
        promotionValues(organizationId, actorUserId, prepared)
      );
      const promotion = result.rows[0];
      if (!promotion) throw new ValidationFailedError('Promo kod nije sačuvan.');
      await this.replaceCustomerTargets(client, promotion.id, prepared.customerTargets);
      await client.query('COMMIT');
      return serializePromotion({ ...promotion, customer_targets: targetsToDisplay(prepared.customerTargets) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async update(
    organizationId: string,
    promotionId: string,
    actorUserId: string | undefined,
    input: PromotionInput
  ) {
    const prepared = preparePromotion(input);
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<PromotionRow>(
        `SELECT * FROM promotions WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [organizationId, promotionId]
      );
      if (!existing.rows[0]) throw new ValidationFailedError('Promo kod nije pronađen.');
      await this.assertCustomerTargets(client, organizationId, prepared.customerTargets);
      const result = await client.query<PromotionRow>(
        `UPDATE promotions
         SET code = $3, name = $4, description = $5, internal_note = $6, active = $7,
             discount_type = $8, discount_value = $9, max_discount_amount = $10, applies_to = $11,
             min_order_amount = $12, min_eligible_quantity = $13, starts_at = $14, ends_at = $15,
             total_usage_limit = $16, per_customer_usage_limit = $17, login_requirement = $18,
             requires_verified_email = $19, requires_newsletter = $20, first_order_only = $21,
             min_customer_order_count = $22, max_customer_order_count = $23,
             min_customer_lifetime_spend = $24, allowed_shipping_methods = $25::jsonb,
             allowed_payment_methods = $26::jsonb, product_rules = $27::jsonb,
             created_by_user_id = COALESCE($28, created_by_user_id), updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL
         RETURNING *`,
        [organizationId, promotionId, ...promotionValuesWithoutOrganization(actorUserId, prepared)]
      );
      const promotion = result.rows[0];
      if (!promotion) throw new ValidationFailedError('Promo kod nije pronađen.');
      await this.replaceCustomerTargets(client, promotion.id, prepared.customerTargets);
      await client.query('COMMIT');
      return serializePromotion({ ...promotion, customer_targets: targetsToDisplay(prepared.customerTargets) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async archive(organizationId: string, promotionId: string) {
    const result = await this.database.pool.query(
      `UPDATE promotions
       SET active = false, deleted_at = now(), updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [organizationId, promotionId]
    );
    if (result.rowCount !== 1) throw new ValidationFailedError('Promo kod nije pronađen.');
    return { deleted: true };
  }

  async duplicate(organizationId: string, actorUserId: string | undefined, promotionId: string) {
    const result = await this.database.pool.query<PromotionRow>(
      `SELECT p.*, COALESCE(targets.customer_targets, '[]'::jsonb) AS customer_targets
       FROM promotions p
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object('customerId', target.customer_id, 'type', target.target_type)) AS customer_targets
         FROM promotion_customer_targets target WHERE target.promotion_id = p.id
       ) targets ON true
       WHERE p.organization_id = $1 AND p.id = $2 AND p.deleted_at IS NULL`,
      [organizationId, promotionId]
    );
    const source = result.rows[0];
    if (!source) throw new ValidationFailedError('Promo kod nije pronađen.');
    const sourceTargets = parseTargets(source.customer_targets);
    const copyCode = await this.nextCopyCode(organizationId, source.code);
    return this.create(organizationId, actorUserId, {
      code: copyCode,
      name: `${source.name} (kopija)`,
      description: source.description,
      internalNote: source.internal_note,
      active: false,
      discountType: source.discount_type,
      discountValue:
        source.discount_type === 'fixed' ? source.discount_value / 100 : source.discount_value,
      maxDiscountAmount:
        source.max_discount_amount === null ? null : source.max_discount_amount / 100,
      appliesTo: source.applies_to,
      minOrderAmount: source.min_order_amount / 100,
      minEligibleQuantity: source.min_eligible_quantity,
      startsAt: dateString(source.starts_at),
      endsAt: dateString(source.ends_at),
      totalUsageLimit: source.total_usage_limit,
      perCustomerUsageLimit: source.per_customer_usage_limit,
      loginRequirement: source.login_requirement,
      requiresVerifiedEmail: source.requires_verified_email,
      requiresNewsletter: source.requires_newsletter,
      firstOrderOnly: source.first_order_only,
      minCustomerOrderCount: source.min_customer_order_count,
      maxCustomerOrderCount: source.max_customer_order_count,
      minCustomerLifetimeSpend:
        source.min_customer_lifetime_spend === null ? null : source.min_customer_lifetime_spend / 100,
      allowedShippingMethods: stringArray(source.allowed_shipping_methods) as Array<'courier' | 'pickup'>,
      allowedPaymentMethods: stringArray(source.allowed_payment_methods) as Array<'cod' | 'pickup'>,
      productRules: parseProductRules(source.product_rules),
      customerTargets: sourceTargets
    });
  }

  async resolve(
    input: {
      organizationId: string;
      customer: CustomerPrincipal | null;
      code: string | null | undefined;
      items: Array<Record<string, unknown>>;
      shippingMethod?: 'courier' | 'pickup' | undefined;
      paymentMethod?: 'cod' | 'pickup' | undefined;
    },
    client: Queryable = this.database.pool,
    lockPromotion = false
  ): Promise<PromotionResolution> {
    const code = input.code?.trim().toUpperCase();
    if (!code) return emptyResolution();

    const rowResult = await client.query<PromotionRow>(
      `SELECT * FROM promotions
       WHERE organization_id = $1 AND code = $2 AND deleted_at IS NULL
       ${lockPromotion ? 'FOR UPDATE' : ''}`,
      [input.organizationId, code]
    );
    const promotion = rowResult.rows[0];
    if (!promotion || !promotion.active) throw new ValidationFailedError('Promo kod nije aktivan.');
    const now = Date.now();
    if (promotion.starts_at && new Date(promotion.starts_at).getTime() > now) {
      throw new ValidationFailedError('Promo kod još nije počeo da važi.');
    }
    if (promotion.ends_at && new Date(promotion.ends_at).getTime() <= now) {
      throw new ValidationFailedError('Promo kod je istekao.');
    }
    if (promotion.total_usage_limit !== null && promotion.uses_count >= promotion.total_usage_limit) {
      throw new ValidationFailedError('Promo kod je dostigao ukupan broj dozvoljenih korišćenja.');
    }

    await this.assertAudience(promotion, input.customer, client);
    this.assertCheckoutRules(promotion, input.shippingMethod, input.paymentMethod);

    const lines = await canonicalCartLines(client, input.organizationId, input.items);
    const subtotalMinor = lines.reduce((sum, item) => sum + item.priceMinor * item.quantity, 0);
    if (subtotalMinor < promotion.min_order_amount) {
      throw new ValidationFailedError(
        `Promo kod važi za porudžbine od najmanje ${formatRsd(promotion.min_order_amount)}.`
      );
    }
    const rules = parseProductRules(promotion.product_rules);
    const eligible = lines.filter((line) => isEligible(line, rules));
    const eligibleQuantity = eligible.reduce((sum, item) => sum + item.quantity, 0);
    if (!eligible.length || eligibleQuantity < promotion.min_eligible_quantity) {
      throw new ValidationFailedError('Korpa ne ispunjava uslove za proizvode ovog promo koda.');
    }
    const eligibleSubtotalMinor = eligible.reduce(
      (sum, item) => sum + item.priceMinor * item.quantity,
      0
    );
    const discountBaseMinor =
      promotion.applies_to === 'order' ? subtotalMinor : eligibleSubtotalMinor;
    let discountAmountMinor = 0;
    if (promotion.discount_type === 'percentage') {
      discountAmountMinor = Math.round(discountBaseMinor * (promotion.discount_value / 100));
    }
    if (promotion.discount_type === 'fixed') {
      discountAmountMinor = Math.min(discountBaseMinor, promotion.discount_value);
    }
    if (promotion.max_discount_amount !== null) {
      discountAmountMinor = Math.min(discountAmountMinor, promotion.max_discount_amount);
    }

    return {
      promotionId: promotion.id,
      code: promotion.code,
      discountAmount: discountAmountMinor / 100,
      discountAmountMinor,
      freeShipping: promotion.discount_type === 'free_shipping',
      subtotalAmount: subtotalMinor / 100,
      subtotalAmountMinor,
      eligibleSubtotalAmount: eligibleSubtotalMinor / 100,
      eligibleSubtotalAmountMinor: eligibleSubtotalMinor
    };
  }

  async consume(
    input: {
      organizationId: string;
      resolution: PromotionResolution;
      customer: CustomerPrincipal | null;
      orderId: string;
    },
    client: Queryable
  ) {
    if (!input.resolution.promotionId || !input.resolution.code) return;
    const promotion = await client.query<PromotionRow>(
      `SELECT * FROM promotions
       WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [input.organizationId, input.resolution.promotionId]
    );
    const row = promotion.rows[0];
    if (!row?.active) throw new ValidationFailedError('Promo kod više nije aktivan.');
    if (row.total_usage_limit !== null && row.uses_count >= row.total_usage_limit) {
      throw new ValidationFailedError('Promo kod je upravo dostigao limit korišćenja.');
    }
    if (input.customer && row.per_customer_usage_limit !== null) {
      const used = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM promotion_redemptions
         WHERE organization_id = $1 AND promotion_id = $2 AND customer_id = $3`,
        [input.organizationId, row.id, input.customer.customerId]
      );
      if (Number(used.rows[0]?.count ?? 0) >= row.per_customer_usage_limit) {
        throw new ValidationFailedError('Dostigli ste limit korišćenja ovog promo koda.');
      }
    }
    await client.query(
      `UPDATE promotions SET uses_count = uses_count + 1, updated_at = now() WHERE id = $1`,
      [row.id]
    );
    await client.query(
      `INSERT INTO promotion_redemptions (
         organization_id, promotion_id, order_id, customer_id, code, discount_amount, free_shipping
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.organizationId,
        row.id,
        input.orderId,
        input.customer?.customerId ?? null,
        row.code,
        input.resolution.discountAmountMinor,
        input.resolution.freeShipping
      ]
    );
  }

  private async assertAudience(
    promotion: PromotionRow,
    customer: CustomerPrincipal | null,
    client: Queryable
  ) {
    if (promotion.login_requirement === 'authenticated' && !customer) {
      throw new ValidationFailedError('Prijavite se da biste koristili ovaj promo kod.');
    }
    if (promotion.login_requirement === 'guest' && customer) {
      throw new ValidationFailedError('Ovaj promo kod važi samo za kupovinu bez prijave.');
    }
    const targets = await client.query<{ customer_id: string; target_type: CustomerTargetType }>(
      `SELECT customer_id, target_type FROM promotion_customer_targets WHERE promotion_id = $1`,
      [promotion.id]
    );
    const included = targets.rows.filter((target) => target.target_type === 'include');
    const excluded = targets.rows.filter((target) => target.target_type === 'exclude');
    if (included.length && !customer) {
      throw new ValidationFailedError('Ovaj promo kod važi samo za odabrane korisnike.');
    }
    if (included.length && !included.some((target) => target.customer_id === customer?.customerId)) {
      throw new ValidationFailedError('Vaš nalog nema pravo na ovaj promo kod.');
    }
    if (excluded.some((target) => target.customer_id === customer?.customerId)) {
      throw new ValidationFailedError('Vaš nalog nema pravo na ovaj promo kod.');
    }

    const customerRuleRequired =
      promotion.requires_verified_email ||
      promotion.requires_newsletter ||
      promotion.first_order_only ||
      promotion.per_customer_usage_limit !== null ||
      promotion.min_customer_order_count !== null ||
      promotion.max_customer_order_count !== null ||
      promotion.min_customer_lifetime_spend !== null;
    if (!customerRuleRequired) return;
    if (!customer) throw new ValidationFailedError('Prijavite se da biste koristili ovaj promo kod.');

    const status = await client.query<{
      email_verified: boolean;
      newsletter_subscribed: boolean;
      order_count: string;
      lifetime_spend: string;
    }>(
      `SELECT c.email_verified,
              EXISTS (
                SELECT 1 FROM newsletter_subscribers newsletter
                WHERE newsletter.organization_id = c.organization_id
                  AND newsletter.normalized_email = c.normalized_email
                  AND newsletter.active
              ) AS newsletter_subscribed,
              (
                SELECT COUNT(*) FROM orders customer_orders
                WHERE customer_orders.organization_id = c.organization_id
                  AND customer_orders.deleted_at IS NULL
                  AND (customer_orders.customer_id = c.id OR lower(customer_orders.customer_email) = c.normalized_email)
              )::text AS order_count,
              (
                SELECT COALESCE(SUM(total_amount), 0) FROM orders customer_orders
                WHERE customer_orders.organization_id = c.organization_id
                  AND customer_orders.deleted_at IS NULL
                  AND (customer_orders.customer_id = c.id OR lower(customer_orders.customer_email) = c.normalized_email)
              )::text AS lifetime_spend
       FROM customers c
       WHERE c.organization_id = $1 AND c.id = $2 AND c.deleted_at IS NULL
       FOR UPDATE`,
      [customer.organizationId, customer.customerId]
    );
    const customerStatus = status.rows[0];
    if (!customerStatus) throw new ValidationFailedError('Korisnički nalog nije dostupan.');
    if (promotion.requires_verified_email && !customerStatus.email_verified) {
      throw new ValidationFailedError('Za ovaj promo kod potreban je potvrđen email.');
    }
    if (promotion.requires_newsletter && !customerStatus.newsletter_subscribed) {
      throw new ValidationFailedError('Za ovaj promo kod potrebna je prijava na newsletter.');
    }
    const orderCount = Number(customerStatus.order_count);
    const lifetimeSpend = Number(customerStatus.lifetime_spend);
    if (promotion.first_order_only && orderCount > 0) {
      throw new ValidationFailedError('Promo kod važi samo za prvu porudžbinu.');
    }
    if (
      promotion.min_customer_order_count !== null &&
      orderCount < promotion.min_customer_order_count
    ) {
      throw new ValidationFailedError('Nalog nema dovoljan broj prethodnih porudžbina za ovaj promo kod.');
    }
    if (
      promotion.max_customer_order_count !== null &&
      orderCount > promotion.max_customer_order_count
    ) {
      throw new ValidationFailedError('Nalog ima previše prethodnih porudžbina za ovaj promo kod.');
    }
    if (
      promotion.min_customer_lifetime_spend !== null &&
      lifetimeSpend < promotion.min_customer_lifetime_spend
    ) {
      throw new ValidationFailedError('Nalog nema dovoljan prethodni promet za ovaj promo kod.');
    }
  }

  private assertCheckoutRules(
    promotion: PromotionRow,
    shippingMethod?: 'courier' | 'pickup',
    paymentMethod?: 'cod' | 'pickup'
  ) {
    const shippingMethods = stringArray(promotion.allowed_shipping_methods);
    const paymentMethods = stringArray(promotion.allowed_payment_methods);
    if (shippingMethod && shippingMethods.length && !shippingMethods.includes(shippingMethod)) {
      throw new ValidationFailedError('Promo kod ne važi za izabrani način dostave.');
    }
    if (paymentMethod && paymentMethods.length && !paymentMethods.includes(paymentMethod)) {
      throw new ValidationFailedError('Promo kod ne važi za izabrani način plaćanja.');
    }
  }

  private async assertCustomerTargets(
    client: Queryable,
    organizationId: string,
    targets: { include: string[]; exclude: string[] }
  ) {
    const ids = [...new Set([...targets.include, ...targets.exclude])];
    if (!ids.length) return;
    if (targets.include.some((id) => targets.exclude.includes(id))) {
      throw new ValidationFailedError('Korisnik ne može istovremeno biti uključen i isključen.');
    }
    const result = await client.query<{ id: string }>(
      `SELECT id FROM customers WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
      [organizationId, ids]
    );
    if (result.rows.length !== ids.length) {
      throw new ValidationFailedError('Jedan ili više odabranih korisnika ne postoje.');
    }
  }

  private async replaceCustomerTargets(
    client: Queryable,
    promotionId: string,
    targets: { include: string[]; exclude: string[] }
  ) {
    await client.query(`DELETE FROM promotion_customer_targets WHERE promotion_id = $1`, [promotionId]);
    for (const targetType of ['include', 'exclude'] as const) {
      for (const customerId of targets[targetType]) {
        await client.query(
          `INSERT INTO promotion_customer_targets (promotion_id, customer_id, target_type)
           VALUES ($1, $2, $3)`,
          [promotionId, customerId, targetType]
        );
      }
    }
  }

  private async nextCopyCode(organizationId: string, sourceCode: string) {
    for (let index = 1; index < 100; index += 1) {
      const suffix = `-${index}`;
      const candidate = `${sourceCode.slice(0, 40 - suffix.length)}${suffix}`;
      const existing = await this.database.pool.query(
        `SELECT 1 FROM promotions WHERE organization_id = $1 AND code = $2 AND deleted_at IS NULL`,
        [organizationId, candidate]
      );
      if (!existing.rowCount) return candidate;
    }
    throw new ValidationFailedError('Nije moguće napraviti jedinstvenu kopiju promo koda.');
  }
}

function preparePromotion(input: PromotionInput) {
  const discountType = input.discountType;
  const discountValue =
    discountType === 'fixed'
      ? moneyToMinor(input.discountValue, 'Iznos popusta')
      : discountType === 'free_shipping'
        ? 0
        : integerInRange(input.discountValue, 1, 100, 'Procenat popusta');
  const startsAt = parseDate(input.startsAt, 'Datum početka');
  const endsAt = parseDate(input.endsAt, 'Datum završetka');
  if (startsAt && endsAt && endsAt <= startsAt) {
    throw new ValidationFailedError('Datum završetka mora biti nakon datuma početka.');
  }
  const minOrders = optionalInteger(input.minCustomerOrderCount, 'Minimalan broj porudžbina', false);
  const maxOrders = optionalInteger(input.maxCustomerOrderCount, 'Maksimalan broj porudžbina', false);
  if (minOrders !== null && maxOrders !== null && maxOrders < minOrders) {
    throw new ValidationFailedError('Maksimalan broj porudžbina ne može biti manji od minimalnog.');
  }
  const loginRequirement = input.loginRequirement ?? 'any';
  const perCustomerUsageLimit = optionalInteger(
    input.perCustomerUsageLimit,
    'Limit po korisniku',
    true
  );
  if (
    loginRequirement === 'guest' &&
    (perCustomerUsageLimit !== null || input.firstOrderOnly || minOrders !== null || maxOrders !== null)
  ) {
    throw new ValidationFailedError('Pravilo za goste se ne može kombinovati sa pravilima istorije korisnika.');
  }
  const productRules = normalizeProductRules(input.productRules);
  const customerTargets = {
    include: uniqueIds(input.customerTargets?.include),
    exclude: uniqueIds(input.customerTargets?.exclude)
  };
  if (
    loginRequirement === 'guest' &&
    (input.requiresVerifiedEmail || input.requiresNewsletter || customerTargets.include.length)
  ) {
    throw new ValidationFailedError('Pravila za goste ne mogu zahtevati nalog, newsletter ili odabrane korisnike.');
  }
  return {
    code: normalizeCode(input.code),
    name: requiredText(input.name, 'Naziv promocije', 160),
    description: optionalText(input.description, 2_000),
    internalNote: optionalText(input.internalNote, 2_000),
    active: input.active !== false,
    discountType,
    discountValue,
    maxDiscountAmount:
      discountType === 'percentage' ? optionalMoneyToMinor(input.maxDiscountAmount, 'Maksimalan popust') : null,
    appliesTo: input.appliesTo ?? 'eligible_items',
    minOrderAmount: optionalMoneyToMinor(input.minOrderAmount, 'Minimalna vrednost porudžbine') ?? 0,
    minEligibleQuantity: optionalInteger(input.minEligibleQuantity, 'Minimalna količina') ?? 1,
    startsAt,
    endsAt,
    totalUsageLimit: optionalInteger(input.totalUsageLimit, 'Ukupan limit korišćenja', true),
    perCustomerUsageLimit,
    loginRequirement,
    requiresVerifiedEmail: Boolean(input.requiresVerifiedEmail),
    requiresNewsletter: Boolean(input.requiresNewsletter),
    firstOrderOnly: Boolean(input.firstOrderOnly),
    minCustomerOrderCount: minOrders,
    maxCustomerOrderCount: maxOrders,
    minCustomerLifetimeSpend: optionalMoneyToMinor(
      input.minCustomerLifetimeSpend,
      'Minimalan prethodni promet'
    ),
    allowedShippingMethods: uniqueStrings(input.allowedShippingMethods, ['courier', 'pickup']),
    allowedPaymentMethods: uniqueStrings(input.allowedPaymentMethods, ['cod', 'pickup']),
    productRules,
    customerTargets
  };
}

function promotionValues(
  organizationId: string,
  actorUserId: string | undefined,
  value: ReturnType<typeof preparePromotion>
) {
  return [organizationId, ...promotionValuesWithoutOrganization(actorUserId, value)];
}

function promotionValuesWithoutOrganization(
  actorUserId: string | undefined,
  value: ReturnType<typeof preparePromotion>
) {
  return [
    value.code,
    value.name,
    value.description,
    value.internalNote,
    value.active,
    value.discountType,
    value.discountValue,
    value.maxDiscountAmount,
    value.appliesTo,
    value.minOrderAmount,
    value.minEligibleQuantity,
    value.startsAt,
    value.endsAt,
    value.totalUsageLimit,
    value.perCustomerUsageLimit,
    value.loginRequirement,
    value.requiresVerifiedEmail,
    value.requiresNewsletter,
    value.firstOrderOnly,
    value.minCustomerOrderCount,
    value.maxCustomerOrderCount,
    value.minCustomerLifetimeSpend,
    JSON.stringify(value.allowedShippingMethods),
    JSON.stringify(value.allowedPaymentMethods),
    JSON.stringify(value.productRules),
    actorUserId ?? null
  ];
}

async function canonicalCartLines(
  client: Queryable,
  organizationId: string,
  items: Array<Record<string, unknown>>
): Promise<CanonicalCartLine[]> {
  const quantities = new Map<string, number>();
  for (const item of items) {
    const variantId = typeof item.variantId === 'string' ? item.variantId : null;
    const quantity = Number(item.qty ?? item.quantity ?? 1);
    if (!variantId || !isUuid(variantId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 200) {
      throw new ValidationFailedError('Korpa sadrži neispravan proizvod ili količinu.');
    }
    quantities.set(variantId, (quantities.get(variantId) ?? 0) + quantity);
  }
  if (!quantities.size) throw new ValidationFailedError('Korpa je prazna.');
  const variantIds = [...quantities.keys()];
  const result = await client.query<{
    product_id: string;
    variant_id: string;
    category_id: string | null;
    brand_id: string | null;
    department_id: string | null;
    price_minor: number;
    attributes: Record<string, unknown>;
    specification_values: Record<string, unknown>;
  }>(
    `SELECT p.id AS product_id,
            v.id AS variant_id,
            p.primary_category_id AS category_id,
            p.brand_id AS brand_id,
            p.department_id AS department_id,
            COALESCE(active_sale.amount_minor, v.current_price_amount) AS price_minor,
            v.attributes,
            COALESCE(specifications.values, '{}'::jsonb) AS specification_values
     FROM product_variants v
     JOIN products p
       ON p.id = v.product_id AND p.organization_id = v.organization_id
     LEFT JOIN LATERAL (
       SELECT amount_minor FROM variant_prices
       WHERE organization_id = v.organization_id
         AND variant_id = v.id
         AND price_type = 'sale'
         AND valid_from <= now()
         AND (valid_until IS NULL OR valid_until > now())
       ORDER BY valid_from DESC, created_at DESC
       LIMIT 1
     ) active_sale ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_object_agg(spec_key_id::text, lower(value)) AS values
       FROM variant_specification_values
       WHERE organization_id = v.organization_id AND variant_id = v.id
     ) specifications ON true
     WHERE v.organization_id = $1
       AND v.id = ANY($2::uuid[])
       AND v.deleted_at IS NULL AND v.active AND v.published
       AND p.deleted_at IS NULL AND p.active AND p.published`,
    [organizationId, variantIds]
  );
  if (result.rows.length !== variantIds.length) {
    throw new ValidationFailedError('Jedan ili više proizvoda iz korpe više nisu dostupni.');
  }
  return result.rows.map((row) => ({
    productId: row.product_id,
    variantId: row.variant_id,
    categoryId: row.category_id,
    brandId: row.brand_id,
    departmentId: row.department_id,
    priceMinor: Number(row.price_minor),
    quantity: quantities.get(row.variant_id) ?? 0,
    attributes: asObject(row.attributes),
    specificationValues: asObject(row.specification_values)
  }));
}

function isEligible(line: CanonicalCartLine, rules: { include: PromotionScope; exclude: PromotionScope }) {
  const included = !scopeHasRules(rules.include) || matchesScope(line, rules.include);
  const excluded = scopeHasRules(rules.exclude) && matchesScope(line, rules.exclude);
  return included && !excluded;
}

function scopeHasRules(scope: PromotionScope) {
  return Boolean(
    scope.productIds.length ||
      scope.variantIds.length ||
      scope.categoryIds.length ||
      scope.brandIds.length ||
      scope.departmentIds.length ||
      scope.specifications.length
  );
}

function matchesScope(line: CanonicalCartLine, scope: PromotionScope) {
  const dimensions: boolean[] = [];
  if (scope.productIds.length) dimensions.push(scope.productIds.includes(line.productId));
  if (scope.variantIds.length) dimensions.push(scope.variantIds.includes(line.variantId));
  if (scope.categoryIds.length) dimensions.push(Boolean(line.categoryId && scope.categoryIds.includes(line.categoryId)));
  if (scope.brandIds.length) dimensions.push(Boolean(line.brandId && scope.brandIds.includes(line.brandId)));
  if (scope.departmentIds.length) dimensions.push(Boolean(line.departmentId && scope.departmentIds.includes(line.departmentId)));
  if (scope.specifications.length) {
    dimensions.push(scope.specifications.every((rule) => specificationMatches(line, rule)));
  }
  if (!dimensions.length) return false;
  return dimensions.every(Boolean);
}

function specificationMatches(
  line: CanonicalCartLine,
  rule: {
    specKeyId: string;
    specKeySlug?: string;
    specKeyName?: string;
    value: string;
    operator: 'equals' | 'contains';
  }
) {
  const raw =
    line.specificationValues[rule.specKeyId] ??
    line.attributes[rule.specKeyId] ??
    (rule.specKeySlug ? line.attributes[rule.specKeySlug] : undefined) ??
    (rule.specKeyName ? line.attributes[rule.specKeyName] : undefined);
  if (raw === undefined || raw === null) return false;
  const actual = String(raw).trim().toLocaleLowerCase('sr-RS');
  const expected = rule.value.trim().toLocaleLowerCase('sr-RS');
  return rule.operator === 'contains' ? actual.includes(expected) : actual === expected;
}

function normalizeProductRules(input: PromotionInput['productRules']) {
  return {
    include: normalizeScope(input?.include),
    exclude: normalizeScope(input?.exclude)
  };
}

function normalizeScope(scope: Partial<PromotionScope> | undefined): PromotionScope {
  const specifications = (scope?.specifications ?? []).map((rule) => {
    if (!isUuid(rule.specKeyId) || !String(rule.value ?? '').trim()) {
      throw new ValidationFailedError('Pravilo specifikacije nije ispravno.');
    }
    return {
      specKeyId: rule.specKeyId,
      ...(typeof rule.specKeySlug === 'string' && rule.specKeySlug.trim()
        ? { specKeySlug: rule.specKeySlug.trim().slice(0, 120) }
        : {}),
      ...(typeof rule.specKeyName === 'string' && rule.specKeyName.trim()
        ? { specKeyName: rule.specKeyName.trim().slice(0, 240) }
        : {}),
      value: String(rule.value).trim().slice(0, 240),
      operator: rule.operator === 'contains' ? 'contains' : 'equals'
    };
  });
  return {
    productIds: uniqueIds(scope?.productIds),
    variantIds: uniqueIds(scope?.variantIds),
    categoryIds: uniqueIds(scope?.categoryIds),
    brandIds: uniqueIds(scope?.brandIds),
    departmentIds: uniqueIds(scope?.departmentIds),
    specifications
  };
}

function parseProductRules(value: unknown) {
  const raw = asObject(value);
  return normalizeProductRules({
    include: asObject(raw.include) as Partial<PromotionScope>,
    exclude: asObject(raw.exclude) as Partial<PromotionScope>
  });
}

function parseTargets(value: unknown) {
  const targets = Array.isArray(value) ? value : [];
  const result = { include: [] as string[], exclude: [] as string[] };
  targets.forEach((target) => {
    const row = asObject(target);
    const type = row.type;
    const customerId = row.customerId;
    if ((type === 'include' || type === 'exclude') && typeof customerId === 'string' && isUuid(customerId)) {
      result[type].push(customerId);
    }
  });
  return result;
}

function serializePromotion(row: PromotionRow) {
  const customerTargets = Array.isArray(row.customer_targets) ? row.customer_targets : [];
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    internalNote: row.internal_note,
    active: row.active,
    discountType: row.discount_type,
    discountValue: row.discount_type === 'fixed' ? row.discount_value / 100 : row.discount_value,
    maxDiscountAmount: row.max_discount_amount === null ? null : row.max_discount_amount / 100,
    appliesTo: row.applies_to,
    minOrderAmount: row.min_order_amount / 100,
    minEligibleQuantity: row.min_eligible_quantity,
    startsAt: dateString(row.starts_at),
    endsAt: dateString(row.ends_at),
    totalUsageLimit: row.total_usage_limit,
    usesCount: row.uses_count,
    perCustomerUsageLimit: row.per_customer_usage_limit,
    loginRequirement: row.login_requirement,
    requiresVerifiedEmail: row.requires_verified_email,
    requiresNewsletter: row.requires_newsletter,
    firstOrderOnly: row.first_order_only,
    minCustomerOrderCount: row.min_customer_order_count,
    maxCustomerOrderCount: row.max_customer_order_count,
    minCustomerLifetimeSpend:
      row.min_customer_lifetime_spend === null ? null : row.min_customer_lifetime_spend / 100,
    allowedShippingMethods: stringArray(row.allowed_shipping_methods),
    allowedPaymentMethods: stringArray(row.allowed_payment_methods),
    productRules: parseProductRules(row.product_rules),
    customerTargets,
    createdAt: dateString(row.created_at),
    updatedAt: dateString(row.updated_at)
  };
}

function targetsToDisplay(targets: { include: string[]; exclude: string[] }) {
  return ['include', 'exclude'].flatMap((type) =>
    targets[type as CustomerTargetType].map((customerId) => ({ customerId, type }))
  );
}

function emptyResolution(): PromotionResolution {
  return {
    promotionId: null,
    code: null,
    discountAmount: 0,
    discountAmountMinor: 0,
    freeShipping: false,
    subtotalAmount: null,
    subtotalAmountMinor: null,
    eligibleSubtotalAmount: null,
    eligibleSubtotalAmountMinor: null
  };
}

function normalizeCode(value: string) {
  const code = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{2,39}$/.test(code)) {
    throw new ValidationFailedError('Kod mora imati 3–40 slova, brojeva, crticu ili donju crtu.');
  }
  return code;
}

function requiredText(value: string, label: string, maxLength: number) {
  const text = String(value ?? '').trim();
  if (!text || text.length > maxLength) throw new ValidationFailedError(`${label} nije ispravan.`);
  return text;
}

function optionalText(value: string | null | undefined, maxLength: number) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function parseDate(value: string | null | undefined, label: string) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new ValidationFailedError(`${label} nije ispravan.`);
  return parsed;
}

function dateString(value: Date | string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function moneyToMinor(value: number, label: string) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) {
    throw new ValidationFailedError(`${label} mora biti pozitivan iznos.`);
  }
  return Math.round(amount * 100);
}

function optionalMoneyToMinor(value: number | null | undefined, label: string) {
  if (value === null || value === undefined) return null;
  return moneyToMinor(value, label);
}

function integerInRange(value: number, min: number, max: number, label: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ValidationFailedError(`${label} nije ispravan.`);
  }
  return parsed;
}

function optionalInteger(value: number | null | undefined, label: string, strictlyPositive = true) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  const min = strictlyPositive ? 1 : 0;
  if (!Number.isInteger(parsed) || parsed < min || parsed > 1_000_000) {
    throw new ValidationFailedError(`${label} nije ispravan.`);
  }
  return parsed;
}

function uniqueStrings(value: readonly string[] | undefined, allowed: string[]) {
  const values = [...new Set((value ?? []).filter((item) => typeof item === 'string'))];
  if (values.some((item) => !allowed.includes(item))) {
    throw new ValidationFailedError('Izabrana opcija nije podržana.');
  }
  return values;
}

function uniqueIds(value: readonly string[] | undefined) {
  const ids = [...new Set((value ?? []).filter((item) => typeof item === 'string'))];
  if (ids.some((id) => !isUuid(id))) throw new ValidationFailedError('Izabrani ID nije ispravan.');
  return ids;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function formatRsd(amountMinor: number) {
  return `${Math.round(amountMinor / 100).toLocaleString('sr-RS')} RSD`;
}
