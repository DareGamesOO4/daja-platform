import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@daja/config';
import {
  StorefrontRepository,
  type Database,
  type ProductAlertNotification,
  type ProductAlertSubscription,
  type ProductAlertDeliveryChannel,
  type ProductAlertType
} from '@daja/database';
import { CONFIG, DATABASE } from './tokens.js';
import { EmailDeliveryService } from './email-delivery.service.js';
import { PrivacyService } from './privacy.service.js';
import { SmsDeliveryService } from './sms-delivery.service.js';

@Injectable()
export class ProductAlertService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database,
    private readonly delivery: EmailDeliveryService,
    private readonly sms: SmsDeliveryService,
    private readonly privacy: PrivacyService
  ) {}

  async subscribe(input: {
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
  }): Promise<
    ProductAlertSubscription & {
      managementToken?: string;
      maskedEmail?: string;
    }
  > {
    const usesEmail = input.deliveryChannel === 'email';
    const contact = !usesEmail || input.customerId
      ? null
      : await this.privacy.resolveAlertContact({
          organizationId: input.organizationId,
          email: input.email,
          managementToken: input.managementToken,
          acceptedTerms: true,
          policyVersion: input.policyVersion
        });
    const email = usesEmail ? input.email?.trim().toLowerCase() || contact?.email : undefined;
    const phone = !usesEmail ? normalizePhone(input.phone) : undefined;
    if (usesEmail && !email) throw new Error('Unesite email adresu za obaveštenje.');
    if (!usesEmail && !phone) throw new Error('Unesite broj telefona u međunarodnom formatu, npr. +381601234567.');
    const contactValue = email ?? phone;
    if (!contactValue) throw new Error('Kontakt za obaveštenje nije dostupan.');
    const subscription = await new StorefrontRepository(this.database.pool).subscribeProductAlert({
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
    await this.database.pool.query(
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
      source: input.customerId ? 'authenticated_alert_modal' : 'guest_alert_modal'
    });
    if (input.acceptedSmsMarketing && phone) {
      await new StorefrontRepository(this.database.pool).subscribeSmsMarketing({
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
    const alerts = await new StorefrontRepository(this.database.pool).claimBackInStockProductAlerts(input);
    await Promise.all(
      alerts.map((alert) => (
        alert.deliveryChannel === 'sms'
          ? this.sendBackInStockSms(alert)
          : this.sendBackInStockEmail(alert)
      ))
    );
  }

  async notifyPriceChanged(input: {
    organizationId: string;
    variantId: string;
    previousPriceAmount: number;
    currentPriceAmount: number;
  }): Promise<void> {
    if (input.previousPriceAmount === input.currentPriceAmount) return;
    const alerts = await new StorefrontRepository(this.database.pool).claimPriceChangeProductAlerts(input);
    await Promise.all(
      alerts.map((alert) => (
        alert.deliveryChannel === 'sms'
          ? this.sendPriceChangeSms(alert)
          : this.sendPriceChangeEmail(alert)
      ))
    );
  }

  private async sendBackInStockEmail(alert: ProductAlertNotification): Promise<void> {
    if (!alert.email) return;
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
    if (!alert.email) return;
    const name = productName(alert);
    const url = this.productUrl(alert.slug);
    const previousPriceAmount = alert.previousPriceAmount ?? alert.currentPriceAmount;
    const oldPrice = formatMoney(previousPriceAmount, alert.currency);
    const currentPrice = formatMoney(alert.currentPriceAmount, alert.currency);
    const priceDropped = previousPriceAmount > alert.currentPriceAmount;
    const savings = priceDropped
      ? formatMoney(previousPriceAmount - alert.currentPriceAmount, alert.currency)
      : undefined;
    await this.delivery.send({
      recipients: [alert.email],
      fromEmail: this.fromEmail(),
      subject: priceDropped
        ? `Cena je sada niža za ${name} | DajaShop`
        : `Promenjena je cena za ${name} | DajaShop`,
      text: [
        priceDropped ? `Cena za ${name} je sada niža.` : `Cena za ${name} je promenjena.`,
        `Prethodna cena: ${oldPrice}`,
        `Nova cena: ${currentPrice}`,
        ...(savings ? [`Ušteda: ${savings}`] : []),
        '',
        `Pogledajte proizvod: ${url}`,
        `Odjava od ovog obaveštenja: ${this.privacy.productAlertUnsubscribeUrl(alert.subscriptionId)}`
      ].join('\n'),
      html: priceChangeEmail({
        productName: name,
        imageUrl: alert.imageUrl,
        previousPrice: oldPrice,
        currentPrice,
        ...(savings ? { savings } : {}),
        priceDropped,
        url,
        unsubscribeUrl: this.privacy.productAlertUnsubscribeUrl(alert.subscriptionId)
      }),
      tag: 'product-price-change'
    });
  }

  private async sendBackInStockSms(alert: ProductAlertNotification): Promise<void> {
    if (!alert.phone) return;
    const name = productName(alert);
    const url = this.productUrl(alert.slug);
    await this.sms.send({
      phone: alert.phone,
      message: [
        `DajaShop: ${name} je ponovo na stanju.`,
        `Cena: ${formatMoney(alert.currentPriceAmount, alert.currency)}.`,
        url,
        `Odjava: ${this.privacy.productAlertUnsubscribeUrl(alert.subscriptionId)}`
      ].join('\n'),
      tag: 'product-back-in-stock'
    });
  }

  private async sendPriceChangeSms(alert: ProductAlertNotification): Promise<void> {
    if (!alert.phone) return;
    const name = productName(alert);
    const url = this.productUrl(alert.slug);
    const oldPrice = formatMoney(alert.previousPriceAmount ?? alert.currentPriceAmount, alert.currency);
    const currentPrice = formatMoney(alert.currentPriceAmount, alert.currency);
    await this.sms.send({
      phone: alert.phone,
      message: [
        `DajaShop: cena za ${name} je promenjena.`,
        `Pre: ${oldPrice}. Sada: ${currentPrice}.`,
        url,
        `Odjava: ${this.privacy.productAlertUnsubscribeUrl(alert.subscriptionId)}`
      ].join('\n'),
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

function priceChangeEmail(input: {
  productName: string;
  imageUrl: string | null;
  previousPrice: string;
  currentPrice: string;
  savings?: string;
  priceDropped: boolean;
  url: string;
  unsubscribeUrl: string;
}): string {
  const productName = escapeHtml(input.productName);
  const url = escapeHtml(input.url);
  const unsubscribeUrl = escapeHtml(input.unsubscribeUrl);
  const priceMessage = input.priceDropped
    ? 'Cena proizvoda koji pratite je sada niža.'
    : 'Cena proizvoda koji pratite je upravo ažurirana.';
  const priceLabel = input.priceDropped ? 'NOVA, NIŽA CENA' : 'TRENUTNA CENA';
  const buttonLabel = input.priceDropped ? 'Pogledajte novu cenu' : 'Pogledajte proizvod';
  const savingsBlock = input.savings
    ? '<p class="price-savings" style="margin:14px 0 0;color:#166534;font-size:13px;font-weight:800;letter-spacing:0.02em">UŠTEDA ' +
      escapeHtml(input.savings) +
      '</p>'
    : '';
  return (
    '<!doctype html><html lang="sr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">' +
    '<style>:root{color-scheme:light dark;supported-color-schemes:light dark}@media only screen and (max-width:640px){.price-shell{width:100% !important}.price-outer{padding:0 !important}.price-header{padding:24px 20px !important}.price-content{padding:28px 20px !important}.price-footer{padding:20px !important}.price-product-media,.price-product-info{display:block !important;width:auto !important}.price-product-media{padding:20px 20px 0 !important}.price-product-info{padding:18px 20px 24px !important}.price-product-image{width:100% !important;height:220px !important}.price-button{display:block !important;text-align:center !important}.price-link{word-break:break-all !important}}@media (prefers-color-scheme:dark){.price-body,.price-page,.price-outer,.price-shell,.price-header,.price-footer{background:#2c2c2e !important}.price-header,.price-footer,.price-product-card{border-color:#48484a !important}.price-content h1,.price-content h2,.price-content p,.price-content td,.price-content a,.price-brand,.price-product-name,.price-current,.price-price-label{color:#fafafa !important}.price-copy,.price-footer,.price-eyebrow,.price-product-copy,.price-old,.price-link{color:#c7c7cc !important}.price-product-card,.price-product-card td,.price-image-frame,.price-image-frame td{background-color:#3a3a3c !important;background-image:linear-gradient(#3a3a3c,#3a3a3c) !important}.price-product-card{border-color:#48484a !important}.price-savings{color:#86efac !important}.price-button-cell{background-color:#fafafa !important}.price-button{color:#2c2c2e !important}}</style>' +
    '</head><body class="price-body" style="margin:0;padding:0;background:#f4f4f5;color:#18181b;font-family:Arial,Helvetica,sans-serif">' +
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">' +
    priceMessage +
    '</div><table class="price-page" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f4f4f5"><tr><td class="price-outer" align="center" style="padding:32px 16px">' +
    '<table class="price-shell" role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:640px;max-width:640px;background:#ffffff">' +
    '<tr><td class="price-header" style="padding:28px 44px;border-bottom:1px solid #e4e4e7">' +
    '<p class="price-brand" style="margin:0;color:#18181b;font-size:14px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase">DajaShop</p>' +
    '<p class="price-eyebrow" style="margin:8px 0 0;color:#71717a;font-size:12px;font-weight:700;letter-spacing:0.08em">OBAVEŠTENJE O CENI</p>' +
    '</td></tr><tr><td class="price-content" style="padding:38px 44px">' +
    '<h1 style="margin:0 0 12px;color:#18181b;font-size:28px;line-height:1.2;font-weight:700">' +
    (input.priceDropped ? 'Cena je sada niža.' : 'Cena je ažurirana.') +
    '</h1><p class="price-copy" style="margin:0 0 28px;color:#52525b;font-size:16px;line-height:1.6">' +
    priceMessage +
    '</p>' +
    '<table class="price-product-card" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f4f4f5" style="width:100%;border-collapse:collapse;background-color:#f4f4f5;border:1px solid #e4e4e7"><tr>' +
    '<td class="price-product-media" width="196" valign="top" bgcolor="#f4f4f5" style="width:196px;padding:20px 0 20px 20px;background-color:#f4f4f5">' +
    productAlertImageHtml(input.imageUrl, input.productName) +
    '</td><td class="price-product-info" valign="middle" bgcolor="#f4f4f5" style="padding:22px 24px 22px 22px;background-color:#f4f4f5">' +
    '<p class="price-price-label" style="margin:0 0 8px;color:#71717a;font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase">' +
    priceLabel +
    '</p><h2 class="price-product-name" style="margin:0 0 17px;color:#18181b;font-size:18px;line-height:1.35;font-weight:700">' +
    productName +
    '</h2><p class="price-old" style="margin:0 0 4px;color:#71717a;font-size:14px;line-height:1.4;text-decoration:line-through">' +
    escapeHtml(input.previousPrice) +
    '</p><p class="price-current" style="margin:0;color:#18181b;font-size:28px;line-height:1.2;font-weight:800">' +
    escapeHtml(input.currentPrice) +
    '</p>' +
    savingsBlock +
    '</td></tr></table>' +
    '<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 0"><tr><td class="price-button-cell" align="center" bgcolor="#18181b" style="background-color:#18181b"><a class="price-button" href="' +
    url +
    '" style="display:inline-block;padding:14px 22px;color:#ffffff;font-size:14px;font-weight:700;line-height:1.2;text-decoration:none">' +
    buttonLabel +
    '</a></td></tr></table>' +
    '<p class="price-product-copy" style="margin:20px 0 0;color:#52525b;font-size:14px;line-height:1.65">Otvorite proizvod da proverite trenutnu dostupnost i detalje modela.</p>' +
    '<p class="price-link" style="margin:20px 0 0;color:#71717a;font-size:12px;line-height:1.6">Ako dugme ne radi, kopirajte ovaj link u pregledač:<br><a href="' +
    url +
    '" style="color:#52525b;text-decoration:underline;word-break:break-all">' +
    url +
    '</a></p>' +
    '</td></tr><tr><td class="price-footer" style="padding:20px 44px;border-top:1px solid #e4e4e7;color:#71717a;font-size:12px;line-height:1.55">' +
    'Ovu poruku ste dobili jer ste zatražili obaveštenje o ceni. <a href="' +
    unsubscribeUrl +
    '" style="color:#52525b;text-decoration:underline">Odjavite se jednim klikom</a>.<br>DajaShop' +
    '</td></tr></table></td></tr></table></body></html>'
  );
}

function productAlertImageHtml(imageUrl: string | null, productName: string): string {
  if (imageUrl) {
    return '<img class="price-product-image" src="' +
      escapeHtml(imageUrl) +
      '" alt="' +
      escapeHtml(productName) +
      '" width="176" height="176" style="display:block;width:176px;height:176px;border:0;object-fit:contain" />';
  }
  return '<table class="price-image-frame" role="presentation" width="176" height="176" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff" style="width:176px;height:176px;background-color:#ffffff"><tr><td align="center" valign="middle" bgcolor="#ffffff" style="background-color:#ffffff;color:#71717a;font-size:13px;font-weight:800;letter-spacing:0.12em">DAJASHOP</td></tr></table>';
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

function normalizePhone(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().replace(/[\s()-]/g, '');
  return normalized && /^\+[1-9]\d{7,14}$/.test(normalized)
    ? normalized
    : undefined;
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
