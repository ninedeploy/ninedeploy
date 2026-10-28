import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, PackageCheck, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import type { RegistryHookView, ServiceDetail } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { formatDateTime, useCopy } from '../../lib/format.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, ConfirmDialog, Switch } from '../../components/ui.js';
import { useT } from '../../lib/i18n.js';

/**
 * G1.7 registry push webhook: a secret URL to paste into Docker Hub, GHCR,
 * Harbor or a registry:2 notification endpoint. The service redeploys when
 * the pushed tag is its image. The token is stored hashed, so the URL is
 * shown once, right after it is made.
 */
export function RegistryHookCard({ svc }: { svc: ServiceDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { copied, copy } = useCopy();
  const [confirmRotate, setConfirmRotate] = useState(false);
  const imageService = svc.type === 'docker' && !!svc.image;
  const hook = useQuery({
    queryKey: ['registry-hook', svc.id],
    queryFn: () => api.services.registryHook.get(svc.id),
    retry: false,
    enabled: imageService,
  });
  const set = (data: RegistryHookView) => qc.setQueryData(['registry-hook', svc.id], data);

  const enable = useMutation({
    mutationFn: () => api.services.registryHook.enable(svc.id),
    onSuccess: (data) => {
      set(data);
      toast(hook.data?.enabled ? t('New registry webhook URL — the old one no longer works') : t('Registry webhook on'), 'success');
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });
  const disable = useMutation({
    mutationFn: () => api.services.registryHook.disable(svc.id),
    onSuccess: (data) => {
      set(data);
      toast(t('Registry webhook off'), 'success');
    },
    onError: (err: Error) => toast(err.message, 'error'),
  });

  if (!imageService || hook.isError || !hook.data) return null;
  const { enabled, url, mine, lastPushAt } = hook.data;
  const busy = enable.isPending || disable.isPending;

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <PackageCheck size={15} className="text-slate-500" /> {t('Registry webhook')}
          </div>
          <Switch checked={enabled} onChange={(on) => (on ? enable.mutate() : disable.mutate())} disabled={busy} label={t('Registry webhook')} />
        </div>
        <p className="text-xs text-slate-500">
          {t('Paste this URL into Docker Hub, GitHub Packages, Harbor or a registry:2 notification endpoint. When {image} is pushed, the service redeploys, as you, with your access checked on every call. Pushes of other images or tags are ignored.', { image: svc.image ?? '' })}
        </p>
        {enabled && url && (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-black/30 px-2 py-1.5 font-mono text-[11px] text-slate-300" title={url}>
                {url}
              </code>
              <Button size="sm" variant="secondary" onClick={() => void copy(url)} aria-label={t('Copy URL')}>
                {copied ? <Check size={13} /> : <Copy size={13} />}
              </Button>
            </div>
            <p className="text-xs text-amber-300/80">{t('Copy it now: it is shown only once.')}</p>
          </div>
        )}
        {enabled && !url && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded bg-black/20 px-2 py-1.5 text-xs text-slate-400">
            <span>
              {mine ? t('On. The URL was shown once when it was made; make a new one if you lost it.') : t('Turned on by another member — it deploys as them.')}
              {lastPushAt ? ` · ${t('last push {time}', { time: formatDateTime(lastPushAt) })}` : ''}
            </span>
            <Button size="sm" variant="secondary" onClick={() => setConfirmRotate(true)} disabled={busy}>
              <RefreshCw size={13} /> {t('New URL')}
            </Button>
          </div>
        )}
      </CardBody>
      <ConfirmDialog
        open={confirmRotate}
        title={t('New registry webhook URL?')}
        message={t('The current URL stops working; update the webhook in your registry with the new one. The hook deploys as you from now on.')}
        confirmLabel={t('New URL')}
        onConfirm={() => {
          setConfirmRotate(false);
          enable.mutate();
        }}
        onClose={() => setConfirmRotate(false)}
      />
    </Card>
  );
}
