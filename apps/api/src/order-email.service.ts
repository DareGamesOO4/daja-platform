import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@daja/config';
import { CONFIG } from './tokens.js';
import { EmailDeliveryService, type TransactionalEmail } from './email-delivery.service.js';

interface OrderEmailPayload {
  displayId: string;
  customer: Record<string, unknown>;
  items: unknown[];
  subtotal: number;
  discountAmount: number;
  shippingCost: number;
  finalTotal: number;
  currency: string;
  shippingMethod: string;
  paymentMethod: string;
  status: string;
  createdAt: Date | string;
}

@Injectable()
export class OrderEmailService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly delivery: EmailDeliveryService
  ) {}

  async sendOrderCreated(order: OrderEmailPayload): Promise<void> {
    const emails: Promise<void>[] = [
      this.delivery.send(this.adminNewOrderEmail(order))
    ];
    const customerEmail = customerValue(order.customer, 'email');
    if (customerEmail) emails.push(this.delivery.send(this.customerConfirmationEmail(order, customerEmail)));
    await Promise.all(emails);
  }

  async sendStatusUpdate(order: OrderEmailPayload): Promise<void> {
    const customerEmail = customerValue(order.customer, 'email');
    if (!customerEmail) return;
    await this.delivery.send(this.customerStatusEmail(order, customerEmail));
  }

  private customerConfirmationEmail(order: OrderEmailPayload, recipient: string): TransactionalEmail {
    const name = customerName(order.customer);
    const items = orderItems(order);
    const total = formatMoney(order.finalTotal, order.currency);
    const shipping = shippingDetails(order);
    return {
      recipients: [recipient],
      subject: `Potvrda porudžbine #${order.displayId} | DajaShop`,
      text: [
        `Zdravo ${name},`,
        '',
        `Uspešno smo primili vašu porudžbinu #${order.displayId}.`,
        '',
        'Artikli:',
        ...items.map((item) => `- ${item.name} × ${item.quantity} — ${formatMoney(item.total, order.currency)}`),
        '',
        `Ukupno za plaćanje: ${total}`,
        `Isporuka: ${shipping.text}`,
        `Plaćanje: ${paymentLabel(order.paymentMethod)}`,
        '',
        'Obavestićemo vas emailom kada se status porudžbine promeni.',
        'DajaShop'
      ].join('\n'),
      html: emailPage({
        title: 'Porudžbina je primljena',
        introduction: `Zdravo ${escapeHtml(name)}, hvala na poverenju. Uspešno smo primili vašu porudžbinu.`,
        content: orderSummaryHtml(order, items, shipping),
        footer: 'Obavestićemo vas emailom kada se status porudžbine promeni.'
      }),
      tag: 'order-confirmation'
    };
  }

  private adminNewOrderEmail(order: OrderEmailPayload): TransactionalEmail {
    const name = customerName(order.customer);
    const email = customerValue(order.customer, 'email') || 'Nije unet';
    const phone = customerValue(order.customer, 'phone') || 'Nije unet';
    const items = orderItems(order);
    const shipping = shippingDetails(order);
    const recipients = notificationRecipients(
      this.config.ORDER_NOTIFICATION_EMAILS || this.config.SES_REPLY_TO_EMAIL
    );
    return {
      recipients,
      subject: `Nova porudžbina #${order.displayId} — ${formatMoney(order.finalTotal, order.currency)}`,
      text: [
        `Nova porudžbina #${order.displayId}`,
        '',
        `Kupac: ${name}`,
        `Email: ${email}`,
        `Telefon: ${phone}`,
        `Isporuka: ${shipping.text}`,
        `Plaćanje: ${paymentLabel(order.paymentMethod)}`,
        '',
        'Artikli:',
        ...items.map((item) => `- ${item.name} × ${item.quantity} — ${formatMoney(item.total, order.currency)}`),
        '',
        `Ukupno: ${formatMoney(order.finalTotal, order.currency)}`
      ].join('\n'),
      html: emailPage({
        title: `Nova porudžbina #${order.displayId}`,
        introduction: `Kupac ${escapeHtml(name)} je upravo poslao porudžbinu.`,
        content:
          '<section style="margin:24px 0;padding:18px;background:#f7f7f8;border-radius:10px">' +
          `<p style="margin:0 0 8px"><strong>Email:</strong> ${escapeHtml(email)}</p>` +
          `<p style="margin:0 0 8px"><strong>Telefon:</strong> ${escapeHtml(phone)}</p>` +
          `<p style="margin:0"><strong>Isporuka:</strong> ${escapeHtml(shipping.text)}</p>` +
          '</section>' +
          orderSummaryHtml(order, items, shipping),
        footer: 'Porudžbinu možeš pregledati i ažurirati u Admin → Porudžbine.'
      }),
      tag: 'new-order-notification'
    };
  }

  private customerStatusEmail(order: OrderEmailPayload, recipient: string): TransactionalEmail {
    const name = customerName(order.customer);
    const description = statusDescription(order.status);
    return {
      recipients: [recipient],
      subject: `Porudžbina #${order.displayId}: ${order.status} | DajaShop`,
      text: [
        `Zdravo ${name},`,
        '',
        `Status vaše porudžbine #${order.displayId} je promenjen u: ${order.status}.`,
        description,
        '',
        `Ukupan iznos: ${formatMoney(order.finalTotal, order.currency)}`,
        'DajaShop'
      ].join('\n'),
      html: emailPage({
        title: 'Status porudžbine je ažuriran',
        introduction: `Zdravo ${escapeHtml(name)}, status vaše porudžbine <strong>#${escapeHtml(order.displayId)}</strong> je promenjen.`,
        content:
          '<section style="margin:24px 0;padding:20px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px">' +
          `<p style="margin:0 0 6px;color:#166534;font-size:13px;font-weight:700;text-transform:uppercase">Trenutni status</p>` +
          `<p style="margin:0;color:#14532d;font-size:24px;font-weight:700">${escapeHtml(order.status)}</p>` +
          `<p style="margin:10px 0 0;color:#166534;line-height:1.5">${escapeHtml(description)}</p>` +
          '</section>' +
          `<p style="font-size:16px;line-height:1.6"><strong>Ukupan iznos:</strong> ${escapeHtml(formatMoney(order.finalTotal, order.currency))}</p>`,
        footer: 'Ako imate pitanje u vezi porudžbine, odgovorite direktno na ovaj email.'
      }),
      tag: 'order-status-update'
    };
  }
}

function orderSummaryHtml(
  order: OrderEmailPayload,
  items: ReturnType<typeof orderItems>,
  shipping: ReturnType<typeof shippingDetails>
): string {
  const itemRows = items
    .map(
      (item) =>
        '<tr>' +
        `<td style="padding:12px 0;border-bottom:1px solid #ececf0">${escapeHtml(item.name)} × ${item.quantity}</td>` +
        `<td style="padding:12px 0;border-bottom:1px solid #ececf0;text-align:right;font-weight:700">${escapeHtml(formatMoney(item.total, order.currency))}</td>` +
        '</tr>'
    )
    .join('');
  const discount = order.discountAmount > 0
    ? `<tr><td style="padding:8px 0;color:#166534">Popust</td><td style="padding:8px 0;text-align:right;color:#166534">−${escapeHtml(formatMoney(order.discountAmount, order.currency))}</td></tr>`
    : '';
  return (
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:24px 0">' +
    `<thead><tr><th align="left" style="padding:0 0 10px;font-size:14px;color:#6b7280">Porudžbina #${escapeHtml(order.displayId)}</th><th align="right" style="padding:0 0 10px;font-size:14px;color:#6b7280">Iznos</th></tr></thead>` +
    `<tbody>${itemRows}</tbody>` +
    '<tfoot>' +
    `<tr><td style="padding:16px 0 8px;color:#6b7280">Dostava</td><td style="padding:16px 0 8px;text-align:right">${escapeHtml(formatMoney(order.shippingCost, order.currency))}</td></tr>` +
    discount +
    `<tr><td style="padding:12px 0 0;border-top:1px solid #d1d5db;font-size:18px;font-weight:700">Ukupno</td><td style="padding:12px 0 0;border-top:1px solid #d1d5db;text-align:right;font-size:18px;font-weight:700">${escapeHtml(formatMoney(order.finalTotal, order.currency))}</td></tr>` +
    '</tfoot></table>' +
    `<p style="font-size:14px;line-height:1.6;color:#4b5563"><strong>Isporuka:</strong> ${escapeHtml(shipping.text)}<br><strong>Plaćanje:</strong> ${escapeHtml(paymentLabel(order.paymentMethod))}</p>`
  );
}

function emailPage(input: { title: string; introduction: string; content: string; footer: string }): string {
  return (
    '<!doctype html><html lang="sr"><body style="margin:0;background:#f5f5f7;font-family:Arial,sans-serif;color:#171717">' +
    '<main style="max-width:600px;margin:32px auto;background:#fff;padding:40px;border-radius:14px">' +
    `<h1 style="margin:0 0 16px;font-size:26px;line-height:1.2">${input.title}</h1>` +
    `<p style="margin:0;font-size:16px;line-height:1.6">${input.introduction}</p>` +
    input.content +
    `<p style="margin:28px 0 0;font-size:14px;line-height:1.6;color:#6b7280">${input.footer}</p>` +
    '<p style="margin:20px 0 0;font-size:14px;font-weight:700">DajaShop</p>' +
    '</main></body></html>'
  );
}

function orderItems(order: OrderEmailPayload): Array<{ name: string; quantity: number; total: number }> {
  return order.items.map((item) => {
    const record = isRecord(item) ? item : {};
    const quantity = positiveNumber(record.qty ?? record.quantity) || 1;
    const price = nonNegativeNumber(record.price);
    return {
      name: stringValue(record.name) || 'Proizvod',
      quantity,
      total: price * quantity
    };
  });
}

function shippingDetails(order: OrderEmailPayload): { text: string } {
  if (order.shippingMethod === 'pickup') return { text: 'Lično preuzimanje u radnji' };
  const address = [
    customerValue(order.customer, 'address'),
    [customerValue(order.customer, 'postalCode'), customerValue(order.customer, 'city')]
      .filter(Boolean)
      .join(' ')
  ]
    .filter(Boolean)
    .join(', ');
  return { text: address ? `Kurirska isporuka — ${address}` : 'Kurirska isporuka' };
}

function customerName(customer: Record<string, unknown>): string {
  return [customerValue(customer, 'name'), customerValue(customer, 'surname')]
    .filter(Boolean)
    .join(' ') || 'kupče';
}

function paymentLabel(paymentMethod: string): string {
  return paymentMethod === 'cod' ? 'Plaćanje pouzećem' : 'Plaćanje pri preuzimanju';
}

function statusDescription(status: string): string {
  switch (status) {
    case 'Na čekanju':
      return 'Porudžbina je primljena i čeka potvrdu.';
    case 'U obradi':
      return 'Pripremamo vašu porudžbinu.';
    case 'Poslato':
      return 'Porudžbina je poslata kurirskom službom.';
    case 'Isporučeno':
      return 'Porudžbina je uspešno isporučena.';
    case 'Otkazano':
      return 'Porudžbina je otkazana. Za dodatne informacije odgovorite na ovaj email.';
    default:
      return 'Status porudžbine je ažuriran.';
  }
}

function notificationRecipients(value: string): string[] {
  return value.split(',').map((email) => email.trim()).filter(Boolean);
}

function customerValue(customer: Record<string, unknown>, key: string): string {
  return stringValue(customer[key]);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function nonNegativeNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat('sr-RS', {
    style: 'currency',
    currency: currency || 'RSD',
    maximumFractionDigits: 2
  }).format(amount);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
