import { expect, test } from 'vitest';
import { locales } from '../src/i18n';

test('all locales have identical keys', () => {
  const base = Object.keys(locales.en).sort();
  for (const [lang, m] of Object.entries(locales)) {
    expect(Object.keys(m).sort(), lang).toEqual(base);
  }
});
