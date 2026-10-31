import { createHmac, randomInt } from 'node:crypto';
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
          Message: `DajaShop kod za potvrdu: ${code}. Traje 10 min. Ne delite ga ni sa kim.`,
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
    // Compare, count and consume in one Redis operation. Separate GET/SET/DEL
    // allowed concurrent wrong guesses to overwrite each other's attempt count,
    // and concurrent correct guesses to consume the same one-time code twice.
    const result = Number(await client.eval(`
      local raw = redis.call('GET', KEYS[1])
      if not raw then return 0 end
      local ok, challenge = pcall(cjson.decode, raw)
      if not ok or type(challenge) ~= 'table' or type(challenge.codeHash) ~= 'string'
          or #challenge.codeHash ~= 64 or type(challenge.attempts) ~= 'number'
          or challenge.attempts < 0 or challenge.attempts >= tonumber(ARGV[2]) then
        redis.call('DEL', KEYS[1])
        return 0
      end
      local difference = 0
      for i = 1, 64 do
        difference = bit.bor(difference, bit.bxor(string.byte(challenge.codeHash, i), string.byte(ARGV[1], i)))
      end
      if difference == 0 then redis.call('DEL', KEYS[1]); return 1 end
      challenge.attempts = challenge.attempts + 1
      local ttl = redis.call('PTTL', KEYS[1])
      if challenge.attempts >= tonumber(ARGV[2]) or ttl <= 0 then
        redis.call('DEL', KEYS[1])
        return -2
      end
      redis.call('SET', KEYS[1], cjson.encode(challenge), 'PX', ttl)
      return -1
    `, 1, key, this.hash(scope, input.code), MAX_VERIFY_ATTEMPTS));
    if (result === 0) {
      throw new ValidationFailedError('Kod je istekao ili nije ispravan. Zatražite novi kod.');
    }
    if (result === -2) throw new ValidationFailedError('Previše pogrešnih pokušaja. Zatražite novi kod.');
    if (result !== 1) {
      throw new ValidationFailedError('Kod nije ispravan.');
    }
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
