import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, RefreshCw, Webhook } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useCopy } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, ConfirmDialog, Switch } from '../../components/ui.js';

/**
 * Deploy hook: a secret URL that redeploys the service when a CI job POSTs to
 * it. Turn it on, copy the curl line, rotate the URL (the old one stops
 * working) or turn it off. Hidden on a panel without the route and for a
 * viewer seat.
 */
export function DeployHookCard({ serviceId }: { serviceId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { copied, copy } = useCopy();
  const [confirmRotate, setConfirmRotate] = useState(false);
  const hook = useQuery({ queryKey: ['deploy-hook', serviceId], queryFn: () => api.services.deployHook.get(serviceId), retry: false });
  const set = (data: { enabled: boolean; url: string | null; mine: boolean }) => qc.setQueryData(['deploy-hook', serviceId], data);

  const enable = useMutation({
    mutationFn: () => api.services.deployHook.enable(serviceId),
    onSuccess: (data) => {
      set(data);
      toast(hook.data?.enabled ? 'New deploy hook URL — the old one no longer works' : 'Deploy hook on', 'success');
    },
    onError: (err: Error) => toast(err.message || 'Could not turn the deploy hook on', 'error'),
  });
  const disable = useMutation({
    mutationFn: () => api.services.deployHook.disable(serviceId),
    onSuccess: (data) => {
      set(data);
      toast('Deploy hook off', 'success');
    },
    onError: (err: Error) => toast(err.message || 'Could not turn the deploy hook off', 'error'),
  });

  if (hook.isError || !hook.data) return null;
  const { enabled, url } = hook.data;
  const curl = url ? `curl -fsS -X POST ${url}` : '';
  const busy = enable.isPending || disable.isPending;

  return (
    <Card>
      <CardBody>
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <Webhook size={15} className="text-slate-500" /> Deploy hook
          </div>
          <Switch checked={enabled} onChange={(on) => (on ? enable.mutate() : disable.mutate())} disabled={busy} label="Deploy hook" />
        </div>
        <p className="mb-3 text-xs text-slate-500">
          A secret URL that redeploys this service when called with POST — from a CI job, a cron or a script, without a Git
          webhook. It deploys as you, with your access checked on every call. Treat the URL like a password.
        </p>
        {enabled && url && (
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-black/30 px-2 py-1.5 font-mono text-[11px] text-slate-300" title={curl}>
              {curl}
            </code>
            <Button size="sm" variant="secondary" onClick={() => void copy(curl)} aria-label="Copy curl command">
              {copied ? <Check size={13} /> : <Copy size={13} />} curl
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmRotate(true)} disabled={busy} aria-label="New deploy hook URL">
              <RefreshCw size={13} />
            </Button>
          </div>
        )}
        {enabled && !url && (
          // Only the member a hook deploys as sees its URL; taking it over gives a new one.
          <div className="flex items-center justify-between gap-3 rounded bg-black/20 px-2 py-1.5 text-xs text-slate-400">
            <span>Turned on by another member — it deploys as them, so only they see the URL.</span>
            <Button size="sm" variant="secondary" onClick={() => setConfirmRotate(true)} disabled={busy}>
              <RefreshCw size={13} /> Use my own URL
            </Button>
          </div>
        )}
      </CardBody>
      <ConfirmDialog
        open={confirmRotate}
        title="New deploy hook URL?"
        message={
          url
            ? 'The current URL stops working; CI jobs that call it fail until you give them the new one.'
            : 'The other member’s URL stops working, and the hook deploys as you from now on.'
        }
        confirmLabel="New URL"
        onConfirm={() => {
          setConfirmRotate(false);
          enable.mutate();
        }}
        onClose={() => setConfirmRotate(false)}
      />
    </Card>
  );
}
