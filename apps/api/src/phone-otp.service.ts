import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import type { AppConfig } from '@daja/config';
import type { RedisConnection } from '@daja/database';
import { ValidationFailedError } from '@daja/security';
import { CONFIG, REDIS } from './tokens.js';
import { consumeLoginAttempt } from './login-attempts.js';

export type PhoneOtpPurpose = 'login' | 'link';
type PhoneOtpInput = {
  organizationId: string;
  phone: string;
  purpose: PhoneOtpPurpose;
  customerId?: string;
  browserNonce?: string;
};

@Injectable()
export class PhoneOtpService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: RedisConnection
  ) {}

  publicConfig() {
    if (!this.config.FIREBASE_PHONE_ENABLED || !this.config.FIREBASE_PHONE_PROJECT_ID ||
        !this.config.FIREBASE_PHONE_API_KEY || !this.config.FIREBASE_PHONE_APP_ID) return null;
    return {
      projectId: this.config.FIREBASE_PHONE_PROJECT_ID,
      apiKey: this.config.FIREBASE_PHONE_API_KEY,
      authDomain: `${this.config.FIREBASE_PHONE_PROJECT_ID}.firebaseapp.com`,
      appId: this.config.FIREBASE_PHONE_APP_ID
    };
  }

  private assertEnabled(): void {
    if (!this.publicConfig()) throw new ValidationFailedError('SMS verifikacija trenutno nije dostupna. Koristite email ili Google prijavu.');
  }

  private scope(input: PhoneOtpInput): string {
    return createHash('sha256').update(JSON.stringify([
      input.organizationId, input.phone, input.purpose, input.customerId ?? '', input.browserNonce ?? ''
    ])).digest('hex');
  }

  async start(input: PhoneOtpInput) {
    this.assertEnabled();
    if (!/^\+381[1-9]\d{6,11}$/.test(input.phone)) {
      throw new ValidationFailedError('SMS potvrda je trenutno dostupna samo za brojeve iz Srbije.');
    }
    await consumeLoginAttempt(this.config, `firebase-phone:send:${input.phone}`);
    const client = this.redis.client;
    if (client.status === 'wait') await client.connect();
    if (await client.set(`firebase-phone:cooldown:${input.phone}`, '1', 'EX', 60, 'NX') !== 'OK') {
      throw new ValidationFailedError('Sačekajte minut pre ponovnog slanja koda.');
    }
    const challengeToken = randomBytes(32).toString('hex');
    const challenge = JSON.stringify({ scope: this.scope(input), createdAt: Math.floor(Date.now() / 1000) });
    await client.set(`firebase-phone:challenge:${challengeToken}`, challenge, 'EX', 600);
    return { status: 'pending' as const, challengeToken, expiresInSeconds: 600, resendAfterSeconds: 60 };
  }

  async verify(input: PhoneOtpInput & { firebaseIdToken: string; challengeToken: string }) {
    this.assertEnabled();
    if (!/^\+381[1-9]\d{6,11}$/.test(input.phone)) {
      throw new ValidationFailedError('SMS potvrda je trenutno dostupna samo za brojeve iz Srbije.');
    }
    await consumeLoginAttempt(this.config, `firebase-phone:verify:${input.phone}`);
    const client = this.redis.client;
    if (client.status === 'wait') await client.connect();
    const key = `firebase-phone:challenge:${input.challengeToken}`;
    const raw = await client.get(key);
    if (!raw) throw new ValidationFailedError('Kod je istekao ili nije ispravan. Zatražite novi kod.');
    const challenge = JSON.parse(raw) as { scope: string; createdAt: number };
    if (challenge.scope !== this.scope(input)) throw new ValidationFailedError('Kod nije ispravan.');
    const projectId = this.config.FIREBASE_PHONE_PROJECT_ID;
    const appName = `daja-phone-${projectId}`;
    const app = getApps().find(item => item.name === appName) ?? initializeApp({ projectId }, appName);
    let token: DecodedIdToken;
    try { token = await getAuth(app).verifyIdToken(input.firebaseIdToken); }
    catch { throw new ValidationFailedError('Kod nije ispravan.'); }
    const now = Math.floor(Date.now() / 1000);
    if (token.phone_number !== input.phone || token.firebase.sign_in_provider !== 'phone' ||
        typeof token.auth_time !== 'number' || token.auth_time < challenge.createdAt - 5 ||
        token.auth_time > now + 5 || now - token.auth_time > 600 || token.iat > now + 5) {
      throw new ValidationFailedError('Kod je istekao ili nije ispravan. Zatražite novi kod.');
    }
    // Consume the challenge and proof atomically across API instances and purposes.
    const proof = createHash('sha256').update(`${projectId}:${token.uid}:${token.auth_time}`).digest('hex');
    const consumed = await client.eval(`
      if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      if not redis.call('SET', KEYS[2], '1', 'EX', 660, 'NX') then return 0 end
      redis.call('DEL', KEYS[1])
      return 1
    `, 2, key, `firebase-phone:used:${proof}`, raw);
    if (Number(consumed) !== 1) throw new ValidationFailedError('Kod je istekao ili nije ispravan. Zatražite novi kod.');
    return { status: 'verified' as const };
  }
}
