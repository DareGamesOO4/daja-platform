import { Inject, Injectable } from '@nestjs/common';
import { StorefrontRepository, TransactionManager, WISHLIST_PRICE_COUPON_CONSENT, type CustomerPrincipal, type Database, type DbClient, type StorefrontItemSnapshot } from '@daja/database';
import type { Logger } from '@daja/observability';
import { ValidationFailedError } from '@daja/security';
import { ProductAlertService } from './product-alert.service.js';
import { WhatsAppNotificationsService } from './whatsapp-notifications.service.js';
import { DATABASE, LOGGER } from './tokens.js';

type Channel = 'email' | 'whatsapp';
type Preference = { channel: Channel; contact: string; language: 'sr' | 'en'; policyVersion: string | undefined };
type Owner = Pick<CustomerPrincipal, 'organizationId' | 'customerId'>;

@Injectable()
export class WishlistAlertService {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(ProductAlertService) private readonly email: ProductAlertService,
    @Inject(WhatsAppNotificationsService) private readonly whatsapp: WhatsAppNotificationsService
  ) {}

  private transaction<T>(customer: Owner, work: (client: DbClient) => Promise<T>) {
    return new TransactionManager(this.database.pool, this.logger).run(async client => {
      await this.lockAccount(client, customer);
      return work(client);
    });
  }

  async lockAccount(client: DbClient, customer: Owner) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      ['wishlist-alert:' + customer.organizationId + ':' + customer.customerId]);
  }

  private async contacts(client: DbClient, customer: Owner) {
    const result = await client.query<{ email: string | null; phone: string | null }>(
      `SELECT CASE WHEN email_verified THEN lower(email) END AS email,
              CASE WHEN phone_verified THEN phone END AS phone
       FROM customers WHERE organization_id=$1 AND id=$2 AND active AND deleted_at IS NULL FOR UPDATE`,
      [customer.organizationId, customer.customerId]);
    return { email: result.rows[0]?.email, whatsapp: result.rows[0]?.phone };
  }

  async status(customer: CustomerPrincipal) {
    const result = await this.database.pool.query<{ channel: Channel; coupon_consent: boolean }>(
      `SELECT channel, (p.price_coupon_consent_at IS NOT NULL AND p.price_coupon_consent_version=$3)
        AS coupon_consent FROM wishlist_alert_preferences p JOIN customers c
       ON c.organization_id=p.organization_id AND c.id=p.customer_id
       WHERE p.organization_id=$1 AND p.customer_id=$2 AND c.active AND c.deleted_at IS NULL
         AND ((channel='email' AND c.email_verified AND lower(c.email)=p.contact)
           OR (channel='whatsapp' AND c.phone_verified AND c.phone=p.contact))`,
      [customer.organizationId, customer.customerId, WISHLIST_PRICE_COUPON_CONSENT]);
    return { channels: result.rows.map(row => row.channel),
      couponAvailable: this.whatsapp.wishlistCouponsAvailable(),
      couponConsent: result.rows.some(row => row.channel === 'whatsapp' && row.coupon_consent) };
  }

  async setCouponConsent(customer: CustomerPrincipal, accepted: boolean) {
    if (accepted && !this.whatsapp.wishlistCouponsAvailable()) {
      throw new ValidationFailedError('Lični WhatsApp kuponi trenutno nisu dostupni.');
    }
    return this.transaction(customer, async client => {
      if (customer.phone) await this.whatsapp.lockWishlistPhone(client, customer.phone);
      const result = await client.query(`UPDATE wishlist_alert_preferences p SET
        price_coupon_consent_at=CASE WHEN $3 THEN CASE WHEN p.price_coupon_consent_version=$4
          THEN coalesce(p.price_coupon_consent_at,now()) ELSE now() END END,
        price_coupon_consent_version=CASE WHEN $3 THEN $4 END
        FROM customers c WHERE p.organization_id=$1 AND p.customer_id=$2 AND p.channel='whatsapp'
          AND c.id=p.customer_id AND c.organization_id=p.organization_id AND c.active AND c.deleted_at IS NULL
          AND (NOT $3 OR (c.phone_verified AND c.phone=p.contact AND p.language='sr'))`,
        [customer.organizationId, customer.customerId, accepted, WISHLIST_PRICE_COUPON_CONSENT]);
      if (accepted && !result.rowCount) throw new ValidationFailedError('Uključite praćenje liste preko WhatsApp-a na srpskom i potvrdite broj.');
      return { couponConsent: accepted };
    });
  }

  async enable(customer: CustomerPrincipal, input: { channel: Channel; language: 'sr' | 'en'; policyVersion?: string | undefined; phone?: string | undefined }) {
    return this.transaction(customer, async client => {
      if (input.channel === 'whatsapp' && customer.phone) await this.whatsapp.lockWishlistPhone(client, customer.phone);
      if (input.channel === 'email' && customer.email) {
        await this.lockEmail(client, customer.organizationId, customer.email);
      }
      const contacts = await this.contacts(client, customer);
      const contact = contacts[input.channel];
      if (!contact || (input.channel === 'email' && contact !== customer.email?.toLowerCase()) ||
        (input.channel === 'whatsapp' && (contact !== customer.phone || (input.phone !== undefined && contact !== input.phone) || !/^\+381[1-9]\d{6,11}$/.test(contact)))) {
        throw new ValidationFailedError(input.channel === 'email'
          ? 'Potvrdite email adresu naloga pre uključivanja email obaveštenja.'
          : 'Potvrdite broj telefona u profilu pre uključivanja WhatsApp obaveštenja.');
      }
      if (input.channel === 'whatsapp') this.whatsapp.assertWishlistAvailable(customer, input.language);
      const targets = await this.email.wishlistTargets(customer.organizationId, customer.customerId, client);
      const preference = { ...input, contact, policyVersion: input.policyVersion };
      const existing = await client.query(
        `SELECT 1 FROM wishlist_alert_preferences WHERE organization_id=$1 AND customer_id=$2 AND channel=$3 AND contact=$4`,
        [customer.organizationId,customer.customerId,input.channel,contact]);
      if (existing.rowCount) return { alreadyEnabled: true, active: 0, skipped: 0 };
      const result = await this.enroll(client, customer, preference, targets);
      await client.query(`INSERT INTO wishlist_alert_preferences(organization_id,customer_id,channel,contact,language,policy_version)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id,customer_id,channel) DO UPDATE
        SET contact=EXCLUDED.contact,language=EXCLUDED.language,policy_version=EXCLUDED.policy_version,created_at=now(),
          price_coupon_consent_at=NULL,price_coupon_consent_version=NULL`,
        [customer.organizationId,customer.customerId,input.channel,contact,input.language,input.policyVersion ?? null]);
      return { ...result, alreadyEnabled: false };
    });
  }

  async add(customer: Owner, item: StorefrontItemSnapshot) {
    return this.transaction(customer, async client => {
      const productId = item.productId ?? item.id;
      if (typeof productId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(productId)) {
        throw new ValidationFailedError('Wishlist item requires product id');
      }
      const previous = await this.email.wishlistTargets(customer.organizationId, customer.customerId, client, productId);
      const wishlist = await new StorefrontRepository(client).addWishlistItem({ ...customer, item });
      const targets = await this.email.wishlistTargets(customer.organizationId, customer.customerId, client, productId);
      const variantId = targets[0]?.variantId ?? null;
      // Repeated client syncs must never undo an explicit individual opt-out.
      if (previous.length && previous[0]?.variantId === variantId) return wishlist;
      const preferences = await this.prepareMutation(client, customer, productId);
      await this.removeDerived(client, customer, productId, variantId);
      if (variantId && preferences.length) {
        const contacts = await this.contacts(client, customer);
        for (const preference of preferences) {
          if (contacts[preference.channel] !== preference.contact) continue;
          await this.enroll(client, customer, preference, targets);
        }
      }
      return wishlist;
    });
  }

  async remove(customer: Owner, productId: string) {
    return this.transaction(customer, async client => {
      const wishlist = await new StorefrontRepository(client).removeWishlistItem({ ...customer, productId });
      await this.prepareMutation(client, customer, productId);
      await this.removeDerived(client, customer, productId, null);
      return wishlist;
    });
  }

  private async prepareMutation(client: DbClient, customer: Owner, productId: string) {
    const ids = [customer.organizationId,customer.customerId];
    const phones = await client.query<{ phone: string }>(`SELECT contact AS phone FROM wishlist_alert_preferences
      WHERE organization_id=$1 AND customer_id=$2 AND channel='whatsapp'
      UNION SELECT phone FROM whatsapp_subscriptions
      WHERE organization_id=$1 AND wishlist_customer_id=$2 AND product_id=$3 AND revoked_at IS NULL
      ORDER BY phone`, [...ids,productId]);
    for (const { phone } of phones.rows) await this.whatsapp.lockWishlistPhone(client, phone);
    const email = await client.query<{ contact: string }>(`SELECT contact FROM wishlist_alert_preferences
      WHERE organization_id=$1 AND customer_id=$2 AND channel='email'`, ids);
    const emailContact = email.rows[0]?.contact;
    if (emailContact) await this.lockEmail(client, customer.organizationId, emailContact);
    // Read again after taking the same contact locks as channel-wide opt-outs.
    const preferences = await client.query<Preference>(`SELECT channel,contact,language,policy_version AS "policyVersion"
      FROM wishlist_alert_preferences WHERE organization_id=$1 AND customer_id=$2
        AND (channel='email' OR contact=ANY($3::text[])) ORDER BY channel`, [...ids,phones.rows.map(row => row.phone)]);
    return preferences.rows;
  }

  private lockEmail(client: DbClient, organizationId: string, email: string) {
    return client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      ['wishlist-email:' + organizationId + ':' + email.toLowerCase()]);
  }

  private async removeDerived(client: DbClient, customer: Owner, productId: string, keepVariant: string | null) {
    await this.whatsapp.removeWishlistProductAlerts(client, customer, productId, keepVariant);
    await client.query(`WITH revoked AS (
      UPDATE product_alert_subscriptions SET active=false,revoked_at=now(),updated_at=now()
      WHERE organization_id=$1 AND wishlist_customer_id=$2 AND product_id=$3 AND revoked_at IS NULL
        AND variant_id IS DISTINCT FROM $4::uuid RETURNING id
      )
      UPDATE email_deliveries d SET status='suppressed',last_error='Watch removed from wishlist'
      FROM revoked WHERE d.payload->>'productAlertSubscriptionId'=revoked.id::text AND d.status IN ('pending','failed')`,
      [customer.organizationId,customer.customerId,productId,keepVariant]);
  }

  private enroll(client: DbClient, customer: Owner, preference: Preference,
    targets: Array<{ productId: string; variantId: string | null }>) {
    return preference.channel === 'email'
      ? this.email.subscribeWishlist(customer, targets, preference.contact, preference.policyVersion ?? undefined, client)
      : this.whatsapp.subscribeWishlist(customer, targets, preference, preference.contact, client);
  }
}
