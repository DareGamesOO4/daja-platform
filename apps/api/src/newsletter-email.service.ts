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

  async sendWelcomeEmail(input: {
    recipient: string;
    unsubscribeUrl: string;
    promotionCode?: string;
  }): Promise<void> {
    await this.sendEmail({
      recipient: input.recipient,
      fromEmail: dajaShopSender(this.config.SES_FROM_EMAIL),
      subject: 'Stigli ste na pravo vreme.',
      text: newsletterWelcomeText({
        shopUrl: this.config.STOREFRONT_PUBLIC_BASE_URL,
        unsubscribeUrl: input.unsubscribeUrl,
        ...(input.promotionCode ? { promotionCode: input.promotionCode } : {})
      }),
      html: newsletterWelcomeHtml({
        shopUrl: this.config.STOREFRONT_PUBLIC_BASE_URL,
        unsubscribeUrl: input.unsubscribeUrl,
        ...(input.promotionCode ? { promotionCode: input.promotionCode } : {})
      }),
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

function newsletterWelcomeText(input: {
  promotionCode?: string;
  shopUrl: string;
  unsubscribeUrl: string;
}): string {
  const promotionInstructions = input.promotionCode
    ? [
        'Kao dobrodošlicu, za prvu porudžbinu možete iskoristiti kod: ' +
          input.promotionCode,
        '',
        'Kako se koristi:',
        '1. Otvorite ' + input.shopUrl + ' i dodajte artikle u korpu.',
        '2. Prijavite se na nalog sa istom email adresom na koju je stigla ova poruka.',
        '3. Kod se može automatski primeniti pri otvaranju korpe. Ako se ne prikaže, ručno unesite ' +
          input.promotionCode +
          ' u polje „Promo kod”.',
        '4. Popust se proverava ponovo pri završetku porudžbine.',
        ''
      ]
    : ['Otvorite ' + input.shopUrl + ' i upoznajte našu ponudu.', ''];
  return [
    'Dobro došli u DajaShop!',
    '',
    'Hvala što ste se prijavili na newsletter.',
    '',
    ...promotionInstructions,
    'U newsletteru možete očekivati novitete, pažljivo odabrane ponude, informacije o dostupnosti i korisne savete za izbor i održavanje sata.',
    '',
    'Odjava sa newslettera: ' + input.unsubscribeUrl
  ].join('\n');
}

function newsletterWelcomeHtml(input: {
  promotionCode?: string;
  shopUrl: string;
  unsubscribeUrl: string;
}): string {
  const promotionCode = input.promotionCode ? escapeHtml(input.promotionCode) : '';
  const shopUrl = escapeHtml(input.shopUrl);
  const unsubscribeUrl = escapeHtml(input.unsubscribeUrl);
  const promotionSection = input.promotionCode
    ? '<p class="welcome-copy" style="margin:0;color:#52525b;font-size:16px;line-height:1.6">Kao dobrodošlicu, spremili smo vam kod za popust na prvu porudžbinu.</p>' +
      '<table class="welcome-code-card" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f4f4f5" style="width:100%;margin:24px 0;background-color:#f4f4f5;border:1px solid #e4e4e7"><tr><td align="center" bgcolor="#f4f4f5" style="padding:20px;background-color:#f4f4f5">' +
      '<p style="margin:0 0 7px;color:#71717a;font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase">VAŠ KOD ZA PRVU PORUDŽBINU</p>' +
      '<p style="margin:0;color:#18181b;font-family:Arial,Helvetica,sans-serif;font-size:24px;letter-spacing:0.12em;font-weight:800">' +
      promotionCode +
      '</p></td></tr></table>' +
      '<section class="welcome-section" style="margin:28px 0;padding-top:20px;border-top:1px solid #e4e4e7">' +
      '<h2 style="margin:0 0 10px;color:#18181b;font-size:16px;line-height:1.35;font-weight:700">Kako se koristi kod</h2>' +
      '<table class="welcome-steps" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f4f4f5" style="width:100%;border-collapse:collapse;background-color:#f4f4f5">' +
      welcomeStepHtml('1', 'Dodajte željene artikle u korpu.') +
      welcomeStepHtml('2', 'Prijavite se na nalog sa istom email adresom na koju je stigla ova poruka.') +
      welcomeStepHtml('3', 'Kod se može automatski primeniti pri ulasku u korpu. Ako se ne prikaže, unesite ga ručno u polje „Promo kod”.') +
      welcomeStepHtml('4', 'Uslovi koda se proveravaju ponovo pri završetku porudžbine.') +
      '</table></section>'
    : '<p class="welcome-copy" style="margin:0;color:#52525b;font-size:16px;line-height:1.6">Drago nam je što ste sa nama. Pratićemo vas kroz novitete, odabrane ponude i korisne savete.</p>';
  return (
    '<!doctype html><html lang="sr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">' +
    '<style>:root{color-scheme:light dark;supported-color-schemes:light dark}@media only screen and (max-width:640px){.welcome-shell{width:100% !important}.welcome-outer{padding:0 !important}.welcome-header{padding:24px 20px !important}.welcome-content{padding:28px 20px !important}.welcome-footer{padding:20px !important}.welcome-step-number{width:28px !important}}@media (prefers-color-scheme:dark){.welcome-body,.welcome-page,.welcome-outer,.welcome-shell,.welcome-header,.welcome-footer{background:#2c2c2e !important}.welcome-header,.welcome-footer,.welcome-section{border-color:#48484a !important}.welcome-content h1,.welcome-content h2,.welcome-content p,.welcome-content td,.welcome-content a,.welcome-brand{color:#fafafa !important}.welcome-copy,.welcome-footer,.welcome-eyebrow,.welcome-step-number{color:#c7c7cc !important}.welcome-code-card,.welcome-code-card td,.welcome-steps,.welcome-steps td{background-color:#3a3a3c !important;background-image:linear-gradient(#3a3a3c,#3a3a3c) !important}.welcome-code-card,.welcome-steps td{border-color:#48484a !important}.welcome-button{background:#fafafa !important;color:#2c2c2e !important}}</style>' +
    '</head><body class="welcome-body" style="margin:0;padding:0;background:#f4f4f5;color:#18181b;font-family:Arial,Helvetica,sans-serif">' +
    '<table class="welcome-page" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f4f4f5"><tr><td class="welcome-outer" align="center" style="padding:32px 16px">' +
    '<table class="welcome-shell" role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:640px;max-width:640px;background:#ffffff">' +
    '<tr><td class="welcome-header" style="padding:28px 44px;border-bottom:1px solid #e4e4e7">' +
    '<p class="welcome-brand" style="margin:0;color:#18181b;font-size:14px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase">DajaShop</p>' +
    '<p class="welcome-eyebrow" style="margin:8px 0 0;color:#71717a;font-size:12px;font-weight:700;letter-spacing:0.08em">NEWSLETTER · DOBRO DOŠLI</p>' +
    '</td></tr><tr><td class="welcome-content" style="padding:38px 44px">' +
    '<h1 style="margin:0 0 12px;color:#18181b;font-size:26px;line-height:1.25;font-weight:700">Dobro došli u DajaShop.</h1>' +
    promotionSection +
    '<p style="margin:0 0 16px"><a class="welcome-button" href="' +
    shopUrl +
    '" style="display:inline-block;background:#18181b;color:#ffffff;padding:13px 18px;text-decoration:none;font-size:14px;font-weight:700">Otvori prodavnicu</a></p>' +
    '<section class="welcome-section" style="margin:28px 0 0;padding-top:20px;border-top:1px solid #e4e4e7">' +
    '<h2 style="margin:0 0 8px;color:#18181b;font-size:16px;line-height:1.35;font-weight:700">Šta možete da očekujete</h2>' +
    '<p class="welcome-copy" style="margin:0;color:#52525b;font-size:14px;line-height:1.65">Novitete iz ponude, pažljivo odabrane akcije, informacije o dostupnosti i korisne savete za izbor i održavanje sata.</p>' +
    '</section>' +
    '</td></tr><tr><td class="welcome-footer" style="padding:20px 44px;border-top:1px solid #e4e4e7;color:#71717a;font-size:12px;line-height:1.55">' +
    'Ne želite više newsletter? <a href="' +
    unsubscribeUrl +
    '" style="color:#52525b;text-decoration:underline">Odjavite se jednim klikom</a>.<br>DajaShop' +
    '</td></tr></table></td></tr></table></body></html>'
  );
}

function welcomeStepHtml(number: string, text: string): string {
  return (
    '<tr><td class="welcome-step-number" width="36" valign="top" bgcolor="#f4f4f5" style="width:36px;padding:12px 0 12px 14px;background-color:#f4f4f5;color:#71717a;font-size:13px;font-weight:800">' +
    number +
    '</td><td valign="top" bgcolor="#f4f4f5" style="padding:12px 14px 12px 0;background-color:#f4f4f5;color:#27272a;font-size:14px;line-height:1.55">' +
    text +
    '</td></tr>'
  );
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
