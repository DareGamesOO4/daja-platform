import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { AppConfig } from '@daja/config';
import type { Logger } from '@daja/observability';
import {
  StorefrontRepository,
  type Database,
  type ProductAlertNotification,
  type ProductAlertSubscription,
  type ProductAlertDeliveryChannel,
  type ProductAlertType
} from '@daja/database';
import { CONFIG, DATABASE, LOGGER } from './tokens.js';
import { EmailDeliveryService } from './email-delivery.service.js';
import { PrivacyService } from './privacy.service.js';
import { SmsDeliveryService } from './sms-delivery.service.js';

type PriceAlertEventKind = 'sale_started' | 'regular_price_drop' | 'regular_price_increase';

interface PriceAlertEvent {
  kind: PriceAlertEventKind;
  previousPriceAmount: number;
  currentPriceAmount: number;
  saleValidFrom?: Date;
  saleValidUntil?: Date;
}

@Injectable()
export class ProductAlertService implements OnModuleInit, OnModuleDestroy {
  private saleStartTimer: NodeJS.Timeout | undefined;
  private dispatchingDueSales = false;
  private dispatchingDueRegularPrices = false;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly delivery: EmailDeliveryService,
    private readonly sms: SmsDeliveryService,
    private readonly privacy: PrivacyService
  ) {}

  onModuleInit(): void {
    void this.dispatchDueRegularPriceChanges();
    void this.dispatchDueSaleStarts();
    this.saleStartTimer = setInterval(() => {
      void this.dispatchDueRegularPriceChanges();
      void this.dispatchDueSaleStarts();
    }, 60_000);
    this.saleStartTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.saleStartTimer) clearInterval(this.saleStartTimer);
  }

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
    await this.dispatchDueRegularPriceChanges();
  }

  async dispatchDueRegularPriceChanges(): Promise<void> {
    if (this.dispatchingDueRegularPrices) return;
    this.dispatchingDueRegularPrices = true;
    try {
      const changes = await new StorefrontRepository(this.database.pool).claimDueRegularPriceAlerts();
      await Promise.all(
        changes.map((change) => this.sendPriceAlertEvent(change.organizationId, change.variantId, {
          kind: change.previousPriceAmount > change.currentPriceAmount
            ? 'regular_price_drop'
            : 'regular_price_increase',
          previousPriceAmount: change.previousPriceAmount,
          currentPriceAmount: change.currentPriceAmount
        }))
      );
    } catch (error) {
      this.logger.error({ err: error }, 'Unable to dispatch due regular price alerts');
    } finally {
      this.dispatchingDueRegularPrices = false;
    }
  }

  async dispatchDueSaleStarts(): Promise<void> {
    if (this.dispatchingDueSales) return;
    this.dispatchingDueSales = true;
    try {
      const sales = await new StorefrontRepository(this.database.pool).claimDueSalePriceAlerts();
      await Promise.all(
        sales.map((sale) => this.sendPriceAlertEvent(sale.organizationId, sale.variantId, {
          kind: 'sale_started',
          previousPriceAmount: sale.regularPriceAmount,
          currentPriceAmount: sale.salePriceAmount,
          saleValidFrom: sale.validFrom,
          saleValidUntil: sale.validUntil
        }))
      );
    } catch (error) {
      this.logger.error({ err: error }, 'Unable to dispatch due sale price alerts');
    } finally {
      this.dispatchingDueSales = false;
    }
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

  private async sendPriceAlertEvent(
    organizationId: string,
    variantId: string,
    event: PriceAlertEvent
  ): Promise<void> {
    const alerts = await new StorefrontRepository(this.database.pool).claimPriceChangeProductAlerts({
      organizationId,
      variantId,
      previousPriceAmount: event.previousPriceAmount,
      currentPriceAmount: event.currentPriceAmount
    });
    await Promise.all(
      alerts.map((alert) => (
        alert.deliveryChannel === 'sms'
          ? this.sendPriceChangeSms(alert, event)
          : this.sendPriceChangeEmail(alert, event)
      ))
    );
  }

  private async sendPriceChangeEmail(
    alert: ProductAlertNotification,
    event: PriceAlertEvent
  ): Promise<void> {
    if (!alert.email) return;
    const name = productName(alert);
    const url = this.productUrl(alert.slug);
    const previousPriceAmount = event.previousPriceAmount;
    const oldPrice = formatMoney(previousPriceAmount, alert.currency);
    const currentPrice = formatMoney(event.currentPriceAmount, alert.currency);
    const priceDropped = previousPriceAmount > event.currentPriceAmount;
    const savings = priceDropped
      ? formatMoney(previousPriceAmount - event.currentPriceAmount, alert.currency)
      : undefined;
    const previousPriceLabel = event.kind === 'sale_started' ? 'Redovna cena' : 'Prethodna cena';
    const currentPriceLabel = event.kind === 'sale_started' ? 'Akcijska cena' : 'Nova cena';
    await this.delivery.send({
      recipients: [alert.email],
      fromEmail: this.fromEmail(),
      subject: priceAlertSubject(event.kind, name),
      text: [
        priceAlertHeading(event.kind, name),
        `${previousPriceLabel}: ${oldPrice}`,
        `${currentPriceLabel}: ${currentPrice}`,
        ...(savings ? [`Ušteda: ${savings}`] : []),
        ...(event.saleValidFrom && event.saleValidUntil
          ? [`Akcija važi od ${formatSaleDate(event.saleValidFrom)} do ${formatSaleDate(event.saleValidUntil)}.`]
          : []),
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
        kind: event.kind,
        ...(event.saleValidFrom ? { saleValidFrom: event.saleValidFrom } : {}),
        ...(event.saleValidUntil ? { saleValidUntil: event.saleValidUntil } : {}),
        url,
        unsubscribeUrl: this.privacy.productAlertUnsubscribeUrl(alert.subscriptionId)
      }),
      tag: event.kind === 'sale_started'
        ? 'product-sale-start'
        : 'product-regular-price-change'
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

  private async sendPriceChangeSms(
    alert: ProductAlertNotification,
    event: PriceAlertEvent
  ): Promise<void> {
    if (!alert.phone) return;
    const name = productName(alert);
    const url = this.productUrl(alert.slug);
    const oldPrice = formatMoney(event.previousPriceAmount, alert.currency);
    const currentPrice = formatMoney(event.currentPriceAmount, alert.currency);
    await this.sms.send({
      phone: alert.phone,
      message: [
        `DajaShop: ${priceAlertHeading(event.kind, name)}`,
        `Pre: ${oldPrice}. Sada: ${currentPrice}.`,
        ...(event.saleValidUntil ? [`Akcija do: ${formatSaleDate(event.saleValidUntil)}.`] : []),
        url,
        `Odjava: ${this.privacy.productAlertUnsubscribeUrl(alert.subscriptionId)}`
      ].join('\n'),
      tag: event.kind === 'sale_started'
        ? 'product-sale-start'
        : 'product-regular-price-change'
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
  kind: PriceAlertEventKind;
  saleValidFrom?: Date;
  saleValidUntil?: Date;
  url: string;
  unsubscribeUrl: string;
}): string {
  const productName = escapeHtml(input.productName);
  const url = escapeHtml(input.url);
  const unsubscribeUrl = escapeHtml(input.unsubscribeUrl);
  const saleStarted = input.kind === 'sale_started';
  const priceDropped = saleStarted || input.kind === 'regular_price_drop';
  const priceMessage = saleStarted
    ? 'Cena koju ste čekali je sada na akciji.'
    : priceDropped
      ? 'Redovna cena proizvoda koji pratite je sada niža.'
      : 'Redovna cena proizvoda koji pratite je upravo ažurirana.';
  const priceLabel = saleStarted
    ? 'AKCIJSKA CENA'
    : priceDropped
      ? 'NOVA, NIŽA REDOVNA CENA'
      : 'NOVA REDOVNA CENA';
  const buttonLabel = saleStarted
    ? 'Pogledajte akcijsku cenu →'
    : priceDropped
      ? 'Pogledajte novu cenu →'
      : 'Pogledajte proizvod →';
  const headline = saleStarted
    ? 'Akcija je počela.'
    : priceDropped
      ? 'Cena je sada niža.'
      : 'Cena je ažurirana.';
  const savingsBlock = input.savings
    ? '<table class="price-savings" role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:16px 0 0"><tr><td bgcolor="#facc15" style="padding:7px 10px;background-color:#facc15;border-radius:3px">' +
      '<p style="margin:0;color:#881337;font-size:12px;font-weight:800;letter-spacing:0.04em">UŠTEDA ' +
      escapeHtml(input.savings) +
      '</p></td></tr></table>'
    : '';
  const urgencyBlock = priceDropped
    ? '<table class="price-drop-badge" role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 16px"><tr><td bgcolor="#facc15" style="padding:7px 10px;background-color:#facc15;border-radius:3px">' +
      '<p style="margin:0;color:#9f1239;font-size:11px;font-weight:800;letter-spacing:0.1em">' +
      (saleStarted ? 'AKCIJA JE POČELA' : 'CENA JE PALA') +
      '</p></td></tr></table>'
    : '';
  const salePeriodBlock = saleStarted && input.saleValidFrom && input.saleValidUntil
    ? '<table class="sale-period" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#881337" style="width:100%;margin:20px 0 0;background-color:#881337"><tr><td bgcolor="#881337" style="padding:16px 18px;background-color:#881337">' +
      '<p style="margin:0 0 8px;color:#facc15;font-size:11px;font-weight:800;letter-spacing:0.1em">TRAJANJE AKCIJE</p>' +
      '<p style="margin:0;color:#ffffff;font-size:14px;line-height:1.55;font-weight:700">Od ' +
      escapeHtml(formatSaleDate(input.saleValidFrom)) +
      '<br>Do ' +
      escapeHtml(formatSaleDate(input.saleValidUntil)) +
      '</p></td></tr></table>'
    : '';
  return (
    '<!doctype html><html lang="sr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">' +
    '<style>:root{color-scheme:light dark;supported-color-schemes:light dark}@media only screen and (max-width:640px){.price-shell{width:100% !important}.price-outer{padding:0 !important}.price-header{padding:24px 20px !important}.price-content{padding:28px 20px !important}.price-footer{padding:20px !important}.price-product-media,.price-product-info{display:block !important;width:auto !important}.price-product-media{padding:20px 20px 0 !important}.price-product-info{padding:18px 20px 24px !important}.price-product-image{width:100% !important;height:220px !important}.price-button{display:block !important;text-align:center !important}.price-link{word-break:break-all !important}}@media (prefers-color-scheme:dark){.price-body,.price-page,.price-outer{background:#27272a !important}.price-shell{background:#2c2c2e !important}.price-header{background:#9f1239 !important;border-color:#facc15 !important}.price-footer{background:#3a3a3c !important;border-color:#48484a !important}.price-product-card{border-color:#fb7185 !important}.price-content h1,.price-content h2,.price-content p,.price-content td,.price-content a,.price-brand,.price-product-name,.price-current,.price-price-label{color:#fafafa !important}.price-copy,.price-footer,.price-eyebrow,.price-product-copy,.price-old,.price-link{color:#fecdd3 !important}.price-product-card,.price-product-card td{background-color:#3a3a3c !important;background-image:linear-gradient(#3a3a3c,#3a3a3c) !important}.price-product-media,.price-image-frame,.price-image-frame td{background-color:#4c1d2f !important;background-image:linear-gradient(#4c1d2f,#4c1d2f) !important}.price-savings td,.price-drop-badge td{background-color:#facc15 !important}.sale-period,.sale-period td{background-color:#881337 !important;background-image:linear-gradient(#881337,#881337) !important}.price-button-cell{background-color:#e11d48 !important}.price-button{color:#ffffff !important}}</style>' +
    '</head><body class="price-body" style="margin:0;padding:0;background:#fff7ed;color:#18181b;font-family:Arial,Helvetica,sans-serif">' +
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">' +
    priceMessage +
    '</div><table class="price-page" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#fff7ed"><tr><td class="price-outer" align="center" style="padding:32px 16px">' +
    '<table class="price-shell" role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:640px;max-width:640px;background:#ffffff">' +
    '<tr><td class="price-header" bgcolor="#e11d48" style="padding:28px 44px;background-color:#e11d48;border-bottom:6px solid #facc15">' +
    '<p class="price-brand" style="margin:0;color:#ffffff;font-size:14px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase">DajaShop</p>' +
    '<p class="price-eyebrow" style="margin:8px 0 0;color:#fef3c7;font-size:12px;font-weight:800;letter-spacing:0.08em">OBAVEŠTENJE O CENI</p>' +
    '</td></tr><tr><td class="price-content" style="padding:38px 44px">' +
    urgencyBlock +
    '<h1 style="margin:0 0 12px;color:#9f1239;font-size:30px;line-height:1.16;font-weight:800">' +
    headline +
    '</h1><p class="price-copy" style="margin:0 0 28px;color:#6b2132;font-size:16px;line-height:1.6">' +
    priceMessage +
    '</p>' +
    '<table class="price-product-card" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#fff7ed" style="width:100%;border-collapse:collapse;background-color:#fff7ed;border:2px solid #fb7185"><tr>' +
    '<td class="price-product-media" width="196" valign="top" bgcolor="#fef3c7" style="width:196px;padding:20px 0 20px 20px;background-color:#fef3c7">' +
    productAlertImageHtml(input.imageUrl, input.productName) +
    '</td><td class="price-product-info" valign="middle" bgcolor="#fff7ed" style="padding:22px 24px 22px 22px;background-color:#fff7ed">' +
    '<p class="price-price-label" style="margin:0 0 8px;color:#be123c;font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase">' +
    priceLabel +
    '</p><h2 class="price-product-name" style="margin:0 0 17px;color:#18181b;font-size:19px;line-height:1.35;font-weight:800">' +
    productName +
    '</h2><p class="price-old" style="margin:0 0 4px;color:#71717a;font-size:14px;line-height:1.4;text-decoration:line-through">' +
    escapeHtml(input.previousPrice) +
    '</p><p class="price-current" style="margin:0;color:#be123c;font-size:32px;line-height:1.15;font-weight:800">' +
    escapeHtml(input.currentPrice) +
    '</p>' +
    savingsBlock +
    '</td></tr></table>' +
    salePeriodBlock +
    '<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:30px 0 0"><tr><td class="price-button-cell" align="center" bgcolor="#e11d48" style="background-color:#e11d48;border-radius:4px"><a class="price-button" href="' +
    url +
    '" style="display:inline-block;padding:15px 24px;color:#ffffff;font-size:15px;font-weight:800;line-height:1.2;text-decoration:none">' +
    buttonLabel +
    '</a></td></tr></table>' +
    '<p class="price-product-copy" style="margin:20px 0 0;color:#6b2132;font-size:14px;line-height:1.65">Otvorite proizvod da proverite trenutnu dostupnost i detalje modela.</p>' +
    '<p class="price-link" style="margin:20px 0 0;color:#8b5e4a;font-size:12px;line-height:1.6">Ako dugme ne radi, kopirajte ovaj link u pregledač:<br><a href="' +
    url +
    '" style="color:#9f1239;text-decoration:underline;word-break:break-all">' +
    url +
    '</a></p>' +
    '</td></tr><tr><td class="price-footer" bgcolor="#fff1f2" style="padding:20px 44px;background-color:#fff1f2;border-top:1px solid #fecdd3;color:#8b5e4a;font-size:12px;line-height:1.55">' +
    'Ovu poruku ste dobili jer ste zatražili obaveštenje o ceni. <a href="' +
    unsubscribeUrl +
    '" style="color:#9f1239;text-decoration:underline">Odjavite se jednim klikom</a>.<br>DajaShop' +
    '</td></tr></table></td></tr></table></body></html>'
  );
}

function priceAlertSubject(kind: PriceAlertEventKind, productName: string): string {
  if (kind === 'sale_started') return `Akcija je počela: ${productName} | DajaShop`;
  if (kind === 'regular_price_drop') return `Cena je niža: ${productName} | DajaShop`;
  return `Nova redovna cena: ${productName} | DajaShop`;
}

function priceAlertHeading(kind: PriceAlertEventKind, productName: string): string {
  if (kind === 'sale_started') return `Akcija za ${productName} je počela.`;
  if (kind === 'regular_price_drop') return `Redovna cena za ${productName} je sada niža.`;
  return `Redovna cena za ${productName} je promenjena.`;
}

function formatSaleDate(value: Date): string {
  return new Intl.DateTimeFormat('sr-RS', {
    timeZone: 'Europe/Belgrade',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(value);
}

function productAlertImageHtml(imageUrl: string | null, productName: string): string {
  if (imageUrl) {
    return '<img class="price-product-image" src="' +
      escapeHtml(imageUrl) +
      '" alt="' +
      escapeHtml(productName) +
      '" width="176" height="176" style="display:block;width:176px;height:176px;border:0;object-fit:contain" />';
  }
  return '<table class="price-image-frame" role="presentation" width="176" height="176" cellspacing="0" cellpadding="0" border="0" bgcolor="#fff7ed" style="width:176px;height:176px;background-color:#fff7ed"><tr><td align="center" valign="middle" bgcolor="#fff7ed" style="background-color:#fff7ed;color:#be123c;font-size:13px;font-weight:800;letter-spacing:0.12em">DAJASHOP</td></tr></table>';
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
