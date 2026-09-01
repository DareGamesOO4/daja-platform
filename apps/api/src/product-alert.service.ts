import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@daja/config';
import {
  StorefrontRepository,
  type Database,
  type ProductAlertNotification,
  type ProductAlertSubscription,
  type ProductAlertType
} from '@daja/database';
import { CONFIG, DATABASE } from './tokens.js';
import { EmailDeliveryService } from './email-delivery.service.js';
import { PrivacyService } from './privacy.service.js';

@Injectable()
export class ProductAlertService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database,
    private readonly delivery: EmailDeliveryService,
    private readonly privacy: PrivacyService
  ) {}

  async subscribe(input: {
    organizationId: string;
    productId: string;
    variantId: string;
    customerId?: string | null | undefined;
    email?: string | undefined;
    managementToken?: string | undefined;
    acceptedTerms: boolean;
    policyVersion?: string | undefined;
    type: ProductAlertType;
  }): Promise<
    ProductAlertSubscription & {
      managementToken?: string;
      maskedEmail?: string;
      termsAccepted: boolean;
    }
  > {
    if (!input.acceptedTerms) {
      throw new Error('Potvrdite uslove korišćenja i politiku privatnosti.');
    }
    const contact = input.customerId
      ? null
      : await this.privacy.resolveAlertContact({
          organizationId: input.organizationId,
          email: input.email,
          managementToken: input.managementToken,
          acceptedTerms: input.acceptedTerms,
          policyVersion: input.policyVersion
        });
    const email = input.email?.trim().toLowerCase() || contact?.email;
    if (!email) throw new Error('Unesite email adresu za obaveštenje.');
    const subscription = await new StorefrontRepository(this.database.pool).subscribeProductAlert({
      organizationId: input.organizationId,
      productId: input.productId,
      variantId: input.variantId,
      ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
      ...(contact?.id ? { contactId: contact.id } : {}),
      email,
      type: input.type
    });
    await this.database.pool.query(
      `UPDATE product_alert_subscriptions
       SET consent_status = 'explicit', consent_version = $2, consented_at = now(), revoked_at = NULL
       WHERE id = $1`,
      [subscription.id, input.policyVersion ?? '2026-09-01-draft']
    );
    await this.privacy.recordProductAlertConsent({
      organizationId: input.organizationId,
      email,
      customerId: input.customerId,
      subscriptionId: subscription.id,
      policyVersion: input.policyVersion,
      source: input.customerId ? 'authenticated_alert_modal' : 'guest_alert_modal'
    });
    return {
      ...subscription,
      termsAccepted: true,
      ...(contact
        ? { managementToken: contact.managementToken, maskedEmail: contact.maskedEmail }
        : {})
    };
  }

  async activeTypes(input: {
    organizationId: string;
    productId: string;
    variantId: string;
    customerId?: string | null | undefined;
    email?: string | null | undefined;
    managementToken?: string | undefined;
  }): Promise<{
    types: ProductAlertType[];
    maskedEmail?: string;
    termsAccepted: boolean;
    newsletterSubscribed: boolean;
  }> {
    const contact = input.managementToken
      ? await this.privacy.alertContactByToken(input.organizationId, input.managementToken)
      : null;
    const email = input.email?.trim().toLowerCase() || contact?.email;
    if (!email) {
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
        email
      }),
      this.privacy.newsletterStatus({ organizationId: input.organizationId, email }),
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
    managementToken?: string | undefined;
  }): Promise<boolean> {
    const contact = input.managementToken
      ? await this.privacy.alertContactByToken(input.organizationId, input.managementToken)
      : null;
    const email = input.email?.trim().toLowerCase() || contact?.email;
    if (!email) throw new Error('Prijavite se ili potvrdite email za odjavu.');
    const result = await this.database.pool.query<{ id: string }>(
      `SELECT id FROM product_alert_subscriptions
       WHERE organization_id = $1 AND product_id = $2 AND variant_id = $3
         AND alert_type = $4 AND active
         AND (customer_id = $5 OR normalized_email = lower($6))
       LIMIT 1`,
      [
        input.organizationId,
        input.productId,
        input.variantId,
        input.type,
        input.customerId ?? null,
        email
      ]
    );
    const subscriptionId = result.rows[0]?.id;
    if (!subscriptionId) return false;
    return this.privacy.revokeProductAlertSubscription({
      organizationId: input.organizationId,
      subscriptionId,
      customerId: input.customerId,
      customerEmail: email,
      source: input.customerId ? 'account_or_wishlist' : 'guest_wishlist'
    });
  }

  async notifyBackInStock(input: { organizationId: string; variantId: string }): Promise<void> {
    const alerts = await new StorefrontRepository(this.database.pool).claimBackInStockProductAlerts(input);
    await Promise.all(alerts.map((alert) => this.sendBackInStockEmail(alert)));
  }

  async notifyPriceChanged(input: {
    organizationId: string;
    variantId: string;
    previousPriceAmount: number;
    currentPriceAmount: number;
  }): Promise<void> {
    if (input.previousPriceAmount === input.currentPriceAmount) return;
    const alerts = await new StorefrontRepository(this.database.pool).claimPriceChangeProductAlerts(input);
    await Promise.all(alerts.map((alert) => this.sendPriceChangeEmail(alert)));
  }

  private async sendBackInStockEmail(alert: ProductAlertNotification): Promise<void> {
    const name = productName(alert);
    const url = this.productUrl(alert.slug);
    await this.delivery.send({
      recipients: [alert.email],
      fromEmail: this.fromEmail(),
      subject: `${name} je ponovo na stanju | DajaShop`,
      text: [
        `Dobre vesti — ${name} je ponovo na stanju.`,
        `Trenutna cena: ${formatMoney(alert.currentPriceAmount, alert.currency)}.`,
        '',
        `Pogledajte proizvod: ${url}`,
        `Odjava od ovog obaveštenja: ${this.privacy.productAlertUnsubscribeUrl(alert.subscriptionId)}`
      ].join('\n'),
      html: emailPage({
        title: 'Ponovo je na stanju',
        introduction: `Sat <strong>${escapeHtml(name)}</strong>, za koji ste tražili obaveštenje, ponovo je dostupan.`,
        price: formatMoney(alert.currentPriceAmount, alert.currency),
        buttonLabel: 'Pogledajte proizvod',
        url,
        unsubscribeUrl: this.privacy.productAlertUnsubscribeUrl(alert.subscriptionId)
      }),
      tag: 'product-back-in-stock'
    });
  }

  private async sendPriceChangeEmail(alert: ProductAlertNotification): Promise<void> {
    const name = productName(alert);
    const url = this.productUrl(alert.slug);
    const oldPrice = formatMoney(alert.previousPriceAmount ?? alert.currentPriceAmount, alert.currency);
    const currentPrice = formatMoney(alert.currentPriceAmount, alert.currency);
    await this.delivery.send({
      recipients: [alert.email],
      fromEmail: this.fromEmail(),
      subject: `Promenjena je cena za ${name} | DajaShop`,
      text: [
        `Cena za ${name} je promenjena.`,
        `Prethodna cena: ${oldPrice}`,
        `Nova cena: ${currentPrice}`,
        '',
        `Pogledajte proizvod: ${url}`,
        `Odjava od ovog obaveštenja: ${this.privacy.productAlertUnsubscribeUrl(alert.subscriptionId)}`
      ].join('\n'),
      html: emailPage({
        title: 'Cena je promenjena',
        introduction: `Cena za sat <strong>${escapeHtml(name)}</strong>, za koji ste tražili obaveštenje, je ažurirana.`,
        oldPrice,
        price: currentPrice,
        buttonLabel: 'Pogledajte proizvod',
        url,
        unsubscribeUrl: this.privacy.productAlertUnsubscribeUrl(alert.subscriptionId)
      }),
      tag: 'product-price-change'
    });
  }

  private productUrl(slug: string): string {
    return `${this.config.STOREFRONT_PUBLIC_BASE_URL.replace(/\/$/, '')}/product/${encodeURIComponent(slug)}`;
  }

  private fromEmail(): string {
    const configured = this.config.SES_FROM_EMAIL;
    const address = rawEmailAddress(configured);
    return address ? `DajaShop <${address}>` : configured;
  }
}

function emailPage(input: {
  title: string;
  introduction: string;
  price: string;
  oldPrice?: string;
  buttonLabel: string;
  url: string;
  unsubscribeUrl: string;
}): string {
  const priceBlock = input.oldPrice
    ? `<p style="margin:0 0 4px;color:#6b7280;font-size:15px;text-decoration:line-through">${escapeHtml(input.oldPrice)}</p>` +
      `<p style="margin:0;color:#111827;font-size:26px;font-weight:800">${escapeHtml(input.price)}</p>`
    : `<p style="margin:0;color:#111827;font-size:26px;font-weight:800">${escapeHtml(input.price)}</p>`;
  return (
    '<!doctype html><html lang="sr"><body style="margin:0;background:#f6f6f6;font-family:Arial,sans-serif;color:#1f1f1f">' +
    '<main style="max-width:560px;margin:32px auto;background:#fff;padding:40px;border-radius:12px">' +
    `<h1 style="margin:0 0 16px;font-size:26px">${escapeHtml(input.title)}</h1>` +
    `<p style="font-size:16px;line-height:1.6">${input.introduction}</p>` +
    '<section style="margin:24px 0;padding:18px;background:#f7f7f8;border-radius:10px">' +
    priceBlock +
    '</section>' +
    `<p style="margin:28px 0"><a href="${escapeHtml(input.url)}" style="display:inline-block;background:#111;color:#fff;padding:14px 22px;border-radius:8px;text-decoration:none;font-weight:bold">${escapeHtml(input.buttonLabel)}</a></p>` +
    `<p style="margin:28px 0 0;font-size:14px;color:#666">Ne želite više ovu obavest? <a href="${escapeHtml(input.unsubscribeUrl)}">Odjavite se jednim klikom</a>.</p>` +
    '<p style="margin:16px 0 0;font-size:14px;color:#666">DajaShop</p></main></body></html>'
  );
}

function productName(alert: ProductAlertNotification): string {
  return [alert.brand, alert.productName].filter(Boolean).join(' ');
}

function formatMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat('sr-RS', {
    style: 'currency',
    currency: currency || 'RSD',
    maximumFractionDigits: 2
  }).format(amountMinor / 100);
}

function rawEmailAddress(value: string | undefined): string {
  const match = /<([^>]+)>/.exec(value ?? '');
  const address = (match?.[1] ?? value ?? '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : '';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    };
    return entities[character] ?? character;
  });
}
