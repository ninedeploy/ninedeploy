import { useMutation } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router';
import { CheckCircle2, ExternalLink, GitBranch, XCircle } from 'lucide-react';
import type { GithubApp } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.js';
import { Button, Card, PageHeader, Spinner } from '../../components/ui.js';

/**
 * 0.13: where GitHub sends the browser during GitHub App setup. Auth is a
 * Bearer token from the SPA store (no cookies), so GitHub cannot call an
 * authenticated API route directly; these pages land first and then POST.
 * Both are inside RequireAuth, which keeps the query string across a login.
 */

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function Shell({ children }: { children: ReactNode }) {
  return (
    <div>
      <PageHeader icon={<GitBranch size={18} />} title="GitHub App" subtitle="Setup with GitHub" />
      <Card className="max-w-2xl p-6">{children}</Card>
    </div>
  );
}

function BackToSources() {
  return (
    <Link to="/sources">
      <Button size="sm" variant="secondary">
        Back to Sources
      </Button>
    </Link>
  );
}

function OperatorsOnly() {
  return (
    <Shell>
      <p className="text-sm text-slate-300">GitHub App setup is limited to instance operators.</p>
    </Shell>
  );
}

/**
 * `/github-apps/callback?code&state`: the manifest flow's redirect. The code
 * is single-use, so the completion request is sent exactly once per page
 * load (the ref survives StrictMode's effect replay).
 */
export function GithubAppCallback() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const code = params.get('code') ?? '';
  const state = params.get('state') ?? '';
  const sent = useRef(false);
  const complete = useMutation({ mutationFn: () => api.githubApps.completeManifest({ code, state }) });
  const isOperator = user?.isOperator === true;
  useEffect(() => {
    if (!isOperator || !code || !state || sent.current) return;
    sent.current = true;
    complete.mutate();
  }, [isOperator, code, state, complete]);

  if (!isOperator) return <OperatorsOnly />;
  if (!code || !state) {
    return (
      <Shell>
        <Failure message="GitHub did not return a setup code. Start the setup again from Sources." />
      </Shell>
    );
  }
  return (
    <Shell>
      {complete.isSuccess ? (
        <Registered app={complete.data} />
      ) : complete.isError ? (
        <Failure message={errorText(complete.error)} />
      ) : (
        <div className="flex items-center gap-2 text-sm text-slate-300">
          <Spinner /> Saving the GitHub App…
        </div>
      )}
    </Shell>
  );
}

function Registered({ app }: { app: GithubApp }) {
  return (
    <div className="space-y-4" data-testid="github-app-registered">
      <div className="flex items-center gap-2 text-sm text-emerald-300">
        <CheckCircle2 size={16} /> GitHub App <span className="font-semibold">{app.name}</span> is registered.
      </div>
      <p className="text-xs leading-relaxed text-slate-400">
        Next, install it on the account or organization whose repositories you deploy. GitHub brings you back here and the
        installation appears as a source.
      </p>
      <div className="flex flex-wrap gap-2">
        {app.installUrl && (
          <a
            href={app.installUrl}
            className="inline-flex h-8 items-center gap-1 rounded-md bg-indigo-500 px-3 text-xs font-medium text-white transition hover:bg-indigo-400"
          >
            Install the App <ExternalLink size={11} />
          </a>
        )}
        <BackToSources />
      </div>
    </div>
  );
}

function Failure({ message }: { message: string }) {
  return (
    <div className="space-y-4" data-testid="github-app-failed">
      <div className="flex items-start gap-2 text-sm text-rose-300">
        <XCircle size={16} className="mt-0.5 shrink-0" /> <span>{message}</span>
      </div>
      <BackToSources />
    </div>
  );
}

/**
 * `/github-apps/installed`: GitHub's setup URL after an install or a change
 * of repository selection. `installation_id` in the query is never trusted;
 * the page only asks the server to sync every App's installations from GitHub.
 */
export function GithubAppInstalled() {
  const { user } = useAuth();
  const sent = useRef(false);
  const isOperator = user?.isOperator === true;
  const sync = useMutation({
    mutationFn: async () => {
      const apps = await api.githubApps.list();
      const results: Array<{ app: GithubApp; created: number; sourcesCreated: number; error?: string }> = [];
      for (const app of apps) {
        try {
          const res = await api.githubApps.syncInstallations(app.id);
          results.push({ app, created: res.created, sourcesCreated: res.sourcesCreated });
        } catch (err) {
          results.push({ app, created: 0, sourcesCreated: 0, error: errorText(err) });
        }
      }
      return results;
    },
  });
  useEffect(() => {
    if (!isOperator || sent.current) return;
    sent.current = true;
    sync.mutate();
  }, [isOperator, sync]);

  if (!isOperator) return <OperatorsOnly />;
  return (
    <Shell>
      {sync.isSuccess ? (
        <div className="space-y-4" data-testid="github-app-synced">
          {sync.data.length === 0 ? (
            <p className="text-sm text-slate-300">No GitHub App is registered on this panel yet.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {sync.data.map((r) => (
                <li key={r.app.id} className={r.error ? 'text-rose-300' : 'text-slate-300'}>
                  <span className="font-medium">{r.app.name}</span>:{' '}
                  {r.error ? `sync failed: ${r.error}` : `${r.created} new installation(s), ${r.sourcesCreated} new source(s)`}
                </li>
              ))}
            </ul>
          )}
          <BackToSources />
        </div>
      ) : sync.isError ? (
        <Failure message={errorText(sync.error)} />
      ) : (
        <div className="flex items-center gap-2 text-sm text-slate-300">
          <Spinner /> Syncing installations from GitHub…
        </div>
      )}
    </Shell>
  );
}
