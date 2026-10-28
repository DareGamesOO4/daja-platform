import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@daja/config';
import { TransactionManager, type Database, type DbClient } from '@daja/database';
import type { Logger } from '@daja/observability';
import { NovostiEmailService } from './novosti-email.service.js';
import { ValidationFailedError } from '@daja/security';
import { CONFIG, DATABASE, LOGGER } from './tokens.js';
import {
  LEGAL_DOCUMENTS,
  LEGAL_POLICY_VERSION,
  type LegalDocumentKind
} from './legal-policy-content.js';

const CONSENT_RETENTION_YEARS = 5;
const MARKETING_PROOF_RETENTION_YEARS = 3;

export interface ConsentCategories {
  preferences: boolean;
  externalGoogle: boolean;
  analytics: boolean;
}

export interface AlertContact {
  id: string;
  email: string;
  maskedEmail: string;
  managementToken: string;
  termsAccepted: boolean;
}

@Injectable()
export class PrivacyService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(NovostiEmailService) private readonly email: NovostiEmailService
  ) {}

  async currentPolicy(organizationId: string) {
    const result = await this.database.pool.query<{
      version: string;
      material: boolean;
      change_summary: string;
      effective_at: Date;
    }>(
      `SELECT version, material, change_summary, effective_at
       FROM privacy_policy_publications
       WHERE organization_id = $1 AND active
       ORDER BY published_at DESC
       LIMIT 1`,
      [organizationId]
    );
    const publication = result.rows[0];
    return {
      version: publication?.version ?? LEGAL_POLICY_VERSION,
      // Analytics is a new optional category. Existing receipts must be
      // refreshed instead of being interpreted as analytics consent.
      material: publication?.material ?? true,
      changeSummary: publication?.change_summary ?? '',
      effectiveAt: publication?.effective_at?.toISOString() ?? '2026-09-02T00:00:00.000Z',
      ready: LEGAL_DOCUMENTS.every((document) => document.ready),
      documents: LEGAL_DOCUMENTS
    };
  }

  async document(kind: LegalDocumentKind, organizationId: string) {
    const policy = await this.currentPolicy(organizationId);
    const document = LEGAL_DOCUMENTS.find((candidate) => candidate.kind === kind);
    if (!document) throw new ValidationFailedError('Pravni dokument nije pronađen.');
    return { ...document, version: policy.version, policyReady: policy.ready };
  }

  async recordConsent(input: {
    organizationId: string;
    receipt?: string | undefined;
    customerId?: string | null | undefined;
    policyVersion?: string | undefined;
    categories: ConsentCategories;
    action?: 'granted' | 'updated' | 'revoked' | 'policy_reset' | undefined;
    source?: string | undefined;
  }): Promise<{ receipt: string; version: string; categories: ConsentCategories }> {
    const policy = await this.currentPolicy(input.organizationId);
    const receipt = validReceipt(input.receipt) ? input.receipt! : randomToken();
    const action = input.action ?? 'granted';
    const categories = {
      preferences: Boolean(input.categories.preferences),
      externalGoogle: Boolean(input.categories.externalGoogle),
      analytics: Boolean(input.categories.analytics)
    };
    await this.database.pool.query(
      `INSERT INTO privacy_consent_events (
         organization_id, receipt_hash, customer_id, policy_version,
         preferences_allowed, external_google_allowed, analytics_allowed, action, source, retain_until
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + interval '5 years')`,
      [
        input.organizationId,
        sha256(receipt),
        input.customerId ?? null,
        policy.version,
        categories.preferences,
        categories.externalGoogle,
        categories.analytics,
        action,
        input.source ?? 'storefront_web'
      ]
    );
    return { receipt, version: policy.version, categories };
  }

  async subscribeNewsletter(input: {
    organizationId: string; email: string; source: string;
    policyVersion?: string | undefined; customerId?: string | null | undefined;
  }) {
    const email = normalizeEmail(input.email);
    return new TransactionManager(this.database.pool, this.logger).run(async client => {
      const existing = await client.query<{ id: string; email: string; active: boolean }>(
        'SELECT id, email, active FROM newsletter_subscribers WHERE organization_id = $1 AND normalized_email = $2',
        [input.organizationId, email]);
      const current = existing.rows[0];
      if (current?.active) return { active: true, alreadySubscribed: true, isFirstSubscription: false,
        requiresConfirmation: false };
      const token = randomToken();
      const pending = await client.query<{ id: string; email: string; active: boolean }>(
        `INSERT INTO newsletter_subscribers (organization_id, email, source, active, consent_status,
           consent_version, consented_at, revoked_at, confirmation_token_hash, confirmation_expires_at)
         VALUES ($1,$2,$3,false,'explicit',$4,now(),NULL,$5,now() + interval '24 hours')
         ON CONFLICT (organization_id, normalized_email) DO UPDATE SET
           source = EXCLUDED.source, consent_status = 'explicit', consent_version = EXCLUDED.consent_version,
           consented_at = now(), revoked_at = NULL, confirmation_token_hash = EXCLUDED.confirmation_token_hash,
           confirmation_expires_at = EXCLUDED.confirmation_expires_at, updated_at = now()
         WHERE NOT newsletter_subscribers.active
           AND (newsletter_subscribers.confirmation_expires_at IS NULL
                OR newsletter_subscribers.confirmation_expires_at < now() + interval '23 hours 59 minutes')
         RETURNING id, email, active`,
        [input.organizationId, email, input.source, input.policyVersion ?? LEGAL_POLICY_VERSION, sha256(token)]);
      const subscriber = pending.rows[0];
      if (subscriber) {
        const url = new URL('/newsletter-confirm', this.config.STOREFRONT_PUBLIC_BASE_URL);
        url.searchParams.set('token', token);
        await this.email.posaljiPotvrduPrijave({ recipient: email, confirmationUrl: url.toString() }, client);
      }
      return { active: false, alreadySubscribed: false,
        isFirstSubscription: !current, requiresConfirmation: true, status: 'pending_confirmation' as const };
    });
  }

  async confirmNewsletter(token: string, client: DbClient) {
    const confirmed = await client.query<{ id: string; email: string; organization_id: string;
      welcome_queued_at: Date | null; consent_version: string }>(
      `UPDATE newsletter_subscribers SET active = true, confirmed_at = now(), updated_at = now(),
         confirmation_token_hash = NULL, confirmation_expires_at = NULL
       WHERE confirmation_token_hash = $1 AND confirmation_expires_at > now() AND NOT active
       RETURNING id, email, organization_id, welcome_queued_at, consent_version`, [sha256(token)]);
    const subscriber = confirmed.rows[0];
    if (!subscriber) throw new ValidationFailedError('Link je istekao ili je već iskorišćen. Zatražite novu prijavu na novosti.');
    await client.query(`INSERT INTO marketing_consent_events (organization_id, subject_email_hash,
      newsletter_subscriber_id, purpose, action, policy_version, source)
      VALUES ($1,$2,$3,'newsletter','granted',$4,'email_confirmation')`,
      [subscriber.organization_id, sha256(subscriber.email.toLowerCase()), subscriber.id, subscriber.consent_version]);
    return { ...subscriber, odjavaUrl: this.odjavaUrlNovosti(subscriber.id) };
  }

  async nemaPrethodnihPorudzbina(input: {
    organizationId: string;
    email: string;
    customerId?: string | null | undefined;
  }): Promise<boolean> {
    const result = await this.database.pool.query<{ has_orders: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM orders
         WHERE organization_id = $1
           AND deleted_at IS NULL
           AND (
             lower(customer_email) = $2
             OR ($3::uuid IS NOT NULL AND customer_id = $3::uuid)
           )
       ) AS has_orders`,
      [input.organizationId, normalizeEmail(input.email), input.customerId ?? null]
    );
    return result.rows[0]?.has_orders !== true;
  }

  async newsletterStatus(input: { organizationId: string; email: string | null | undefined }) {
    if (!input.email) return { active: false };
    const result = await this.database.pool.query<{ active: boolean }>(
      `SELECT active FROM newsletter_subscribers
       WHERE organization_id = $1 AND normalized_email = lower($2)
       LIMIT 1`,
      [input.organizationId, normalizeEmail(input.email)]
    );
    return { active: result.rows[0]?.active === true };
  }

  async newsletterSubscriber(input: { organizationId: string; email: string }) {
    const result = await this.database.pool.query<{ id: string; active: boolean }>(
      `SELECT id, active FROM newsletter_subscribers
       WHERE organization_id = $1 AND normalized_email = lower($2)
       LIMIT 1`,
      [input.organizationId, normalizeEmail(input.email)]
    );
    return result.rows[0] ?? null;
  }

  async unsubscribeNewsletterById(input: {
    organizationId: string;
    subscriberId: string;
    source: string;
    customerId?: string | null | undefined;
  }): Promise<boolean> {
    const result = await this.database.pool.query<{ id: string; email: string; customer_id: string | null }>(
      `UPDATE newsletter_subscribers
       SET active = false, revoked_at = COALESCE(revoked_at, now()), updated_at = now(),
           confirmation_token_hash = NULL, confirmation_expires_at = NULL
       WHERE organization_id = $1 AND id = $2 AND (active OR confirmation_token_hash IS NOT NULL)
       RETURNING id, email, NULL::uuid AS customer_id`,
      [input.organizationId, input.subscriberId]
    );
    const row = result.rows[0];
    if (!row) return false;
    await this.recordMarketingEvent({
      organizationId: input.organizationId,
      contact: row.email,
      customerId: input.customerId,
      newsletterSubscriberId: row.id,
      purpose: 'newsletter',
      action: 'revoked',
      source: input.source
    });
    return true;
  }

  async unsubscribeNewsletterToken(token: string): Promise<boolean> {
    const subscriberId = this.verifySignedToken('newsletter', token);
    const row = await this.database.pool.query<{ organization_id: string }>(
      `SELECT organization_id FROM newsletter_subscribers WHERE id = $1 LIMIT 1`,
      [subscriberId]
    );
    const organizationId = row.rows[0]?.organization_id;
    if (!organizationId) return false;
    return this.unsubscribeNewsletterById({
      organizationId,
      subscriberId,
      source: 'email_unsubscribe'
    });
  }

  async resolveAlertContact(input: {
    organizationId: string;
    email?: string | undefined;
    managementToken?: string | undefined;
    acceptedTerms?: boolean | undefined;
    policyVersion?: string | undefined;
  }): Promise<AlertContact> {
    if (input.managementToken) {
      const current = await this.alertContactByToken(input.organizationId, input.managementToken);
      if (!current.termsAccepted && input.acceptedTerms !== true) {
        throw new ValidationFailedError('Potvrdite uslove korišćenja i politiku privatnosti.');
      }
      if (!current.termsAccepted && input.acceptedTerms === true) {
        await this.database.pool.query(
          `UPDATE product_alert_contacts
           SET terms_accepted_at = now(), policy_version = $3, updated_at = now()
           WHERE organization_id = $1 AND id = $2`,
          [input.organizationId, current.id, input.policyVersion ?? LEGAL_POLICY_VERSION]
        );
        current.termsAccepted = true;
      }
      return current;
    }

    const email = normalizeEmail(input.email);
    if (input.acceptedTerms !== true) {
      throw new ValidationFailedError('Potvrdite uslove korišćenja i politiku privatnosti.');
    }
    const managementToken = randomToken();
    const result = await this.database.pool.query<{
      id: string;
      email: string;
      terms_accepted_at: Date | null;
    }>(
      `INSERT INTO product_alert_contacts (
         organization_id, email, management_token_hash, terms_accepted_at, policy_version
       ) VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (organization_id, normalized_email) DO UPDATE
       SET email = EXCLUDED.email,
           management_token_hash = EXCLUDED.management_token_hash,
           terms_accepted_at = COALESCE(product_alert_contacts.terms_accepted_at, EXCLUDED.terms_accepted_at),
           policy_version = COALESCE(product_alert_contacts.policy_version, EXCLUDED.policy_version),
           updated_at = now()
       RETURNING id, email, terms_accepted_at`,
      [
        input.organizationId,
        email,
        sha256(managementToken),
        input.policyVersion ?? LEGAL_POLICY_VERSION
      ]
    );
    const row = result.rows[0];
    if (!row) throw new ValidationFailedError('Email za obaveštenje nije sačuvan.');
    return {
      id: row.id,
      email: row.email,
      maskedEmail: maskEmail(row.email),
      managementToken,
      termsAccepted: row.terms_accepted_at !== null
    };
  }

  async alertContactByToken(organizationId: string, managementToken: string): Promise<AlertContact> {
    const result = await this.database.pool.query<{
      id: string;
      email: string;
      terms_accepted_at: Date | null;
    }>(
      `SELECT id, email, terms_accepted_at
       FROM product_alert_contacts
       WHERE organization_id = $1 AND management_token_hash = $2
       LIMIT 1`,
      [organizationId, sha256(managementToken)]
    );
    const row = result.rows[0];
    if (!row) throw new ValidationFailedError('Sačuvani podaci za obaveštenje više nisu dostupni.');
    return {
      id: row.id,
      email: row.email,
      maskedEmail: maskEmail(row.email),
      managementToken,
      termsAccepted: row.terms_accepted_at !== null
    };
  }

  async recordProductAlertConsent(input: {
    organizationId: string;
    contact: string;
    customerId?: string | null | undefined;
    subscriptionId: string;
    policyVersion?: string | undefined;
    source: string;
  }): Promise<void> {
    await this.recordMarketingEvent({
      organizationId: input.organizationId,
      contact: input.contact,
      customerId: input.customerId,
      productAlertSubscriptionId: input.subscriptionId,
      purpose: 'product_alert',
      action: 'granted',
      policyVersion: input.policyVersion,
      source: input.source
    });
  }

  async revokeProductAlertSubscription(input: {
    organizationId: string;
    subscriptionId: string;
    source: string;
    customerId?: string | null | undefined;
    customerEmail?: string | null | undefined;
  }): Promise<boolean> {
    const result = await this.database.pool.query<{ id: string; email: string | null; phone: string | null }>(
      `UPDATE product_alert_subscriptions
       SET active = false, revoked_at = COALESCE(revoked_at, now()), updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND (active OR revoked_at IS NULL)
         AND ($3::uuid IS NULL OR customer_id = $3 OR normalized_email = lower($4))
       RETURNING id, email, phone`,
      [input.organizationId, input.subscriptionId, input.customerId ?? null, input.customerEmail ?? null]
    );
    const row = result.rows[0];
    if (!row) return false;
    await this.recordMarketingEvent({
      organizationId: input.organizationId,
      contact: row.email ?? row.phone ?? '',
      customerId: input.customerId,
      productAlertSubscriptionId: row.id,
      purpose: 'product_alert',
      action: 'revoked',
      source: input.source
    });
    return true;
  }

  async unsubscribeProductAlertToken(token: string): Promise<boolean> {
    const subscriptionId = this.verifySignedToken('product_alert', token);
    const result = await this.database.pool.query<{ organization_id: string }>(
      `SELECT organization_id FROM product_alert_subscriptions WHERE id = $1 LIMIT 1`,
      [subscriptionId]
    );
    const organizationId = result.rows[0]?.organization_id;
    if (!organizationId) return false;
    return this.revokeProductAlertSubscription({
      organizationId,
      subscriptionId,
      source: 'email_unsubscribe'
    });
  }

  async customerSnapshot(input: { organizationId: string; customerId: string; email: string | null }) {
    const [newsletter, alerts] = await Promise.all([
      this.newsletterStatus({ organizationId: input.organizationId, email: input.email }),
      input.email
        ? this.database.pool.query<{
            id: string;
            product_id: string;
            variant_id: string;
            alert_type: 'back_in_stock' | 'price_change';
            created_at: Date;
            product_name: string;
            product_slug: string;
            brand_name: string | null;
            price: number | null;
            currency: string | null;
            image_url: string | null;
          }>(
            `SELECT alert.id, alert.product_id, alert.variant_id, alert.alert_type, alert.created_at,
                    product.name AS product_name, product.slug AS product_slug, brand.name AS brand_name,
                    COALESCE(active_sale.amount_minor, variant.current_price_amount)::double precision / 100 AS price,
                    variant.currency, product_image.public_url AS image_url
             FROM product_alert_subscriptions alert
             JOIN products product
               ON product.id = alert.product_id AND product.organization_id = alert.organization_id
             JOIN product_variants variant
               ON variant.id = alert.variant_id AND variant.organization_id = alert.organization_id
             LEFT JOIN brands brand
               ON brand.id = product.brand_id AND brand.organization_id = product.organization_id
             LEFT JOIN LATERAL (
               SELECT price.amount_minor
               FROM variant_prices price
               WHERE price.organization_id = variant.organization_id AND price.variant_id = variant.id
                 AND price.price_type = 'sale' AND price.valid_from <= now()
                 AND price.cancelled_at IS NULL
                 AND (price.valid_until IS NULL OR price.valid_until > now())
               ORDER BY price.valid_from DESC, price.created_at DESC
               LIMIT 1
             ) active_sale ON true
             LEFT JOIN LATERAL (
               SELECT media.public_url
               FROM product_media link
               JOIN media_assets media ON media.id = link.media_asset_id AND media.status = 'ready'
               WHERE link.organization_id = product.organization_id AND link.product_id = product.id
               ORDER BY link.is_primary DESC, link.position ASC, link.id
               LIMIT 1
             ) product_image ON true
             WHERE alert.organization_id = $1 AND alert.active
               AND (alert.customer_id = $2 OR alert.normalized_email = lower($3))
             ORDER BY alert.created_at DESC`,
            [input.organizationId, input.customerId, input.email]
          )
        : Promise.resolve({ rows: [] as Array<never> })
    ]);
    return {
      newsletter,
      alerts: alerts.rows.map((row) => ({
        id: row.id,
        productId: row.product_id,
        variantId: row.variant_id,
        type: row.alert_type,
        createdAt: row.created_at,
        name: row.product_name,
        slug: row.product_slug,
        brand: row.brand_name,
        price: row.price,
        currency: row.currency,
        image: row.image_url
      }))
    };
  }

  odjavaUrlNovosti(subscriberId: string): string {
    return `${this.apiBase()}/privacy/unsubscribe/newsletter?token=${encodeURIComponent(
      this.signedToken('newsletter', subscriberId)
    )}`;
  }

  productAlertUnsubscribeUrl(subscriptionId: string): string {
    return `${this.apiBase()}/privacy/unsubscribe/product-alert?token=${encodeURIComponent(
      this.signedToken('product_alert', subscriptionId)
    )}`;
  }

  private async recordMarketingEvent(input: {
    organizationId: string;
    contact: string;
    customerId?: string | null | undefined;
    newsletterSubscriberId?: string | undefined;
    productAlertSubscriptionId?: string | undefined;
    purpose: 'newsletter' | 'product_alert';
    action: 'granted' | 'renewed' | 'revoked' | 'legacy';
    policyVersion?: string | undefined;
    source: string;
  }): Promise<void> {
    const subjectEmailHash = sha256(normalizeEmail(input.contact));
    await this.database.pool.query(
      `INSERT INTO marketing_consent_events (
         organization_id, subject_email_hash, customer_id, newsletter_subscriber_id,
         product_alert_subscription_id, purpose, action, policy_version, source, retain_until
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                 CASE WHEN $10 THEN now() + interval '3 years' ELSE NULL END)`,
      [
        input.organizationId,
        subjectEmailHash,
        input.customerId ?? null,
        input.newsletterSubscriberId ?? null,
        input.productAlertSubscriptionId ?? null,
        input.purpose,
        input.action,
        input.policyVersion ?? null,
        input.source,
        input.action === 'revoked'
      ]
    );
    // Consent evidence is append-only. The revocation event carries its own
    // three-year retention deadline instead of rewriting the earlier grant.
  }

  private apiBase(): string {
    const base = this.config.API_PUBLIC_BASE_URL.replace(/\/$/, '').replace(/\/api\/v1$/, '');
    return `${base}/api/v1`;
  }

  private signedToken(kind: 'newsletter' | 'product_alert', id: string): string {
    const signature = createHmac('sha256', this.signingSecret())
      .update(`${kind}:${id}`)
      .digest('base64url');
    return `${id}.${signature}`;
  }

  private verifySignedToken(kind: 'newsletter' | 'product_alert', token: string): string {
    const [id, signature, ...extra] = token.split('.');
    if (!id || !signature || extra.length || !isUuid(id)) {
      throw new ValidationFailedError('Link za odjavu nije važeći.');
    }
    const expected = createHmac('sha256', this.signingSecret())
      .update(`${kind}:${id}`)
      .digest('base64url');
    const provided = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (provided.length !== expectedBuffer.length || !timingSafeEqual(provided, expectedBuffer)) {
      throw new ValidationFailedError('Link za odjavu nije važeći.');
    }
    return id;
  }

  private signingSecret(): string {
    const secret = this.config.PRIVACY_TOKEN_SECRET || this.config.JWT_ACCESS_SECRET;
    if (!secret) throw new Error('PRIVACY_TOKEN_SECRET or JWT_ACCESS_SECRET is required.');
    return secret;
  }
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function validReceipt(value: string | undefined): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{24,160}$/.test(value);
}

function normalizeEmail(value: string | undefined | null): string {
  const email = String(value ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ValidationFailedError('Unesite ispravnu email adresu.');
  }
  return email;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function maskEmail(value: string): string {
  const [local = '', domain = ''] = value.split('@');
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'•'.repeat(Math.max(1, local.length - visible.length))}@${domain}`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export const PRIVACY_RETENTION = {
  consentYears: CONSENT_RETENTION_YEARS,
  marketingProofYears: MARKETING_PROOF_RETENTION_YEARS
};
