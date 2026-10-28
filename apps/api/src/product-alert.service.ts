import { createHash, createHmac, randomBytes } from 'node:crypto';
import { ResourceConflictError, ValidationFailedError } from '@daja/security';
import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@daja/config';
import type { Logger } from '@daja/observability';
import {
  ProductAlertDispatcher,
  StorefrontRepository,
  TransactionManager,
  type DbClient,
  type Database,
  type ProductAlertDeliveryChannel,
  type ProductAlertType
} from '@daja/database';
import { CONFIG, DATABASE, LOGGER } from './tokens.js';
import { EmailDeliveryService } from './email-delivery.service.js';
import { PrivacyService } from './privacy.service.js';
import { SmsDeliveryService } from './sms-delivery.service.js';
import { brandedEmail, emailEscape } from '@daja/shared';

type AlertInput = {
    organizationId: string;
    productId: string;
    variantId: string;
    customerId?: string | null | undefined;
    email?: string | undefined;
    phone?: string | undefined;
    managementToken?: string | undefined;
    deliveryChannel: ProductAlertDeliveryChannel;
    acceptedSmsMarketing?: boolean | undefined;
    policyVersion?: string | undefined;
    type: ProductAlertType;
};

@Injectable()
export class ProductAlertService {

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly delivery: EmailDeliveryService,
    private readonly sms: SmsDeliveryService,
    private readonly privacy: PrivacyService
  ) {}

  async subscribe(input: AlertInput) {
    if (input.deliveryChannel === 'email' && input.customerId && !await this.verifiedCustomer(input.organizationId, input.customerId)) {
      throw new ValidationFailedError('Potvrdite email adresu naloga pre uključivanja email obaveštenja.');
    }
    if (input.deliveryChannel === 'email' && !input.customerId && !input.managementToken) {
      return this.requestConfirmation(input);
    }
    return new TransactionManager(this.database.pool, this.logger).run(client => this.activate(input, client));
  }

  private async activate(input: AlertInput, client: DbClient) {
    const usesEmail = input.deliveryChannel === 'email';
    const contact = !usesEmail || input.customerId
      ? null
      : await this.privacy.alertContactByToken(input.organizationId, input.managementToken!, client);
    const email = usesEmail ? contact?.email ?? input.email?.trim().toLowerCase() : undefined;
    const phone = !usesEmail ? normalizePhone(input.phone) : undefined;
    if (usesEmail && !email) throw new Error('Unesite email adresu za obaveštenje.');
    if (!usesEmail && !phone) throw new Error('Unesite broj telefona u međunarodnom formatu, npr. +381601234567.');
    const contactValue = email ?? phone;
    if (!contactValue) throw new Error('Kontakt za obaveštenje nije dostupan.');
    const subscription = await new StorefrontRepository(client).subscribeProductAlert({
      organizationId: input.organizationId,
      productId: input.productId,
      variantId: input.variantId,
      ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
      ...(contact?.id ? { contactId: contact.id } : {}),
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
      deliveryChannel: input.deliveryChannel,
      type: input.type
    });
    await client.query(
      `UPDATE product_alert_subscriptions
       SET consent_status = 'explicit', consent_version = $2, consented_at = now(), revoked_at = NULL
       WHERE id = $1`,
      [subscription.id, input.policyVersion ?? '2026-09-01-draft']
    );
    await this.privacy.recordProductAlertConsent({
      organizationId: input.organizationId,
      contact: contactValue,
      customerId: input.customerId,
      subscriptionId: subscription.id,
      policyVersion: input.policyVersion,
      source: input.customerId ? 'authenticated_alert_modal' : 'guest_email_confirmation'
    }, client);
    if (input.acceptedSmsMarketing && phone) {
      await new StorefrontRepository(client).subscribeSmsMarketing({
        organizationId: input.organizationId,
        ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
        phone,
        policyVersion: input.policyVersion,
        source: input.customerId ? 'authenticated_alert_modal' : 'guest_alert_modal'
      });
    }
    return {
      ...subscription,
      ...(contact
        ? { managementToken: contact.managementToken, maskedEmail: contact.maskedEmail }
        : {})
    };
  }

  private async verifiedCustomer(organizationId: string, customerId: string): Promise<boolean> {
    const result = await this.database.pool.query<{ verified: boolean }>(
      'SELECT email_verified AS verified FROM customers WHERE organization_id = $1 AND id = $2 AND active AND deleted_at IS NULL',
      [organizationId, customerId]);
    return result.rows[0]?.verified === true;
  }

  private async requestConfirmation(input: AlertInput) {
    const email = input.email?.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationFailedError('Unesite ispravnu email adresu.');
    await new TransactionManager(this.database.pool, this.logger).run(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [input.organizationId + ':' + email]);
      const recent = await client.query(`SELECT 1 FROM product_alert_confirmations WHERE organization_id = $1 AND email = $2
        AND created_at > now() - interval '5 minutes' AND used_at IS NULL AND intent->>'productId' = $3
        AND intent->>'variantId' = $4 AND intent->>'type' = $5 LIMIT 1`,
        [input.organizationId, email, input.productId, input.variantId, input.type]);
      if (recent.rowCount) return;
      const count = await client.query<{ total: number }>(`SELECT count(*)::int AS total FROM product_alert_confirmations
        WHERE organization_id = $1 AND email = $2 AND created_at > now() - interval '1 hour'`, [input.organizationId, email]);
      if ((count.rows[0]?.total ?? 0) >= 5) throw new ValidationFailedError('Već je zatraženo više potvrda. Proverite email ili pokušajte kasnije.');
      const product = await client.query<{ name: string; variant_name: string | null }>(`SELECT p.name, v.name AS variant_name
        FROM product_variants v JOIN products p ON p.id = v.product_id AND p.organization_id = v.organization_id
        WHERE v.organization_id = $1 AND v.id = $2 AND p.id = $3 AND v.active AND v.published AND v.deleted_at IS NULL
        AND p.active AND p.published AND p.deleted_at IS NULL`, [input.organizationId, input.variantId, input.productId]);
      if (!product.rowCount) throw new ValidationFailedError('Artikal više nije dostupan.');
      const item = product.rows[0]!;
      const name = [item.name, item.variant_name].filter(Boolean).join(' — ');
      const purpose = input.type === 'price_change' ? 'kada se cena promeni' : 'kada se artikal vrati na stanje';
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const intent = { ...input, email, managementToken: undefined, customerId: undefined };
      await client.query(`INSERT INTO product_alert_confirmations(token_hash, organization_id, email, intent, expires_at)
        VALUES ($1,$2,$3,$4::jsonb,$5)`, [createHash('sha256').update(token).digest('hex'), input.organizationId, email, JSON.stringify(intent), expiresAt]);
      const url = new URL('/product-alert-confirm', this.config.STOREFRONT_PUBLIC_BASE_URL);
      url.searchParams.set('token', token);
      await this.delivery.send({ recipients: [email], tag: 'product-alert-confirmation', expiresAt,
        linkTokenHash: createHash('sha256').update(token).digest('hex'),
        fromEmail: this.config.SES_ACCOUNT_FROM_EMAIL || this.config.SES_FROM_EMAIL,
        subject: 'Potvrdite obaveštenje: ' + name.slice(0, 120) + ' | DajaShop',
        text: `Zatražili ste obaveštenje ${purpose} za artikal: ${name}.\nPotvrdite prijavu: ${url}\nLink važi 24 sata. Ako niste zatražili obaveštenje, zanemarite poruku.`,
        html: brandedEmail({ siteUrl: this.config.STOREFRONT_PUBLIC_BASE_URL, eyebrow: 'OBAVEŠTENJE O ARTIKLU',
          title: 'Potvrdite obaveštenje za artikal',
          content: `<p>Artikal: <strong>${emailEscape(name)}</strong>.</p><p>Javićemo vam ${purpose}. Aktivirajte prijavu preko dugmeta ispod. Link važi 24 sata.</p><p>Ako niste zatražili obaveštenje, zanemarite ovu poruku.</p>`,
          button: { label: 'Potvrdi obaveštenje', url: url.toString() } }) }, client);
    });
    return { requiresConfirmation: true, active: false };
  }

  async confirm(token: string) {
    return new TransactionManager(this.database.pool, this.logger).run(async client => {
      const result = await client.query<{ organization_id: string; email: string; intent: AlertInput; used_at: Date | null }>(
        `SELECT organization_id, email, intent, used_at FROM product_alert_confirmations
         WHERE token_hash = $1 AND expires_at > now() FOR UPDATE`, [createHash('sha256').update(token).digest('hex')]);
      const row = result.rows[0];
      if (!row) throw new ValidationFailedError('Link je istekao. Zatražite novo obaveštenje.');
      const secret = this.config.PRIVACY_TOKEN_SECRET || this.config.JWT_ACCESS_SECRET;
      if (!secret) throw new Error('Email confirmation signing secret is required');
      const owner = row.used_at
        ? await client.query<{ id: string }>(`SELECT id FROM product_alert_contacts
          WHERE organization_id = $1 AND normalized_email = $2 AND verified_at IS NOT NULL FOR UPDATE`, [row.organization_id, row.email])
        : await client.query<{ id: string }>(`INSERT INTO product_alert_contacts(organization_id,email,management_token_hash,terms_accepted_at,policy_version,verified_at)
          VALUES ($1,$2,$3,now(),$4,now()) ON CONFLICT (organization_id,normalized_email) DO UPDATE
          SET verified_at = now(), terms_accepted_at = now(), policy_version = EXCLUDED.policy_version, updated_at = now()
          RETURNING id`, [row.organization_id, row.email, createHash('sha256').update(token).digest('hex'), row.intent.policyVersion ?? '2026-09-01-draft']);
      const ownerId = owner.rows[0]?.id;
      if (!ownerId) throw new ValidationFailedError('Link za obaveštenje više nije važeći. Zatražite novu prijavu.');
      const managementToken = createHmac('sha256', secret).update('product-alert-owner:' + ownerId).digest('base64url');
      if (!row.used_at) {
        await client.query('UPDATE product_alert_contacts SET management_token_hash = $2 WHERE id = $1',
          [ownerId, createHash('sha256').update(managementToken).digest('hex')]);
        try {
          await this.activate({ ...row.intent, managementToken }, client);
        } catch (error) {
          // The item may have returned to stock while its owner was confirming.
          if (!(error instanceof ResourceConflictError) || row.intent.type !== 'back_in_stock'
            || error.message !== 'Ovaj proizvod je već na stanju.') throw error;
        }
        await client.query('UPDATE product_alert_confirmations SET used_at = now() WHERE token_hash = $1', [createHash('sha256').update(token).digest('hex')]);
      }
      const contact = await this.privacy.alertContactByToken(row.organization_id, managementToken, client);
      const subscription = await client.query<{ active: boolean }>(`SELECT active FROM product_alert_subscriptions
        WHERE organization_id = $1 AND product_id = $2 AND variant_id = $3 AND alert_type = $4
          AND delivery_channel = 'email' AND normalized_email = $5`,
        [row.organization_id, row.intent.productId, row.intent.variantId, row.intent.type, row.email]);
      return { status: 'confirmed', managementToken: contact.managementToken, maskedEmail: contact.maskedEmail,
        active: subscription.rows[0]?.active === true,
        productId: row.intent.productId, variantId: row.intent.variantId, type: row.intent.type };
    });
  }

  async activeTypes(input: {
    organizationId: string;
    productId: string;
    variantId: string;
    customerId?: string | null | undefined;
    email?: string | null | undefined;
    phone?: string | null | undefined;
    managementToken?: string | undefined;
  }): Promise<{
    types: ProductAlertType[];
    maskedEmail?: string;
    termsAccepted: boolean;
    newsletterSubscribed: boolean;
  }> {
    if (input.customerId && !await this.verifiedCustomer(input.organizationId, input.customerId)) {
      input = { ...input, customerId: undefined, email: undefined, phone: undefined };
    }
    const contact = input.managementToken
      ? await this.privacy.alertContactByToken(input.organizationId, input.managementToken)
      : null;
    const email = input.email?.trim().toLowerCase() || contact?.email;
    const phone = normalizePhone(input.phone);
    if (!email && !phone && !input.customerId) {
      return {
        types: [],
        termsAccepted: contact?.termsAccepted ?? false,
        newsletterSubscribed: false
      };
    }
    const [types, newsletter, storedTerms] = await Promise.all([
      new StorefrontRepository(this.database.pool).listActiveProductAlertTypes({
        organizationId: input.organizationId,
        productId: input.productId,
        variantId: input.variantId,
        ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
        ...(email ? { email } : {}),
        ...(phone ? { phone } : {})
      }),
      this.privacy.newsletterStatus({ organizationId: input.organizationId, email: email ?? null }),
      input.customerId
        ? this.database.pool.query<{ accepted: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM product_alert_subscriptions
               WHERE organization_id = $1 AND customer_id = $2
                 AND consent_status = 'explicit' AND consented_at IS NOT NULL
             ) AS accepted`,
            [input.organizationId, input.customerId]
          )
        : Promise.resolve({ rows: [] as Array<{ accepted: boolean }> })
    ]);
    const termsAccepted = contact?.termsAccepted ?? storedTerms.rows[0]?.accepted === true;
    return {
      types,
      termsAccepted,
      newsletterSubscribed: newsletter.active,
      ...(contact ? { maskedEmail: contact.maskedEmail } : {})
    };
  }

  async unsubscribe(input: {
    organizationId: string;
    productId: string;
    variantId: string;
    type: ProductAlertType;
    customerId?: string | null | undefined;
    email?: string | null | undefined;
    phone?: string | null | undefined;
    managementToken?: string | undefined;
  }): Promise<boolean> {
    if (input.customerId && !await this.verifiedCustomer(input.organizationId, input.customerId)) {
      input = { ...input, customerId: undefined, email: undefined, phone: undefined };
    }
    const contact = input.managementToken
      ? await this.privacy.alertContactByToken(input.organizationId, input.managementToken)
      : null;
    const email = input.email?.trim().toLowerCase() || contact?.email;
    const phone = normalizePhone(input.phone);
    if (!email && !phone && !input.customerId) {
      throw new Error('Prijavite se ili otvorite link za odjavu iz obaveštenja.');
    }
    const result = await this.database.pool.query<{ id: string }>(
      `SELECT id FROM product_alert_subscriptions
       WHERE organization_id = $1 AND product_id = $2 AND variant_id = $3
         AND alert_type = $4 AND active
         AND (
           customer_id = $5
           OR normalized_email = lower($6)
           OR normalized_phone = regexp_replace($7, '[^0-9+]', '', 'g')
         )
       LIMIT 1`,
      [
        input.organizationId,
        input.productId,
        input.variantId,
        input.type,
        input.customerId ?? null,
        email ?? null,
        phone ?? null
      ]
    );
    const subscriptionId = result.rows[0]?.id;
    if (!subscriptionId) return false;
    return this.privacy.revokeProductAlertSubscription({
      organizationId: input.organizationId,
      subscriptionId,
      customerId: input.customerId,
      customerEmail: email ?? null,
      source: input.customerId ? 'account_or_wishlist' : 'guest_wishlist'
    });
  }

  async notifyBackInStock(input: { organizationId: string; variantId: string }): Promise<void> {
    await new ProductAlertDispatcher(this.config, this.database, this.logger, this.delivery, this.sms, this.privacy).notifyBackInStock(input);
  }

  async notifyPriceChanged(_input: { organizationId: string; variantId: string; previousPriceAmount: number; currentPriceAmount: number }): Promise<void> {
    // Database triggers persist debounced changes; the worker dispatches them.
  }
}

function normalizePhone(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().replace(/[\s()-]/g, '');
  return normalized && /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : undefined;
}
