export function whatsappPreferenceCommand(input: string) {
  const text = input.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toUpperCase();
  const code = /^(?:STOP SAT|STOP WATCH) ([1-9][0-9]{0,18})$/.exec(text)?.[1];
  const page = /^(?:MOJI SATOVI|MY WATCHES)(?: ([1-9][0-9]{0,4}))?$/.exec(text);
  if (code) return { kind: 'watch', code } as const;
  if (page) return { kind: 'list', page: Number(page[1] ?? 1), english: text.startsWith('MY') } as const;
  if (/^(STOP SAT|STOP WATCH|ODJAVI OVAJ SAT|UNSUBSCRIBE THIS WATCH)$/.test(text)) return { kind: 'watch' } as const;
  if (/^(STOP CENE|STOP PRICES|STOP SATOVI|STOP WATCHES)$/.test(text)) return { kind: 'prices' } as const;
  if (/^(STOP SVE|STOP ALL|ODJAVA|UNSUBSCRIBE|PREKINI|ODJAVI SVE|UNSUBSCRIBE FROM ALL)$/.test(text)) return { kind: 'all' } as const;
  if (/^(STOP|STOP NOVOSTI|STOP NEWS|ODJAVI NOVOSTI|UNSUBSCRIBE FROM NEWS)$/.test(text)) return { kind: 'newsletter', legacyEligible: text === 'STOP' } as const;
  if (/^(POMOC|HELP)$/.test(text)) return { kind: 'help', english: text === 'HELP' } as const;
  return undefined;
}
