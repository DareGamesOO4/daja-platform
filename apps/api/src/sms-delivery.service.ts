import { Inject, Injectable } from '@nestjs/common';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import type { AppConfig } from '@daja/config';
import type { Logger } from '@daja/observability';
import { CONFIG, LOGGER } from './tokens.js';

export interface TransactionalSms {
  phone: string;
  message: string;
  tag: string;
}

@Injectable()
export class SmsDeliveryService {
  private client: SNSClient | undefined;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger
  ) {}

  async send(input: TransactionalSms): Promise<void> {
    const phone = normalizePhone(input.phone);
    if (!phone) {
      this.logger.warn({ tag: input.tag }, 'Transactional SMS skipped because it has no valid recipient');
      return;
    }
    if (!this.isConfigured()) {
      this.logger.warn({ tag: input.tag }, 'Transactional SMS skipped because Amazon SNS is not configured');
      return;
    }

    try {
      const response = await this.getClient().send(
        new PublishCommand({
          PhoneNumber: phone,
          Message: input.message,
          MessageAttributes: {
            'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' },
            'AWS.SNS.SMS.SenderID': {
              DataType: 'String',
              StringValue: this.config.SNS_SMS_SENDER_ID
            }
          }
        })
      );
      this.logger.info({ messageId: response.MessageId, phone, tag: input.tag }, 'Transactional SMS sent');
    } catch (error) {
      this.logger.error({ err: error, phone, tag: input.tag }, 'Unable to send transactional SMS');
    }
  }

  private isConfigured(): boolean {
    return Boolean(this.config.SNS_SMS_ACCESS_KEY_ID && this.config.SNS_SMS_SECRET_ACCESS_KEY);
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
}

function normalizePhone(value: string): string | null {
  const normalized = value.trim().replace(/[\s()-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
}
