import { Injectable, Inject } from '@nestjs/common';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { AppConfig } from '@daja/config';
import type { Logger } from '@daja/observability';
import { CONFIG, LOGGER } from './tokens.js';

@Injectable()
export class NewsletterEmailService {
  private client: SESv2Client | undefined;

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger
  ) {}

  async sendWelcomeEmail(recipient: string): Promise<void> {
    if (!this.isConfigured()) {
      this.logger.warn('Newsletter welcome email skipped because Amazon SES is not configured');
      return;
    }

    try {
      const response = await this.getClient().send(
        new SendEmailCommand({
          FromEmailAddress: this.config.SES_FROM_EMAIL,
          Destination: { ToAddresses: [recipient] },
          ReplyToAddresses: this.config.SES_REPLY_TO_EMAIL
            ? [this.config.SES_REPLY_TO_EMAIL]
            : undefined,
          Content: {
            Simple: {
              Subject: { Charset: 'UTF-8', Data: 'Dobro došli u DajaShop newsletter' },
              Body: {
                Text: {
                  Charset: 'UTF-8',
                  Data:
                    'Hvala što ste se prijavili na DajaShop newsletter. Prvi saznajte za nove proizvode, akcije i posebne ponude.'
                },
                Html: {
                  Charset: 'UTF-8',
                  Data:
                    '<!doctype html><html lang="sr"><body style="margin:0;background:#f6f6f6;font-family:Arial,sans-serif;color:#1f1f1f"><main style="max-width:560px;margin:32px auto;background:#fff;padding:40px;border-radius:12px"><h1 style="margin:0 0 16px;font-size:26px">Dobro došli u DajaShop</h1><p style="font-size:16px;line-height:1.6">Hvala što ste se prijavili na naš newsletter.</p><p style="font-size:16px;line-height:1.6">Prvi saznajte za nove proizvode, akcije i posebne ponude.</p><p style="margin:28px 0 0;font-size:14px;color:#666">DajaShop</p></main></body></html>'
                }
              }
            }
          },
          EmailTags: [{ Name: 'type', Value: 'newsletter-welcome' }]
        })
      );
      this.logger.info({ messageId: response.MessageId }, 'Newsletter welcome email sent');
    } catch (error) {
      // A successful subscription must not fail because SES is temporarily unavailable.
      this.logger.error({ err: error }, 'Unable to send newsletter welcome email');
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
