import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, ConfirmDialog, ErrorCard, Select, Skeleton } from '../../components/ui.js';
import { type Translate, useT } from '../../lib/i18n.js';

/** The egress routes answer 200 `{ ok: false, error }` for a refused request. */
function refused(res: { ok: boolean; error?: string }, t: Translate): void {
  if (!res.ok) throw new Error(res.error ?? t('The request was refused'));
}

/**
 * Settings → Security, G1.5 (operator): a static outgoing IP per project
 * (G-15). Traffic from the project's containers leaves through the chosen
 * host address (iptables SNAT), so an external allow-list can name it. The
 * routes and `ninedeploy egress` existed; this is the first web control.
 */
export function EgressIpCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useT();
  const rules = useQuery({ queryKey: ['egress'], queryFn: () => api.egress.list() });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.projects.list() });
  const hostIps = useQuery({ queryKey: ['host-ips'], queryFn: () => api.hostIps.list() });
  const [projectId, setProjectId] = useState('');
  const [ip, setIp] = useState('');
  const [pendingClear, setPendingClear] = useState<{ projectId: number; driver: string } | null>(null);

  const changed = (message: string) => {
    void qc.invalidateQueries({ queryKey: ['egress'] });
    toast(message, 'success');
  };
  const attach = useMutation({
    mutationFn: async () => {
      const res = await api.egress.set({ projectId: Number(projectId), ip });
      refused(res, t);
      return res;
    },
    onSuccess: () => {
      setProjectId('');
      setIp('');
      changed(t('Outgoing IP set'));
    },
    onError: (err: Error) => toast(err.message || t('Could not set the outgoing IP'), 'error'),
  });
  const clear = useMutation({
    mutationFn: async (target: { projectId: number; driver: string }) => refused(await api.egress.clear(target.projectId, target.driver), t),
    onSuccess: () => changed(t('Outgoing IP removed')),
    onError: (err: Error) => toast(err.message || t('Could not remove the outgoing IP'), 'error'),
  });

  const title = (
    <div className="p-4 border-b border-white/[0.06]">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-slate-400">
        <ArrowUpRight size={14} /> {t('Outgoing IP per project')}
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        {t("Traffic from a project's containers on the panel host leaves through the address you pick, so an external allow-list can name it. Applied with iptables SNAT on the panel host.")}
      </p>
    </div>
  );

  if (rules.isLoading) {
    return (
      <Card>
        <CardBody>
          <Skeleton className="h-20" />
        </CardBody>
      </Card>
    );
  }
  if (rules.isError) return <ErrorCard title={t('Could not load the outgoing IP rules')} error={rules.error} onRetry={() => void rules.refetch()} />;

  const projectName = (id: number) => projects.data?.find((p) => p.id === id)?.name ?? t('project #{id}', { id });
  const rows = (rules.data?.drivers ?? []).flatMap((d) => d.rules.map((r) => ({ driver: d.name, ...r })));
  const ipv4 = (hostIps.data?.addresses ?? []).filter((a) => a.family === 4);
  const hasDriver = (rules.data?.drivers ?? []).length > 0;

  return (
    <Card className="overflow-hidden">
      {title}
      <CardBody className="space-y-4">
        {rows.length === 0 ? (
          <p className="text-xs text-slate-500">{t("No project has its own outgoing IP; containers leave through the host's default route.")}</p>
        ) : (
          <ul className="divide-y divide-white/5 text-sm">
            {rows.map((r) => (
              <li key={`${r.driver}-${r.selector.projectId}`} className="flex flex-wrap items-center gap-3 py-2">
                <span className="text-slate-200">{projectName(r.selector.projectId)}</span>
                <span className="font-mono text-xs text-indigo-300">{r.ip}</span>
                {r.selector.sourceCidr && <span className="font-mono text-[11px] text-slate-500">{t('from {cidr}', { cidr: r.selector.sourceCidr })}</span>}
                <span className="text-[11px] text-slate-600">{r.driver}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  aria-label={t('Remove the outgoing IP of {project}', { project: projectName(r.selector.projectId) })}
                  disabled={clear.isPending}
                  onClick={() => setPendingClear({ projectId: r.selector.projectId, driver: r.driver })}
                >
                  <Trash2 size={12} />
                </Button>
              </li>
            ))}
          </ul>
        )}

        {hasDriver ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              attach.mutate();
            }}
          >
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label={t('Project')} className="w-48 text-xs">
              <option value="">{t('Project…')}</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <Select value={ip} onChange={(e) => setIp(e.target.value)} aria-label={t('Outgoing IP')} className="w-48 font-mono text-xs">
              <option value="">{t('Host IPv4 address…')}</option>
              {ipv4.map((a) => (
                <option key={a.ip} value={a.ip}>
                  {a.ip}
                  {a.label ? ` (${a.label})` : ''}
                </option>
              ))}
            </Select>
            <Button type="submit" size="sm" disabled={!projectId || !ip || attach.isPending}>
              {t('Set outgoing IP')}
            </Button>
          </form>
        ) : (
          <p className="text-xs text-amber-300">{t('No egress IP driver is registered on this panel.')}</p>
        )}
      </CardBody>
      <ConfirmDialog
        open={pendingClear != null}
        title={t('Remove the outgoing IP?')}
        message={pendingClear ? t("Traffic from {project} leaves through the host's default route again.", { project: projectName(pendingClear.projectId) }) : ''}
        confirmLabel={t('Remove')}
        onConfirm={() => {
          if (pendingClear) clear.mutate(pendingClear);
        }}
        onClose={() => setPendingClear(null)}
      />
    </Card>
  );
}
