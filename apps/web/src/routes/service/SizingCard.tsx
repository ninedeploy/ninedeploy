import { useQuery } from '@tanstack/react-query';
import { Ruler } from 'lucide-react';
import type { SizingHint } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { msg, useT } from '../../lib/i18n.js';
import { Badge, Card, CardBody } from '../../components/ui.js';

const ACTION: Record<SizingHint['action'], string> = {
  set: msg('Set a limit'),
  raise: msg('Raise the limit'),
  lower: msg('Lower the limit'),
};
const TONE = { set: 'amber', raise: 'rose', lower: 'sky' } as const;

/**
 * Service → Settings, under Resource limits (G5.6): memory and CPU limit
 * suggestions from the service's metric history. Advisory: nothing changes
 * until someone edits the limits.
 */
export function SizingCard({ serviceId }: { serviceId: number }) {
  const t = useT();
  const q = useQuery({ queryKey: ['sizing', serviceId], queryFn: () => api.services.sizing(serviceId), staleTime: 5 * 60_000 });
  const r = q.data;
  if (!r || (!r.memory && !r.cpu)) return null;
  const amount = (h: SizingHint, v: number | null) => (v === null ? t('none') : h.resource === 'memory' ? `${v} MiB` : t('{n} cores', { n: v }));

  return (
    <Card>
      <CardBody className="space-y-3 text-sm">
        <div className="flex items-center gap-2 font-medium text-slate-300">
          <Ruler size={15} className="text-slate-500" /> {t('Right-sizing')}
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-400">
          {r.memory && <span>{t('Memory: {p95} MiB at the 95th percentile, peak {peak} MiB', { p95: Math.round(r.memory.p95), peak: Math.round(r.memory.peak) })}</span>}
          {r.cpu && <span>{t('CPU: {p95} cores at the 95th percentile, peak {peak}', { p95: r.cpu.p95.toFixed(2), peak: r.cpu.peak.toFixed(2) })}</span>}
          <span className="text-slate-500">{t('over the last {hours} h', { hours: r.spanHours })}</span>
        </div>
        {!r.enoughHistory ? (
          <p className="text-xs text-slate-500">{t('Suggestions start after 12 hours of history.')}</p>
        ) : r.hints.length === 0 ? (
          <p className="text-xs text-emerald-300">{t('The limits fit how the service runs.')}</p>
        ) : (
          <ul className="space-y-2">
            {r.hints.map((h) => (
              <li key={h.resource} className="flex flex-wrap items-center gap-2 text-xs">
                <Badge tone={TONE[h.action]}>{t(ACTION[h.action])}</Badge>
                <span className="text-slate-300">
                  {h.resource === 'memory' ? t('Memory') : t('CPU')}: {amount(h, h.current)} → <span className="font-mono">{amount(h, h.suggested)}</span>
                </span>
                <span className="text-slate-500">({h.reason})</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-slate-500">{t('From the primary container’s metrics. Nothing changes until you edit the limits above.')}</p>
      </CardBody>
    </Card>
  );
}
