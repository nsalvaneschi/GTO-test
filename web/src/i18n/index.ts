import en from './en.json';
import es from './es.json';
import it from './it.json';

export const locales = { en, es, it } as const;
export type Lang = keyof typeof locales;
export type Key = keyof typeof en;

/** Minimal ICU: {name} substitution and {name, plural, one {..} other {..}} with # = formatted number. */
export function format(msg: string, lang: Lang, vars: Record<string, string | number> = {}): string {
  const plural = /\{(\w+), plural, one \{([^}]*)\} other \{([^}]*)\}\}/g;
  msg = msg.replace(plural, (_, n, one, other) => {
    const v = Number(vars[n]);
    const form = new Intl.PluralRules(lang).select(v) === 'one' ? one : other;
    return form.replace('#', fmt(v, lang));
  });
  return msg.replace(/\{(\w+)\}/g, (_, n) => String(vars[n]));
}

export function fmt(n: number, lang: Lang, opts?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(lang, opts).format(n);
}

export function t(lang: Lang, key: Key, vars?: Record<string, string | number>): string {
  return format(locales[lang][key], lang, vars);
}
