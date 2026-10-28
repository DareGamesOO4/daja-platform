export function emailEscape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!
  );
}

export function brandedEmail(input: {
  siteUrl: string;
  eyebrow: string;
  title: string;
  content: string;
  button?: { label: string; url: string };
  footer?: string;
  unsubscribeUrl?: string;
}): string {
  const e = emailEscape;
  const button = input.button
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:26px 0"><tr><td bgcolor="#111111" style="border-radius:8px"><a class="mail-button" href="${e(input.button.url)}" style="display:inline-block;padding:16px 24px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:bold">${e(input.button.label)}</a></td></tr></table><p class="mail-muted" style="font-size:12px;line-height:1.6;color:#71717a">Ako dugme ne radi, otvorite ovaj link:<br><a href="${e(input.button.url)}" style="color:inherit;word-break:break-all">${e(input.button.url)}</a></p>`
    : '';
  return `<!doctype html><html lang="sr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><style>.mail-logo-dark{display:none!important;max-height:0;overflow:hidden}@media(max-width:640px){.mail-shell{width:100%!important}.mail-outer{padding:0!important}.mail-pad{padding:26px 20px!important}}@media(prefers-color-scheme:dark){.mail-body,.mail-page{background:#27272a!important}.mail-shell,.mail-header{background:#2c2c2e!important;color:#fafafa!important}.mail-footer{background:#353538!important;color:#d4d4d8!important}.mail-shell h1,.mail-shell p{color:#fafafa!important}.mail-shell .mail-muted{color:#d4d4d8!important}.mail-logo-light{display:none!important}.mail-logo-dark{display:block!important;max-height:none!important}.mail-button{color:#fff!important}}</style></head><body class="mail-body" style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b"><table class="mail-page" role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f5"><tr><td class="mail-outer" align="center" style="padding:32px 16px"><table class="mail-shell" role="presentation" width="640" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;background:#fff"><tr><td class="mail-header mail-pad" style="padding:24px 40px;border-bottom:1px solid #e4e4e7"><a href="${e(input.siteUrl)}"><img class="mail-logo-light" src="${e(new URL('/images/dajashop-email-logo.png', input.siteUrl).toString())}" width="106" alt="DajaShop" style="display:block;width:106px;height:auto;border:0"><img class="mail-logo-dark" src="${e(new URL('/images/dajashop-email-logo-dark.png', input.siteUrl).toString())}" width="106" alt="DajaShop" style="display:none;width:106px;height:auto;border:0;max-height:0;overflow:hidden"></a><p class="mail-muted" style="margin:14px 0 0;color:#71717a;font-size:11px;letter-spacing:1px;font-weight:bold">${e(input.eyebrow)}</p></td></tr><tr><td class="mail-pad" style="padding:32px 40px;font-size:16px;line-height:1.65"><h1 style="margin:0 0 18px;font-size:27px;line-height:1.25">${e(input.title)}</h1>${input.content}${button}</td></tr><tr><td class="mail-footer mail-pad" style="padding:24px 40px;background:#fafafa;border-top:1px solid #e4e4e7;font-size:12px;line-height:1.65;color:#71717a">${e(input.footer ?? 'DajaShop · Podzemni prolaz, lokal C31 · Niš')}${input.unsubscribeUrl ? `<br><a href="${e(input.unsubscribeUrl)}" style="color:inherit">Odjavite se od ovih poruka</a>` : ''}<br>© ${new Date().getFullYear()} DajaShop</td></tr></table></td></tr></table></body></html>`;
}
