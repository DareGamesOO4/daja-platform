import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { AppConfig } from '@daja/config';
import type { Database, DbClient } from '@daja/database';
import type { Logger } from '@daja/observability';
import sharp from 'sharp';
import { CONFIG, DATABASE, LOGGER } from './tokens.js';

interface OrderAlert {
  order_id: string;
  attempts: number;
  display_id: string;
  customer_payload: Record<string, unknown>;
  items_payload: Array<{
    sku: string;
    name: string;
    slug: string;
    image?: string;
    thumb?: string;
    qty: number;
    price: number;
  }>;
  shipping_method: string;
  shipping_amount: number;
  total_amount: number;
  currency: string;
}

const storefront = 'https://dajashop.rs';
const maxPhotos = 16;
const maxPhotoBytes = 8 * 1024 * 1024;

function line(value: unknown, max: number) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function templateValues(order: OrderAlert): string[] {
  const customer = order.customer_payload;
  const pickup = order.shipping_method === 'pickup';
  const money = (amount: number) =>
    new Intl.NumberFormat('sr-Latn-RS', { style: 'currency', currency: order.currency, minimumFractionDigits: 0, maximumFractionDigits: 2 })
      .format(amount).replace(/\s+/g, ' ');
  const address = line([
    line(customer.address, 180),
    [line(customer.postalCode ?? customer.zip, 16), line(customer.city, 60)].filter(Boolean).join(' ')
  ].filter(Boolean).join(', '), 220);
  // The template displays quantity near the top but defines it as parameter 8.
  const values = [
    order.display_id,
    line([line(customer.name, 60), line(customer.surname, 60)].filter(Boolean).join(' '), 100) || 'Kupac',
    line(customer.phone, 40) || 'Nije unet',
    pickup ? 'Lično preuzimanje u radnji' : address || 'Pogledaj adresu u adminu',
    '',
    money(order.shipping_amount / 100),
    money(order.total_amount / 100),
    String(order.items_payload.reduce((sum, item) => sum + item.qty, 0))
  ];
  const itemBudget = Math.min(550, 980 - 245 - values.join('').length);
  const lines = order.items_payload.map(item => [
    `${line(item.sku, 64) || line(item.name, 80) || 'Artikal'} · ${item.qty} × ${money(item.price)}`,
    item.slug ? `${storefront}/product/${encodeURIComponent(item.slug)}` : ''
  ].filter(Boolean).join(' · '));
  const displayed: string[] = [];
  for (const item of lines) {
    if ([...displayed, item].join(' | ').length > itemBudget - 40) break;
    displayed.push(item);
  }
  const remaining = lines.length - displayed.length;
  if (remaining) displayed.push(`Još ${remaining} stavki u adminu`);
  values[4] = displayed.join(' | ') || 'Detalji u adminu';
  return values;
}

async function photo(urlValue: string | undefined, origin: string, size: number): Promise<Buffer | null> {
  if (!urlValue) return null;
  try {
    const url = new URL(urlValue);
    // Only the shop's image CDN is an allowed source for server-side fetches.
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) return null;
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5_000) });
    if (!response.body) return null;
    if (!response.ok || Number(response.headers.get('content-length')) > maxPhotoBytes) {
      await response.body.cancel();
      return null;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxPhotoBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
    return await sharp(Buffer.concat(chunks), { limitInputPixels: 36_000_000 })
      .rotate().resize(size, size, { fit: 'contain', background: '#ffffff' }).flatten({ background: '#ffffff' })
      .jpeg().toBuffer();
  } catch {
    return null;
  }
}

function labelImage(text: string, width: number, height: number, fontSize: number) {
  const escaped = text.replace(/[&<>]/g, symbol => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[symbol]!);
  return Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><text x="50%" y="50%" fill="#374151" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="${fontSize}" font-weight="600">${escaped}</text></svg>`);
}

async function orderImage(order: OrderAlert, origin: string) {
  const models = [...new Map(order.items_payload.map(item => [item.sku || item.slug || item.name, item])).values()];
  const visible = models.slice(0, maxPhotos);
  const columns = Math.max(1, Math.ceil(Math.sqrt(visible.length)));
  const tile = Math.floor(960 / columns);
  const footer = models.length > visible.length ? 54 : 0;
  const height = Math.max(1, Math.ceil(visible.length / columns)) * tile;
  const layers: sharp.OverlayOptions[] = [];
  for (let offset = 0; offset < visible.length; offset += 4) {
    const batch = visible.slice(offset, offset + 4);
    const photos = await Promise.all(batch.map(async item =>
      await photo(item.thumb, origin, tile - 56) ?? await photo(item.image, origin, tile - 56)));
    batch.forEach((item, index) => {
      const position = offset + index;
      const left = (position % columns) * tile;
      const top = Math.floor(position / columns) * tile;
      const model = line(item.sku || item.name, 24) || 'Artikal';
      const picture = photos[index];
      if (picture) {
        layers.push({ input: picture, left: left + 28, top: top + 10 });
      } else {
        layers.push({ input: labelImage('Slika nije dostupna', tile, tile - 46, 16), left, top });
      }
      layers.push({ input: labelImage(model, tile, 34, Math.min(24, Math.floor(tile / 14))), left, top: top + tile - 40 });
    });
  }
  if (footer) layers.push({ input: labelImage(`Još ${models.length - visible.length} modela u adminu`, columns * tile, footer, 22), left: 0, top: height });
  return sharp({ create: { width: columns * tile, height: height + footer, channels: 3, background: '#ffffff' } })
    .composite(layers).jpeg({ quality: 84 }).toBuffer();
}

@Injectable()
export class OrderWhatsAppService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopping = false;
  private active: Promise<void> | undefined;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(LOGGER) private readonly logger: Logger
  ) {}

  private enabled() {
    const { PUBLIC_ORGANIZATION_ID, WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
      WHATSAPP_GRAPH_API_VERSION, WHATSAPP_ORDER_ALERT_PHONE, WHATSAPP_BUSINESS_PHONE } = this.config;
    return Boolean(PUBLIC_ORGANIZATION_ID && WHATSAPP_ACCESS_TOKEN && WHATSAPP_PHONE_NUMBER_ID &&
      WHATSAPP_GRAPH_API_VERSION && WHATSAPP_BUSINESS_PHONE && WHATSAPP_ORDER_ALERT_PHONE &&
      WHATSAPP_ORDER_ALERT_PHONE !== WHATSAPP_BUSINESS_PHONE);
  }

  async enqueue(client: DbClient, organizationId: string, orderId: string) {
    if (!this.enabled() || organizationId !== this.config.PUBLIC_ORGANIZATION_ID) return;
    await client.query('INSERT INTO order_whatsapp_alerts (order_id) VALUES ($1) ON CONFLICT DO NOTHING', [orderId]);
  }

  onModuleInit() {
    if (this.enabled()) this.schedule();
  }

  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.active;
  }

  private schedule() {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.active = this.tick().catch(() => this.logger.warn('Order WhatsApp queue processing failed'))
        .finally(() => this.schedule());
    }, 5_000);
    this.timer.unref();
  }

  private async tick() {
    await this.db.pool.query(`UPDATE order_whatsapp_alerts SET state = 'unknown',
      error_code = 'interrupted_send', updated_at = now()
      WHERE state = 'sending' AND updated_at < now() - interval '2 minutes'`);
    await this.db.pool.query(`UPDATE order_whatsapp_alerts SET state = 'failed',
      error_code = 'interrupted_preparation', updated_at = now()
      WHERE state = 'preparing' AND attempts >= 5 AND updated_at < now() - interval '2 minutes'`);
    await this.db.pool.query(`UPDATE order_whatsapp_alerts SET state = 'cancelled',
      error_code = 'expired', updated_at = now()
      WHERE created_at <= now() - interval '24 hours' AND state IN ('queued', 'preparing')`);
    const result = await this.db.pool.query<OrderAlert>(`WITH next_order AS (
      SELECT a.order_id FROM order_whatsapp_alerts a JOIN orders o ON o.id = a.order_id
      WHERE o.organization_id = $1 AND o.deleted_at IS NULL AND a.attempts < 5 AND
        ((a.state = 'queued' AND a.available_at <= now()) OR
         (a.state = 'preparing' AND a.updated_at < now() - interval '2 minutes'))
      ORDER BY a.available_at, a.order_id FOR UPDATE OF a SKIP LOCKED LIMIT 1
    )
    UPDATE order_whatsapp_alerts a SET state = 'preparing', attempts = a.attempts + 1, updated_at = now()
    FROM next_order n JOIN orders o ON o.id = n.order_id WHERE a.order_id = n.order_id
    RETURNING a.order_id, a.attempts, o.display_id, o.customer_payload, o.items_payload,
      o.shipping_method, o.shipping_amount, o.total_amount, o.currency`, [this.config.PUBLIC_ORGANIZATION_ID]);
    if (result.rows[0]) await this.deliver(result.rows[0]);
  }

  private async deliver(order: OrderAlert) {
    const graph = `https://graph.facebook.com/${this.config.WHATSAPP_GRAPH_API_VERSION}/${this.config.WHATSAPP_PHONE_NUMBER_ID}`;
    const authorization = `Bearer ${this.config.WHATSAPP_ACCESS_TOKEN}`;
    let stage: 'preparing' | 'sending' = 'preparing';
    let state = 'unknown';
    let code: string | null = 'no_ack';
    let providerId: string | null = null;
    try {
      const origin = new URL(this.config.MEDIA_PUBLIC_BASE_URL || 'https://cdn.dajashop.rs').origin;
      const image = await orderImage(order, origin);
      const values = templateValues(order);
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('file', new Blob([Uint8Array.from(image)], { type: 'image/jpeg' }), 'daja-porudzbina.jpg');
      const uploaded = await fetch(`${graph}/media`, {
        method: 'POST', headers: { Authorization: authorization }, body: form, signal: AbortSignal.timeout(15_000)
      });
      const media = await uploaded.json() as { id?: string; error?: { code?: number } };
      if (!uploaded.ok || !media.id) {
        code = String(media.error?.code ?? `media_http_${uploaded.status}`);
        state = uploaded.status === 429 || uploaded.status >= 500 ? 'queued' : 'failed';
      } else {
        const claim = await this.db.pool.query(`UPDATE order_whatsapp_alerts a SET state = 'sending', updated_at = now()
          WHERE a.order_id = $1 AND a.attempts = $2 AND a.state = 'preparing'
            AND EXISTS (SELECT 1 FROM orders WHERE id = a.order_id AND deleted_at IS NULL)`, [order.order_id, order.attempts]);
        if (!claim.rowCount) return;
        stage = 'sending';
        const response = await fetch(`${graph}/messages`, {
          method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({
            messaging_product: 'whatsapp', to: this.config.WHATSAPP_ORDER_ALERT_PHONE.slice(1), type: 'template',
            template: {
              name: this.config.WHATSAPP_ORDER_ALERT_TEMPLATE,
              language: { code: this.config.WHATSAPP_ORDER_ALERT_LANGUAGE },
              components: [
                { type: 'header', parameters: [{ type: 'image', image: { id: media.id } }] },
                { type: 'body', parameters: values.map(text => ({ type: 'text', text })) }
              ]
            }
          })
        });
        const body = await response.json() as { messages?: Array<{ id?: string }>; error?: { code?: number } };
        providerId = response.ok ? body.messages?.[0]?.id ?? null : null;
        state = providerId ? 'accepted' : response.status === 429 ? 'queued' :
          !response.ok && response.status < 500 ? 'failed' : 'unknown';
        code = providerId ? null : String(body.error?.code ?? `send_http_${response.status}`);
      }
    } catch {
      // A lost send response can follow acceptance; only preparation may be retried after an ambiguous request.
      state = stage === 'sending' ? 'unknown' : 'queued';
      code = stage === 'sending' ? 'send_unconfirmed' : 'prepare_failed';
    }
    if (state === 'queued' && order.attempts >= 5) state = 'failed';
    await this.db.pool.query(`UPDATE order_whatsapp_alerts SET state = $3, provider_id = $4,
      error_code = $5, updated_at = now(), available_at = now() + $7 * interval '1 second'
      WHERE order_id = $1 AND attempts = $2 AND state = $6`,
      [order.order_id, order.attempts, state, providerId, code, stage, 15 * 2 ** order.attempts]);
    this.logger.info({ orderId: order.order_id, attempts: order.attempts, state, errorCode: code }, 'Order WhatsApp notification processed');
  }
}
