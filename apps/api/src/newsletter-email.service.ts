import { Injectable, Inject } from '@nestjs/common';
import type { AppConfig } from '@daja/config';
import { CONFIG } from './tokens.js';
import { EmailDeliveryService } from './email-delivery.service.js';

@Injectable()
export class NewsletterEmailService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly delivery: EmailDeliveryService
  ) {}

  async sendNewsletterConfirmationEmail(input: {
    recipient: string;
    confirmationUrl: string;
  }): Promise<void> {
    const confirmationUrl = escapeHtml(input.confirmationUrl);
    await this.sendEmail({
      recipient: input.recipient,
      subject: 'Potvrdite prijavu na DajaShop newsletter',
      text: `Potvrdite prijavu na DajaShop newsletter otvaranjem ovog linka: ${input.confirmationUrl}`,
      html:
        '<!doctype html><html lang="sr"><body style="margin:0;background:#f6f6f6;font-family:Arial,sans-serif;color:#1f1f1f"><main style="max-width:560px;margin:32px auto;background:#fff;padding:40px;border-radius:12px"><h1 style="margin:0 0 16px;font-size:26px">Potvrdite prijavu</h1><p style="font-size:16px;line-height:1.6">Jos samo jedan korak vas deli od DajaShop newslettera.</p><p style="margin:28px 0"><a href="' +
        confirmationUrl +
        '" style="display:inline-block;background:#111;color:#fff;padding:14px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Potvrdite email adresu</a></p><p style="font-size:14px;line-height:1.6;color:#666">Link vazi 24 sata. Ako niste vi zatrazili prijavu, slobodno zanemarite ovu poruku.</p></main></body></html>',
      tag: 'newsletter-confirmation'
    });
  }

  async sendAccountVerificationEmail(input: {
    recipient: string;
    verificationUrl: string;
  }): Promise<void> {
    const verificationUrl = escapeHtml(input.verificationUrl);
    await this.sendEmail({
      recipient: input.recipient,
      fromEmail: dajaShopSender(this.config.SES_ACCOUNT_FROM_EMAIL || this.config.SES_FROM_EMAIL),
      subject: 'Potvrdite email adresu za DajaShop nalog',
      text: `Otvorite ovaj link da potvrdite email adresu za svoj DajaShop nalog: ${input.verificationUrl}\n\nLink vazi 15 minuta.`,
      html:
        '<!doctype html><html lang="sr"><body style="margin:0;background:#f6f6f6;font-family:Arial,sans-serif;color:#1f1f1f"><main style="max-width:560px;margin:32px auto;background:#fff;padding:40px;border-radius:12px"><h1 style="margin:0 0 16px;font-size:26px">Potvrdite email adresu</h1><p style="font-size:16px;line-height:1.6">Otvorite dugme ispod da potvrdite email adresu svog DajaShop naloga.</p><p style="margin:28px 0"><a href="' +
        verificationUrl +
        '" style="display:inline-block;background:#111;color:#fff;padding:14px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Potvrdi email adresu</a></p><p style="font-size:14px;line-height:1.6;color:#666">Link vazi 15 minuta i moze da se iskoristi samo jednom. Ako niste vi zatrazili verifikaciju, slobodno zanemarite ovu poruku.</p></main></body></html>',
      tag: 'account-email-verification'
    });
  }

  async sendWelcomeEmail(input: { recipient: string; unsubscribeUrl: string }): Promise<void> {
    const unsubscribeUrl = escapeHtml(input.unsubscribeUrl);
    await this.sendEmail({
      recipient: input.recipient,
      subject: 'Dobro dosli u DajaShop newsletter',
      text:
        'Hvala što ste se prijavili na DajaShop newsletter. Kod DOBRODOSLI10 donosi 10% popusta na prvu porudžbinu.\n\nOdjava: ' +
        input.unsubscribeUrl,
      html:
        '<!doctype html><html lang="sr"><body style="margin:0;background:#f6f6f6;font-family:Arial,sans-serif;color:#1f1f1f"><main style="max-width:560px;margin:32px auto;background:#fff;padding:40px;border-radius:12px"><h1 style="margin:0 0 16px;font-size:26px">Dobro došli u DajaShop</h1><p style="font-size:16px;line-height:1.6">Hvala što ste se prijavili na naš newsletter.</p><p style="font-size:16px;line-height:1.6">Za prvu porudžbinu iskoristite kod <strong>DOBRODOSLI10</strong> i ostvarite 10% popusta.</p><p style="margin:28px 0 0;font-size:14px;color:#666">Ne želite više newsletter? <a href="' +
        unsubscribeUrl +
        '">Odjavite se jednim klikom</a>.</p><p style="margin:16px 0 0;font-size:14px;color:#666">DajaShop</p></main></body></html>',
      tag: 'newsletter-welcome'
    });
  }

  private async sendEmail(input: {
    recipient: string;
    fromEmail?: string;
    subject: string;
    text: string;
    html: string;
    tag: string;
  }): Promise<void> {
    await this.delivery.send({
      recipients: [input.recipient],
      subject: input.subject,
      text: input.text,
      html: input.html,
      tag: input.tag,
      ...(input.fromEmail ? { fromEmail: input.fromEmail } : {})
    });
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    };
    return entities[character] ?? character;
  });
}

function dajaShopSender(configuredSender: string): string {
  const match = configuredSender.match(/<([^>]+)>/);
  const address = (match?.[1] || configuredSender).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)
    ? `DajaShop <${address}>`
    : configuredSender;
}
