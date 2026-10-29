import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Coins } from 'lucide-react';
import type { UsageFigures, UsageReport } from '@ninedeploy/sdk';
import { api } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { useToast } from './Toast.js';
import { Button, Card, ErrorCard, Input, Select } from './ui.js';

/**
 * ROADMAP item 9: usage and cost per service, project and workspace (operator
 * only). The figures come from the resource history and traffic analytics the
 * panel already keeps; the cost is each server's monthly cost split among its
 * services by their share of its CPU and memory.
 */

const WINDOWS = [1, 7, 30, 90] as const;
type View = 'services' | 'projects' | 'workspaces';
const num = (n: number, digits = 2) => n.toLocaleString(undefined, { maximumFractionDigits: digits });

export function UsageCostCard() {
  const t = useT();
  const [days, setDays] = useState<number>(30);
  const [view, setView] = useState<View>('services');
  const [editing, setEditing] = useState(false);
  const report = useQuery({ queryKey: ['usage', days], queryFn: () => api.usage.report({ days }) });

  return (
    <Card className="p-5" data-testid="usage-cost">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
          <Coins size={15} className="text-amber-400" /> {t('Usage and cost')}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label={t('Window')} value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
            {WINDOWS.map((d) => (
              <option key={d} value={d}>
                {d === 1 ? t('Last 24 hours') : t('Last {days} days', { days: d })}
              </option>
            ))}
          </Select>
          <Select aria-label={t('Group by')} value={view} onChange={(e) => setView(e.target.value as View)}>
            <option value="services">{t('Services')}</option>
            <option value="projects">{t('Projects')}</option>
            <option value="workspaces">{t('Workspaces')}</option>
          </Select>
          <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)}>
            {t('Server costs')}
          </Button>
        </div>
      </div>

      {editing && report.data && <CostsForm report={report.data} onDone={() => setEditing(false)} />}

      {report.isError ? (
        <ErrorCard title={t('Usage could not be read')} error={report.error} onRetry={() => report.refetch()} />
      ) : !report.data ? (
        <p className="text-xs text-slate-500">{t('Reading usage…')}</p>
      ) : (
        <UsageTable report={report.data} view={view} />
      )}
    </Card>
  );
}

function UsageTable({ report, view }: { report: UsageReport; view: View }) {
  const t = useT();
  const rows: Array<UsageFigures & { key: number; name: string; detail: string }> =
    view === 'services'
      ? report.services.map((s) => ({ ...s, key: s.serviceId, detail: s.serverName }))
      : report[view].map((g) => ({ ...g, key: g.id, detail: t('{n} services', { n: g.services }) }));
  const money = (v: number | null) => (v === null ? '—' : `${num(v)} ${report.currency}`);
  return (
    <div className="space-y-2">
      {report.days > report.historyDays && (
        <p className="text-xs text-amber-300">
          {t('Resource history is kept for {kept} days, so CPU and memory older than that are not counted. Raise it under Resource history to cover the whole window.', { kept: report.historyDays })}
        </p>
      )}
      {!report.trafficAnalytics && <p className="text-xs text-slate-500">{t('Traffic analytics is off: bandwidth and requests are not counted.')}</p>}
      {view !== 'services' && <p className="text-xs text-slate-500">{t('A service in several groups counts in each, so groups do not add up to the total.')}</p>}
      {rows.length === 0 ? (
        <p className="text-xs text-slate-500">{t('Nothing to show yet.')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-slate-500">
              <tr>
                <th className="py-1 pr-3 font-medium">{t('Name')}</th>
                <th className="py-1 pr-3 text-right font-medium">{t('CPU (core-hours)')}</th>
                <th className="py-1 pr-3 text-right font-medium">{t('Memory (GiB-hours)')}</th>
                <th className="py-1 pr-3 text-right font-medium">{t('Egress (GB)')}</th>
                <th className="py-1 pr-3 text-right font-medium">{t('Requests')}</th>
                <th className="py-1 text-right font-medium">{t('Cost')}</th>
              </tr>
            </thead>
            <tbody className="text-slate-300">
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-white/5">
                  <td className="py-1.5 pr-3">
                    <span className="font-medium text-slate-200">{r.name}</span> <span className="text-slate-500">{r.detail}</span>
                  </td>
                  <td className="py-1.5 pr-3 text-right font-mono">{num(r.cpuCoreHours)}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{num(r.memoryGbHours)}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{num(r.egressGb, 3)}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{num(r.requests, 0)}</td>
                  <td className="py-1.5 text-right font-mono">{money(r.cost)}</td>
                </tr>
              ))}
            </tbody>
            {view === 'services' && (
              <tfoot className="text-slate-200">
                <tr className="border-t border-white/10">
                  <td className="py-1.5 pr-3 font-medium">{t('Total')}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{num(report.totals.cpuCoreHours)}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{num(report.totals.memoryGbHours)}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{num(report.totals.egressGb, 3)}</td>
                  <td className="py-1.5 pr-3 text-right font-mono">{num(report.totals.requests, 0)}</td>
                  <td className="py-1.5 text-right font-mono">{money(report.totals.cost)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {report.servers.some((s) => s.unallocated) && (
        <p className="text-xs text-slate-500">
          {t('Not carried by any service: {list}', {
            list: report.servers
              .filter((s) => s.unallocated)
              .map((s) => `${s.name} ${money(s.unallocated)}`)
              .join(', '),
          })}
        </p>
      )}
    </div>
  );
}

function CostsForm({ report, onDone }: { report: UsageReport; onDone: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [currency, setCurrency] = useState(report.currency);
  const [costs, setCosts] = useState<Record<string, string>>(() =>
    Object.fromEntries(report.servers.map((s) => [String(s.serverId), s.monthlyCost === null ? '' : String(s.monthlyCost)])),
  );
  const save = useMutation({
    mutationFn: () =>
      api.usage.setCosts({
        currency: currency.trim().toUpperCase(),
        servers: report.servers.flatMap((s) => {
          const v = costs[String(s.serverId)]?.trim();
          return v ? [{ serverId: s.serverId, monthlyCost: Number(v) }] : [];
        }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['usage'] });
      toast(t('Server costs saved'), 'success');
      onDone();
    },
    onError: (err) => toast(t('Server costs could not be saved: {error}', { error: err instanceof Error ? err.message : String(err) }), 'error'),
  });
  const valid = /^[A-Za-z]{3}$/.test(currency.trim()) && Object.values(costs).every((v) => !v.trim() || (Number.isFinite(Number(v)) && Number(v) >= 0));
  return (
    <form
      className="mb-3 space-y-2 rounded-lg border border-white/5 p-3"
      aria-label={t('Server costs')}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate();
      }}
    >
      <p className="text-xs text-slate-500">
        {t('What each server costs a month. It is split among the services on it, half by their share of its CPU time and half by their share of its memory. Leave a server empty to leave it unpriced.')}
      </p>
      <label className="flex items-center gap-2 text-xs text-slate-400">
        {t('Currency')}
        <Input className="w-20" value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value)} />
      </label>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {report.servers.map((s) => (
          <label key={String(s.serverId)} className="flex items-center justify-between gap-2 text-xs text-slate-300">
            <span>{s.name}</span>
            <Input
              className="w-32"
              inputMode="decimal"
              aria-label={t('Monthly cost of {name}', { name: s.name })}
              value={costs[String(s.serverId)] ?? ''}
              onChange={(e) => setCosts((c) => ({ ...c, [String(s.serverId)]: e.target.value }))}
            />
          </label>
        ))}
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={!valid || save.isPending}>
          {t('Save')}
        </Button>
      </div>
    </form>
  );
}
