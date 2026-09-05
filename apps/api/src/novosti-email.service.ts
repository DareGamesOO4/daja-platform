import { Injectable, Inject } from '@nestjs/common';
import type { AppConfig } from '@daja/config';
import { CONFIG } from './tokens.js';
import { EmailDeliveryService } from './email-delivery.service.js';

@Injectable()
export class NovostiEmailService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly delivery: EmailDeliveryService
  ) {}

  async posaljiPotvrduPrijave(input: {
    recipient: string;
    confirmationUrl: string;
  }): Promise<void> {
    const confirmationUrl = escapeHtml(input.confirmationUrl);
    await this.posaljiEmail({
      recipient: input.recipient,
      subject: 'Potvrdite prijavu za DajaShop novosti',
      text: `Potvrdite prijavu za DajaShop novosti otvaranjem ovog linka: ${input.confirmationUrl}`,
      html:
        '<!doctype html><html lang="sr"><body style="margin:0;background:#f6f6f6;font-family:Arial,sans-serif;color:#1f1f1f"><main style="max-width:560px;margin:32px auto;background:#fff;padding:40px;border-radius:12px"><h1 style="margin:0 0 16px;font-size:26px">Potvrdite prijavu</h1><p style="font-size:16px;line-height:1.6">Još samo jedan korak vas deli od DajaShop novosti.</p><p style="margin:28px 0"><a href="' +
        confirmationUrl +
        '" style="display:inline-block;background:#111;color:#fff;padding:14px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Potvrdite email adresu</a></p><p style="font-size:14px;line-height:1.6;color:#666">Link važi 24 sata. Ako niste vi zatražili prijavu, slobodno zanemarite ovu poruku.</p></main></body></html>',
      tag: 'novosti-potvrda'
    });
  }

  async posaljiPotvrduEmailAdrese(input: {
    recipient: string;
    verificationUrl: string;
  }): Promise<void> {
    const verificationUrl = escapeHtml(input.verificationUrl);
    await this.posaljiEmail({
      recipient: input.recipient,
      fromEmail: dajaShopSender(this.config.SES_ACCOUNT_FROM_EMAIL || this.config.SES_FROM_EMAIL),
      subject: 'Potvrdite email adresu za DajaShop nalog',
      text: `Otvorite ovaj link da potvrdite email adresu za svoj DajaShop nalog: ${input.verificationUrl}\n\nLink važi 15 minuta.`,
      html:
        '<!doctype html><html lang="sr"><body style="margin:0;background:#f6f6f6;font-family:Arial,sans-serif;color:#1f1f1f"><main style="max-width:560px;margin:32px auto;background:#fff;padding:40px;border-radius:12px"><h1 style="margin:0 0 16px;font-size:26px">Potvrdite email adresu</h1><p style="font-size:16px;line-height:1.6">Otvorite dugme ispod da potvrdite email adresu svog DajaShop naloga.</p><p style="margin:28px 0"><a href="' +
        verificationUrl +
        '" style="display:inline-block;background:#111;color:#fff;padding:14px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Potvrdi email adresu</a></p><p style="font-size:14px;line-height:1.6;color:#666">Link važi 15 minuta i može da se iskoristi samo jednom. Ako niste vi zatražili verifikaciju, slobodno zanemarite ovu poruku.</p></main></body></html>',
      tag: 'potvrda-email-adrese'
    });
  }

  async posaljiLinkZaPromenuLozinke(input: {
    recipient: string;
    resetUrl: string;
  }): Promise<void> {
    const resetUrl = escapeHtml(input.resetUrl);
    await this.posaljiEmail({
      recipient: input.recipient,
      fromEmail: dajaShopSender(this.config.SES_ACCOUNT_FROM_EMAIL || this.config.SES_FROM_EMAIL),
      subject: 'Promena lozinke za DajaShop nalog',
      text: `Otvorite ovaj link da postavite novu lozinku za svoj DajaShop nalog: ${input.resetUrl}\n\nLink važi 30 minuta i može da se iskoristi samo jednom. Ako niste vi zatražili promenu lozinke, slobodno zanemarite ovu poruku.`,
      html: htmlPromenaLozinke(resetUrl),
      tag: 'promena-lozinke'
    });
  }

  async posaljiPorukuDobrodoslice(input: {
    recipient: string;
    odjavaUrl: string;
    kodDobrodoslice?: string;
  }): Promise<void> {
    await this.posaljiEmail({
      recipient: input.recipient,
      fromEmail: dajaShopSender(this.config.SES_FROM_EMAIL),
      subject: 'Stigli ste na pravo vreme.',
      text: tekstDobrodoslice({
        shopUrl: this.config.STOREFRONT_PUBLIC_BASE_URL,
        odjavaUrl: input.odjavaUrl,
        ...(input.kodDobrodoslice ? { kodDobrodoslice: input.kodDobrodoslice } : {})
      }),
      html: htmlDobrodoslice({
        shopUrl: this.config.STOREFRONT_PUBLIC_BASE_URL,
        odjavaUrl: input.odjavaUrl,
        ...(input.kodDobrodoslice ? { kodDobrodoslice: input.kodDobrodoslice } : {})
      }),
      tag: 'poruka-dobrodoslice'
    });
  }

  private async posaljiEmail(input: {
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

function htmlPromenaLozinke(resetUrl: string): string {
  return (
    '<!doctype html><html lang="sr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">' +
    '<style>:root{color-scheme:light dark;supported-color-schemes:light dark}@media only screen and (max-width:640px){.reset-shell{width:100% !important}.reset-outer{padding:0 !important}.reset-header{padding:24px 20px !important}.reset-content{padding:28px 20px !important}.reset-footer{padding:20px !important}.reset-button{display:block !important;text-align:center !important}}@media (prefers-color-scheme:dark){.reset-body,.reset-page,.reset-outer,.reset-shell,.reset-header,.reset-footer{background:#2c2c2e !important}.reset-header,.reset-footer,.reset-security-card{border-color:#48484a !important}.reset-content h1,.reset-content h2,.reset-content p,.reset-content td,.reset-content a,.reset-brand,.reset-security-value{color:#fafafa !important}.reset-copy,.reset-footer,.reset-eyebrow,.reset-security-label{color:#c7c7cc !important}.reset-security-card,.reset-security-card td{background-color:#3a3a3c !important;background-image:linear-gradient(#3a3a3c,#3a3a3c) !important}.reset-button-cell{background-color:#fafafa !important}.reset-button{color:#2c2c2e !important}}</style>' +
    '</head><body class="reset-body" style="margin:0;padding:0;background:#f4f4f5;color:#18181b;font-family:Arial,Helvetica,sans-serif">' +
    '<table class="reset-page" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f4f4f5"><tr><td class="reset-outer" align="center" style="padding:32px 16px">' +
    '<table class="reset-shell" role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:640px;max-width:640px;background:#ffffff">' +
    '<tr><td class="reset-header" style="padding:28px 44px;border-bottom:1px solid #e4e4e7">' +
    '<p class="reset-brand" style="margin:0;color:#18181b;font-size:14px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase">DajaShop</p>' +
    '<p class="reset-eyebrow" style="margin:8px 0 0;color:#71717a;font-size:12px;font-weight:700;letter-spacing:0.08em">BEZBEDNOST NALOGA</p>' +
    '</td></tr><tr><td class="reset-content" style="padding:38px 44px">' +
    '<h1 style="margin:0 0 12px;color:#18181b;font-size:26px;line-height:1.25;font-weight:700">Promenite lozinku.</h1>' +
    '<p class="reset-copy" style="margin:0;color:#52525b;font-size:16px;line-height:1.6">Zatražili ste promenu lozinke za svoj DajaShop nalog. Kliknite na dugme ispod da postavite novu lozinku.</p>' +
    '<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0"><tr><td class="reset-button-cell" align="center" bgcolor="#18181b" style="background-color:#18181b"><a class="reset-button" href="' +
    resetUrl +
    '" style="display:inline-block;padding:13px 18px;color:#ffffff;font-size:14px;font-weight:700;line-height:1.2;text-decoration:none">Postavi novu lozinku</a></td></tr></table>' +
    '<table class="reset-security-card" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f4f4f5" style="width:100%;border-collapse:collapse;background-color:#f4f4f5;border:1px solid #e4e4e7"><tr><td bgcolor="#f4f4f5" style="padding:16px 18px;background-color:#f4f4f5">' +
    '<p class="reset-security-label" style="margin:0 0 5px;color:#71717a;font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase">VAŽNOST LINKA</p>' +
    '<p class="reset-security-value" style="margin:0;color:#18181b;font-size:15px;line-height:1.45;font-weight:700">30 minuta · može da se iskoristi samo jednom</p>' +
    '</td></tr></table>' +
    '<p class="reset-copy" style="margin:24px 0 0;color:#52525b;font-size:14px;line-height:1.65">Ako niste vi zatražili promenu lozinke, slobodno zanemarite ovu poruku. Vaša postojeća lozinka ostaje nepromenjena.</p>' +
    '<p class="reset-copy" style="margin:16px 0 0;color:#52525b;font-size:13px;line-height:1.6">Ako dugme ne radi, kopirajte ovaj link u pregledač:<br><a href="' +
    resetUrl +
    '" style="color:#52525b;text-decoration:underline;word-break:break-all">' +
    resetUrl +
    '</a></p>' +
    '</td></tr><tr><td class="reset-footer" style="padding:20px 44px;border-top:1px solid #e4e4e7;color:#71717a;font-size:12px;line-height:1.55">DajaShop · Automatska poruka o bezbednosti vašeg naloga</td></tr>' +
    '</table></td></tr></table></body></html>'
  );
}

function tekstDobrodoslice(input: {
  kodDobrodoslice?: string;
  shopUrl: string;
  odjavaUrl: string;
}): string {
  const uputstvoZaKod = input.kodDobrodoslice
    ? [
        'Za prvu porudžbinu pripremili smo vaš kod dobrodošlice: ' + input.kodDobrodoslice,
        '',
        'Kako se koristi:',
        '1. Otvorite ' + input.shopUrl + ' i dodajte artikle u korpu.',
        '2. Prijavite se na nalog sa istom email adresom na koju je stigla ova poruka.',
        '3. Kod se može automatski primeniti pri otvaranju korpe. Ako se ne prikaže, unesite ga ručno u polje „Kod”.',
        '4. Uslovi koda se proveravaju ponovo pri završetku porudžbine.',
        ''
      ]
    : ['Otvorite ' + input.shopUrl + ' i upoznajte našu ponudu.', ''];
  return [
    'Dobro došli u DajaShop!',
    '',
    'Hvala što želite da ostanemo u kontaktu.',
    '',
    ...uputstvoZaKod,
    'Od nas možete očekivati novitete, informacije o dostupnosti i korisne savete za izbor i održavanje sata.',
    '',
    'Odjava od ovakvih poruka: ' + input.odjavaUrl
  ].join('\n');
}

function htmlDobrodoslice(input: {
  kodDobrodoslice?: string;
  shopUrl: string;
  odjavaUrl: string;
}): string {
  const kodDobrodoslice = input.kodDobrodoslice ? escapeHtml(input.kodDobrodoslice) : '';
  const shopUrl = escapeHtml(input.shopUrl);
  const odjavaUrl = escapeHtml(input.odjavaUrl);
  const deoSaKodom = input.kodDobrodoslice
    ? '<p class="welcome-copy" style="margin:0;color:#52525b;font-size:16px;line-height:1.6">Za prvu porudžbinu pripremili smo vam kod dobrodošlice.</p>' +
      '<table class="welcome-code-card" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f4f4f5" style="width:100%;margin:24px 0;background-color:#f4f4f5;border:1px solid #e4e4e7"><tr><td align="center" bgcolor="#f4f4f5" style="padding:20px;background-color:#f4f4f5">' +
      '<p style="margin:0 0 7px;color:#71717a;font-size:11px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase">KOD DOBRODOŠLICE</p>' +
      '<p style="margin:0;color:#18181b;font-family:Arial,Helvetica,sans-serif;font-size:24px;letter-spacing:0.12em;font-weight:800">' +
      kodDobrodoslice +
      '</p></td></tr></table>' +
      '<section class="welcome-section" style="margin:28px 0;padding-top:20px;border-top:1px solid #e4e4e7">' +
      '<h2 style="margin:0 0 10px;color:#18181b;font-size:16px;line-height:1.35;font-weight:700">Kako se koristi kod</h2>' +
      '<table class="welcome-steps" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#f4f4f5" style="width:100%;border-collapse:collapse;background-color:#f4f4f5">' +
      korakHtml('1', 'Dodajte željene artikle u korpu.') +
      korakHtml('2', 'Prijavite se na nalog sa istom email adresom na koju je stigla ova poruka.') +
      korakHtml('3', 'Kod se može automatski primeniti pri ulasku u korpu. Ako se ne prikaže, unesite ga ručno u polje „Kod”.') +
      korakHtml('4', 'Uslovi koda se proveravaju ponovo pri završetku porudžbine.') +
      '</table></section>'
    : '<p class="welcome-copy" style="margin:0;color:#52525b;font-size:16px;line-height:1.6">Drago nam je što ste sa nama. Pratićemo vas kroz novitete, informacije o dostupnosti i korisne savete.</p>';
  return (
    '<!doctype html><html lang="sr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">' +
    '<style>:root{color-scheme:light dark;supported-color-schemes:light dark}@media only screen and (max-width:640px){.welcome-shell{width:100% !important}.welcome-outer{padding:0 !important}.welcome-header{padding:24px 20px !important}.welcome-content{padding:28px 20px !important}.welcome-footer{padding:20px !important}.welcome-step-number{width:28px !important}}@media (prefers-color-scheme:dark){.welcome-body,.welcome-page,.welcome-outer,.welcome-shell,.welcome-header,.welcome-footer{background:#2c2c2e !important}.welcome-header,.welcome-footer,.welcome-section{border-color:#48484a !important}.welcome-content h1,.welcome-content h2,.welcome-content p,.welcome-content td,.welcome-content a,.welcome-brand{color:#fafafa !important}.welcome-copy,.welcome-footer,.welcome-eyebrow,.welcome-step-number{color:#c7c7cc !important}.welcome-code-card,.welcome-code-card td,.welcome-steps,.welcome-steps td{background-color:#3a3a3c !important;background-image:linear-gradient(#3a3a3c,#3a3a3c) !important}.welcome-code-card,.welcome-steps td{border-color:#48484a !important}.welcome-button{background:#fafafa !important;color:#2c2c2e !important}}</style>' +
    '</head><body class="welcome-body" style="margin:0;padding:0;background:#f4f4f5;color:#18181b;font-family:Arial,Helvetica,sans-serif">' +
    '<table class="welcome-page" role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f4f4f5"><tr><td class="welcome-outer" align="center" style="padding:32px 16px">' +
    '<table class="welcome-shell" role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:640px;max-width:640px;background:#ffffff">' +
    '<tr><td class="welcome-header" style="padding:28px 44px;border-bottom:1px solid #e4e4e7">' +
    '<p class="welcome-brand" style="margin:0;color:#18181b;font-size:14px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase">DajaShop</p>' +
    '<p class="welcome-eyebrow" style="margin:8px 0 0;color:#71717a;font-size:12px;font-weight:700;letter-spacing:0.08em">DOBRO DOŠLI</p>' +
    '</td></tr><tr><td class="welcome-content" style="padding:38px 44px">' +
    '<h1 style="margin:0 0 12px;color:#18181b;font-size:26px;line-height:1.25;font-weight:700">Dobro došli u DajaShop.</h1>' +
    deoSaKodom +
    '<p style="margin:0 0 16px"><a class="welcome-button" href="' +
    shopUrl +
    '" style="display:inline-block;background:#18181b;color:#ffffff;padding:13px 18px;text-decoration:none;font-size:14px;font-weight:700">Otvori prodavnicu</a></p>' +
    '<section class="welcome-section" style="margin:28px 0 0;padding-top:20px;border-top:1px solid #e4e4e7">' +
    '<h2 style="margin:0 0 8px;color:#18181b;font-size:16px;line-height:1.35;font-weight:700">Šta možete da očekujete</h2>' +
    '<p class="welcome-copy" style="margin:0;color:#52525b;font-size:14px;line-height:1.65">Novitete iz ponude, informacije o dostupnosti i korisne savete za izbor i održavanje sata.</p>' +
    '</section>' +
    '</td></tr><tr><td class="welcome-footer" style="padding:20px 44px;border-top:1px solid #e4e4e7;color:#71717a;font-size:12px;line-height:1.55">' +
    'Ne želite više ovakve poruke? <a href="' +
    odjavaUrl +
    '" style="color:#52525b;text-decoration:underline">Odjavite se jednim klikom</a>.<br>DajaShop' +
    '</td></tr></table></td></tr></table></body></html>'
  );
}

function korakHtml(number: string, text: string): string {
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
