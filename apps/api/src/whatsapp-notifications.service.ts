import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import type { AppConfig } from '@daja/config';
import { TransactionManager, WISHLIST_PRICE_COUPON_CONSENT, WISHLIST_PRICE_COUPON_TEMPLATE, type Database, type DbClient } from '@daja/database';
import type { Logger } from '@daja/observability';
import { ValidationFailedError } from '@daja/security';
import { z } from 'zod';
import { CONFIG, DATABASE, LOGGER, REDIS } from './tokens.js';
import type { RedisConnection } from '@daja/database';
import { whatsappPreferenceCommand } from './whatsapp-preference-command.js';
import { fetchWhatsAppJpeg } from './order-whatsapp.service.js';

const NEWSLETTER_TEMPLATE = 'daja_newsletter_v2';
const PRICE_TEMPLATE = 'daja_price_change_v2';
const REGULAR_DECREASE_TEMPLATE = 'daja_price_regular_decrease_v1';
const WHATSAPP_NOTICE_VERSION = 'whatsapp-preferences-v2';
const NEWSLETTER_LINK_ORIGIN = 'https://dajashop.rs';

function newsletterLinkSuffix(value: string) {
  try {
    const url = new URL(value);
    if (url.origin !== NEWSLETTER_LINK_ORIGIN || url.username || url.password || url.href.length > 2000) return undefined;
    return url.href.slice(NEWSLETTER_LINK_ORIGIN.length + 1);
  } catch {
    return undefined;
  }
}

type VerifiedAccount = { customerId: string; organizationId: string };
type AlertOwner = VerifiedAccount & { phone: string | null; phoneVerified: boolean };

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const unavailable = 'WhatsApp obaveštenja još nisu dostupna. Za sada izaberite Email.';
const webhookSchema = z.object({ object: z.literal('whatsapp_business_account'), entry: z.array(z.object({
  id: z.string(), changes: z.array(z.object({ field: z.string(), value: z.object({
    metadata: z.object({ phone_number_id: z.string() }).optional(),
    messages: z.array(z.object({ id: z.string().max(300), from: z.string().regex(/^\d{8,15}$/),
      timestamp: z.string(), text: z.object({ body: z.string().max(4096) }).optional(),
      context: z.object({ id: z.string().max(300) }).optional(),
      button: z.object({ text: z.string().max(100).optional(), payload: z.string().max(100).optional() }).optional(),
      interactive: z.object({ button_reply: z.object({ id: z.string().max(100), title: z.string().max(100) }).optional() }).optional()
    })).max(100).optional(),
    statuses: z.array(z.object({ id: z.string().max(300), status: z.string(),
      errors: z.array(z.object({ code: z.number() })).optional()
    })).max(100).optional()
  }) })).max(100)
})).max(100) });

type Purpose = 'newsletter' | 'price_change' | 'back_in_stock';
type Subscription = { id: string; phone: string; purpose: Purpose; language: 'sr' | 'en'; variant_id: string | null; last_price: string | null; watch_code: string | null };
type Product = { product_id: string; name: string; variant_name: string | null; slug: string; price: string; regular_price: string; currency: string; stock: string };

@Injectable()
export class WhatsAppNotificationsService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private nextHistoryCleanup = 0;
  constructor(@Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(REDIS) private readonly redis: RedisConnection) {}

  available() {
    const c = this.config;
    return c.WHATSAPP_NOTIFICATIONS_ENABLED && c.WHATSAPP_NOTIFICATION_TEMPLATES_APPROVED &&
      c.WHATSAPP_NEWSLETTER_TEMPLATE === NEWSLETTER_TEMPLATE && c.WHATSAPP_PRICE_TEMPLATE === PRICE_TEMPLATE &&
      Boolean(c.PUBLIC_ORGANIZATION_ID && c.WHATSAPP_ACCESS_TOKEN && c.WHATSAPP_PHONE_NUMBER_ID &&
        c.WHATSAPP_GRAPH_API_VERSION && c.WHATSAPP_BUSINESS_PHONE && c.WHATSAPP_APP_SECRET.length >= 32 &&
        c.WHATSAPP_WEBHOOK_VERIFY_TOKEN.length >= 32);
  }

  wishlistCouponsAvailable() { return this.available() && this.config.WHATSAPP_WISHLIST_PRICE_COUPONS_ENABLED; }

  async request(input: { phone: string; purpose: Purpose; productId?: string | undefined;
    variantId?: string | undefined; policyVersion?: string | undefined; source?: string | undefined; language: 'sr' | 'en' }, customer?: VerifiedAccount) {
    if (!this.available()) throw new ValidationFailedError(unavailable);
    if (input.purpose === 'back_in_stock' && !this.config.WHATSAPP_STOCK_ALERTS_ENABLED) {
      throw new ValidationFailedError('WhatsApp obaveštenje o povratku na stanje nije uključeno.');
    }
    const phone = input.phone.replace(/[\s()-]/g, '');
    if (!/^\+381[1-9]\d{6,11}$/.test(phone)) throw new ValidationFailedError('Unesite broj telefona u međunarodnom formatu, npr. +381601234567.');
    const result = await this.transaction(async client => {
      await this.lock(client, phone);
      const product = input.purpose === 'newsletter' ? undefined : await this.product(client, input.variantId ?? '');
      if (input.purpose !== 'newsletter' && (!product || product.product_id !== input.productId)) {
        throw new ValidationFailedError('Artikal više nije dostupan.');
      }

      if (customer) {
        if (input.purpose !== 'price_change' || customer.organizationId !== this.org()) {
          throw new ValidationFailedError('Ova WhatsApp prijava nije dostupna.');
        }
        if (!await this.verifiedPhone(client, customer, phone)) return { active: false, requiresPhoneVerification: true } as const;
        await this.activatePriceAlert(client, phone, product!, input.variantId!, input.language, input.policyVersion);
        return { active: true } as const;
      }
      const recent = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM whatsapp_subscriptions
        WHERE organization_id=$1 AND phone=$2 AND created_at>now()-interval '1 hour'`, [this.org(), phone]);
      if ((recent.rows[0]?.count ?? 0) >= 5) throw new ValidationFailedError('Sačekajte pre ponovne prijave na WhatsApp.');
      const token = randomBytes(24).toString('hex');
      await client.query(`INSERT INTO whatsapp_subscriptions
        (organization_id,phone,purpose,product_id,variant_id,policy_version,source,token_hash,language,expires_at,notice_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '30 minutes',$10)`,
        [this.org(), phone, input.purpose, input.productId ?? null, input.variantId ?? null,
          input.policyVersion ?? WHATSAPP_NOTICE_VERSION, 'site_whatsapp', hash(token), input.language, WHATSAPP_NOTICE_VERSION]);
      // Sending this message from WhatsApp proves control of the requested number.
      return { active: false, requiresWhatsAppConfirmation: true, confirmationToken: token,
        whatsappUrl: `https://wa.me/${this.config.WHATSAPP_BUSINESS_PHONE.slice(1)}?text=${encodeURIComponent('DAJA ' + token)}` };
    });
    return result;
  }

  lockWishlistPhone(client: DbClient, phone: string) { return this.lock(client, phone); }

  assertWishlistAvailable(customer: VerifiedAccount) {
    if (!this.available() || customer.organizationId !== this.org()) throw new ValidationFailedError(unavailable);
  }

  async subscribeWishlist(customer: VerifiedAccount, targets: Array<{ productId: string; variantId: string | null }>,
    input: { language: 'sr' | 'en'; policyVersion?: string | undefined }, phone: string, client: DbClient) {
    if (customer.organizationId !== this.org()) return { active: 0, skipped: targets.length };
    let active = 0;
    for (const { productId, variantId } of targets) {
      if (!variantId) continue;
      const product = await this.product(client, variantId);
      if (!product || product.product_id !== productId) continue;
      await this.activatePriceAlert(client, phone, product, variantId, input.language, input.policyVersion, customer.customerId);
      active++;
    }
    return { active, skipped: targets.length - active };
  }

  async removeWishlistProductAlerts(client: DbClient, customer: VerifiedAccount, productId: string, keepVariant: string | null) {
    const result = await client.query<{ id: string }>(`UPDATE whatsapp_subscriptions
      SET active=false,revoked_at=now(),updated_at=now()
      WHERE organization_id=$1 AND wishlist_customer_id=$2 AND product_id=$3 AND revoked_at IS NULL
        AND variant_id IS DISTINCT FROM $4::uuid RETURNING id`,
      [customer.organizationId, customer.customerId, productId, keepVariant]);
    await this.cancelQueued(client, result.rows.map(row => row.id));
  }

  async accountAlerts(customer: AlertOwner, watch?: { productId: string; variantId: string }) {
    const phone = this.alertPhone(customer);
    if (!phone) return [];
    const result = await this.db.pool.query<{
      id: string; productId: string; variantId: string; type: Exclude<Purpose, 'newsletter'>; name: string | null; variantName: string | null; slug: string | null; watchCode: string | null;
    }>(`SELECT s.id, s.product_id AS "productId", s.variant_id AS "variantId", s.purpose AS type,
                p.name AS name, v.name AS "variantName", p.slug,
                CASE WHEN s.purpose='price_change' THEN s.watch_code::text END AS "watchCode"
         FROM whatsapp_subscriptions s
         LEFT JOIN products p ON p.organization_id=s.organization_id AND p.id=s.product_id
         LEFT JOIN product_variants v ON v.organization_id=s.organization_id AND v.id=s.variant_id
         WHERE s.organization_id=$1 AND s.phone=$2 AND s.purpose<>'newsletter'
           AND EXISTS (SELECT 1 FROM customers WHERE organization_id=$1 AND id=$5 AND phone=$2
             AND phone_verified AND active AND deleted_at IS NULL)
           AND s.active AND s.revoked_at IS NULL AND s.confirmed_at IS NOT NULL
           AND ($3::uuid IS NULL OR s.product_id=$3) AND ($4::uuid IS NULL OR s.variant_id=$4)
         ORDER BY s.created_at DESC`, [this.org(), phone, watch?.productId ?? null, watch?.variantId ?? null, customer.customerId]);
    return result.rows.map(({ variantName, ...row }) => ({
      ...row, name: [row.name, variantName !== row.name ? variantName : null].filter(Boolean).join(' — '),
      channel: 'whatsapp' as const
    }));
  }

  async unsubscribeAccountAlerts(customer: AlertOwner, scope: { productId?: string; variantId?: string }, transaction?: DbClient) {
    const phone = this.alertPhone(customer);
    if (!phone) return 0;
    const revoke = async (client: DbClient) => {
      await this.lock(client, phone);
      if (!await this.verifiedPhone(client, customer, phone)) return 0;
      return this.revokeProductAlerts(client, phone, scope);
    };
    return transaction ? revoke(transaction) : this.transaction(revoke);
  }

  private alertPhone(customer: AlertOwner) {
    return customer.organizationId === this.org() && customer.phoneVerified && customer.phone &&
      /^\+381[1-9]\d{6,11}$/.test(customer.phone) ? customer.phone : null;
  }

  private async verifiedPhone(client: DbClient, customer: VerifiedAccount, phone: string) {
    const account = await client.query(`SELECT id FROM customers
      WHERE organization_id=$1 AND id=$2 AND phone=$3 AND phone_verified AND active AND deleted_at IS NULL FOR UPDATE`,
      [this.org(), customer.customerId, phone]);
    return Boolean(account.rowCount);
  }

  private async activatePriceAlert(client: DbClient, phone: string, product: Product, variantId: string,
    language: 'sr' | 'en', policyVersion?: string, wishlistCustomerId?: string) {
    if (!wishlistCustomerId) await client.query(`UPDATE whatsapp_subscriptions SET wishlist_customer_id=NULL
      WHERE organization_id=$1 AND phone=$2 AND purpose='price_change' AND variant_id=$3
        AND active AND revoked_at IS NULL AND wishlist_customer_id IS NOT NULL`, [this.org(),phone,variantId]);
    await client.query(`INSERT INTO whatsapp_subscriptions
        (organization_id,phone,purpose,product_id,variant_id,policy_version,source,token_hash,language,
         expires_at,confirmed_at,active,last_price,wishlist_customer_id,notice_version,watch_code)
      SELECT $1,$2,'price_change',$3,$4,$5,CASE WHEN $9::uuid IS NULL THEN 'site_verified_account' ELSE 'site_wishlist' END,
        $6,$7,now(),now(),true,$8,$9,$10,nextval('whatsapp_watch_code_seq')
      WHERE NOT EXISTS (SELECT 1 FROM whatsapp_subscriptions WHERE organization_id=$1 AND phone=$2
        AND purpose='price_change' AND variant_id=$4 AND active AND revoked_at IS NULL)`,
      [this.org(), phone, product.product_id, variantId, policyVersion ?? WHATSAPP_NOTICE_VERSION,
        hash(randomBytes(24).toString('hex')), language, product.price, wishlistCustomerId ?? null, WHATSAPP_NOTICE_VERSION]);
  }

  private async revokeProductAlerts(client: DbClient, phone: string,
    scope: { productId?: string; variantId?: string; before?: Date }) {
    const result = await client.query<{ id: string }>(`UPDATE whatsapp_subscriptions
      SET active=false,revoked_at=now(),updated_at=now()
      WHERE organization_id=$1 AND phone=$2 AND purpose<>'newsletter' AND revoked_at IS NULL
        AND ($3::uuid IS NULL OR product_id=$3) AND ($4::uuid IS NULL OR variant_id=$4)
        AND ($5::timestamptz IS NULL OR (created_at<=$5 AND (confirmed_at IS NULL OR confirmed_at<=$5)))
      RETURNING id`, [this.org(), phone, scope.productId ?? null, scope.variantId ?? null, scope.before ?? null]);
    await this.cancelQueued(client, result.rows.map(row => row.id));
    return result.rows.length;
  }

  private async cancelQueued(client: DbClient, ids: string[]) {
    if (!ids.length) return;
    await client.query(`UPDATE whatsapp_deliveries SET state='cancelled',updated_at=now()
      WHERE subscription_id=ANY($1::uuid[]) AND state='queued'`, [ids]);
  }

  private async revokeByCommand(client: DbClient, phone: string, before: Date, purpose?: Purpose, subscriptionId?: string, source = 'whatsapp') {
    const result = await client.query<{ id: string }>(`UPDATE whatsapp_subscriptions
      SET active=false,revoked_at=now(),updated_at=now(),revoked_via=$6
      WHERE organization_id=$1 AND phone=$2 AND revoked_at IS NULL
        AND created_at<=$3 AND (confirmed_at IS NULL OR confirmed_at<=$3)
        AND ($4::text IS NULL OR purpose=$4) AND ($5::uuid IS NULL OR id=$5)
      RETURNING id`, [this.org(), phone, before, purpose ?? null, subscriptionId ?? null, source]);
    await this.cancelQueued(client, result.rows.map(row => row.id));
    return result.rowCount ?? 0;
  }

  private async enqueueServiceReply(client: DbClient, phone: string, messageId: string, eventAt: Date, message: string) {
    const expiresAt = new Date(eventAt.getTime() + 23 * 3600_000);
    if (expiresAt.getTime() <= Date.now()) return;
    await client.query(`INSERT INTO whatsapp_service_replies(message_id,organization_id,phone,message,expires_at)
      SELECT $1,$2,$3,$4,$5 WHERE (
        SELECT count(*) FROM whatsapp_service_replies WHERE organization_id=$2 AND phone=$3 AND expires_at>now()
      ) < 5 ON CONFLICT DO NOTHING`, [messageId,this.org(),phone,message,expiresAt]);
  }

  private async handlePreferenceCommand(client: DbClient, phone: string, messageId: string, eventAt: Date,
    contextId: string | undefined, command: NonNullable<ReturnType<typeof whatsappPreferenceCommand>>) {
    const before = new Date(eventAt.getTime() + 999);
    const latest = await client.query<{ language: 'sr' | 'en' }>(`SELECT language FROM whatsapp_subscriptions
      WHERE organization_id=$1 AND phone=$2 AND confirmed_at IS NOT NULL ORDER BY confirmed_at DESC,id LIMIT 1`, [this.org(),phone]);
    const english = 'english' in command ? command.english : latest.rows[0]?.language === 'en';
    const reply = (sr: string, en: string) => this.enqueueServiceReply(client,phone,messageId,eventAt,english ? en : sr);
    if (command.kind === 'help') {
      return reply(
        'DajaShop • STOP — novosti. STOP CENE — sva praćenja cena. STOP SVE — sve pretplate. MOJI SATOVI — vaše šifre. STOP SAT <šifra> — jedan sat. Za pomoć: dajashopnis@gmail.com.',
        'DajaShop • STOP — newsletter. STOP PRICES — all price alerts. STOP ALL — all subscriptions. MY WATCHES — your codes. STOP WATCH <code> — one watch. Help: dajashopnis@gmail.com.');
    }
    if (command.kind === 'list') {
      if (eventAt.getTime() + 23 * 3600_000 <= Date.now()) return;
      const rows = await client.query<{ name: string | null; variant: string | null; code: string }>(`
        SELECT p.name, v.name AS variant, s.watch_code::text AS code FROM whatsapp_subscriptions s
        LEFT JOIN products p ON p.organization_id=s.organization_id AND p.id=s.product_id
        LEFT JOIN product_variants v ON v.organization_id=s.organization_id AND v.id=s.variant_id
        WHERE s.organization_id=$1 AND s.phone=$2 AND s.purpose='price_change'
          AND s.watch_code IS NOT NULL AND s.active AND s.revoked_at IS NULL AND s.confirmed_at IS NOT NULL
        ORDER BY s.watch_code LIMIT 11 OFFSET $3`, [this.org(),phone,(command.page - 1) * 10]);
      if (!rows.rows.length) return reply('Nema aktivnih praćenja na ovoj strani.', 'There are no active alerts on this page.');
      const list = rows.rows.slice(0, 10).map(row => {
        const name = [row.name, row.variant !== row.name ? row.variant : null].filter(Boolean).join(' — ');
        return `${row.code} · ${name.replace(/\s+/g, ' ').slice(0, 160) || (english ? 'Watch' : 'Sat')}`;
      }).join('\n');
      return reply(`Vaša praćenja cena\n${list}\nZa odjavu pošaljite STOP SAT <šifra>.${rows.rows.length > 10 ? ` Sledeća strana: MOJI SATOVI ${command.page + 1}.` : ''}`,
        `Your price alerts\n${list}\nTo unsubscribe, send STOP WATCH <code>.${rows.rows.length > 10 ? ` Next page: MY WATCHES ${command.page + 1}.` : ''}`);
    }
    if (command.kind === 'watch') {
      const code = 'code' in command ? command.code : null;
      const target = await client.query<{ id: string }>(`SELECT s.id FROM whatsapp_subscriptions s
        WHERE s.organization_id=$1 AND s.phone=$2 AND s.purpose='price_change'
          AND (($3::text IS NOT NULL AND s.watch_code::text=$3) OR
            ($3::text IS NULL AND EXISTS (SELECT 1 FROM whatsapp_deliveries d WHERE d.subscription_id=s.id AND d.provider_id=$4)))`,
        [this.org(),phone,code,contextId ?? null]);
      const id = target.rows[0]?.id;
      if (!id) return reply('Sat nije pronađen. Pošaljite MOJI SATOVI da vidite šifre.', 'Watch not found. Send MY WATCHES for your codes.');
      const revoked = await this.revokeByCommand(client,phone,before,'price_change',id);
      return revoked
        ? reply('WhatsApp praćenje cene za ovaj sat je isključeno.', 'WhatsApp price alerts for this watch are off.')
        : reply('Za tu šifru ili poruku nema aktivne prijave.', 'There is no active subscription for that code or message.');
    }
    const legacy = command.kind === 'newsletter' && command.legacyEligible && (await client.query(`
      SELECT 1 FROM whatsapp_deliveries d JOIN whatsapp_subscriptions s ON s.id=d.subscription_id
      WHERE s.organization_id=$1 AND s.phone=$2 AND s.notice_version IS NULL AND d.provider_id IS NOT NULL
        AND d.created_at<=$3 AND ($4::text=d.provider_id OR NOT EXISTS (
          SELECT 1 FROM whatsapp_subscriptions newer WHERE newer.organization_id=s.organization_id AND newer.phone=s.phone
            AND newer.notice_version=$5 AND newer.confirmed_at>d.created_at AND newer.confirmed_at<=$3
        )) LIMIT 1`, [this.org(),phone,before,contextId ?? null,WHATSAPP_NOTICE_VERSION])).rowCount;
    if (command.kind === 'all' || legacy) {
      await this.disableWishlistTracking(client,phone,before);
      await this.revokeByCommand(client,phone,before);
      return reply('Sve DajaShop WhatsApp pretplate su isključene.', 'All DajaShop WhatsApp subscriptions are off.');
    }
    if (command.kind === 'prices') {
      await this.disableWishlistTracking(client,phone,before);
      await this.revokeByCommand(client,phone,before,'price_change');
      return reply('Sva WhatsApp praćenja cena su isključena. Ova odjava ne menja prijavu na novosti.', 'All WhatsApp price alerts are off. This does not change your newsletter preference.');
    }
    await this.revokeByCommand(client,phone,before,'newsletter');
    return reply('WhatsApp novosti su isključene. Za odjavu svega pošaljite STOP SVE.', 'The WhatsApp newsletter is off. Send STOP ALL to unsubscribe from everything.');
  }

  async status(token: string) {
    const result = await this.db.pool.query<{ confirmed: boolean; expired: boolean }>(`SELECT
      (confirmed_at IS NOT NULL AND revoked_at IS NULL) AS confirmed,
      (expires_at<=now() AND confirmed_at IS NULL OR revoked_at IS NOT NULL) AS expired
      FROM whatsapp_subscriptions WHERE organization_id=$1 AND token_hash=$2`, [this.org(),hash(token)]);
    return result.rows[0] ?? { confirmed: false, expired: true };
  }

  verifySignature(raw: Buffer, signature: unknown) {
    if (!this.config.WHATSAPP_APP_SECRET || typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
    const expected = 'sha256=' + createHmac('sha256', this.config.WHATSAPP_APP_SECRET).update(raw).digest('hex');
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }

  async webhook(body: unknown) {
    if (!this.org()) return;
    const payload = webhookSchema.parse(body);
    for (const entry of payload.entry) for (const change of entry.changes) {
      const value = change.value;
      if (change.field !== 'messages' || value.metadata?.phone_number_id !== this.config.WHATSAPP_PHONE_NUMBER_ID) continue;
      for (const status of value.statuses ?? []) {
        if (!['sent','delivered','read','failed'].includes(status.status)) continue;
        // Persist first: a callback may arrive before the send response is saved.
        await this.db.pool.query(`INSERT INTO whatsapp_delivery_statuses(provider_id,state,error_code) VALUES($1,$2,$3)
          ON CONFLICT(provider_id) DO UPDATE SET state=EXCLUDED.state,error_code=EXCLUDED.error_code,updated_at=now()
          WHERE (whatsapp_delivery_statuses.state='sent' AND EXCLUDED.state IN ('delivered','read','failed'))
            OR (whatsapp_delivery_statuses.state='delivered' AND EXCLUDED.state='read')`,
          [status.id, status.status, status.errors?.[0]?.code?.toString() ?? null]);
        await this.db.pool.query(`UPDATE whatsapp_deliveries d SET state=s.state,error_code=s.error_code,updated_at=now()
          FROM whatsapp_delivery_statuses s WHERE d.provider_id=s.provider_id AND s.provider_id=$1 AND
          (d.state IN ('accepted','unknown') OR (d.state='sent' AND s.state IN ('delivered','read','failed')) OR (d.state='delivered' AND s.state='read'))`, [status.id]);
        if (status.status === 'delivered' || status.status === 'read') await this.activateDeliveredCoupon(this.db.pool, status.id);
      }
      for (const message of value.messages ?? []) await this.transaction(async client => {
        const phone = '+' + message.from;
        if (!/^\+381[1-9]\d{6,11}$/.test(phone)) return;
        await this.lock(client, phone);
        const receipt = await client.query(`INSERT INTO whatsapp_webhook_receipts(message_id) VALUES($1)
          ON CONFLICT DO NOTHING RETURNING message_id`, [message.id]);
        if (!receipt.rowCount) return;
        const text = (message.text?.body ?? message.button?.payload ?? message.interactive?.button_reply?.id ?? message.button?.text ?? '').trim();
        const eventAt = new Date(Number(message.timestamp) * 1000);
        if (!Number.isFinite(eventAt.getTime()) || eventAt.getTime() > Date.now() + 300_000) return;
        const command = whatsappPreferenceCommand(text);
        if (command) return this.handlePreferenceCommand(client,phone,message.id,eventAt,message.context?.id,command);
        const match = /^DAJA ([a-f0-9]{48})$/i.exec(text);
        if (!match || !this.available()) return;
        const result = await client.query<Subscription>(`SELECT id,phone,purpose,language,variant_id,last_price,watch_code FROM whatsapp_subscriptions
          WHERE organization_id=$1 AND phone=$2 AND token_hash=$3 AND confirmed_at IS NULL
            AND revoked_at IS NULL AND expires_at>now() AND created_at<=$4 FOR UPDATE`,
          [this.org(), phone, hash(match[1]!.toLowerCase()), new Date(eventAt.getTime() + 999)]);
        const s = result.rows[0];
        if (!s) return;
        const p = s.variant_id ? await this.product(client, s.variant_id) : null;
        if (s.purpose !== 'newsletter' && !p) return;
        // A new consent replaces only the same purpose/product; other channels are untouched.
        await client.query(`UPDATE whatsapp_subscriptions SET active=false,revoked_at=now(),updated_at=now()
          WHERE organization_id=$1 AND phone=$2 AND purpose=$3 AND variant_id IS NOT DISTINCT FROM $4 AND id<>$5 AND active`,
          [this.org(), phone, s.purpose, s.variant_id, s.id]);
        const activated = await client.query<{ watch_code: string | null }>(`UPDATE whatsapp_subscriptions
          SET active=true,confirmed_at=$3,last_price=$2,updated_at=now(),
            watch_code=CASE WHEN purpose='price_change' THEN COALESCE(watch_code,nextval('whatsapp_watch_code_seq')) END
          WHERE id=$1 RETURNING watch_code`, [s.id, p?.price ?? null, eventAt]);
        // Only send a session reply for a freshly received opt-in, inside the 24-hour window.
        if (eventAt.getTime() > Date.now() - 23 * 3600_000) {
          const label = s.language === 'en' ? (s.purpose === 'newsletter' ? 'news and offers' : s.purpose === 'price_change'
            ? 'price changes for ' + p!.name.slice(0, 150) : 'back-in-stock updates for ' + p!.name.slice(0, 150))
            : s.purpose === 'newsletter' ? 'novosti i ponude' : s.purpose === 'price_change'
              ? 'promene cene artikla ' + p!.name.slice(0, 150) : 'povratak na stanje artikla ' + p!.name.slice(0, 150);
          const code = activated.rows[0]?.watch_code;
          const howToStop = s.language === 'en'
            ? code ? `Send STOP WATCH ${code} for this watch, STOP PRICES for all price alerts or STOP ALL for all subscriptions.`
              : s.purpose === 'newsletter' ? 'Send STOP for the newsletter or STOP ALL for all subscriptions.' : 'Send STOP ALL to unsubscribe.'
            : code ? `Pošaljite STOP SAT ${code} za ovaj sat, STOP CENE za sva praćenja cena ili STOP SVE za sve pretplate.`
              : s.purpose === 'newsletter' ? 'Pošaljite STOP za novosti ili STOP SVE za sve pretplate.' : 'Za odjavu pošaljite STOP SVE.';
          await client.query(`INSERT INTO whatsapp_deliveries(subscription_id,dedupe_key,template_name,kind,parameters,expires_at)
            VALUES($1,$2,'session_confirmation','text',$3::jsonb,$4) ON CONFLICT(dedupe_key) DO NOTHING`,
            [s.id,'confirmation:' + s.id, JSON.stringify([s.language === 'en'
              ? 'DajaShop: your WhatsApp subscription is confirmed for ' + label + '. ' + howToStop
              : 'DajaShop: potvrđena je WhatsApp prijava za ' + label + '. ' + howToStop]), new Date(eventAt.getTime() + 23 * 3600_000)]);
        }
      });
    }
  }

  async campaign(organizationId: string, campaignId: string, text: string, language: 'sr' | 'en', link?: string) {
    if (!this.available() || organizationId !== this.org()) throw new ValidationFailedError(unavailable);
    const parameters = [text];
    if (language === 'sr') {
      const explicit = link ? newsletterLinkSuffix(link) : undefined;
      if (link && !explicit) throw new ValidationFailedError('Unesite važeći link sa sajta https://dajashop.rs.');
      const embedded = text.match(/https?:\/\/[^\s<>"']+/gi)?.map(value => newsletterLinkSuffix(value.replace(/[.,!;:)\]]+$/, ''))).find(Boolean);
      parameters.push(explicit || embedded || 'catalog');
    }
    const previousContentHash = hash(language + ':' + text);
    const contentHash = language === 'sr' ? hash(JSON.stringify([language, ...parameters])) : previousContentHash;
    return this.transaction(async client => {
    const campaign = await client.query(`INSERT INTO whatsapp_campaigns(organization_id,id,content_hash)
      VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`, [organizationId,campaignId,contentHash]);
    if (!campaign.rowCount) {
      const existing = await client.query<{ content_hash: string }>('SELECT content_hash FROM whatsapp_campaigns WHERE organization_id=$1 AND id=$2', [organizationId,campaignId]);
      if (existing.rows[0]?.content_hash !== contentHash && (link || existing.rows[0]?.content_hash !== previousContentHash)) {
        throw new ValidationFailedError('Za izmenjenu poruku napravite novu kampanju.');
      }
      return { queued: 0 };
    }
    const result = await client.query(`INSERT INTO whatsapp_deliveries(subscription_id,dedupe_key,template_name,parameters)
      SELECT id,$2||':'||id::text,$3,$4::jsonb FROM whatsapp_subscriptions
      WHERE organization_id=$1 AND purpose='newsletter' AND language=$5 AND active AND confirmed_at IS NOT NULL AND revoked_at IS NULL
      ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
      [organizationId, 'campaign:' + campaignId, this.config.WHATSAPP_NEWSLETTER_TEMPLATE, JSON.stringify(parameters), language]);
    return { queued: result.rowCount ?? 0 };
    });
  }

  async summary(organizationId: string) {
    const subscriptions = await this.db.pool.query(`SELECT purpose,count(*)::int AS count FROM whatsapp_subscriptions
      WHERE organization_id=$1 AND active AND revoked_at IS NULL GROUP BY purpose`, [organizationId]);
    const deliveries = await this.db.pool.query(`SELECT d.id,d.template_name AS "templateName",d.state,d.error_code AS "errorCode",d.created_at AS "createdAt"
      FROM whatsapp_deliveries d JOIN whatsapp_subscriptions s ON s.id=d.subscription_id
      WHERE s.organization_id=$1 ORDER BY d.created_at DESC LIMIT 30`, [organizationId]);
    return { available: this.available(), subscriptions: subscriptions.rows, deliveries: deliveries.rows };
  }

  async unsubscribeFromSupport(organizationId: string, phone: string, scope: 'all' | 'prices' | 'newsletter', staffId: string) {
    if (organizationId !== this.org()) throw new ValidationFailedError(unavailable);
    const before = new Date();
    const revoked = await this.transaction(async client => {
      await this.lock(client, phone);
      if (scope !== 'newsletter') await this.disableWishlistTracking(client,phone,before);
      return this.revokeByCommand(client,phone,before,
        scope === 'prices' ? 'price_change' : scope === 'newsletter' ? 'newsletter' : undefined, undefined, 'support');
    });
    this.logger.info({ organizationId, staffId, scope, revoked }, 'WhatsApp support opt-out processed');
    return { revoked };
  }

  onModuleInit() { this.schedule(); }
  onModuleDestroy() { this.stopped = true; if (this.timer) clearTimeout(this.timer); }
  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.tick().catch(() => {
      this.logger.warn('WhatsApp notification processing failed');
    }).finally(() => this.schedule()); }, 15_000);
    this.timer.unref();
  }
  private async tick() {
    await this.sendServiceReply();
    if (Date.now() >= this.nextHistoryCleanup && this.org() &&
        this.config.WHATSAPP_RETENTION_APPROVED && this.config.WHATSAPP_RETENTION_HMAC_KEY.length >= 32) {
      this.nextHistoryCleanup = Date.now() + 60 * 60_000;
      await this.expireHistory().catch(() => this.logger.warn('WhatsApp history cleanup failed'));
    }
    if (!this.available()) return;
    if (this.config.WHATSAPP_WISHLIST_PRICE_COUPONS_ENABLED) await this.activateDeliveredCoupon(this.db.pool);
    await this.db.pool.query(`UPDATE whatsapp_deliveries d SET state=s.state,error_code=s.error_code,updated_at=now()
      FROM whatsapp_delivery_statuses s WHERE d.provider_id=s.provider_id AND
      (d.state IN ('accepted','unknown') OR (d.state='sent' AND s.state IN ('delivered','read','failed')) OR (d.state='delivered' AND s.state='read'))`);
    await this.db.pool.query(`UPDATE whatsapp_deliveries SET state='cancelled',error_code='expired',updated_at=now()
      WHERE state='queued' AND expires_at<=now()`);
    await this.db.pool.query(`UPDATE whatsapp_deliveries SET state='unknown',error_code='interrupted',updated_at=now()
      WHERE state='sending' AND updated_at<now()-interval '2 minutes'`);
    await this.transaction(async client => {
      // Serialize event generation across API instances, without blocking HTTP requests.
      const lock = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_xact_lock(hashtextextended('whatsapp-alert-scan',0)) AS locked`);
      if (!lock.rows[0]?.locked) return;
      const targets = await client.query<Subscription & { updated_at: Date }>(`SELECT id,phone,purpose,language,variant_id,last_price,watch_code,updated_at FROM whatsapp_subscriptions
        WHERE organization_id=$1 AND active AND revoked_at IS NULL AND purpose<>'newsletter'
          AND (purpose='price_change' OR $2::boolean)
        ORDER BY updated_at,id LIMIT 100 FOR UPDATE SKIP LOCKED`, [this.org(), this.config.WHATSAPP_STOCK_ALERTS_ENABLED]);
      for (const s of targets.rows) {
        const p = await this.product(client, s.variant_id!);
        if (!p) { await client.query('UPDATE whatsapp_subscriptions SET updated_at=now() WHERE id=$1', [s.id]); continue; }
        const priceChanged = s.purpose === 'price_change' && s.last_price !== null && Number(s.last_price) !== Number(p.price);
        const stock = s.purpose === 'back_in_stock' && Number(p.stock) > 0;
        if (priceChanged || stock) {
          const url = new URL((s.language === 'en' ? '/en' : '') + '/product/' + encodeURIComponent(p.slug), this.config.STOREFRONT_PUBLIC_BASE_URL).toString();
          const money = (amount: string) => new Intl.NumberFormat(s.language === 'en' ? 'en-GB' : 'sr-RS', { style: 'currency', currency: p.currency }).format(Number(amount) / 100);
          const watchName = [p.name, p.variant_name !== p.name ? p.variant_name : null].filter(Boolean).join(' — ').slice(0, 200);
          const parameters = stock ? [watchName, money(p.price), url]
            : [watchName, money(s.last_price!), money(p.price), url, s.watch_code!];
          const regularDecrease = priceChanged && s.language === 'sr' && p.price === p.regular_price &&
            Number(p.price) < Number(s.last_price) && (await client.query(`
              SELECT 1 FROM product_regular_price_alert_events
              WHERE organization_id=$1 AND variant_id=$2 AND created_at >= $3
                AND previous_price_amount=$4 AND current_price_amount=$5
              LIMIT 1`, [this.org(), s.variant_id, s.updated_at, s.last_price, p.price])).rowCount;
          const template = stock ? this.config.WHATSAPP_STOCK_TEMPLATE :
            regularDecrease ? REGULAR_DECREASE_TEMPLATE : this.config.WHATSAPP_PRICE_TEMPLATE;
          await client.query(`INSERT INTO whatsapp_deliveries(subscription_id,dedupe_key,template_name,parameters)
            VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(dedupe_key) DO NOTHING`,
            [s.id, stock ? 'stock:' + s.id : 'price:' + s.id + ':' + s.last_price + ':' + p.price + ':' + Date.now(),
              template, JSON.stringify(parameters)]);
        }
        await client.query(`UPDATE whatsapp_subscriptions SET last_price=$2,updated_at=now() WHERE id=$1`, [s.id, p.price]);
      }
    });
    // One outbound attempt per tick. Persist before calling Meta; never blindly retry an ambiguous send.
    await this.transaction(async client => {
      const picked = await client.query<{ id: string; subscription_id: string; phone: string; language: string; template_name: string; kind: string; parameters: string[] }>(
        `SELECT d.id,d.subscription_id,s.phone,s.language,d.template_name,d.kind,d.parameters FROM whatsapp_deliveries d
         JOIN whatsapp_subscriptions s ON s.id=d.subscription_id WHERE d.state='queued' AND s.organization_id=$1
         AND s.active AND s.revoked_at IS NULL AND s.confirmed_at IS NOT NULL
         AND (d.kind='text' OR d.template_name=ANY($2::text[]))
         ORDER BY d.created_at LIMIT 1 FOR UPDATE OF d SKIP LOCKED`,
        [this.org(),[NEWSLETTER_TEMPLATE,PRICE_TEMPLATE,REGULAR_DECREASE_TEMPLATE,this.config.WHATSAPP_STOCK_TEMPLATE,
          ...(this.config.WHATSAPP_WISHLIST_PRICE_COUPONS_ENABLED ? [WISHLIST_PRICE_COUPON_TEMPLATE] : [])]]);
      const item = picked.rows[0];
      if (!item) return;
      const redis = this.redis.client;
      if (redis.status === 'wait') await redis.connect();
      const budget = Number(await redis.eval(`local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],86400) end; return n`, 1, 'whatsapp-notifications:daily-budget'));
      if (budget > this.config.WHATSAPP_NOTIFICATION_DAILY_LIMIT) return;
      await client.query(`UPDATE whatsapp_deliveries SET state='sending',updated_at=now() WHERE id=$1`, [item.id]);
      // Commit the claim before the network request so process termination cannot cause duplicate sends.
      return item;
    }).then(async item => {
      if (!item) return;
      await this.transaction(async client => {
        await this.lock(client, item.phone);
        const owner = await client.query<Subscription>(`SELECT id,phone,purpose,language,variant_id,last_price,watch_code FROM whatsapp_subscriptions WHERE id=$1 AND active AND revoked_at IS NULL`, [item.subscription_id]);
        if (!owner.rowCount) { await client.query(`UPDATE whatsapp_deliveries SET state='cancelled',updated_at=now() WHERE id=$1`, [item.id]); return; }
        const subscription = owner.rows[0]!;
        if (subscription.purpose === 'back_in_stock' && !this.config.WHATSAPP_STOCK_ALERTS_ENABLED) {
          await client.query(`UPDATE whatsapp_deliveries SET state='cancelled',error_code='stock_alerts_disabled',updated_at=now() WHERE id=$1`, [item.id]); return;
        }
        if (subscription.variant_id && !await this.product(client, subscription.variant_id)) {
          await client.query(`UPDATE whatsapp_deliveries SET state='cancelled',error_code='product_unavailable',updated_at=now() WHERE id=$1`, [item.id]); return;
        }
        let state = 'unknown'; let providerId: string | null = null; let errorCode: string | null = null;
        try {
          const hasNewsletterLink = item.template_name === NEWSLETTER_TEMPLATE && item.language === 'sr';
          const buttonPayloads = item.template_name === NEWSLETTER_TEMPLATE && !hasNewsletterLink ? ['STOP NEWS','STOP ALL'] : [];
          const buttons = buttonPayloads.map((payload, index) => ({ type: 'button', sub_type: 'quick_reply',
            index: String(index), parameters: [{ type: 'payload', payload }] }));
          const bodyParameters = hasNewsletterLink ? item.parameters.slice(0, 1) : item.parameters;
          const linkButton = hasNewsletterLink ? [{ type: 'button', sub_type: 'url', index: '0',
            parameters: [{ type: 'text', text: item.parameters[1] || 'catalog' }] }] : [];
          const coupon = item.template_name === WISHLIST_PRICE_COUPON_TEMPLATE
            ? await this.prepareWishlistCoupon(client, item.id, item.parameters) : null;
          if (item.template_name === WISHLIST_PRICE_COUPON_TEMPLATE && !coupon) {
            await client.query(`UPDATE whatsapp_deliveries SET state='cancelled',error_code='coupon_no_longer_eligible',updated_at=now() WHERE id=$1`, [item.id]);
            return;
          }
          const decrease = item.template_name === REGULAR_DECREASE_TEMPLATE
            ? await this.regularDecreaseComponents(client, subscription.variant_id!, item.parameters) : null;
          if (item.template_name === REGULAR_DECREASE_TEMPLATE && !decrease) {
            await client.query(`UPDATE whatsapp_deliveries SET state='failed',error_code='product_image_unavailable',updated_at=now() WHERE id=$1`, [item.id]);
            return;
          }
          const response = await fetch(`https://graph.facebook.com/${this.config.WHATSAPP_GRAPH_API_VERSION}/${this.config.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
            headers: { Authorization: 'Bearer ' + this.config.WHATSAPP_ACCESS_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ messaging_product: 'whatsapp', to: item.phone.slice(1), ...(item.kind === 'text'
              ? { type: 'text', text: { body: item.parameters[0] } }
              : { type: 'template', template: {
              name: item.template_name, language: { code: item.language },
              components: coupon ?? decrease ?? [{ type: 'body', parameters: bodyParameters.map(text => ({ type: 'text', text })) }, ...linkButton, ...buttons]
            } }) })
          });
          const data = await response.json() as { messages?: Array<{ id?: string }>; error?: { code?: number } };
          providerId = data.messages?.[0]?.id ?? null;
          state = response.ok && providerId ? 'accepted' : response.status >= 400 && response.status < 500 && data.error?.code ? 'failed' : 'unknown';
          errorCode = data.error?.code?.toString() ?? null;
        } catch { errorCode = 'ambiguous_provider_response'; }
        await client.query(`UPDATE whatsapp_deliveries SET state=$2,provider_id=$3,error_code=$4,updated_at=now() WHERE id=$1`, [item.id,state,providerId,errorCode]);
        if (state === 'accepted' && providerId && item.template_name === WISHLIST_PRICE_COUPON_TEMPLATE) {
          await this.activateDeliveredCoupon(client, providerId);
        }
        if (state === 'accepted' && item.kind === 'template') await client.query(`UPDATE whatsapp_subscriptions SET active=false,updated_at=now() WHERE id=$1 AND purpose='back_in_stock'`, [item.subscription_id]);
      });
    });
    await this.db.pool.query(`DELETE FROM whatsapp_webhook_receipts WHERE received_at<now()-interval '30 days'`);
    await this.db.pool.query(`DELETE FROM whatsapp_delivery_statuses WHERE updated_at<now()-interval '30 days'`);
    await this.db.pool.query(`DELETE FROM whatsapp_subscriptions WHERE confirmed_at IS NULL AND expires_at<now()-interval '1 day'`);
  }

  private async activateDeliveredCoupon(client: DbClient, providerId?: string) {
    await client.query(`WITH delivered AS (
      UPDATE wishlist_price_coupons c SET activated_at=now()
      FROM whatsapp_deliveries d JOIN whatsapp_delivery_statuses s ON s.provider_id=d.provider_id,
        promotions p WHERE p.id=c.promotion_id AND d.id=c.delivery_id AND c.activated_at IS NULL
        AND ($1::text IS NULL OR d.provider_id=$1) AND s.state IN ('delivered','read')
        AND p.starts_at IS NOT NULL AND p.ends_at>now() AND p.deleted_at IS NULL
      RETURNING c.promotion_id
    ) UPDATE promotions p SET active=true, updated_at=now() FROM delivered WHERE p.id=delivered.promotion_id`,
    [providerId ?? null]);
  }

  private async prepareWishlistCoupon(client: DbClient, id: string, parameters: Array<string | number>) {
    const match = (await client.query<{ promotion_id: string; slug: string; image_url: string | null }>(`
      SELECT coupon.promotion_id,p.slug,media.public_url AS image_url
      FROM wishlist_price_coupons coupon
      JOIN product_regular_price_alert_events e ON e.id=coupon.price_event_id
      JOIN whatsapp_deliveries d ON d.id=coupon.delivery_id JOIN whatsapp_subscriptions s ON s.id=d.subscription_id
      JOIN customers c ON c.id=coupon.customer_id AND c.organization_id=s.organization_id
        AND c.active AND c.deleted_at IS NULL AND c.phone_verified AND c.phone=s.phone
      JOIN wishlist_alert_preferences pref ON pref.organization_id=s.organization_id AND pref.customer_id=c.id
        AND pref.channel='whatsapp' AND pref.contact=s.phone AND pref.price_coupon_consent_at<=e.created_at
        AND pref.price_coupon_consent_version=$2
      JOIN product_variants v ON v.id=coupon.variant_id AND v.organization_id=s.organization_id
        AND v.current_price_amount=coupon.regular_price_at_issue AND v.currency='RSD'
      JOIN products p ON p.id=v.product_id AND p.organization_id=s.organization_id
      JOIN promotions code ON code.id=coupon.promotion_id AND code.deleted_at IS NULL AND code.starts_at IS NULL
      JOIN LATERAL (
        SELECT a.public_url FROM product_media m JOIN media_assets a ON a.id=m.media_asset_id
        WHERE m.organization_id=s.organization_id AND m.product_id=p.id AND a.status='ready' AND a.public_url IS NOT NULL
        ORDER BY m.is_primary DESC,m.position,m.id LIMIT 1
      ) media ON true
      WHERE d.id=$1 AND s.active AND s.revoked_at IS NULL AND s.wishlist_customer_id=c.id
        AND v.active AND v.published AND v.deleted_at IS NULL AND p.active AND p.published AND p.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM customer_wishlist_items w WHERE w.organization_id=s.organization_id
          AND w.customer_id=c.id AND w.product_id=p.id
          AND (nullif(w.item_snapshot->>'variantId','') IS NULL OR w.item_snapshot->>'variantId'=v.id::text))
        AND NOT EXISTS (SELECT 1 FROM variant_prices sale WHERE sale.organization_id=s.organization_id
          AND sale.variant_id=v.id AND sale.price_type='sale' AND sale.cancelled_at IS NULL
          AND sale.valid_from<=now() AND sale.valid_until>now() AND sale.amount_minor<v.current_price_amount)`,
      [id, WISHLIST_PRICE_COUPON_CONSENT])).rows[0];
    if (!match) return null;
    const mediaId = await this.uploadProductImage(match.image_url);
    if (!mediaId) return null;
    const starts = new Date();
    const ends = new Date(starts.getTime() + 72 * 60 * 60_000);
    const dates = new Intl.DateTimeFormat('sr-Latn-RS', { timeZone: 'Europe/Belgrade', dateStyle: 'short', timeStyle: 'medium' });
    const money = new Intl.NumberFormat('sr-Latn-RS', { style: 'currency', currency: 'RSD' });
    const [name, oldPrice, newPrice, amount, code, watchCode] = parameters;
    const values = [String(name), ...[oldPrice,newPrice,amount].map(value => money.format(Number(value)/100)),
      String(code), dates.format(starts), dates.format(ends), String(watchCode)];
    await client.query('UPDATE promotions SET starts_at=$2,ends_at=$3 WHERE id=$1 AND starts_at IS NULL',
      [match.promotion_id, starts, ends]);
    return [
      { type: 'header', parameters: [{ type: 'image', image: { id: mediaId } }] },
      { type: 'body', parameters: values.map(text => ({ type: 'text', text })) },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'product/' + encodeURIComponent(match.slug) }] }
    ];
  }

  private async regularDecreaseComponents(client: DbClient, variantId: string, parameters: string[]) {
    const match = (await client.query<{ slug: string; image_url: string }>(`
      SELECT p.slug, a.public_url AS image_url
      FROM product_variants v
      JOIN products p ON p.id=v.product_id AND p.organization_id=v.organization_id
      JOIN product_media m ON m.product_id=p.id AND m.organization_id=p.organization_id
      JOIN media_assets a ON a.id=m.media_asset_id AND a.organization_id=m.organization_id
      WHERE v.id=$1 AND v.organization_id=$2 AND a.status='ready' AND a.public_url IS NOT NULL
      ORDER BY m.is_primary DESC,m.position,m.id LIMIT 1`, [variantId,this.org()])).rows[0];
    if (!match) return null;
    const mediaId = await this.uploadProductImage(match.image_url);
    if (!mediaId) return null;
    const [name, oldPrice, newPrice, , watchCode] = parameters;
    return [
      { type: 'header', parameters: [{ type: 'image', image: { id: mediaId } }] },
      { type: 'body', parameters: [name, oldPrice, newPrice, watchCode].map(text => ({ type: 'text', text })) },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'product/' + encodeURIComponent(match.slug) }] }
    ];
  }

  private async uploadProductImage(url: string | null) {
    const jpeg = await fetchWhatsAppJpeg(url ?? undefined,
      new URL(this.config.MEDIA_PUBLIC_BASE_URL || 'https://cdn.dajashop.rs').origin, 768);
    if (!jpeg) return null;
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', new Blob([Uint8Array.from(jpeg)], { type: 'image/jpeg' }), 'daja-sat.jpg');
    const response = await fetch(`https://graph.facebook.com/${this.config.WHATSAPP_GRAPH_API_VERSION}/${this.config.WHATSAPP_PHONE_NUMBER_ID}/media`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), body: form,
      headers: { Authorization: 'Bearer ' + this.config.WHATSAPP_ACCESS_TOKEN }
    });
    if (!response.ok) return null;
    const media = await response.json() as { id?: string };
    return media.id ?? null;
  }

  private async expireHistory() {
    await this.transaction(async client => {
      await client.query(`DELETE FROM whatsapp_deliveries d USING whatsapp_subscriptions s
        WHERE d.subscription_id=s.id AND s.organization_id=$1
          AND d.updated_at<now()-interval '90 days' AND d.state NOT IN ('queued','sending')`, [this.org()]);
      const old = await client.query<{ id: string; phone: string }>(`SELECT id,phone FROM whatsapp_subscriptions s
        WHERE organization_id=$1 AND revoked_at<now()-interval '90 days'
          AND NOT EXISTS(SELECT 1 FROM whatsapp_deliveries d WHERE d.subscription_id=s.id)
        ORDER BY revoked_at LIMIT 100 FOR UPDATE SKIP LOCKED`, [this.org()]);
      for (const row of old.rows) {
        const digest = createHmac('sha256', this.config.WHATSAPP_RETENTION_HMAC_KEY).update(this.org() + ':' + row.phone).digest('hex');
        await client.query(`INSERT INTO whatsapp_consent_evidence
          (subscription_id,organization_id,phone_digest,purpose,policy_version,notice_version,source,confirmed_at,revoked_at,revoked_via)
          SELECT id,organization_id,$2,purpose,policy_version,notice_version,source,confirmed_at,revoked_at,revoked_via
          FROM whatsapp_subscriptions WHERE id=$1 AND confirmed_at IS NOT NULL
            AND revoked_at>=now()-interval '12 months' ON CONFLICT DO NOTHING`, [row.id,digest]);
        await client.query('DELETE FROM whatsapp_subscriptions WHERE id=$1', [row.id]);
      }
      await client.query(`DELETE FROM whatsapp_consent_evidence WHERE organization_id=$1 AND revoked_at<now()-interval '12 months'`, [this.org()]);
    });
  }

  private async sendServiceReply() {
    if (!this.org() || !this.config.WHATSAPP_ACCESS_TOKEN || !this.config.WHATSAPP_PHONE_NUMBER_ID) return;
    await this.db.pool.query('DELETE FROM whatsapp_service_replies WHERE organization_id=$1 AND expires_at<=now()', [this.org()]);
    // Claim once before the network call. An ambiguous provider result must not send a second reply.
    const claimed = await this.db.pool.query<{ phone: string; message: string }>(`
      DELETE FROM whatsapp_service_replies WHERE message_id=(
        SELECT message_id FROM whatsapp_service_replies WHERE organization_id=$1 AND expires_at>now()
        ORDER BY expires_at LIMIT 1 FOR UPDATE SKIP LOCKED
      ) RETURNING phone,message`, [this.org()]);
    const reply = claimed.rows[0];
    if (!reply) return;
    try {
      const response = await fetch(`https://graph.facebook.com/${this.config.WHATSAPP_GRAPH_API_VERSION}/${this.config.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: 'Bearer ' + this.config.WHATSAPP_ACCESS_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: reply.phone.slice(1), type: 'text', text: { body: reply.message } })
      });
      if (!response.ok) this.logger.warn({ status: response.status }, 'WhatsApp service reply rejected');
    } catch {
      this.logger.warn('WhatsApp service reply outcome unknown');
    }
  }

  private async disableWishlistTracking(client: DbClient, phone: string, before: Date) {
    await client.query(`DELETE FROM wishlist_alert_preferences
      WHERE organization_id=$1 AND channel='whatsapp' AND contact=$2 AND created_at<=$3`, [this.org(),phone,before]);
  }

  private org() { return this.config.PUBLIC_ORGANIZATION_ID; }
  private transaction<T>(fn: (client: DbClient) => Promise<T>) { return new TransactionManager(this.db.pool, this.logger).run(fn); }
  private lock(client: DbClient, phone: string) { return client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['wa:' + this.org() + ':' + phone]); }
  private async product(client: DbClient, variantId: string): Promise<Product | undefined> {
    if (!variantId) return undefined;
    const result = await client.query<Product>(`SELECT p.id AS product_id,p.name,v.name AS variant_name,p.slug,v.currency,v.current_price_amount::text AS regular_price,
      COALESCE((SELECT amount_minor FROM variant_prices WHERE organization_id=v.organization_id AND variant_id=v.id
        AND price_type='sale' AND cancelled_at IS NULL AND valid_from<=now() AND valid_until>now()
        AND amount_minor<v.current_price_amount ORDER BY valid_from DESC,created_at DESC LIMIT 1),v.current_price_amount)::text AS price,
      (SELECT COALESCE(sum(quantity),0)::text FROM inventory_balances WHERE organization_id=v.organization_id AND variant_id=v.id) AS stock
      FROM product_variants v JOIN products p ON p.id=v.product_id AND p.organization_id=v.organization_id
      WHERE v.organization_id=$1 AND v.id=$2 AND v.active AND v.published AND v.deleted_at IS NULL
      AND p.active AND p.published AND p.deleted_at IS NULL`, [this.org(), variantId]);
    return result.rows[0];
  }
}
