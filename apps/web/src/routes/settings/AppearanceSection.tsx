import { useTheme, ACCENTS } from '../../lib/theme.js';
import { Card, CardBody, cn } from '../../components/ui.js';
import { LanguageSwitch } from '../../components/LanguageSwitch.js';
import { useT } from '../../lib/i18n.js';

/** Appearance: interface language, dark/light theme + accent color. */
export function AppearanceSection() {
  const { theme, accent, setTheme, setAccent } = useTheme();
  const t = useT();
  return (
    <Card className="mb-5">
      <CardBody>
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-500">{t('Appearance')}</h2>
        <div className="mb-4">
          <span className="mb-2 block text-xs text-slate-500">{t('Language')}</span>
          <LanguageSwitch />
        </div>
        <div className="mb-4">
          <span className="mb-2 block text-xs text-slate-500">{t('Theme')}</span>
          <div className="flex gap-2">
            {(['dark', 'light'] as const).map((th) => (
              <button type="button"
                key={th}
                onClick={() => setTheme(th)}
                className={cn(
                  'flex items-center gap-2 rounded-lg border px-4 py-2 text-sm transition',
                  theme === th
                    ? 'border-indigo-500/60 bg-indigo-500/10 text-slate-200'
                    : 'border-white/10 bg-white/[0.02] text-slate-500 hover:border-white/20',
                )}
              >
                {th === 'dark' ? t('Dark') : t('Light')}
              </button>
            ))}
          </div>
        </div>
        <div>
          <span className="mb-2 block text-xs text-slate-500">{t('Accent color')}</span>
          <div className="flex flex-wrap gap-2">
            {ACCENTS.map((a) => (
              <button type="button"
                key={a.id}
                onClick={() => setAccent(a.id)}
                className={cn(
                  'group flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition',
                  accent === a.id
                    ? 'border-white/20 bg-white/[0.06]'
                    : 'border-white/10 hover:border-white/20',
                )}
              >
                <span
                  className="h-4 w-4 rounded-full ring-2 ring-transparent transition group-hover:ring-white/20"
                  style={{ backgroundColor: a.color }}
                />
                {t(a.label)}
              </button>
            ))}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
