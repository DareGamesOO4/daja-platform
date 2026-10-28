import { createHmac } from 'node:crypto';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import type { AppConfig } from '@daja/config';
import type { Logger } from '@daja/observability';
import { enqueueEmail, ProductAlertDispatcher, type Database } from '@daja/database';

export class ProductAlertWorker {
  private timer: NodeJS.Timeout | undefined;
  private task: Promise<void> | undefined;
  private sns: SNSClient | undefined;
  private stopping = false;

  constructor(private readonly config: AppConfig, private readonly logger: Logger, private readonly database: Database) {}

  start(): void {
    const secret = this.config.PRIVACY_TOKEN_SECRET || this.config.JWT_ACCESS_SECRET;
    if (!secret) {
      this.logger.warn('Product alert scheduler requires the same signing secret as the API; persisted events remain pending');
      return;
    }
    const dispatcher = new ProductAlertDispatcher(this.config, this.database, this.logger, {
      send: (input, client = this.database.pool) => enqueueEmail(client, {
        ...input, replyTo: this.config.SES_REPLY_TO_EMAIL ? [this.config.SES_REPLY_TO_EMAIL] : []
      })
    }, {
      send: async input => {
        if (!this.config.SNS_SMS_ACCESS_KEY_ID || !this.config.SNS_SMS_SECRET_ACCESS_KEY) {
          this.logger.warn({ tag: input.tag }, 'Product alert SMS sender is not configured');
          return;
        }
        try {
          this.sns ??= new SNSClient({ region: this.config.SNS_SMS_REGION, credentials: {
            accessKeyId: this.config.SNS_SMS_ACCESS_KEY_ID, secretAccessKey: this.config.SNS_SMS_SECRET_ACCESS_KEY
          } });
          await this.sns.send(new PublishCommand({ PhoneNumber: input.phone, Message: input.message,
            MessageAttributes: {
              'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' },
              'AWS.SNS.SMS.SenderID': { DataType: 'String', StringValue: this.config.SNS_SMS_SENDER_ID }
            } }), { abortSignal: AbortSignal.timeout(20_000) });
        } catch (error) {
          this.logger.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Product alert SMS failed');
        }
      }
    }, {
      productAlertUnsubscribeUrl: id => {
        const signature = createHmac('sha256', secret).update('product_alert:' + id).digest('base64url');
        const base = this.config.API_PUBLIC_BASE_URL.replace(/\/$/, '').replace(/\/api\/v1$/, '');
        return `${base}/api/v1/privacy/unsubscribe/product-alert?token=${encodeURIComponent(id + '.' + signature)}`;
      }
    });
    const run = () => {
      if (this.stopping || this.task) return;
      this.task = (async () => {
        await dispatcher.dispatchDueBackInStock();
        if (!this.stopping) await dispatcher.dispatchDueRegularPriceChanges();
        if (!this.stopping) await dispatcher.dispatchDueSaleStarts();
      })().catch(error => this.logger.error({ err: error }, 'Product alert scheduling failed'))
        .finally(() => { this.task = undefined; });
    };
    this.timer = setInterval(run, 60_000);
    this.timer.unref();
    run();
  }

  async close(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.task;
    this.sns?.destroy();
  }
}
