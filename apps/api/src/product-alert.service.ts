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
    const discountPercent = priceDropped && previousPriceAmount > 0
      ? Math.round(((previousPriceAmount - event.currentPriceAmount) / previousPriceAmount) * 100)
      : undefined;
    const previousPriceLabel = event.kind === 'sale_started' ? 'Redovna cena' : 'Prethodna cena';
    const currentPriceLabel = event.kind === 'sale_started' ? 'Akcijska cena' : 'Nova cena';
    const brandUrl = this.brandUrl(alert.brand);
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
        brand: alert.brand,
        model: alert.variantName?.trim() || alert.sku,
        ...(brandUrl ? { brandUrl } : {}),
        emailAssetBaseUrl: this.emailAssetBaseUrl(),
        imageUrl: alert.imageUrl,
        previousPrice: oldPrice,
        currentPrice,
        ...(savings ? { savings } : {}),
        ...(discountPercent ? { discountPercent } : {}),
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

  private brandUrl(brand: string | null): string | undefined {
    const normalizedBrand = brand?.trim();
    if (!normalizedBrand) return undefined;
    return `${this.config.STOREFRONT_PUBLIC_BASE_URL.replace(/\/$/, '')}/catalog?brand=${encodeURIComponent(normalizedBrand)}`;
  }

  private emailAssetBaseUrl(): string {
    return `${this.config.STOREFRONT_PUBLIC_BASE_URL.replace(/\/$/, '')}/images/email`;
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
  brand: string | null;
  model?: string | null;
  brandUrl?: string;
  emailAssetBaseUrl: string;
  imageUrl: string | null;
  previousPrice: string;
  currentPrice: string;
  savings?: string;
  discountPercent?: number;
  kind: PriceAlertEventKind;
  saleValidFrom?: Date;
  saleValidUntil?: Date;
  url: string;
  unsubscribeUrl: string;
}): string {
  const productName = escapeHtml(input.productName);
  const brand = input.brand?.trim() ? escapeHtml(input.brand.trim()) : '';
  const model = input.model?.trim() ? escapeHtml(input.model.trim()) : '';
  const url = escapeHtml(input.url);
  const brandUrl = input.brandUrl ? escapeHtml(input.brandUrl) : '';
  const emailAssetBaseUrl = escapeHtml(input.emailAssetBaseUrl.replace(/\/$/, ''));
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
  const buttonLabel = 'POGLEDAJ ARTIKAL →';
  const headline = saleStarted
    ? 'Dobra vest! 🎉'
    : priceDropped
      ? 'Dobra vest! 🎉'
      : 'Cena je ažurirana.';
  const brandBadge = brand
    ? '<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 13px"><tr><td bgcolor="#eef1f5" style="padding:6px 10px;background-color:#eef1f5;border-radius:7px">' +
      (brandUrl
        ? '<a href="' + brandUrl + '" style="color:#4b5563;font-size:11px;font-weight:800;letter-spacing:0.06em;text-decoration:none">' + brand + '</a>'
        : '<p style="margin:0;color:#4b5563;font-size:11px;font-weight:800;letter-spacing:0.06em">' + brand + '</p>') +
      '</td></tr></table>'
    : '';
  const modelBlock = model
    ? '<p class="price-model" style="margin:0 0 20px;color:#6b7280;font-size:20px;line-height:1.3;font-weight:400">' + model + '</p>'
    : '';
  const heroCopy = saleStarted
    ? 'Artikal koji pratite je sada <strong style="color:#e30613">na akciji.</strong>'
    : priceDropped
      ? 'Cena artikla koji pratite je sada <strong style="color:#e30613">niža.</strong>'
      : 'Redovna cena artikla koji pratite je upravo ažurirana.';
  const savingsBlock = input.savings
    ? '<tr><td class="price-savings" colspan="' + (input.discountPercent ? '2' : '1') + '" bgcolor="#f7f8fc" style="padding:0 14px 14px;background-color:#f7f8fc">' +
      '<p style="margin:0;color:#16853a;font-size:11px;font-weight:800;letter-spacing:0.04em">◇ UŠTEDA: ' +
      escapeHtml(input.savings) +
      '</p></td></tr>'
    : '';
  const discountBlock = input.discountPercent
    ? '<td class="price-discount-cell" align="center" valign="middle" width="82" bgcolor="#f7f8fc" style="width:82px;padding:12px 10px 12px 0;background-color:#f7f8fc"><table class="price-discount" role="presentation" width="72" height="66" cellspacing="0" cellpadding="0" border="0" bgcolor="#e30613" style="width:72px;height:66px;background-color:#e30613;border-radius:8px"><tr><td align="center" valign="middle" bgcolor="#e30613" style="width:72px;height:66px;background-color:#e30613;border-radius:8px">' +
      '<p style="margin:0;color:#ffffff;font-size:20px;line-height:1;font-weight:800">-' +
      input.discountPercent +
      '%</p><p style="margin:5px 0 0;color:#ffffff;font-size:10px;line-height:1;font-weight:800;letter-spacing:0.05em">' +
      (saleStarted ? 'POPUST' : 'NIŽA CENA') +
      '</p></td></tr></table></td>'
    : '';
  const urgencyBlock = priceDropped
    ? '<table class="price-drop-badge" role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto 16px"><tr><td bgcolor="#fdebed" style="padding:7px 10px;background-color:#fdebed;border-radius:14px">' +
      '<p style="margin:0;color:#e30613;font-size:11px;font-weight:800;letter-spacing:0.1em">' +
      (saleStarted ? 'AKCIJA JE POČELA' : 'CENA JE PALA') +
      '</p></td></tr></table>'
    : '';
  const salePeriodBlock = saleStarted && input.saleValidFrom && input.saleValidUntil
    ? '<p class="price-sale-period" style="margin:12px 0 0;color:#71717a;font-size:11px;line-height:1.45">Akcija traje od ' +
      escapeHtml(formatSaleDate(input.saleValidFrom)) +
      ' do ' +
      escapeHtml(formatSaleDate(input.saleValidUntil)) +
      '.</p>'
    : '';
  const hasGShockFeatures = /g[-\s]?shock|(?:^|\s)ga-/i.test(`${input.productName} ${input.model ?? ''}`);
  const productFeatureBlock = hasGShockFeatures
    ? '<tr><td class="price-product-features" style="padding:0 20px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-top:1px solid #eceef1"><tr>' +
      '<td class="price-product-feature" width="24%" valign="top" style="width:24%;padding:15px 7px 13px"><img src="' + emailAssetBaseUrl + '/feature-water.svg" alt="" width="19" height="19" style="display:block;width:19px;height:19px;border:0;margin:0 0 5px" /><p style="margin:0;color:#27272a;font-size:9px;line-height:1.35">Vodootporan<br>do 200m</p></td>' +
      '<td class="price-product-feature-divider" width="1" valign="middle" style="width:1px;padding:0"><table role="presentation" width="1" height="28" cellspacing="0" cellpadding="0" border="0" style="width:1px;height:28px"><tr><td bgcolor="#e1e3e8" style="width:1px;height:28px;background-color:#e1e3e8;font-size:0;line-height:0">&nbsp;</td></tr></table></td>' +
      '<td class="price-product-feature" width="24%" valign="top" style="width:24%;padding:15px 7px 13px"><img src="' + emailAssetBaseUrl + '/feature-light.svg" alt="" width="19" height="19" style="display:block;width:19px;height:19px;border:0;margin:0 0 5px" /><p style="margin:0;color:#27272a;font-size:9px;line-height:1.35">LED<br>osvetljenje</p></td>' +
      '<td class="price-product-feature-divider" width="1" valign="middle" style="width:1px;padding:0"><table role="presentation" width="1" height="28" cellspacing="0" cellpadding="0" border="0" style="width:1px;height:28px"><tr><td bgcolor="#e1e3e8" style="width:1px;height:28px;background-color:#e1e3e8;font-size:0;line-height:0">&nbsp;</td></tr></table></td>' +
      '<td class="price-product-feature" width="24%" valign="top" style="width:24%;padding:15px 7px 13px"><img src="' + emailAssetBaseUrl + '/feature-battery.svg" alt="" width="19" height="19" style="display:block;width:19px;height:19px;border:0;margin:0 0 5px" /><p style="margin:0;color:#27272a;font-size:9px;line-height:1.35">Dug vek<br>trajanja baterije</p></td>' +
      '<td class="price-product-feature-divider" width="1" valign="middle" style="width:1px;padding:0"><table role="presentation" width="1" height="28" cellspacing="0" cellpadding="0" border="0" style="width:1px;height:28px"><tr><td bgcolor="#e1e3e8" style="width:1px;height:28px;background-color:#e1e3e8;font-size:0;line-height:0">&nbsp;</td></tr></table></td>' +
      '<td class="price-product-feature" width="24%" valign="top" style="width:24%;padding:15px 7px 13px"><img src="' + emailAssetBaseUrl + '/feature-protection.svg" alt="" width="19" height="19" style="display:block;width:19px;height:19px;border:0;margin:0 0 5px" /><p style="margin:0;color:#27272a;font-size:9px;line-height:1.35">Otporan na<br>udarce</p></td>' +
      '</tr></table></td></tr>'
    : '';
  const benefitsBlock =
    '<table class="price-benefits" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f8f8fa" style="width:100%;margin:30px 0 0;background-color:#f8f8fa;border-radius:10px;overflow:hidden"><tr>' +
    '<td class="price-benefit" width="24%" valign="top" style="width:24%;padding:16px 10px 14px">' +
    '<img src="' + emailAssetBaseUrl + '/benefit-delivery.svg" alt="" width="20" height="20" style="display:block;width:20px;height:20px;border:0;margin:0 0 8px" /><p class="price-benefit-title" style="margin:0;color:#111111;font-size:10px;line-height:1.25;font-weight:800">Besplatna dostava</p><p class="price-benefit-copy" style="margin:4px 0 0;color:#52525b;font-size:10px;line-height:1.35">za porudžbine<br>preko 5.000 RSD</p></td>' +
    '<td class="price-benefit-divider" width="1" valign="middle" style="width:1px;padding:0"><table role="presentation" width="1" height="44" cellspacing="0" cellpadding="0" border="0" style="width:1px;height:44px"><tr><td bgcolor="#e1e3e8" style="width:1px;height:44px;background-color:#e1e3e8;font-size:0;line-height:0">&nbsp;</td></tr></table></td>' +
    '<td class="price-benefit" width="24%" valign="top" style="width:24%;padding:16px 10px 14px">' +
    '<img src="' + emailAssetBaseUrl + '/benefit-warranty.svg" alt="" width="20" height="20" style="display:block;width:20px;height:20px;border:0;margin:0 0 8px" /><p class="price-benefit-title" style="margin:0;color:#111111;font-size:10px;line-height:1.25;font-weight:800">2 godine garancije</p><p class="price-benefit-copy" style="margin:4px 0 0;color:#52525b;font-size:10px;line-height:1.35">na sve naše<br>proizvode</p></td>' +
    '<td class="price-benefit-divider" width="1" valign="middle" style="width:1px;padding:0"><table role="presentation" width="1" height="44" cellspacing="0" cellpadding="0" border="0" style="width:1px;height:44px"><tr><td bgcolor="#e1e3e8" style="width:1px;height:44px;background-color:#e1e3e8;font-size:0;line-height:0">&nbsp;</td></tr></table></td>' +
    '<td class="price-benefit" width="24%" valign="top" style="width:24%;padding:16px 10px 14px">' +
    '<img src="' + emailAssetBaseUrl + '/benefit-return.svg" alt="" width="20" height="20" style="display:block;width:20px;height:20px;border:0;margin:0 0 8px" /><p class="price-benefit-title" style="margin:0;color:#111111;font-size:10px;line-height:1.25;font-weight:800">Jednostavan povrat</p><p class="price-benefit-copy" style="margin:4px 0 0;color:#52525b;font-size:10px;line-height:1.35">14 dana pravo na<br>povrat</p></td>' +
    '<td class="price-benefit-divider" width="1" valign="middle" style="width:1px;padding:0"><table role="presentation" width="1" height="44" cellspacing="0" cellpadding="0" border="0" style="width:1px;height:44px"><tr><td bgcolor="#e1e3e8" style="width:1px;height:44px;background-color:#e1e3e8;font-size:0;line-height:0">&nbsp;</td></tr></table></td>' +
    '<td class="price-benefit" width="24%" valign="top" style="width:24%;padding:16px 10px 14px">' +
    '<img src="' + emailAssetBaseUrl + '/benefit-support.svg" alt="" width="20" height="20" style="display:block;width:20px;height:20px;border:0;margin:0 0 8px" /><p class="price-benefit-title" style="margin:0;color:#111111;font-size:10px;line-height:1.25;font-weight:800">Korisnička podrška</p><p class="price-benefit-copy" style="margin:4px 0 0;color:#52525b;font-size:10px;line-height:1.35">Tu smo za vas<br>svakog dana</p></td>' +
    '</tr></table>';
  const communityBlock =
    '<table class="price-community" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:20px 0 0"><tr><td align="center">' +
    '<p style="margin:0;color:#27272a;font-size:15px;line-height:1.4">Hvala što ste deo DajaShop zajednice!</p>' +
    '<p class="price-social-copy" style="margin:12px 0 8px;color:#52525b;font-size:11px;line-height:1.4">Pratite nas</p>' +
    '<table role="presentation" align="center" cellspacing="0" cellpadding="0" border="0"><tr>' +
    '<td style="padding:0 6px"><a href="https://facebook.com" aria-label="Facebook" style="display:block;width:22px;height:22px;background-color:#111111;border-radius:11px;color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:800;line-height:22px;text-align:center;text-decoration:none">f</a></td>' +
    '<td style="padding:0 6px"><a href="https://instagram.com" aria-label="Instagram" style="display:block;width:22px;height:22px;background-color:#111111;border-radius:11px;color:#ffffff;font-family:Arial,sans-serif;font-size:14px;font-weight:800;line-height:22px;text-align:center;text-decoration:none">◎</a></td>' +
    '<td style="padding:0 6px"><a href="https://youtube.com" aria-label="YouTube" style="display:block;width:22px;height:22px;background-color:#111111;border-radius:11px;color:#ffffff;font-family:Arial,sans-serif;font-size:11px;font-weight:800;line-height:22px;text-align:center;text-decoration:none">▶</a></td>' +
    '</tr></table></td></tr></table>';
  return (
    '<!doctype html><html lang="sr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">' +
    '<style>:root{color-scheme:light dark;supported-color-schemes:light dark}@media only screen and (max-width:640px){.price-shell{width:100% !important}.price-outer{padding:0 !important}.price-header{padding:24px 20px 8px !important}.price-content{padding:28px 20px !important}.price-footer{padding:20px !important}.price-product-top{padding:18px 16px 0 !important}.price-product-media,.price-product-info{display:block !important;width:auto !important}.price-product-media{padding:12px 0 6px !important}.price-product-info{padding:18px 4px 20px !important}.price-image-frame{width:220px !important;height:240px !important}.price-product-image{width:190px !important;height:226px !important}.price-button{display:block !important;text-align:center !important}.price-link{word-break:break-all !important}.price-product-feature{display:block !important;width:auto !important;padding-left:10px !important;border-bottom:1px solid #e5e7eb !important}.price-product-feature-divider,.price-benefit-divider{display:none !important}.price-product-feature:last-child,.price-benefit:last-child{border-bottom:0 !important}.price-benefit{display:block !important;width:auto !important;border-right:0 !important;border-bottom:1px solid #e5e7eb !important}}@media (prefers-color-scheme:dark){.price-body,.price-page,.price-outer{background:#27272a !important}.price-shell,.price-header{background:#2c2c2e !important}.price-footer{background:#353538 !important;border-color:#48484a !important}.price-product-card{border-color:#48484a !important}.price-content h1,.price-content h2,.price-content p,.price-content td,.price-content a,.price-brand,.price-product-name,.price-current,.price-price-label{color:#fafafa !important}.price-copy,.price-footer,.price-eyebrow,.price-product-copy,.price-old,.price-link,.price-sale-period{color:#d4d4d8 !important}.price-product-card,.price-product-card td,.price-product-media,.price-image-frame,.price-image-frame td,.price-summary,.price-summary td,.price-benefits,.price-benefits td{background-color:#3a3a3c !important;background-image:linear-gradient(#3a3a3c,#3a3a3c) !important}.price-benefit-copy,.price-social-copy{color:#d4d4d8 !important}.price-savings{background-color:#3a3a3c !important}.price-savings p{color:#b8f0c7 !important}.price-drop-badge td{background-color:#4d1c24 !important}.price-discount,.price-discount td,.price-button-cell{background-color:#e30613 !important}.price-button{color:#ffffff !important}}</style>' +
    '</head><body class="price-body" style="margin:0;padding:0;background:#f7f7f8;color:#18181b;font-family:Arial,Helvetica,sans-serif">' +
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">' +
    priceMessage +
    '</div><table class="price-page" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f7f7f8"><tr><td class="price-outer" align="center" style="padding:32px 16px">' +
    '<table class="price-shell" role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:640px;max-width:640px;background:#ffffff">' +
    '<tr><td class="price-header" align="center" bgcolor="#ffffff" style="padding:26px 44px 8px;background-color:#ffffff">' +
    '<table role="presentation" align="center" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" valign="middle" bgcolor="#fdebed" style="width:46px;height:46px;background-color:#fdebed;border-radius:23px"><p style="margin:0;color:#e30613;font-size:20px;line-height:46px">🔔</p></td></tr></table>' +
    '<p class="price-brand" style="margin:14px 0 0;color:#111111;font-size:14px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase">DajaShop</p>' +
    '<p class="price-eyebrow" style="margin:7px 0 0;color:#6b7280;font-size:11px;font-weight:800;letter-spacing:0.08em">OBAVEŠTENJE O CENI</p>' +
    '</td></tr><tr><td class="price-content" align="center" style="padding:24px 44px 38px">' +
    urgencyBlock +
    '<h1 style="margin:0 0 8px;color:#111111;font-size:30px;line-height:1.16;font-weight:800">' +
    headline +
    '</h1><p class="price-copy" style="margin:0 0 28px;color:#52525b;font-size:16px;line-height:1.6">' +
    heroCopy +
    '</p>' +
    '<table class="price-product-card" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#ffffff" style="width:100%;border-collapse:collapse;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden"><tr><td class="price-product-top" style="padding:24px 24px 0">' +
    '<table class="price-product-detail" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%"><tr>' +
    '<td class="price-product-media" width="214" align="center" valign="middle" bgcolor="#ffffff" style="width:214px;padding:20px 0 20px 20px;background-color:#ffffff;border-radius:16px 0 0 16px">' +
    '<table class="price-image-frame" role="presentation" width="188" height="230" cellspacing="0" cellpadding="0" border="0" bgcolor="#f8f9fb" style="width:188px;height:230px;background-color:#f8f9fb;border-radius:12px"><tr><td align="center" valign="middle" bgcolor="#f8f9fb" style="background-color:#f8f9fb;border-radius:12px">' +
    productAlertImageHtml(input.imageUrl, input.productName) +
    '</td></tr></table></td><td class="price-product-info" valign="middle" bgcolor="#ffffff" style="padding:28px 26px 28px 20px;background-color:#ffffff;border-radius:0 16px 16px 0">' +
    brandBadge +
    '<h2 class="price-product-name" style="margin:0 0 4px;color:#111111;font-size:24px;line-height:1.2;font-weight:800">' +
    productName +
    '</h2>' +
    modelBlock +
    '<table class="price-summary" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f7f8fc" style="width:100%;background-color:#f7f8fc;border:1px solid #edf0f4;border-radius:10px;overflow:hidden"><tr><td class="price-summary-main" valign="middle" bgcolor="#f7f8fc" style="padding:16px 14px;background-color:#f7f8fc;border-radius:10px 0 0 10px">' +
    '<p class="price-old-label" style="margin:0 0 4px;color:#737782;font-size:10px;font-weight:800;letter-spacing:0.05em">STARA CENA</p>' +
    '<p class="price-old" style="margin:0 0 15px;color:#71717a;font-size:17px;line-height:1.2;text-decoration:line-through">' +
    escapeHtml(input.previousPrice) +
    '</p><p class="price-price-label" style="margin:0 0 4px;color:#e30613;font-size:10px;font-weight:800;letter-spacing:0.05em;text-transform:uppercase">' +
    priceLabel +
    '</p><p class="price-current" style="margin:0;color:#111111;font-size:30px;line-height:1.12;font-weight:800">' +
    escapeHtml(input.currentPrice) +
    '</p></td>' +
    discountBlock +
    '</tr>' +
    savingsBlock +
    '</table>' +
    '</td></tr></table></td></tr>' +
    productFeatureBlock +
    '<tr><td class="price-product-action" align="center" style="padding:18px 24px 16px"><table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto"><tr><td class="price-button-cell" align="center" bgcolor="#e30613" style="background-color:#e30613;border-radius:6px"><a class="price-button" href="' +
    url +
    '" style="display:inline-block;padding:15px 24px;color:#ffffff;font-size:15px;font-weight:800;line-height:1.2;text-decoration:none">' +
    buttonLabel +
    '</a></td></tr></table>' +
    salePeriodBlock +
    '</td></tr></table>' +
    benefitsBlock +
    communityBlock +
    '</td></tr><tr><td class="price-footer" bgcolor="#fafafa" style="padding:20px 44px;background-color:#fafafa;border-top:1px solid #e5e7eb;color:#71717a;font-size:12px;line-height:1.55">' +
    'Ovu poruku ste dobili jer ste zatražili obaveštenje o ceni. <a href="' +
    unsubscribeUrl +
    '" style="color:#e30613;text-decoration:underline">Odjavite se jednim klikom</a>.<br>DajaShop' +
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
      '" width="188" height="226" style="display:block;width:188px;height:226px;border:0;margin:0 auto;border-radius:10px;object-fit:contain" />';
  }
  return '<p style="margin:0;color:#e30613;font-size:13px;font-weight:800;letter-spacing:0.12em">DAJASHOP</p>';
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
