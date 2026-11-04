import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@daja/config';
import type { RedisConnection } from '@daja/database';
import { ValidationFailedError } from '@daja/security';
import { CONFIG, REDIS } from './tokens.js';
import { consumeLoginAttempt } from './login-attempts.js';

type Input = {
  organizationId: string;
  phone: string;
  purpose: 'login' | 'link';
  customerId?: string | undefined;
  browserNonce?: string | undefined;
};

const unavailable = 'WhatsApp verifikacija trenutno nije dostupna. Izaberite SMS ili email.';
const invalid = 'Kod je istekao ili nije ispravan. Zatražite novi kod.';

@Injectable()
export class WhatsAppOtpService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: RedisConnection
  ) {}

  available(): boolean {
    return this.config.WHATSAPP_OTP_ENABLED && this.config.WHATSAPP_OTP_TEMPLATES_APPROVED &&
      Boolean(this.config.WHATSAPP_ACCESS_TOKEN && this.config.WHATSAPP_PHONE_NUMBER_ID &&
        this.config.WHATSAPP_GRAPH_API_VERSION && this.config.WHATSAPP_OTP_TEMPLATE_NAME &&
        this.config.WHATSAPP_OTP_SECRET.length >= 32);
  }

  private scope(input: Input): string {
    return createHash('sha256').update(JSON.stringify([
      'whatsapp', input.organizationId, input.phone, input.purpose,
      input.customerId ?? '', input.browserNonce ?? ''
    ])).digest('hex');
  }

  private digest(token: string, scope: string, code: string): string {
    return createHmac('sha256', this.config.WHATSAPP_OTP_SECRET)
      .update(JSON.stringify([token, scope, code])).digest('hex');
  }

  async start(input: Input & { language: 'sr' | 'en' }) {
    if (!this.available()) throw new ValidationFailedError(unavailable);
    if (!/^\+381[1-9]\d{6,11}$/.test(input.phone)) {
      throw new ValidationFailedError('WhatsApp potvrda je trenutno dostupna samo za brojeve iz Srbije.');
    }
    // Share the SMS send budget and cooldown; switching channels must not bypass them.
    await consumeLoginAttempt(this.config, `firebase-phone:send:${input.phone}`);
    const client = this.redis.client;
    if (client.status === 'wait') await client.connect();
    if (await client.set(`firebase-phone:cooldown:${input.phone}`, '1', 'EX', 60, 'NX') !== 'OK') {
      throw new ValidationFailedError('Sačekajte minut pre ponovnog slanja koda.');
    }
    const budget = Number(await client.eval(`
      local n = redis.call('INCR', KEYS[1])
      if n == 1 then redis.call('EXPIRE', KEYS[1], 86400) end
      return n
    `, 1, 'whatsapp-otp:daily-budget'));
    if (budget > this.config.WHATSAPP_OTP_DAILY_LIMIT) throw new ValidationFailedError(unavailable);

    const challengeToken = randomBytes(32).toString('hex');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const scope = this.scope(input);
    const key = `whatsapp-otp:challenge:${challengeToken}`;
    await client.eval(`
      redis.call('HSET', KEYS[1], 'scope', ARGV[1], 'digest', ARGV[2], 'attempts', '0', 'sent', '0')
      redis.call('EXPIRE', KEYS[1], 300)
      return 1
    `, 1, key, scope, this.digest(challengeToken, scope, code));
    try {
      const response = await fetch(`https://graph.facebook.com/${this.config.WHATSAPP_GRAPH_API_VERSION}/${this.config.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
        body: JSON.stringify({
          messaging_product: 'whatsapp', to: input.phone.slice(1), type: 'template',
          template: {
            name: this.config.WHATSAPP_OTP_TEMPLATE_NAME,
            language: { code: input.language },
            components: [
              { type: 'body', parameters: [{ type: 'text', text: code }] },
              { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] }
            ]
          }
        })
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error('provider_rejected'); }
      const data = await response.json() as { messages?: Array<{ id?: string; message_status?: string }> };
      const message = data.messages?.[0];
      if (!message?.id || (message.message_status && message.message_status !== 'accepted')) throw new Error('provider_not_accepted');
      await client.hset(key, 'sent', '1');
      return { status: 'sent' as const, channel: 'whatsapp' as const, challengeToken, expiresInSeconds: 300, resendAfterSeconds: 60 };
    } catch {
      await client.del(key);
      // Never log provider payloads, tokens, recipient numbers, or OTP values.
      // No automatic retry: a timed-out send might already have been accepted.
      throw new ValidationFailedError('WhatsApp kod nije poslat. Pokušajte kasnije ili izaberite SMS.');
    }
  }

  async verify(input: Input & { challengeToken: string; code: string }) {
    if (!this.available()) throw new ValidationFailedError(unavailable);
    await consumeLoginAttempt(this.config, `firebase-phone:verify:${input.phone}`);
    const client = this.redis.client;
    if (client.status === 'wait') await client.connect();
    const scope = this.scope(input);
    const consumed = Number(await client.eval(`
      if redis.call('HGET', KEYS[1], 'scope') ~= ARGV[1] then return 0 end
      if redis.call('HGET', KEYS[1], 'sent') ~= '1' then return 0 end
      local attempts = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
      if attempts > 5 then redis.call('DEL', KEYS[1]); return 0 end
      if redis.call('HGET', KEYS[1], 'digest') ~= ARGV[2] then
        if attempts == 5 then redis.call('DEL', KEYS[1]) end
        return 0
      end
      redis.call('DEL', KEYS[1])
      return 1
    `, 1, `whatsapp-otp:challenge:${input.challengeToken}`, scope, this.digest(input.challengeToken, scope, input.code)));
    if (consumed !== 1) throw new ValidationFailedError(invalid);
    return { status: 'verified' as const };
  }
}
