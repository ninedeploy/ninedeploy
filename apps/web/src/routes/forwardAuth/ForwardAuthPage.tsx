import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useT } from '../../lib/i18n.js';
import { Card, CardBody, FullScreenSpinner } from '../../components/ui.js';

/**
 * G2.3: the panel end of forward auth. A domain behind panel sign-in sends a
 * visitor here (`?d=<domainId>&rd=<url>&state=…`); signed in, the page trades
 * the session for a one-time code on that domain and goes back.
 */
export function ForwardAuthPage() {
  const t = useT();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const domainId = Number(params.get('d'));
    const returnTo = params.get('rd') ?? '';
    const state = params.get('state') ?? '';
    if (!Number.isSafeInteger(domainId) || domainId < 1 || !returnTo || !state) {
      setError(t('This sign-in link is incomplete. Open the protected page again.'));
      return;
    }
    let cancelled = false;
    api.domains.forwardAuth
      .grant({ domainId, returnTo, state })
      .then(({ url }) => {
        if (!cancelled) window.location.replace(url);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [params, t]);

  if (!error) return <FullScreenSpinner />;
  return (
    <div className="mx-auto max-w-lg px-4 py-16">
      <Card>
        <CardBody className="space-y-2">
          <h1 className="flex items-center gap-2 text-base font-semibold text-slate-200">
            <ShieldCheck size={18} className="text-amber-400" /> {t('Could not open the protected page')}
          </h1>
          <p className="text-sm text-slate-400">{error}</p>
        </CardBody>
      </Card>
    </div>
  );
}
