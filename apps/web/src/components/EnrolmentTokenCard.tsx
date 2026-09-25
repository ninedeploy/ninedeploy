import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Eye, EyeOff, KeyRound, RefreshCw } from 'lucide-react';
import { authedFetch } from '../lib/api.js';
import { useCopy } from '../lib/format.js';
import { useToast } from './Toast.js';
import { Button, ConfirmDialog } from './ui.js';

/** `GET /v1/settings/enrolment` — the secret is returned in clear (operator-only route). */
export interface EnrolmentState {
  enabled: boolean;
  token: string | null;
}

export const ENROLMENT_QUERY_KEY = ['enrolment-token'] as const;

/**
 * Raw requests: the SDK has no methods for `/v1/settings/enrolment` (M-6).
 * `authedFetch` resolves against VITE_API_URL and refreshes on a 401.
 */
async function enrolmentRequest(method: 'GET' | 'POST' | 'DELETE', path = ''): Promise<EnrolmentState> {
  const res = await authedFetch(`/v1/settings/enrolment${path}`, { method });
  const body = (await res.json().catch(() => null)) as
    | { enabled?: boolean; token?: string | null; error?: { message?: string } }
    | null;
  if (!res.ok) throw new Error(body?.error?.message ?? `Request failed with status ${res.status}`);
  return { enabled: body?.enabled === true, token: body?.token ?? null };
}

/** The current enrolment secret; shared by the card and the auto-join command. */
export function useEnrolmentToken(enabled: boolean) {
  return useQuery({
    queryKey: ENROLMENT_QUERY_KEY,
    queryFn: () => enrolmentRequest('GET'),
    enabled,
  });
}

/**
 * r359: show, rotate and disable the node-enrolment secret that
 * `POST /v1/servers/announce` demands. The server has served
 * `GET/POST rotate/DELETE /v1/settings/enrolment` since M-6, but nothing in
 * the panel called it — while the Servers page told operators to paste an
 * `<enrolment-token-from-settings>` that no Settings screen showed.
 */
export function EnrolmentTokenCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { copied, copy } = useCopy();
  const [revealed, setRevealed] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const state = useEnrolmentToken(true);

  const rotate = useMutation({
    mutationFn: () => enrolmentRequest('POST', '/rotate'),
    onSuccess: (next) => {
      qc.setQueryData(ENROLMENT_QUERY_KEY, next);
      setRevealed(true);
      toast('New enrolment token generated — agents started with the old one can no longer announce', 'success');
    },
    onError: (err) => toast(err.message, 'error'),
  });
  const disable = useMutation({
    mutationFn: () => enrolmentRequest('DELETE'),
    onSuccess: () => {
      qc.setQueryData(ENROLMENT_QUERY_KEY, { enabled: false, token: null });
      setConfirmDisable(false);
      setRevealed(false);
      toast('Enrolment disabled — new nodes can no longer announce themselves', 'success');
    },
    onError: (err) => toast(err.message, 'error'),
  });

  const token = state.data?.token ?? null;

  return (
    <div className="mt-4 rounded-lg border border-white/[0.08] bg-slate-900/60 p-3" data-testid="enrolment-card">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-300">
        <KeyRound size={13} className="text-indigo-400" /> Enrolment token
      </div>
      {state.isLoading ? (
        <p className="text-xs text-slate-500">Loading…</p>
      ) : state.error ? (
        <p className="text-xs text-rose-300">Could not load the enrolment token: {state.error.message}</p>
      ) : token ? (
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded bg-black/40 px-2 py-1.5 font-mono text-[11px] text-slate-200">
            {revealed ? token : '•'.repeat(24)}
          </code>
          <Button size="sm" variant="secondary" onClick={() => setRevealed((r) => !r)} className="h-7 text-xs">
            {revealed ? <EyeOff size={12} /> : <Eye size={12} />}
            {revealed ? 'Hide' : 'Reveal'}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void copy(token)} className="h-7 text-xs">
            <Copy size={12} /> {copied ? 'Copied' : 'Copy token'}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => rotate.mutate()}
            disabled={rotate.isPending}
            className="h-7 text-xs"
          >
            <RefreshCw size={12} /> Rotate
          </Button>
          <Button size="sm" variant="danger" onClick={() => setConfirmDisable(true)} className="h-7 text-xs">
            Disable
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-amber-200">
            Enrolment is off: announcing nodes are refused until you generate a token.
          </p>
          <Button size="sm" onClick={() => rotate.mutate()} disabled={rotate.isPending} className="h-7 text-xs">
            Generate token
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirmDisable}
        title="Disable node enrolment?"
        message="New nodes will be refused when they announce themselves. Nodes that are already registered keep working."
        confirmLabel="Disable"
        onConfirm={() => disable.mutate()}
        onClose={() => setConfirmDisable(false)}
      />
    </div>
  );
}
