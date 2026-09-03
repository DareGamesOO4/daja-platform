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
  promoCode?: string | null;
  shippingMethod: string;
  paymentMethod: string;
  status: string;
  createdAt: Date | string;
}

interface OrderItem {
  name: string;
  brand: string;
  quantity: number;
  price: number;
  total: number;
  image: string;
}

interface ShippingDetails {
  text: string;
  method: string;
  address: string;
}

interface StatusPresentation {
  title: string;
  description: string;
  color: string;
  border: string;
  background: string;
  step: number | null;
}

@Injectable()
export class OrderEmailService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly delivery: EmailDeliveryService
  ) {}

  async sendOrderCreated(order: OrderEmailPayload): Promise<void> {
    const emails: Promise<void>[] = [this.delivery.send(this.adminNewOrderEmail(order))];
    const customerEmail = customerValue(order.customer, 'email');
    if (customerEmail) {
      emails.push(this.delivery.send(this.customerConfirmationEmail(order, customerEmail)));
    }
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
    const shipping = shippingDetails(order);
    return {
      recipients: [recipient],
      fromEmail: this.orderFromEmail(),
      subject: 'Potvrda porudžbine #' + order.displayId + ' | DajaShop',
      text: customerOrderText({
        heading: 'Hvala, porudžbina #' + order.displayId + ' je primljena.',
        name,
        order,
        items,
        shipping,
        footer: 'Obavestićemo vas emailom kada se status porudžbine promeni.'
      }),
      html: emailPage({
        eyebrow: 'PORUDŽBINA #' + escapeHtml(order.displayId),
        title: 'Hvala, porudžbina je primljena.',
        introduction:
          'Zdravo ' +
          escapeHtml(name) +
          ', hvala na poverenju. Pripremićemo porudžbinu i obavestiti vas o svakoj promeni statusa.',
        content:
          orderStatusHtml(order) +
          orderDetailsHtml(order, shipping) +
          orderSummaryHtml(order, items),
        footer:
          'Sačuvajte ovaj email kao potvrdu porudžbine. Za sva pitanja odgovorite direktno na ovu poruku.'
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
      this.config.ORDER_NOTIFICATION_EMAILS ||
        this.config.SES_REPLY_TO_EMAIL ||
        this.config.STOREFRONT_ADMIN_EMAILS
    );
    return {
      recipients,
      fromEmail: this.orderFromEmail(),
      subject:
        'Nova porudžbina #' +
        order.displayId +
        ' — ' +
        formatMoney(order.finalTotal, order.currency),
      text: adminOrderText(order, items, shipping, { name, email, phone }),
      html: emailPage({
        eyebrow: 'NOVA PORUDŽBINA — ZA OBRADU',
        title: 'Porudžbina #' + escapeHtml(order.displayId),
        introduction:
          'Kupac <strong>' +
          escapeHtml(name) +
          '</strong> je upravo poslao porudžbinu. Ispod su svi podaci potrebni za obradu.',
        content:
          adminCustomerHtml(order, shipping, { name, email, phone }) +
          orderStatusHtml(order) +
          orderSummaryHtml(order, items),
        footer: 'Porudžbinu možeš pregledati i ažurirati u Admin → Porudžbine.'
      }),
      tag: 'new-order-notification'
    };
  }

  private customerStatusEmail(order: OrderEmailPayload, recipient: string): TransactionalEmail {
    const name = customerName(order.customer);
    const items = orderItems(order);
    const shipping = shippingDetails(order);
    return {
      recipients: [recipient],
      fromEmail: this.orderFromEmail(),
      subject: 'Porudžbina #' + order.displayId + ': ' + order.status + ' | DajaShop',
      text: customerOrderText({
        heading:
          'Status porudžbine #' + order.displayId + ' je ažuriran: ' + order.status + '.',
        name,
        order,
        items,
        shipping,
        footer: statusPresentation(order.status).description
      }),
      html: emailPage({
        eyebrow: 'PORUDŽBINA #' + escapeHtml(order.displayId),
        title: 'Status porudžbine je ažuriran.',
        introduction:
          'Zdravo ' +
          escapeHtml(name) +
          ', status vaše porudžbine je promenjen. Ispod možete videti trenutno stanje i kompletan pregled porudžbine.',
        content:
          orderStatusHtml(order) +
          orderDetailsHtml(order, shipping) +
          orderSummaryHtml(order, items),
        footer: 'Ako imate pitanje u vezi porudžbine, odgovorite direktno na ovaj email.'
      }),
      tag: 'order-status-update'
    };
  }

  private orderFromEmail(): string {
    const configuredSender = this.config.SES_ORDER_FROM_EMAIL || this.config.SES_FROM_EMAIL;
    const address = rawEmailAddress(configuredSender);
    return address ? 'DajaShop <' + address + '>' : configuredSender;
  }
}

function orderSummaryHtml(order: OrderEmailPayload, items: OrderItem[]): string {
  const itemRows = items
    .map((item) => {
      const brand = item.brand
        ? '<p style="margin:0 0 3px;color:#71717a;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase">' +
          escapeHtml(item.brand) +
          '</p>'
        : '';
      const unitPrice =
        item.quantity > 1
          ? '<p style="margin:4px 0 0;color:#71717a;font-size:12px">' +
            escapeHtml(formatMoney(item.price, order.currency)) +
            ' po komadu</p>'
          : '';
      return (
        '<tr><td style="padding:15px 0;border-bottom:1px solid #e4e4e7">' +
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>' +
        '<td width="72" valign="top" style="width:72px;padding-right:14px">' +
        productImageHtml(item) +
        '</td>' +
        '<td valign="top" style="padding-right:10px">' +
        brand +
        '<p style="margin:0;color:#18181b;font-size:14px;line-height:1.4;font-weight:700">' +
        escapeHtml(item.name) +
        '</p>' +
        '<p style="margin:4px 0 0;color:#52525b;font-size:13px">Količina: ' +
        escapeHtml(String(item.quantity)) +
        '</p>' +
        unitPrice +
        '</td>' +
        '<td valign="top" align="right" style="white-space:nowrap;color:#18181b;font-size:14px;font-weight:700">' +
        escapeHtml(formatMoney(item.total, order.currency)) +
        '</td>' +
        '</tr></table></td></tr>'
      );
    })
    .join('');
  const hasPromotion = Boolean(order.promoCode) || order.discountAmount > 0;
  const promotionLabel = order.promoCode
    ? '<code style="border:1px solid #bbf7d0;border-radius:5px;background:#f0fdf4;padding:3px 6px;color:#166534;font-family:Arial,sans-serif;font-size:12px;font-weight:700">' +
      escapeHtml(order.promoCode) +
      '</code>'
    : 'Popust';
  const promotionValue =
    order.discountAmount > 0
      ? '−' + escapeHtml(formatMoney(order.discountAmount, order.currency))
      : 'Besplatna dostava';
  const promotionRow = hasPromotion
    ? '<tr>' +
      '<td style="padding:9px 0;color:#166534;font-size:14px">Promo kod: ' +
      promotionLabel +
      '</td>' +
      '<td align="right" style="padding:9px 0;color:#166534;font-size:14px;font-weight:700">' +
      promotionValue +
      '</td>' +
      '</tr>'
    : '';
  const shippingValue =
    order.shippingCost === 0 ? 'Besplatna' : escapeHtml(formatMoney(order.shippingCost, order.currency));
  return (
    '<section style="margin:24px 0;border:1px solid #e4e4e7;border-radius:14px;background:#ffffff;padding:22px">' +
    '<p style="margin:0 0 14px;color:#18181b;font-size:16px;font-weight:700">Artikli u porudžbini</p>' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse">' +
    '<tbody>' +
    itemRows +
    '</tbody><tfoot>' +
    '<tr><td style="padding:16px 0 8px;color:#71717a;font-size:14px">Međuzbir</td>' +
    '<td align="right" style="padding:16px 0 8px;color:#18181b;font-size:14px;font-weight:700">' +
    escapeHtml(formatMoney(order.subtotal, order.currency)) +
    '</td></tr>' +
    '<tr><td style="padding:8px 0;color:#71717a;font-size:14px">Dostava</td>' +
    '<td align="right" style="padding:8px 0;color:#18181b;font-size:14px;font-weight:700">' +
    shippingValue +
    '</td></tr>' +
    promotionRow +
    '<tr><td style="padding:16px 0 0;border-top:1px solid #d4d4d8;color:#18181b;font-size:18px;font-weight:800">Ukupno</td>' +
    '<td align="right" style="padding:16px 0 0;border-top:1px solid #d4d4d8;color:#18181b;font-size:18px;font-weight:800">' +
    escapeHtml(formatMoney(order.finalTotal, order.currency)) +
    '</td></tr>' +
    '</tfoot></table></section>'
  );
}

function productImageHtml(item: OrderItem): string {
  if (!item.image) {
    return '<div class="product-image" style="width:64px;height:64px;border-radius:10px;background:#f4f4f5;color:#71717a;font-size:12px;line-height:64px;text-align:center">D</div>';
  }
  return (
    '<img class="product-image" src="' +
    escapeHtml(item.image) +
    '" alt="' +
    escapeHtml(item.name) +
    '" width="64" height="64" style="display:block;width:64px;height:64px;border:0;border-radius:10px;object-fit:cover;background:#f4f4f5" />'
  );
}

function orderStatusHtml(order: OrderEmailPayload): string {
  const status = statusPresentation(order.status);
  const progress = status.step === null ? '' : statusProgressHtml(status.step, status.color);
  return (
    '<section style="margin:24px 0;padding:20px;border:1px solid ' +
    status.border +
    ';border-radius:14px;background:' +
    status.background +
    '">' +
    '<p style="margin:0 0 8px;color:' +
    status.color +
    ';font-size:11px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase">Trenutni status</p>' +
    '<p style="margin:0;color:#18181b;font-size:22px;line-height:1.25;font-weight:800">' +
    escapeHtml(order.status) +
    '</p>' +
    '<p style="margin:8px 0 0;color:#3f3f46;font-size:14px;line-height:1.55">' +
    escapeHtml(status.description) +
    '</p>' +
    progress +
    '</section>'
  );
}

function statusProgressHtml(currentStep: number, color: string): string {
  const steps = ['Primljena', 'Obrada', 'Poslata', 'Isporučena'];
  const dots = steps
    .map((label, index) => {
      const active = index <= currentStep;
      const dotColor = active ? color : '#d4d4d8';
      const labelColor = active ? '#3f3f46' : '#a1a1aa';
      return (
        '<td align="center" style="width:25%;padding:0 2px">' +
        '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' +
        dotColor +
        ';font-size:0;line-height:0">&nbsp;</span>' +
        '<p style="margin:5px 0 0;color:' +
        labelColor +
        ';font-size:10px;line-height:1.2">' +
        label +
        '</p></td>'
      );
    })
    .join('');
  return (
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:18px;border-top:1px solid rgba(24,24,27,0.1);padding-top:14px"><tr>' +
    dots +
    '</tr></table>'
  );
}

function orderDetailsHtml(order: OrderEmailPayload, shipping: ShippingDetails): string {
  return (
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0;border-collapse:separate;border-spacing:8px">' +
    '<tr>' +
    detailCell('Broj porudžbine', '#' + order.displayId) +
    detailCell('Datum', formatOrderDate(order.createdAt)) +
    '</tr><tr>' +
    detailCell('Isporuka', shipping.text) +
    detailCell('Plaćanje', paymentLabel(order.paymentMethod)) +
    '</tr></table>'
  );
}

function adminCustomerHtml(
  order: OrderEmailPayload,
  shipping: ShippingDetails,
  customer: { name: string; email: string; phone: string }
): string {
  const safeEmail = emailLink(customer.email);
  const contact =
    safeEmail +
    (customer.phone && customer.phone !== 'Nije unet'
      ? '<br><span style="color:#52525b">' + escapeHtml(customer.phone) + '</span>'
      : '');
  return (
    '<section style="margin:24px 0;border:1px solid #e4e4e7;border-radius:14px;background:#ffffff;padding:22px">' +
    '<p style="margin:0 0 14px;color:#18181b;font-size:16px;font-weight:700">Podaci za obradu</p>' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:separate;border-spacing:0 8px">' +
    '<tr>' +
    detailCell('Kupac', customer.name) +
    detailCell('Kontakt', contact, true) +
    '</tr><tr>' +
    detailCell('Isporuka', shipping.text) +
    detailCell('Plaćanje', paymentLabel(order.paymentMethod)) +
    '</tr><tr>' +
    detailCell('Datum porudžbine', formatOrderDate(order.createdAt)) +
    detailCell('Broj porudžbine', '#' + order.displayId) +
    '</tr></table></section>'
  );
}

function detailCell(label: string, value: string, valueIsHtml = false): string {
  return (
    '<td class="mobile-block" valign="top" style="width:50%;padding:12px 14px;background:#f8f8fa;border-radius:10px">' +
    '<p style="margin:0 0 5px;color:#71717a;font-size:11px;font-weight:800;letter-spacing:0.07em;text-transform:uppercase">' +
    escapeHtml(label) +
    '</p><p style="margin:0;color:#27272a;font-size:13px;line-height:1.45;font-weight:600">' +
    (valueIsHtml ? value : escapeHtml(value)) +
    '</p></td>'
  );
}

function emailPage(input: {
  eyebrow: string;
  title: string;
  introduction: string;
  content: string;
  footer: string;
}): string {
  return (
    '<!doctype html><html lang="sr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<style>@media only screen and (max-width:640px){.email-shell{width:100% !important;border-radius:0 !important}.email-outer{padding:0 !important}.email-header{padding:26px 20px !important}.email-padding{padding:28px 20px !important}.mobile-block{display:block !important;width:auto !important;margin-bottom:8px !important}.product-image{width:56px !important;height:56px !important}}</style>' +
    '</head><body style="margin:0;padding:0;background:#f4f4f5;color:#18181b;font-family:Arial,Helvetica,sans-serif">' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f4f4f5"><tr><td class="email-outer" align="center" style="padding:32px 16px">' +
    '<table class="email-shell" role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:640px;max-width:640px;background:#ffffff;border:1px solid #e4e4e7;border-radius:18px;overflow:hidden">' +
    '<tr><td class="email-header" style="padding:30px 44px;background:#18181b;color:#ffffff">' +
    '<p style="margin:0;color:#d4d4d8;font-size:12px;font-weight:700;letter-spacing:0.13em;text-transform:uppercase">DajaShop</p>' +
    '<p style="margin:10px 0 0;color:#ffffff;font-size:14px;font-weight:700;letter-spacing:0.08em">' +
    input.eyebrow +
    '</p></td></tr>' +
    '<tr><td class="email-padding" style="padding:38px 44px">' +
    '<h1 style="margin:0 0 12px;color:#18181b;font-size:28px;line-height:1.2;font-weight:800">' +
    input.title +
    '</h1>' +
    '<p style="margin:0;color:#52525b;font-size:16px;line-height:1.6">' +
    input.introduction +
    '</p>' +
    input.content +
    '<p style="margin:28px 0 0;color:#71717a;font-size:13px;line-height:1.6">' +
    input.footer +
    '</p></td></tr>' +
    '<tr><td style="padding:20px 44px;border-top:1px solid #e4e4e7;background:#fafafa;color:#71717a;font-size:12px;line-height:1.5">' +
    'DajaShop · Automatska poruka o vašoj porudžbini' +
    '</td></tr></table></td></tr></table></body></html>'
  );
}

function customerOrderText(input: {
  heading: string;
  name: string;
  order: OrderEmailPayload;
  items: OrderItem[];
  shipping: ShippingDetails;
  footer: string;
}): string {
  return [
    'Zdravo ' + input.name + ',',
    '',
    input.heading,
    statusPresentation(input.order.status).description,
    '',
    orderTextSummary(input.order, input.items, input.shipping),
    '',
    input.footer,
    'DajaShop'
  ].join('\n');
}

function adminOrderText(
  order: OrderEmailPayload,
  items: OrderItem[],
  shipping: ShippingDetails,
  customer: { name: string; email: string; phone: string }
): string {
  return [
    'Nova porudžbina #' + order.displayId,
    '',
    'Kupac: ' + customer.name,
    'Email: ' + customer.email,
    'Telefon: ' + customer.phone,
    'Datum: ' + formatOrderDate(order.createdAt),
    'Status: ' + order.status,
    'Isporuka: ' + shipping.text,
    'Plaćanje: ' + paymentLabel(order.paymentMethod),
    '',
    orderTextSummary(order, items, shipping),
    '',
    'Porudžbinu obradi u Admin → Porudžbine.'
  ].join('\n');
}

function orderTextSummary(order: OrderEmailPayload, items: OrderItem[], shipping: ShippingDetails): string {
  const promotion =
    order.promoCode || order.discountAmount > 0
      ? 'Promo kod: ' +
        (order.promoCode || 'Popust') +
        (order.discountAmount > 0
          ? ' (−' + formatMoney(order.discountAmount, order.currency) + ')'
          : ' (Besplatna dostava)')
      : '';
  return [
    'Artikli:',
    ...items.map(
      (item) =>
        '- ' +
        item.name +
        ' × ' +
        item.quantity +
        ' — ' +
        formatMoney(item.total, order.currency)
    ),
    '',
    'Međuzbir: ' + formatMoney(order.subtotal, order.currency),
    'Dostava: ' +
      (order.shippingCost === 0 ? 'Besplatna' : formatMoney(order.shippingCost, order.currency)),
    promotion,
    'Ukupno: ' + formatMoney(order.finalTotal, order.currency),
    'Način isporuke: ' + shipping.method,
    'Plaćanje: ' + paymentLabel(order.paymentMethod)
  ]
    .filter(Boolean)
    .join('\n');
}

function shippingDetails(order: OrderEmailPayload): ShippingDetails {
  if (order.shippingMethod === 'pickup') {
    return {
      method: 'Lično preuzimanje u radnji',
      text: 'Lično preuzimanje u radnji',
      address: ''
    };
  }
  const address = [
    customerValue(order.customer, 'address'),
    [customerValue(order.customer, 'postalCode'), customerValue(order.customer, 'city')]
      .filter(Boolean)
      .join(' ')
  ]
    .filter(Boolean)
    .join(', ');
  return {
    method: 'Kurirska isporuka',
    text: address ? 'Kurirska isporuka — ' + address : 'Kurirska isporuka',
    address
  };
}

function orderItems(order: OrderEmailPayload): OrderItem[] {
  return order.items.map((item) => {
    const record = isRecord(item) ? item : {};
    const quantity = positiveNumber(record.qty ?? record.quantity) || 1;
    const price = nonNegativeNumber(record.price);
    return {
      name: stringValue(record.name) || 'Proizvod',
      brand: stringValue(record.brand),
      quantity,
      price,
      total: price * quantity,
      image: safeImageUrl(stringValue(record.image) || stringValue(record.thumb))
    };
  });
}

function statusPresentation(status: string): StatusPresentation {
  switch (status) {
    case 'Na čekanju':
      return {
        title: 'Porudžbina je primljena',
        description: 'Primili smo porudžbinu i uskoro prelazimo na njenu obradu.',
        color: '#b45309',
        border: '#fde68a',
        background: '#fffbeb',
        step: 0
      };
    case 'U obradi':
      return {
        title: 'Pripremamo porudžbinu',
        description: 'Artikli se proveravaju i porudžbina se pažljivo priprema za slanje.',
        color: '#2563eb',
        border: '#bfdbfe',
        background: '#eff6ff',
        step: 1
      };
    case 'Poslato':
      return {
        title: 'Porudžbina je poslata',
        description: 'Porudžbina je predata kurirskoj službi i uskoro je na putu do vas.',
        color: '#7c3aed',
        border: '#ddd6fe',
        background: '#f5f3ff',
        step: 2
      };
    case 'Isporučeno':
      return {
        title: 'Porudžbina je isporučena',
        description: 'Porudžbina je uspešno isporučena. Hvala što kupujete u DajaShop-u.',
        color: '#15803d',
        border: '#bbf7d0',
        background: '#f0fdf4',
        step: 3
      };
    case 'Otkazano':
      return {
        title: 'Porudžbina je otkazana',
        description: 'Porudžbina je otkazana. Za dodatne informacije odgovorite direktno na ovaj email.',
        color: '#b91c1c',
        border: '#fecaca',
        background: '#fef2f2',
        step: null
      };
    default:
      return {
        title: 'Status porudžbine je ažuriran',
        description: 'Status porudžbine je ažuriran. Za dodatne informacije odgovorite direktno na ovaj email.',
        color: '#52525b',
        border: '#e4e4e7',
        background: '#fafafa',
        step: null
      };
  }
}

function paymentLabel(paymentMethod: string): string {
  return paymentMethod === 'cod' ? 'Plaćanje pouzećem' : 'Plaćanje pri preuzimanju';
}

function formatOrderDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Nije dostupan';
  return new Intl.DateTimeFormat('sr-RS', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Belgrade'
  }).format(date);
}

function emailLink(value: string): string {
  const email = rawEmailAddress(value);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return escapeHtml(value);
  return '<a href="mailto:' + escapeHtml(email) + '" style="color:#18181b;text-decoration:underline">' + escapeHtml(email) + '</a>';
}

function notificationRecipients(value: string): string[] {
  return value.split(',').map(rawEmailAddress).filter(Boolean);
}

function rawEmailAddress(value: string): string {
  const match = /<([^>]+)>/.exec(value);
  return (match?.[1] ?? value).trim();
}

function customerName(customer: Record<string, unknown>): string {
  return (
    [customerValue(customer, 'name'), customerValue(customer, 'surname')]
      .filter(Boolean)
      .join(' ') || 'kupče'
  );
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

function safeImageUrl(value: string): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : '';
  } catch {
    return '';
  }
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
