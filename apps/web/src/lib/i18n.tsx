import { Fragment, type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { TR } from '../locales/tr.js';

/**
 * Interface translations (G4.6).
 *
 * The English text in the source IS the message key: `t('Sign out')` returns
 * the Turkish entry from `locales/tr.ts` when the locale is Turkish and the
 * English text otherwise. A string nobody has translated yet therefore still
 * renders, in English, instead of showing a key — so routes can be extracted
 * one at a time. `test/i18nCatalog.test.ts` keeps every `t()` literal and
 * the catalogue in step.
 *
 * Placeholders use `{name}` and are filled from `vars`.
 */

export type Locale = 'en' | 'tr';

export const LOCALES: Array<{ id: Locale; label: string }> = [
  { id: 'en', label: 'English' },
  { id: 'tr', label: 'Türkçe' },
];

const LOCALE_KEY = 'ninedeploy.locale';

const CATALOGUES: Record<Locale, Readonly<Record<string, string>> | null> = { en: null, tr: TR };

export type Translate = (text: string, vars?: Record<string, string | number>) => string;

function interpolate(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/**
 * Marks a static English string for the catalogue without translating it —
 * for module-level tables (nav labels, option lists) that are passed through
 * `t()` at render time. Returns its argument unchanged.
 */
export function msg(text: string): string {
  return text;
}

/**
 * Fills `{name}` placeholders in an already translated string with React
 * nodes, for sentences that wrap a value in markup — the translation keeps
 * its own word order: `fill(t(sentence), { email: <b>{email}</b> })`.
 */
export function fill(text: string, nodes: Record<string, ReactNode>): ReactNode[] {
  return text.split(/(\{\w+\})/).map((part, i) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    return name !== undefined && name in nodes ? <Fragment key={i}>{nodes[name]}</Fragment> : part;
  });
}

/** Translate outside React (or for a fixed locale). */
export function translate(locale: Locale, text: string, vars?: Record<string, string | number>): string {
  return interpolate(CATALOGUES[locale]?.[text] ?? text, vars);
}

function initialLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_KEY);
    if (stored === 'en' || stored === 'tr') return stored;
  } catch { /* storage blocked */ }
  const browser = typeof navigator === 'undefined' ? '' : navigator.language ?? '';
  return browser.toLowerCase().startsWith('tr') ? 'tr' : 'en';
}

interface LocaleContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: Translate;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  useEffect(() => {
    document.documentElement.lang = locale;
    try { localStorage.setItem(LOCALE_KEY, locale); } catch { /* ignore */ }
  }, [locale]);

  const t = useCallback<Translate>((text, vars) => translate(locale, text, vars), [locale]);
  const value = useMemo(() => ({ locale, setLocale: setLocaleState, t }), [locale, t]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

const ENGLISH: Translate = (text, vars) => interpolate(text, vars);

/** The translate function; English outside a LocaleProvider (isolated renders, tests). */
export function useT(): Translate {
  return useContext(LocaleContext)?.t ?? ENGLISH;
}

/** The active locale and its setter; English and a no-op outside a LocaleProvider. */
export function useLocale(): { locale: Locale; setLocale: (l: Locale) => void } {
  const ctx = useContext(LocaleContext);
  return ctx ?? { locale: 'en', setLocale: () => {} };
}
