import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Bot, ShieldAlert } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { useT } from '../lib/i18n.js';
import { Button, Card, CardBody, FullScreenSpinner } from '../components/ui.js';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * R4: the OAuth authorization endpoint of remote MCP. An MCP client sends the
 * signed-in user here; the page names the client (as it registered itself)
 * and the host it will send the user back to, and asks for read-only or full
 * access. A request the panel refuses is shown here and never sent back.
 */
export function OAuthAuthorize() {
  const t = useT();
  const { user } = useAuth();
  const [params] = useSearchParams();
  const request = useMemo(() => Object.fromEntries(params.entries()), [params]);
  const q = useQuery({ queryKey: ['oauth-authorize', params.toString()], queryFn: () => api.mcpRemote.checkAuthorization(request), retry: false });
  const [access, setAccess] = useState<'read' | 'full' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const { redirect } = await api.mcpRemote.decideAuthorization({ request, approve, access: access ?? q.data?.requestedAccess ?? 'full' });
      window.location.assign(redirect);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  // Clickjacking: a page that frames the panel (and walks it here client-side) never gets the buttons.
  const framed = (() => {
    try {
      return window.top !== window.self;
    } catch {
      return true;
    }
  })();
  if (framed) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <Card>
          <CardBody>
            <p className="text-sm text-slate-300">{t('Open this page in its own browser tab to approve an MCP client.')}</p>
          </CardBody>
        </Card>
      </div>
    );
  }
  if (q.isLoading) return <FullScreenSpinner />;
  if (q.isError || !q.data) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <Card>
          <CardBody className="space-y-2">
            <h1 className="flex items-center gap-2 text-base font-semibold text-slate-200">
              <ShieldAlert size={18} className="text-amber-400" /> {t('This authorization request cannot be used')}
            </h1>
            <p className="text-sm text-slate-400">{errorText(q.error)}</p>
          </CardBody>
        </Card>
      </div>
    );
  }
  const chosen = access ?? q.data.requestedAccess;

  return (
    <div className="mx-auto max-w-lg px-4 py-16">
      <Card>
        <CardBody className="space-y-4 text-sm">
          <h1 className="flex items-center gap-2 text-base font-semibold text-slate-200">
            <Bot size={18} className="text-sky-300" /> {t('Connect an MCP client')}
          </h1>
          <p className="text-slate-300">
            {t('{client} wants to use NineDeploy as {user}.', { client: q.data.client.name, user: user?.email ?? '' })}
          </p>
          <p className="text-xs text-slate-400">
            {t('The client named itself; the panel cannot vouch for it. After you decide, you go back to:')}{' '}
            <span className="font-mono text-slate-200">{q.data.client.redirectHost}</span>
          </p>
          <fieldset className="space-y-2">
            <legend className="mb-1 text-xs font-medium text-slate-400">{t('Access')}</legend>
            <label className="flex items-start gap-2">
              <input type="radio" name="access" checked={chosen === 'read'} onChange={() => setAccess('read')} />
              <span>{t('Read only: it can look, but not change anything.')}</span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="access" checked={chosen === 'full'} onChange={() => setAccess('full')} />
              <span>{t('Full: it can do what you can, including deploys and settings.')}</span>
            </label>
          </fieldset>
          <p className="text-xs text-slate-500">
            {t('The grant appears under Settings → Security → API tokens; deleting it there disconnects the client.')}
          </p>
          {error && <p className="text-xs text-red-300">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => void decide(false)} disabled={busy}>
              {t('Deny')}
            </Button>
            <Button onClick={() => void decide(true)} disabled={busy}>
              {t('Allow')}
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
