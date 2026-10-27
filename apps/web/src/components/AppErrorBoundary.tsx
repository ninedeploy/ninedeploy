import { Component, type ErrorInfo, type ReactNode } from 'react';
import { type Locale, translate } from '../lib/i18n.js';

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

/**
 * The boundary sits outside LocaleProvider (a crash unmounts it), so the
 * locale is read from where LocaleProvider stores it.
 */
function storedLocale(): Locale {
  try {
    return localStorage.getItem('ninedeploy.locale') === 'tr' ? 'tr' : 'en';
  } catch {
    return 'en';
  }
}

/** Last-resort UI so an unexpected render error does not leave a blank page. */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('NineDeploy UI crashed', error, info);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const locale = storedLocale();
    const t = (text: string) => translate(locale, text);
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 p-6 text-slate-100">
        <section className="w-full max-w-lg rounded-2xl border border-white/10 bg-slate-900 p-8 text-center shadow-2xl">
          <h1 className="text-xl font-semibold">{t('NineDeploy could not render this page')}</h1>
          <p className="mt-3 text-sm text-slate-400">{t('Reload the dashboard to recover. If this continues, check the server and browser logs.')}</p>
          <button
            type="button"
            className="mt-6 rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400"
            onClick={() => window.location.reload()}
          >
            {t('Reload dashboard')}
          </button>
        </section>
      </main>
    );
  }
}
