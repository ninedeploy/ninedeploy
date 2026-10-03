import { useTheme, ACCENTS } from '../../lib/theme.js';
import { Card, CardBody, cn } from '../../components/ui.js';

/** Appearance: dark/light theme + accent color. */
export function AppearanceSection() {
  const { theme, accent, setTheme, setAccent } = useTheme();
  return (
    <Card className="mb-5">
      <CardBody>
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-500">Appearance</h2>
        <div className="mb-4">
          <span className="mb-2 block text-xs text-slate-500">Theme</span>
          <div className="flex gap-2">
            {(['dark', 'light'] as const).map((t) => (
              <button type="button"
                key={t}
                onClick={() => setTheme(t)}
                className={cn(
                  'flex items-center gap-2 rounded-lg border px-4 py-2 text-sm capitalize transition',
                  theme === t
                    ? 'border-indigo-500/60 bg-indigo-500/10 text-slate-200'
                    : 'border-white/10 bg-white/[0.02] text-slate-500 hover:border-white/20',
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        <div>
          <span className="mb-2 block text-xs text-slate-500">Accent color</span>
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
                {a.label}
              </button>
            ))}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
