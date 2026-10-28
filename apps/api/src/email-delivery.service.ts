import { Inject, Injectable } from '@nestjs/common';
import type { AppConfig } from '@daja/config';
import { enqueueEmail, type Database, type DbClient, type QueuedEmail } from '@daja/database';
import { CONFIG, DATABASE } from './tokens.js';

export type TransactionalEmail = QueuedEmail;

@Injectable()
export class EmailDeliveryService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database
  ) {}

  // Queue persistence does not require credentials for the separate sender process.
  async send(input: TransactionalEmail, client: DbClient = this.database.pool): Promise<void> {
    if (['novosti-potvrda', 'potvrda-email-adrese', 'promena-lozinke'].includes(input.tag)) {
      await client.query(
        `UPDATE email_deliveries SET status = 'expired', payload = '{}'::jsonb,
          last_error = 'Superseded by a newer link' WHERE recipient = ANY($1::text[])
          AND payload->>'tag' = $2 AND status = 'pending'`,
        [input.recipients.map((value) => value.trim().toLowerCase()), input.tag]
      );
    }
    await enqueueEmail(client, {
      ...input,
      fromEmail: input.fromEmail || this.config.SES_FROM_EMAIL,
      replyTo:
        input.replyTo ??
        (this.config.SES_REPLY_TO_EMAIL ? [this.config.SES_REPLY_TO_EMAIL] : undefined)
    });
  }
}
