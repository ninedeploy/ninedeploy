import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
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
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 p-6 text-slate-100">
        <section className="w-full max-w-lg rounded-2xl border border-white/10 bg-slate-900 p-8 text-center shadow-2xl">
          <h1 className="text-xl font-semibold">NineDeploy could not render this page</h1>
          <p className="mt-3 text-sm text-slate-400">Reload the dashboard to recover. If this continues, check the server and browser logs.</p>
          <button
            type="button"
            className="mt-6 rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400"
            onClick={() => window.location.reload()}
          >
            Reload dashboard
          </button>
        </section>
      </main>
    );
  }
}
