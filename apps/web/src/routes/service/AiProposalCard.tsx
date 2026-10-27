import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, FileDiff, Wand2 } from 'lucide-react';
import type { AiFixProposal, AiSettingsChange, Service } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Button, Spinner } from '../../components/ui.js';
import { msg, useT } from '../../lib/i18n.js';

/** The label of a proposed setting, as the Settings tab names it. */
const LABELS: Record<string, string> = {
  port: msg('Port'),
  healthPath: msg('Health path'),
  buildPack: msg('Build pack'),
  baseDir: msg('Base directory'),
  installCmd: msg('Install command'),
  buildCmd: msg('Build command'),
  startCmd: msg('Start command'),
  dockerfilePath: msg('Dockerfile path'),
};

/** Each proposed setting as [key, current value, proposed value]. */
export function settingRows(settings: AiSettingsChange, svc: Service | undefined): Array<[string, string, string]> {
  const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));
  const rows: Array<[string, string, string]> = [];
  if (settings.port !== undefined) rows.push(['port', show(svc?.port), String(settings.port)]);
  if (settings.healthPath !== undefined) rows.push(['healthPath', show(svc?.healthPath), settings.healthPath]);
  for (const [key, value] of Object.entries(settings.build ?? {})) {
    rows.push([key, show((svc?.build as Record<string, unknown> | undefined)?.[key]), show(value)]);
  }
  return rows;
}

/**
 * 0.16.16: what an AI diagnosis proposes. A settings change is shown next to
 * the current values and applied with the ordinary service update (all its
 * rules apply), then redeployed; file edits are shown as find/replace to
 * copy into the repository.
 */
export function AiProposalCard({
  serviceId,
  proposal,
  onDeployed,
}: {
  serviceId: number;
  proposal: AiFixProposal;
  onDeployed: (deploymentId: number) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const service =useQuery({ queryKey: ['service', serviceId], queryFn: () => api.services.get(serviceId) });
  const apply = useMutation({
    mutationFn: async () => {
      await api.services.update(serviceId, proposal.settings as Parameters<typeof api.services.update>[1]);
      return api.deploys.trigger(serviceId);
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['service', serviceId] });
      qc.invalidateQueries({ queryKey: ['deploys', serviceId] });
      toast(t('Change applied — redeploying'), 'info');
      onDeployed(res.deploymentId);
    },
    onError: (err: unknown) => toast(err instanceof Error ? err.message : t('Could not apply the change'), 'error'),
  });
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(t('Copied'), 'info');
    } catch {
      toast(t('Could not copy'), 'error');
    }
  };

  return (
    <div className="mt-3 space-y-3">
      {proposal.settings && (
        <div className="rounded-lg border border-indigo-500/20 bg-indigo-500/[0.06] p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-200">
            <Wand2 size={13} className="text-indigo-300" /> {t('Proposed settings change')}
          </div>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="py-1 pr-3 font-normal">{t('Setting')}</th>
                <th className="py-1 pr-3 font-normal">{t('Now')}</th>
                <th className="py-1 font-normal">{t('Proposed')}</th>
              </tr>
            </thead>
            <tbody>
              {settingRows(proposal.settings, service.data).map(([key, now, next]) => (
                <tr key={key} className="align-top">
                  <td className="py-1 pr-3 text-slate-300">{LABELS[key] ? t(LABELS[key]) : key}</td>
                  <td className="py-1 pr-3 font-mono text-rose-200/80">{now}</td>
                  <td className="py-1 font-mono text-emerald-200">{next}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" onClick={() => apply.mutate()} disabled={apply.isPending}>
              {apply.isPending ? <Spinner className="h-3 w-3" /> : <Wand2 size={13} />} {t('Apply and redeploy')}
            </Button>
            <span className="text-[11px] text-slate-500">{t('Check it first: the model can be wrong.')}</span>
          </div>
        </div>
      )}
      {proposal.files?.map((f, i) => (
        <div key={`${f.path}-${i}`} className="rounded-lg border border-white/[0.07] bg-white/[0.02] p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-slate-200">
              <FileDiff size={13} className="shrink-0 text-slate-400" />
              <span className="truncate font-mono">{f.path}</span>
            </span>
            <button
              type="button"
              onClick={() => void copy(f.replace)}
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-slate-400 hover:bg-white/5 hover:text-slate-200"
              aria-label={t('Copy the replacement for {path}', { path: f.path })}
            >
              <Copy size={11} /> {t('Copy replacement')}
            </button>
          </div>
          {f.why && <p className="mb-2 text-[11px] text-slate-400">{f.why}</p>}
          <div className="overflow-x-auto rounded bg-black/40 p-2 font-mono text-[11px] leading-relaxed">
            {f.find.split('\n').map((l, n) => (
              <div key={`f${n}`} className="whitespace-pre text-rose-300/90">- {l}</div>
            ))}
            {f.replace.split('\n').map((l, n) => (
              <div key={`r${n}`} className="whitespace-pre text-emerald-300/90">+ {l}</div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
