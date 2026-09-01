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

@Injectable()
export class ProductAlertService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database,
    private readonly delivery: EmailDeliveryService
  ) {}

  subscribe(input: {
    organizationId: string;
    productId: string;
    variantId: string;
    customerId?: string | null;
    email: string;
    type: ProductAlertType;
  }): Promise<ProductAlertSubscription> {
    return new StorefrontRepository(this.database.pool).subscribeProductAlert(input);
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
        `Pogledajte proizvod: ${url}`
      ].join('\n'),
      html: emailPage({
        title: 'Ponovo je na stanju',
        introduction: `Sat <strong>${escapeHtml(name)}</strong>, za koji ste tražili obaveštenje, ponovo je dostupan.`,
        price: formatMoney(alert.currentPriceAmount, alert.currency),
        buttonLabel: 'Pogledajte proizvod',
        url
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
        `Pogledajte proizvod: ${url}`
      ].join('\n'),
      html: emailPage({
        title: 'Cena je promenjena',
        introduction: `Cena za sat <strong>${escapeHtml(name)}</strong>, za koji ste tražili obaveštenje, je ažurirana.`,
        oldPrice,
        price: currentPrice,
        buttonLabel: 'Pogledajte proizvod',
        url
      }),
      tag: 'product-price-change'
    });
  }

  private productUrl(slug: string): string {
    return `${this.config.STOREFRONT_PUBLIC_BASE_URL.replace(/\/$/, '')}/product/${encodeURIComponent(slug)}`;
  }

  private fromEmail(): string {
    return 'DajaShop <novosti@dajashop.rs>';
  }
}

function emailPage(input: {
  title: string;
  introduction: string;
  price: string;
  oldPrice?: string;
  buttonLabel: string;
  url: string;
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
    '<p style="margin:28px 0 0;font-size:14px;color:#666">DajaShop</p></main></body></html>'
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
