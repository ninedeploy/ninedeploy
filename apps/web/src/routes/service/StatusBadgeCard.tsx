import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Check, Copy, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useCopy } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, ConfirmDialog, Switch } from '../../components/ui.js';

/**
 * 0.16.1 deploy status badge for a README: turn it on, copy the Markdown,
 * rotate the URL (the old one stops working) or turn it off. The badge shows
 * the deploy state only. Hidden on a panel that does not have the route.
 */
export function StatusBadgeCard({ serviceId, serviceName }: { serviceId: number; serviceName: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { copied, copy } = useCopy();
  const [confirmRotate, setConfirmRotate] = useState(false);
  const badge = useQuery({ queryKey: ['badge', serviceId], queryFn: () => api.services.badge.get(serviceId), retry: false });
  const set = (data: { enabled: boolean; url: string | null }) => qc.setQueryData(['badge', serviceId], data);

  const enable = useMutation({
    mutationFn: () => api.services.badge.enable(serviceId),
    onSuccess: (data) => {
      set(data);
      toast(badge.data?.enabled ? 'New badge URL — the old one no longer works' : 'Status badge on', 'success');
    },
    onError: (err: Error) => toast(err.message || 'Could not turn the badge on', 'error'),
  });
  const disable = useMutation({
    mutationFn: () => api.services.badge.disable(serviceId),
    onSuccess: (data) => {
      set(data);
      toast('Status badge off', 'success');
    },
    onError: (err: Error) => toast(err.message || 'Could not turn the badge off', 'error'),
  });

  // An older panel (no route) or a viewer seat (403): nothing to offer.
  if (badge.isError || !badge.data) return null;
  const { enabled, url } = badge.data;
  const markdown = url ? `[![${serviceName} deploy](${url})](${url})` : '';
  const busy = enable.isPending || disable.isPending;

  return (
    <Card>
      <CardBody>
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <BadgeCheck size={15} className="text-slate-500" /> Status badge
          </div>
          <Switch
            checked={enabled}
            onChange={(on) => (on ? enable.mutate() : disable.mutate())}
            disabled={busy}
            label="Status badge"
          />
        </div>
        <p className="mb-3 text-xs text-slate-500">
          A public image for your README that reads running, deploying, failed or stopped — nothing else about the service.
          Anyone with the URL can see it.
        </p>
        {enabled && url && (
          <div className="space-y-2">
            <img src={url} alt="Deploy status badge" className="h-5" />
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-black/30 px-2 py-1.5 font-mono text-[11px] text-slate-300" title={markdown}>
                {markdown}
              </code>
              <Button size="sm" variant="secondary" onClick={() => void copy(markdown)} aria-label="Copy Markdown">
                {copied ? <Check size={13} /> : <Copy size={13} />} Markdown
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRotate(true)} disabled={busy} aria-label="New badge URL">
                <RefreshCw size={13} />
              </Button>
            </div>
            <p className="text-[11px] text-slate-600">
              Add <code className="font-mono">?label=prod</code> to the URL for another label.
            </p>
          </div>
        )}
      </CardBody>
      <ConfirmDialog
        open={confirmRotate}
        title="New badge URL?"
        message="The current badge URL stops working; READMEs that embed it show a 'not found' badge until you update them."
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
