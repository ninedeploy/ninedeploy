import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import type { OsUpdateStatus } from '@ninedeploy/sdk';
import { api } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import { useT } from '../lib/i18n.js';
import { useToast } from './Toast.js';
import { Badge, Button, Switch } from './ui.js';

/**
 * G4.2: a host's pending OS updates, automatic security updates and the
 * pending-reboot flag. `serverId` null is the panel host. Nothing is read
 * until the operator asks: every read runs a helper container on the host.
 * The panel never reboots a host; the card says so.
 */

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const SHOWN = 15;

export function OsUpdatesCard({ serverId }: { serverId: number | null }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const key = ['os-updates', serverId ?? 'panel'];
  const [asked, setAsked] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const status = useQuery({
    queryKey: key,
    queryFn: () => api.osUpdates.get(serverId),
    enabled: asked,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const refresh = useMutation({
    mutationFn: () => api.osUpdates.get(serverId, { refresh: true }),
    onSuccess: (res) => qc.setQueryData(key, res),
    onError: (err) => toast(t('Could not refresh the package lists: {error}', { error: errorText(err) }), 'error'),
  });
  const setAuto = useMutation({
    mutationFn: (enabled: boolean) => api.osUpdates.setAuto(serverId, enabled),
    onSuccess: (res) => {
      qc.setQueryData(key, res);
      toast(res.autoUpdates.enabled ? t('Automatic security updates are on') : t('Automatic security updates are off'), 'success');
    },
    onError: (err) => toast(t('Could not change automatic updates: {error}', { error: errorText(err) }), 'error'),
  });

  const data: OsUpdateStatus | undefined = status.data;
  const busy = status.isFetching || refresh.isPending || setAuto.isPending;
  const updates = data ? [...data.updates].sort((a, b) => Number(b.security) - Number(a.security) || a.name.localeCompare(b.name)) : [];

  return (
    <section aria-label={t('OS security updates')} className="space-y-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-semibold text-slate-300">
          <ShieldCheck size={13} className="text-emerald-400" /> {t('OS security updates')}
        </div>
        {!asked ? (
          <Button size="sm" variant="secondary" onClick={() => setAsked(true)}>
            {t('Check updates')}
          </Button>
        ) : (
          data && (
            <Button size="sm" variant="secondary" onClick={() => refresh.mutate()} disabled={busy}>
              <RefreshCw size={11} className={refresh.isPending ? 'animate-spin' : ''} /> {refresh.isPending ? t('Refreshing…') : t('Refresh package lists')}
            </Button>
          )
        )}
      </div>

      {asked && status.isLoading && <p className="text-slate-500">{t('Reading the host…')}</p>}
      {status.isError && <p className="text-rose-300">{t('Could not read the host: {error}', { error: errorText(status.error) })}</p>}

      {data && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-slate-400">
            <span>{data.os.name || data.os.id}</span>
            {data.packageManager !== 'unsupported' && <Badge>{data.packageManager}</Badge>}
            {data.rebootRequired === true && <Badge tone="amber">{t('Reboot required')}</Badge>}
            <span className="text-slate-600">{t('checked {time}', { time: formatDateTime(data.checkedAt) })}</span>
          </div>

          {data.packageManager === 'unsupported' ? (
            <p className="text-slate-500">{t('This host has neither apt nor dnf, so NineDeploy cannot read or manage its updates.')}</p>
          ) : (
            <>
              <div className="flex items-start gap-3">
                <Switch
                  checked={data.autoUpdates.enabled}
                  onChange={(v) => setAuto.mutate(v)}
                  disabled={busy}
                  label={t('Install security updates automatically')}
                />
                <div>
                  <div className="text-slate-300">{t('Install security updates automatically')}</div>
                  <div className="mt-0.5 text-[11px] leading-relaxed text-slate-500">
                    {data.packageManager === 'apt'
                      ? t('Uses unattended-upgrades (installed if missing), with its automatic reboot turned off.')
                      : t('Uses dnf-automatic (installed if missing) with security updates only.')}{' '}
                    {t('NineDeploy never reboots the host; plan reboots yourself.')}
                  </div>
                </div>
              </div>

              {data.rebootRequired === true && data.rebootPackages.length > 0 && (
                <p className="text-amber-300">{t('Waiting for a reboot: {packages}', { packages: data.rebootPackages.join(', ') })}</p>
              )}
              {data.rebootRequired === null && <p className="text-slate-500">{t('This host cannot tell whether a reboot is pending.')}</p>}

              <div>
                <div className="mb-1 text-slate-300">
                  {data.updates.length === 0
                    ? t('No pending updates.')
                    : t('{n} pending updates, {s} of them security updates', { n: data.updates.length, s: data.securityCount })}
                  {data.updatesTruncated && ` ${t('(list cut short)')}`}
                </div>
                {updates.length > 0 && (
                  <ul className="space-y-0.5 font-mono text-[11px]">
                    {(showAll ? updates : updates.slice(0, SHOWN)).map((u) => (
                      <li key={u.name} className="flex flex-wrap items-center gap-2">
                        {u.security && <Badge tone="rose">{t('security')}</Badge>}
                        <span className="text-slate-300">{u.name}</span>
                        <span className="text-slate-500">
                          {u.from ? `${u.from} → ` : ''}
                          {u.version}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {updates.length > SHOWN && (
                  <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-1 text-indigo-400 hover:underline">
                    {showAll ? t('Show fewer') : t('Show all {n}', { n: updates.length })}
                  </button>
                )}
              </div>
            </>
          )}
          {data.warnings.length > 0 && <p className="text-amber-300">{data.warnings.join(' · ')}</p>}
        </>
      )}
    </section>
  );
}
