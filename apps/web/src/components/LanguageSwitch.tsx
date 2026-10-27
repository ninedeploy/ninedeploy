import { Languages } from 'lucide-react';
import { LOCALES, type Locale, useLocale, useT } from '../lib/i18n.js';
import { cn } from './ui.js';

/** Compact EN / TR switch (sign-in page, Settings → Appearance). */
export function LanguageSwitch({ className }: { className?: string }) {
  const { locale, setLocale } = useLocale();
  const t = useT();
  return (
    <fieldset className={cn('m-0 flex items-center gap-1 border-0 p-0', className)} aria-label={t('Language')}>
      <Languages size={14} className="mr-1 text-slate-500" aria-hidden="true" />
      {LOCALES.map((l) => (
        <button
          type="button"
          key={l.id}
          lang={l.id}
          aria-pressed={locale === l.id}
          onClick={() => setLocale(l.id as Locale)}
          className={cn(
            'rounded-md px-2 py-1 text-xs transition',
            locale === l.id ? 'bg-white/[0.08] font-medium text-slate-200' : 'text-slate-500 hover:text-slate-300',
          )}
        >
          {l.label}
        </button>
      ))}
    </fieldset>
  );
}
