import { type ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, CheckCircle2, XCircle } from 'lucide-react';
import type { AcceptDomainTransferResult } from '@ninedeploy/sdk';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { formatDateTime } from '../lib/format.js';
import { Button, Card, Field, Select, Spinner } from '../components/ui.js';

/**
 * r358: the page behind the accept link a domain transfer prints
 * (`/domains/transfers/:token/accept`, built by `lib/domainTransfer.ts` on
 * the server). The CLI tells the sender to share that URL, but no route
 * matched it, so the recipient landed on "Not found" and the only way to
 * accept was the CLI.
 *
 * It sits behind RequireAuth: accepting needs a session whose email matches
 * the transfer, and the recipient has to pick one of THEIR services (admin
 * seat — the server re-checks) as the new owner of the hostname. There is no
 * "decline" call for the recipient: the server lets only the sender (or an
 * operator) cancel, so the page says so and lets the link lapse instead.
 */
export function DomainTransferAccept() {
  const { token = '' } = useParams<{ token: string }>();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [targetId, setTargetId] = useState('');
  const [done, setDone] = useState<AcceptDomainTransferResult | null>(null);

  const preview = useQuery({
    queryKey: ['domain-transfer', token],
    queryFn: () => api.domains.previewTransfer(token),
    retry: false,
  });
  const services = useQuery({ queryKey: ['services'], queryFn: () => api.services.list() });

  const accept = useMutation({
    mutationFn: () => api.domains.acceptTransfer(token, { targetServiceId: Number(targetId) }),
    onSuccess: (result) => {
      setDone(result);
      void qc.invalidateQueries({ queryKey: ['domains-all'] });
      void qc.invalidateQueries({ queryKey: ['domains'] });
      void qc.invalidateQueries({ queryKey: ['domain-transfer', token] });
    },
  });

  if (preview.isLoading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const shell = (children: ReactNode) => (
    <div className="flex min-h-[50vh] items-center justify-center px-4">
      <Card className="w-full max-w-lg space-y-4 p-6">{children}</Card>
    </div>
  );
  const backLink = (
    <Link to="/domains" className="text-xs text-indigo-300 hover:underline">
      Back to domains
    </Link>
  );

  if (done) {
    return shell(
      <div className="space-y-3 text-center">
        <CheckCircle2 size={36} className="mx-auto text-emerald-400" />
        <h1 className="text-lg font-semibold text-white">Domain transferred</h1>
        <p className="text-sm text-slate-300">
          <strong className="text-white">{done.hostname}</strong> now routes to your service. Redeploying is not
          required — the proxy was updated.
        </p>
        <Link to={`/services/${done.serviceId}`} className="text-xs text-indigo-300 hover:underline">
          Open the service
        </Link>
      </div>,
    );
  }

  const data = preview.data;
  if (!data) {
    return shell(
      <div className="space-y-3 text-center">
        <XCircle size={36} className="mx-auto text-rose-400" />
        <h1 className="text-lg font-semibold text-white">Transfer not found</h1>
        <p className="text-sm text-slate-400">
          The link is invalid or the transfer no longer exists. Ask the sender for a fresh link.
        </p>
        {backLink}
      </div>,
    );
  }

  const header = (
    <div className="flex items-center gap-3">
      <ArrowRightLeft size={26} className="text-indigo-400" />
      <div>
        <h1 className="text-lg font-semibold text-white">Domain transfer: {data.hostname}</h1>
        <p className="text-xs text-slate-400">
          From <span className="text-slate-200">{data.sourceEmail}</span> to{' '}
          <span className="text-slate-200">{data.targetEmail}</span>
        </p>
      </div>
    </div>
  );

  if (data.status !== 'pending') {
    return shell(
      <>
        {header}
        <p className="text-sm text-slate-300">
          This transfer is <strong className="text-white">{data.status}</strong> and can no longer be accepted.
        </p>
        {backLink}
      </>,
    );
  }

  const emailMatches = user?.email.toLowerCase() === data.targetEmail.toLowerCase();
  const list = services.data ?? [];

  return shell(
    <>
      {header}
      <p className="text-sm text-slate-300">
        Accepting moves the hostname onto one of your services; the sender's service stops serving it immediately.
        The link expires {formatDateTime(data.expiresAt * 1000)}.
      </p>
      {!emailMatches ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3 text-sm text-amber-200">
          This transfer is addressed to <strong>{data.targetEmail}</strong>, but you are signed in as{' '}
          <strong>{user?.email}</strong>. Sign in with the addressed account to accept it.
        </p>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            accept.mutate();
          }}
        >
          <Field label="Move it to" hint="You need an admin seat on the service">
            <Select value={targetId} onChange={(e) => setTargetId(e.target.value)} required>
              <option value="">{list.length === 0 ? 'You have no services yet' : 'Choose a service…'}</option>
              {list.map((s) => (
                <option key={s.id} value={String(s.id)}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          {accept.error && <p className="text-sm text-rose-300">{accept.error.message}</p>}
          <div className="flex items-center justify-end gap-2">
            <Link to="/domains">
              <Button type="button" variant="secondary">
                Not now
              </Button>
            </Link>
            <Button type="submit" disabled={!targetId || accept.isPending}>
              {accept.isPending ? 'Transferring…' : 'Accept transfer'}
            </Button>
          </div>
        </form>
      )}
      <p className="text-[11px] text-slate-500">
        Only the sender can cancel a transfer. If you do not want it, ignore the link — it lapses at expiry.
      </p>
    </>,
  );
}
