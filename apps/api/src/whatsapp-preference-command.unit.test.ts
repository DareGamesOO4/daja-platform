import { describe, expect, it } from 'vitest';
import { whatsappPreferenceCommand } from './whatsapp-preference-command.js';

describe('WhatsApp opt-out commands', () => {
  it.each([
    ['STOP', 'newsletter'],
    ['STOP NOVOSTI', 'newsletter'],
    [' STOP   CENE ', 'prices'],
    ['STOP PRICES', 'prices'],
    ['STOP SATOVI', 'prices'],
    ['STOP SVE', 'all'],
    ['STOP ALL', 'all'],
    ['ODJAVA', 'all'],
    ['STOP SAT', 'watch'],
    ['POMOĆ', 'help']
  ])('parses %s as %s', (text, kind) => {
    expect(whatsappPreferenceCommand(text)?.kind).toBe(kind);
  });

  it('preserves the exact watch code as text in either language', () => {
    expect(whatsappPreferenceCommand('STOP SAT 1042')).toEqual({ kind: 'watch', code: '1042' });
    expect(whatsappPreferenceCommand('STOP WATCH 1042')).toEqual({ kind: 'watch', code: '1042' });
  });

  it('accepts a page number for long lists', () => {
    expect(whatsappPreferenceCommand('moji satovi 2')).toEqual({ kind: 'list', page: 2, english: false });
  });

  it.each(['stopwatch', 'STOP SAT 0', 'STOP SAT 1042 1043', 'STOP CENE DANAS'])('does not act on %s', text => {
    expect(whatsappPreferenceCommand(text)).toBeUndefined();
  });
});
