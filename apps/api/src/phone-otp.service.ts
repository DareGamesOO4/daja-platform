import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import type { AppConfig } from '@daja/config';
import type { RedisConnection } from '@daja/database';
import type { Logger } from '@daja/observability';
import { ValidationFailedError } from '@daja/security';
import { CONFIG, LOGGER, REDIS } from './tokens.js';

export type PhoneOtpPurpose = 'login' | 'link';

interface PhoneOtpChallenge {
  codeHash: string;
  attempts: number;
}

const OTP_TTL_SECONDS = 10 * 60;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_VERIFY_ATTEMPTS = 5;

@Injectable()
export class PhoneOtpService {
  private client: SNSClient | undefined;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(REDIS) private readonly redis: RedisConnection,
    @Inject(LOGGER) private readonly logger: Logger
  ) {}

  async start(input: {
    organizationId: string;
    phone: string;
    purpose: PhoneOtpPurpose;
    customerId?: string;
  }) {
    this.assertConfigured();
    const client = await this.redisClient();
    const scope = this.scope(input);
    const cooldown = await client.set(this.cooldownKey(scope), '1', 'EX', RESEND_COOLDOWN_SECONDS, 'NX');
    if (cooldown !== 'OK') {
      throw new ValidationFailedError('Sačekajte minut pre ponovnog slanja koda.');
    }

    const code = randomInt(100_000, 1_000_000).toString();
    const challenge: PhoneOtpChallenge = { codeHash: this.hash(scope, code), attempts: 0 };
    await client.set(this.challengeKey(scope), JSON.stringify(challenge), 'EX', OTP_TTL_SECONDS);

    try {
      const response = await this.getClient().send(
        new PublishCommand({
          PhoneNumber: input.phone,
          Message: `DajaShop kod za potvrdu je ${code}. Važi 10 minuta. Ne delite ga ni sa kim.`,
          MessageAttributes: {
            'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' },
            'AWS.SNS.SMS.SenderID': {
              DataType: 'String',
              StringValue: this.config.SNS_SMS_SENDER_ID
            }
          }
        })
      );
      this.logger.info(
        { messageId: response.MessageId, phoneLastFour: input.phone.slice(-4), purpose: input.purpose },
        'Phone verification SMS accepted by Amazon SNS'
      );
    } catch (error) {
      await client.del(this.challengeKey(scope), this.cooldownKey(scope));
      this.logger.error({ err: error, purpose: input.purpose }, 'Unable to send phone verification SMS');
      throw new ValidationFailedError('SMS kod trenutno nije moguće poslati. Pokušajte ponovo kasnije.');
    }

    return {
      status: 'sent' as const,
      expiresInSeconds: OTP_TTL_SECONDS,
      resendAfterSeconds: RESEND_COOLDOWN_SECONDS
    };
  }

  async verify(input: {
    organizationId: string;
    phone: string;
    purpose: PhoneOtpPurpose;
    code: string;
    customerId?: string;
  }) {
    const client = await this.redisClient();
    const scope = this.scope(input);
    const key = this.challengeKey(scope);
    const challenge = parseChallenge(await client.get(key));
    if (!challenge) {
      throw new ValidationFailedError('Kod je istekao ili nije ispravan. Zatražite novi kod.');
    }

    const expected = this.hash(scope, input.code);
    if (!safeHashEquals(challenge.codeHash, expected)) {
      const attempts = challenge.attempts + 1;
      if (attempts >= MAX_VERIFY_ATTEMPTS) {
        await client.del(key);
        throw new ValidationFailedError('Previše pogrešnih pokušaja. Zatražite novi kod.');
      }
      const ttl = await client.ttl(key);
      if (ttl > 0) await client.set(key, JSON.stringify({ ...challenge, attempts }), 'EX', ttl);
      throw new ValidationFailedError('Kod nije ispravan.');
    }

    await client.del(key);
    return { status: 'verified' as const };
  }

  private async redisClient() {
    const client = this.redis.client;
    if (client.status === 'wait') await client.connect();
    return client;
  }

  private assertConfigured(): void {
    if (!this.config.SNS_SMS_ACCESS_KEY_ID || !this.config.SNS_SMS_SECRET_ACCESS_KEY) {
      throw new ValidationFailedError('SMS verifikacija trenutno nije podešena.');
    }
  }

  private getClient(): SNSClient {
    if (!this.client) {
      this.client = new SNSClient({
        region: this.config.SNS_SMS_REGION,
        credentials: {
          accessKeyId: this.config.SNS_SMS_ACCESS_KEY_ID,
          secretAccessKey: this.config.SNS_SMS_SECRET_ACCESS_KEY
        }
      });
    }
    return this.client;
  }

  private scope(input: {
    organizationId: string;
    phone: string;
    purpose: PhoneOtpPurpose;
    customerId?: string;
  }): string {
    return [input.purpose, input.organizationId, input.customerId ?? 'anonymous', input.phone].join(':');
  }

  private challengeKey(scope: string): string {
    return `phone-otp:challenge:${scope}`;
  }

  private cooldownKey(scope: string): string {
    return `phone-otp:cooldown:${scope}`;
  }

  private hash(scope: string, code: string): string {
    return createHmac('sha256', this.config.JWT_ACCESS_SECRET).update(`${scope}:${code}`).digest('hex');
  }
}

function parseChallenge(raw: string | null): PhoneOtpChallenge | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PhoneOtpChallenge>;
    const attempts = value.attempts;
    if (
      typeof value.codeHash !== 'string' ||
      !Number.isInteger(attempts) ||
      attempts === undefined ||
      attempts < 0
    ) {
      return null;
    }
    return { codeHash: value.codeHash, attempts };
  } catch {
    return null;
  }
}

function safeHashEquals(first: string, second: string): boolean {
  const firstBuffer = Buffer.from(first, 'utf8');
  const secondBuffer = Buffer.from(second, 'utf8');
  return firstBuffer.length === secondBuffer.length && timingSafeEqual(firstBuffer, secondBuffer);
}
