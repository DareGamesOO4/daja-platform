import { Body, Controller, Inject, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import type { AppConfig } from '@daja/config';
import { brandedEmail, emailEscape } from '@daja/shared';
import { parseWithSchema } from '@daja/validation';
import { EmailDeliveryService } from './email-delivery.service.js';
import { CONFIG } from './tokens.js';

const contactSchema = z.object({
  name: z.string().trim().min(2).max(160),
  email: z.string().trim().email().max(240),
  phone: z.string().trim().max(60).optional(),
  message: z.string().trim().min(10).max(5000),
  website: z.string().max(200).optional(),
  requestId: z.string().uuid()
});

@Controller('contact')
export class ContactController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(EmailDeliveryService) private readonly email: EmailDeliveryService
  ) {}

  @Post()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async submit(@Body() body: unknown) {
    const input = parseWithSchema(contactSchema, body);
    if (input.website) return { status: 'accepted' };
    const details = `<p><strong>Ime:</strong> ${emailEscape(input.name)}<br><strong>Email:</strong> ${emailEscape(input.email)}<br><strong>Telefon:</strong> ${emailEscape(input.phone || 'Nije unet')}</p>`;
    await this.email.send({
      recipients: [this.config.CONTACT_NOTIFICATION_EMAIL],
      fromEmail: this.config.SES_ACCOUNT_FROM_EMAIL || this.config.SES_FROM_EMAIL,
      replyTo: [input.email],
      subject: 'Nova poruka sa kontakt forme | DajaShop',
      text: `Ime: ${input.name}\nEmail: ${input.email}\nTelefon: ${input.phone || 'Nije unet'}\n\n${input.message}`,
      html: brandedEmail({
        siteUrl: this.config.STOREFRONT_PUBLIC_BASE_URL,
        eyebrow: 'KONTAKT SA SAJTA',
        title: 'Stigla je nova poruka.',
        content:
          details +
          `<p style="white-space:pre-wrap">${emailEscape(input.message).replace(/\n/g, '<br>')}</p>`,
        footer: 'Odgovorom na ovu poruku kontaktirate direktno osobu koja je poslala upit.'
      }),
      tag: 'contact-message',
      deduplicationKey: `contact:${input.requestId}`
    });
    return { status: 'accepted' };
  }
}
