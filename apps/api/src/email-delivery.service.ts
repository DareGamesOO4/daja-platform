import { Inject, Injectable } from '@nestjs/common';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { AppConfig } from '@daja/config';
import type { Logger } from '@daja/observability';
import { CONFIG, LOGGER } from './tokens.js';

export interface TransactionalEmail {
  recipients: string[];
  subject: string;
  text: string;
  html: string;
  tag: string;
  fromEmail?: string;
}

@Injectable()
export class EmailDeliveryService {
  private client: SESv2Client | undefined;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger
  ) {}

  async send(input: TransactionalEmail): Promise<void> {
    const recipients = uniqueEmailAddresses(input.recipients);
    if (!recipients.length) {
      this.logger.warn({ tag: input.tag }, 'Transactional email skipped because it has no valid recipient');
      return;
    }
    if (!this.isConfigured()) {
      this.logger.warn({ tag: input.tag }, 'Transactional email skipped because Amazon SES is not configured');
      return;
    }

    try {
      const response = await this.getClient().send(
        new SendEmailCommand({
          FromEmailAddress: input.fromEmail || this.config.SES_FROM_EMAIL,
          Destination: { ToAddresses: recipients },
          ReplyToAddresses: this.config.SES_REPLY_TO_EMAIL
            ? [this.config.SES_REPLY_TO_EMAIL]
            : undefined,
          Content: {
            Simple: {
              Subject: { Charset: 'UTF-8', Data: input.subject },
              Body: {
                Text: { Charset: 'UTF-8', Data: input.text },
                Html: { Charset: 'UTF-8', Data: input.html }
              }
            }
          },
          EmailTags: [{ Name: 'type', Value: input.tag }]
        })
      );
      this.logger.info({ messageId: response.MessageId, recipients, tag: input.tag }, 'Transactional email sent');
    } catch (error) {
      this.logger.error({ err: error, recipients, tag: input.tag }, 'Unable to send transactional email');
    }
  }

  private isConfigured(): boolean {
    return Boolean(
      this.config.SES_ACCESS_KEY_ID &&
        this.config.SES_SECRET_ACCESS_KEY &&
        this.config.SES_FROM_EMAIL
    );
  }

  private getClient(): SESv2Client {
    if (!this.client) {
      this.client = new SESv2Client({
        region: this.config.SES_REGION,
        credentials: {
          accessKeyId: this.config.SES_ACCESS_KEY_ID,
          secretAccessKey: this.config.SES_SECRET_ACCESS_KEY
        }
      });
    }
    return this.client;
  }
}

function uniqueEmailAddresses(values: string[]): string[] {
  const unique = new Set<string>();
  for (const value of values) {
    const email = value.trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) unique.add(email);
  }
  return [...unique];
}
