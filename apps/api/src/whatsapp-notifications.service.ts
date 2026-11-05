import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import type { AppConfig } from '@daja/config';
import { TransactionManager, type Database, type DbClient } from '@daja/database';
import type { Logger } from '@daja/observability';
import { ValidationFailedError } from '@daja/security';
import { z } from 'zod';
import { CONFIG, DATABASE, LOGGER, REDIS } from './tokens.js';
import type { RedisConnection } from '@daja/database';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const unavailable = 'WhatsApp obaveštenja još nisu dostupna. Za sada izaberite Email.';
const webhookSchema = z.object({ object: z.literal('whatsapp_business_account'), entry: z.array(z.object({
  id: z.string(), changes: z.array(z.object({ field: z.string(), value: z.object({
    metadata: z.object({ phone_number_id: z.string() }).optional(),
    messages: z.array(z.object({ id: z.string().max(300), from: z.string().regex(/^\d{8,15}$/),
      timestamp: z.string(), text: z.object({ body: z.string().max(4096) }).optional(),
      button: z.object({ text: z.string().max(100), payload: z.string().max(100) }).optional()
    })).max(100).optional(),
    statuses: z.array(z.object({ id: z.string().max(300), status: z.string(),
      errors: z.array(z.object({ code: z.number() })).optional()
    })).max(100).optional()
  }) })).max(100)
})).max(100) });

type Purpose = 'newsletter' | 'price_change' | 'back_in_stock';
type Subscription = { id: string; phone: string; purpose: Purpose; language: 'sr' | 'en'; variant_id: string | null; last_price: string | null };
type Product = { product_id: string; name: string; slug: string; price: string; currency: string; stock: string };

@Injectable()
export class WhatsAppNotificationsService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  constructor(@Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(REDIS) private readonly redis: RedisConnection) {}

  available() {
    const c = this.config;
    return c.WHATSAPP_NOTIFICATIONS_ENABLED && c.WHATSAPP_NOTIFICATION_TEMPLATES_APPROVED &&
      Boolean(c.PUBLIC_ORGANIZATION_ID && c.WHATSAPP_ACCESS_TOKEN && c.WHATSAPP_PHONE_NUMBER_ID &&
        c.WHATSAPP_GRAPH_API_VERSION && c.WHATSAPP_BUSINESS_PHONE && c.WHATSAPP_APP_SECRET.length >= 32 &&
        c.WHATSAPP_WEBHOOK_VERIFY_TOKEN.length >= 32);
  }

  async request(input: { phone: string; purpose: Purpose; productId?: string | undefined;
    variantId?: string | undefined; policyVersion?: string | undefined; source?: string | undefined; language: 'sr' | 'en' }) {
    if (!this.available()) throw new ValidationFailedError(unavailable);
    if (input.purpose === 'back_in_stock' && !this.config.WHATSAPP_STOCK_ALERTS_ENABLED) {
      throw new ValidationFailedError('WhatsApp obaveštenje o povratku na stanje nije uključeno.');
    }
    const phone = input.phone.replace(/[\s()-]/g, '');
    if (!/^\+381[1-9]\d{6,11}$/.test(phone)) throw new ValidationFailedError('Unesite broj telefona u međunarodnom formatu, npr. +381601234567.');
    const token = randomBytes(24).toString('hex');
    await this.transaction(async client => {
      await this.lock(client, phone);
      const recent = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM whatsapp_subscriptions
        WHERE organization_id=$1 AND phone=$2 AND created_at>now()-interval '1 hour'`, [this.org(), phone]);
      if ((recent.rows[0]?.count ?? 0) >= 5) throw new ValidationFailedError('Sačekajte pre ponovne prijave na WhatsApp.');
      if (input.purpose !== 'newsletter') {
        const p = await this.product(client, input.variantId ?? '');
        if (!p || p.product_id !== input.productId) throw new ValidationFailedError('Artikal više nije dostupan.');
      }
      await client.query(`INSERT INTO whatsapp_subscriptions
        (organization_id,phone,purpose,product_id,variant_id,policy_version,source,token_hash,language,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '30 minutes')`,
        [this.org(), phone, input.purpose, input.productId ?? null, input.variantId ?? null,
          input.policyVersion ?? '2026-09-01-draft', input.source ?? 'site', hash(token), input.language]);
    });
    // Sending this message from WhatsApp proves control of the requested number.
    return { active: false, requiresWhatsAppConfirmation: true, confirmationToken: token,
      whatsappUrl: `https://wa.me/${this.config.WHATSAPP_BUSINESS_PHONE.slice(1)}?text=${encodeURIComponent('DAJA ' + token)}` };
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
      }
      for (const message of value.messages ?? []) await this.transaction(async client => {
        const phone = '+' + message.from;
        await this.lock(client, phone);
        const receipt = await client.query(`INSERT INTO whatsapp_webhook_receipts(message_id) VALUES($1)
          ON CONFLICT DO NOTHING RETURNING message_id`, [message.id]);
        if (!receipt.rowCount) return;
        const text = (message.text?.body ?? message.button?.payload ?? message.button?.text ?? '').trim();
        const eventAt = new Date(Number(message.timestamp) * 1000);
        if (!Number.isFinite(eventAt.getTime()) || eventAt.getTime() > Date.now() + 300_000) return;
        if (/^(STOP|ODJAVA|UNSUBSCRIBE|PREKINI)$/i.test(text)) {
          await client.query(`UPDATE whatsapp_subscriptions SET active=false,revoked_at=now(),updated_at=now()
            WHERE organization_id=$1 AND phone=$2 AND revoked_at IS NULL AND created_at<=$3
              AND (confirmed_at IS NULL OR confirmed_at<=$3)`, [this.org(), phone, new Date(eventAt.getTime() + 999)]);
          await client.query(`UPDATE whatsapp_deliveries d SET state='cancelled',updated_at=now()
            FROM whatsapp_subscriptions s WHERE d.subscription_id=s.id AND s.organization_id=$1 AND s.phone=$2
              AND s.revoked_at IS NOT NULL AND d.state='queued'`, [this.org(), phone]);
          return;
        }
        const match = /^DAJA ([a-f0-9]{48})$/i.exec(text);
        if (!match || !this.available()) return;
        const result = await client.query<Subscription>(`SELECT id,phone,purpose,language,variant_id,last_price FROM whatsapp_subscriptions
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
        await client.query(`UPDATE whatsapp_subscriptions SET active=true,confirmed_at=$3,last_price=$2,updated_at=now() WHERE id=$1`, [s.id, p?.price ?? null, eventAt]);
        // Only send a session reply for a freshly received opt-in, inside the 24-hour window.
        if (eventAt.getTime() > Date.now() - 23 * 3600_000) {
          const label = s.language === 'en' ? (s.purpose === 'newsletter' ? 'news and offers' : s.purpose === 'price_change'
            ? 'price changes for ' + p!.name.slice(0, 150) : 'back-in-stock updates for ' + p!.name.slice(0, 150))
            : s.purpose === 'newsletter' ? 'novosti i ponude' : s.purpose === 'price_change'
              ? 'promene cene artikla ' + p!.name.slice(0, 150) : 'povratak na stanje artikla ' + p!.name.slice(0, 150);
          await client.query(`INSERT INTO whatsapp_deliveries(subscription_id,dedupe_key,template_name,kind,parameters,expires_at)
            VALUES($1,$2,'session_confirmation','text',$3::jsonb,$4) ON CONFLICT(dedupe_key) DO NOTHING`,
            [s.id,'confirmation:' + s.id, JSON.stringify([s.language === 'en'
              ? 'DajaShop: your WhatsApp subscription is confirmed for ' + label + '. Reply STOP to unsubscribe.'
              : 'DajaShop: potvrđena je WhatsApp prijava za ' + label + '. Za odjavu odgovorite STOP.']), new Date(eventAt.getTime() + 23 * 3600_000)]);
        }
      });
    }
  }

  async campaign(organizationId: string, campaignId: string, text: string, language: 'sr' | 'en') {
    if (!this.available() || organizationId !== this.org()) throw new ValidationFailedError(unavailable);
    return this.transaction(async client => {
    const campaign = await client.query(`INSERT INTO whatsapp_campaigns(organization_id,id,content_hash)
      VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`, [organizationId,campaignId,hash(language + ':' + text)]);
    if (!campaign.rowCount) {
      const existing = await client.query<{ content_hash: string }>('SELECT content_hash FROM whatsapp_campaigns WHERE organization_id=$1 AND id=$2', [organizationId,campaignId]);
      if (existing.rows[0]?.content_hash !== hash(language + ':' + text)) throw new ValidationFailedError('Za izmenjenu poruku napravite novu kampanju.');
      return { queued: 0 };
    }
    const result = await client.query(`INSERT INTO whatsapp_deliveries(subscription_id,dedupe_key,template_name,parameters)
      SELECT id,$2||':'||id::text,$3,jsonb_build_array($4::text) FROM whatsapp_subscriptions
      WHERE organization_id=$1 AND purpose='newsletter' AND language=$5 AND active AND confirmed_at IS NOT NULL AND revoked_at IS NULL
      ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
      [organizationId, 'campaign:' + campaignId, this.config.WHATSAPP_NEWSLETTER_TEMPLATE, text, language]);
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
    if (!this.available()) return;
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
      const targets = await client.query<Subscription>(`SELECT id,phone,purpose,language,variant_id,last_price FROM whatsapp_subscriptions
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
          const parameters = stock ? [p.name.slice(0, 200), money(p.price), url]
            : [p.name.slice(0, 200), money(s.last_price!), money(p.price), url];
          await client.query(`INSERT INTO whatsapp_deliveries(subscription_id,dedupe_key,template_name,parameters)
            VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(dedupe_key) DO NOTHING`,
            [s.id, stock ? 'stock:' + s.id : 'price:' + s.id + ':' + s.last_price + ':' + p.price + ':' + Date.now(),
              stock ? this.config.WHATSAPP_STOCK_TEMPLATE : this.config.WHATSAPP_PRICE_TEMPLATE, JSON.stringify(parameters)]);
        }
        await client.query(`UPDATE whatsapp_subscriptions SET last_price=$2,updated_at=now() WHERE id=$1`, [s.id, p.price]);
      }
    });
    // One outbound attempt per tick. Persist before calling Meta; never blindly retry an ambiguous send.
    await this.transaction(async client => {
      const picked = await client.query<{ id: string; subscription_id: string; phone: string; language: string; template_name: string; kind: string; parameters: string[] }>(
        `SELECT d.id,d.subscription_id,s.phone,s.language,d.template_name,d.kind,d.parameters FROM whatsapp_deliveries d
         JOIN whatsapp_subscriptions s ON s.id=d.subscription_id WHERE d.state='queued' AND s.organization_id=$1
         AND s.active AND s.revoked_at IS NULL AND s.confirmed_at IS NOT NULL ORDER BY d.created_at LIMIT 1 FOR UPDATE OF d SKIP LOCKED`, [this.org()]);
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
        const owner = await client.query<Subscription>(`SELECT id,phone,purpose,language,variant_id,last_price FROM whatsapp_subscriptions WHERE id=$1 AND active AND revoked_at IS NULL`, [item.subscription_id]);
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
          const response = await fetch(`https://graph.facebook.com/${this.config.WHATSAPP_GRAPH_API_VERSION}/${this.config.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
            headers: { Authorization: 'Bearer ' + this.config.WHATSAPP_ACCESS_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ messaging_product: 'whatsapp', to: item.phone.slice(1), ...(item.kind === 'text'
              ? { type: 'text', text: { body: item.parameters[0] } }
              : { type: 'template', template: {
              name: item.template_name, language: { code: item.language },
              components: [{ type: 'body', parameters: item.parameters.map(text => ({ type: 'text', text })) }]
            } }) })
          });
          const data = await response.json() as { messages?: Array<{ id?: string }>; error?: { code?: number } };
          providerId = data.messages?.[0]?.id ?? null;
          state = response.ok && providerId ? 'accepted' : response.status >= 400 && response.status < 500 && data.error?.code ? 'failed' : 'unknown';
          errorCode = data.error?.code?.toString() ?? null;
        } catch { errorCode = 'ambiguous_provider_response'; }
        await client.query(`UPDATE whatsapp_deliveries SET state=$2,provider_id=$3,error_code=$4,updated_at=now() WHERE id=$1`, [item.id,state,providerId,errorCode]);
        if (state === 'accepted' && item.kind === 'template') await client.query(`UPDATE whatsapp_subscriptions SET active=false,updated_at=now() WHERE id=$1 AND purpose='back_in_stock'`, [item.subscription_id]);
      });
    });
    await this.db.pool.query(`DELETE FROM whatsapp_webhook_receipts WHERE received_at<now()-interval '30 days'`);
    await this.db.pool.query(`DELETE FROM whatsapp_delivery_statuses WHERE updated_at<now()-interval '30 days'`);
    await this.db.pool.query(`DELETE FROM whatsapp_subscriptions WHERE confirmed_at IS NULL AND expires_at<now()-interval '1 day'`);
  }

  private org() { return this.config.PUBLIC_ORGANIZATION_ID; }
  private transaction<T>(fn: (client: DbClient) => Promise<T>) { return new TransactionManager(this.db.pool, this.logger).run(fn); }
  private lock(client: DbClient, phone: string) { return client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['wa:' + this.org() + ':' + phone]); }
  private async product(client: DbClient, variantId: string): Promise<Product | undefined> {
    if (!variantId) return undefined;
    const result = await client.query<Product>(`SELECT p.id AS product_id,p.name,p.slug,v.currency,
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
