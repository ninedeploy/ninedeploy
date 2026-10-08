import type { TrafficBucket, TrafficCounters, TrafficPercentiles, TrafficRange, TrafficScopeTotal } from '@ninedeploy/sdk';
import { formatBytes } from '../../lib/format.js';
import { cn } from '../ui.js';

/**
 * Traffic analytics views (0.15): a light inline-SVG chart (no chart
 * dependency, like `Sparkline`) with one stacked bar per bucket split by
 * status class and the average latency as a line, plus the totals strip,
 * the range picker and the per-domain table.
 */

export const TRAFFIC_RANGES: TrafficRange[] = ['1h', '24h', '7d', '30d'];

const CLASSES = [
  { key: 'status2xx', label: '2xx', color: '#34d399' },
  { key: 'status3xx', label: '3xx', color: '#38bdf8' },
  { key: 'status4xx', label: '4xx', color: '#fbbf24' },
  { key: 'status5xx', label: '5xx', color: '#fb7185' },
  { key: 'other', label: 'other', color: '#64748b' },
] as const;

const classCount = (b: TrafficCounters, key: (typeof CLASSES)[number]['key']) =>
  key === 'other' ? b.status1xx + b.statusOther : b[key];

const avgLatency = (b: TrafficCounters) => (b.requests > 0 ? b.durationSumMs / b.requests : 0);

export const formatMs = (ms: number | null) => (ms === null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);

export function errorRate(c: TrafficCounters): string {
  return c.requests > 0 ? `${((c.status5xx / c.requests) * 100).toFixed(1)}%` : '—';
}

export function TrafficRangePicker({ value, onChange }: { value: TrafficRange; onChange: (r: TrafficRange) => void }) {
  return (
    <fieldset className="inline-flex rounded-lg border-0 bg-white/[0.04] p-0.5" aria-label="Range">
      {TRAFFIC_RANGES.map((r) => (
        <button
          key={r}
          type="button"
          aria-pressed={value === r}
          onClick={() => onChange(r)}
          className={cn('rounded-md px-2.5 py-1 text-xs', value === r ? 'bg-indigo-500/20 text-indigo-200' : 'text-slate-400 hover:text-slate-200')}
        >
          {r}
        </button>
      ))}
    </fieldset>
  );
}

export function TrafficTotals({ totals }: { totals: TrafficCounters & TrafficPercentiles }) {
  const items = [
    { label: 'Requests', value: totals.requests.toLocaleString() },
    { label: '5xx rate', value: errorRate(totals) },
    { label: 'p50', value: formatMs(totals.p50Ms) },
    { label: 'p95', value: formatMs(totals.p95Ms) },
    { label: 'p99', value: formatMs(totals.p99Ms) },
    { label: 'Sent', value: formatBytes(totals.bytesOut) },
  ];
  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
      {items.map((i) => (
        <div key={i.label} className="rounded-lg bg-white/[0.03] px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">{i.label}</div>
          <div className="mt-0.5 font-mono text-sm text-slate-100">{i.value}</div>
        </div>
      ))}
    </div>
  );
}

const W = 600;
const H = 140;

export function TrafficChart({ series }: { series: TrafficBucket[] }) {
  if (series.length === 0) {
    return <div className="grid h-[140px] place-items-center text-xs text-slate-500">No requests in this range yet.</div>;
  }
  const maxReq = Math.max(1, ...series.map((b) => b.requests));
  const maxLat = Math.max(1, ...series.map(avgLatency));
  const slot = W / series.length;
  const bar = Math.max(1, slot * 0.8);
  const line = series
    .map((b, i) => `${i ? 'L' : 'M'}${(i * slot + slot / 2).toFixed(1)} ${(H - (avgLatency(b) / maxLat) * (H - 4) - 2).toFixed(1)}`)
    .join(' ');
  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[140px] w-full" role="img">
        <title>Requests per bucket by status class, and the average latency</title>
        {series.map((b, i) => {
          let y = H;
          return (
            <g key={b.t}>
              <title>{`${new Date(b.t).toLocaleString()}: ${b.requests} requests, avg ${formatMs(avgLatency(b))}`}</title>
              {CLASSES.map((c) => {
                const h = (classCount(b, c.key) / maxReq) * (H - 4);
                y -= h;
                return h > 0 ? <rect key={c.key} x={i * slot + (slot - bar) / 2} y={y} width={bar} height={h} fill={c.color} opacity={0.85} /> : null;
              })}
            </g>
          );
        })}
        {series.length > 1 && <path d={line} fill="none" stroke="#a5b4fc" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
        {CLASSES.map((c) => (
          <span key={c.key} className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm" style={{ background: c.color }} /> {c.label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1">
          <span className="h-0.5 w-3 bg-indigo-300" /> avg latency (max {formatMs(maxLat)})
        </span>
        <span className="ml-auto">peak {maxReq.toLocaleString()} req/bucket</span>
      </div>
    </div>
  );
}

const scopeLabel = (s: TrafficScopeTotal) =>
  s.host ?? (s.scopeKey === 'panel' ? 'panel' : s.scopeKey === 'custom' ? 'custom routes' : s.scopeKey);

export function TrafficScopeTable({ rows, empty }: { rows: TrafficScopeTotal[]; empty: string }) {
  if (rows.length === 0) return <p className="text-xs text-slate-500">{empty}</p>;
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left uppercase tracking-wide text-slate-500">
          <th className="py-2 font-medium">Host</th>
          <th className="py-2 text-right font-medium">Requests</th>
          <th className="py-2 text-right font-medium">5xx</th>
          <th className="py-2 text-right font-medium">p95</th>
          <th className="py-2 text-right font-medium">Sent</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.scopeKey} className="border-t border-white/5">
            <td className="py-2 font-mono text-slate-300">{scopeLabel(r)}</td>
            <td className="py-2 text-right text-slate-300">{r.requests.toLocaleString()}</td>
            <td className="py-2 text-right text-slate-400">{errorRate(r)}</td>
            <td className="py-2 text-right text-slate-400">{formatMs(r.p95Ms)}</td>
            <td className="py-2 text-right text-slate-400">{formatBytes(r.bytesOut)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
