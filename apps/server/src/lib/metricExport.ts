import { sql } from 'drizzle-orm';
import type { DB } from '@ninedeploy/db';
import type { ObservabilitySettings } from '@ninedeploy/schemas';
import { guardedFetch } from './egressGuard.js';

export interface ResourceMetric {
  serviceId: number;
  slug: string;
  serverId: number | null;
  kind: 'cpu' | 'memory';
  value: number;
  ts: number;
}

/** No tenant data is exported through this helper's routes without an operator credential. */
export async function resourceMetrics(db: DB, now = new Date()): Promise<ResourceMetric[]> {
  const end = Math.floor(now.getTime() / 1000), start = end - 120;
  const rows = await db.all<{ service_id: number; slug: string; server_id: number | null; kind: string; value: number; ts: number }>(sql`
    select m.service_id, s.slug, s.server_id, m.kind, m.value, m.ts
    from metrics m join services s on s.id = m.service_id
    where m.kind in ('cpu', 'memory') and m.ts >= ${start} and m.ts <= ${end}
      and m.id = (select newest.id from metrics newest where newest.service_id = m.service_id
        and newest.kind = m.kind and newest.ts <= ${end} order by newest.ts desc, newest.id desc limit 1)
    order by m.service_id, m.kind limit 10001
  `);
  if (rows.length > 10000) throw new Error('Metric export exceeds 10000 series');
  return rows.filter((r) => Number.isFinite(r.value) && r.value >= 0).map((r) => ({
    serviceId: r.service_id, slug: r.slug, serverId: r.server_id, kind: r.kind as 'cpu' | 'memory',
    value: r.kind === 'cpu' ? r.value / 100 : r.value, ts: r.ts,
  }));
}

const label = (s: string) => s.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
export function prometheusMetrics(rows: ResourceMetric[]): string {
  const lines = [
    '# HELP ninedeploy_service_cpu_percent Service CPU usage in percent (100 is one CPU core).',
    '# TYPE ninedeploy_service_cpu_percent gauge',
    '# HELP ninedeploy_service_memory_bytes Service resident memory in bytes.',
    '# TYPE ninedeploy_service_memory_bytes gauge',
    '# HELP ninedeploy_service_sample_timestamp_seconds Timestamp of the latest collected sample.',
    '# TYPE ninedeploy_service_sample_timestamp_seconds gauge',
  ];
  for (const r of rows) {
    const attrs = 'service_id="' + r.serviceId + '",service="' + label(r.slug) + '",server_id="' + (r.serverId ?? 'panel') + '"';
    lines.push('ninedeploy_service_' + (r.kind === 'cpu' ? 'cpu_percent' : 'memory_bytes') + '{' + attrs + '} ' + r.value);
    lines.push('ninedeploy_service_sample_timestamp_seconds{' + attrs + ',kind="' + r.kind + '"} ' + r.ts);
  }
  return lines.join('\n') + '\n';
}

export function otlpMetrics(rows: ResourceMetric[]) {
  return {
    resourceMetrics: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'ninedeploy' } }] },
      scopeMetrics: [{
        scope: { name: 'ninedeploy.infrastructure', version: '1' },
        metrics: (['cpu', 'memory'] as const).map((kind) => ({
          name: kind === 'cpu' ? 'ninedeploy_service_cpu_percent' : 'ninedeploy_service_memory_bytes',
          description: kind === 'cpu' ? 'Service CPU usage (100 is one core)' : 'Service resident memory',
          unit: kind === 'cpu' ? '%' : 'By',
          gauge: { dataPoints: rows.filter((r) => r.kind === kind).map((r) => ({
            attributes: [
              { key: 'service.id', value: { stringValue: String(r.serviceId) } },
              { key: 'service.name', value: { stringValue: r.slug } },
              { key: 'server.id', value: { stringValue: String(r.serverId ?? 'panel') } },
            ],
            timeUnixNano: String(BigInt(r.ts) * 1000000000n), asDouble: r.value,
          })) },
        })).filter((m) => m.gauge.dataPoints.length > 0),
      }],
    }],
  };
}

export interface ExportResult { ok: boolean; status: number; samples: number; error: string | null }
export async function exportOtlpMetrics(
  settings: ObservabilitySettings, rows: ResourceMetric[],
  signal?: AbortSignal, fetchImpl: typeof guardedFetch = guardedFetch,
): Promise<ExportResult> {
  if (!settings.otlpEndpoint) return { ok: false, status: 0, samples: 0, error: 'not_configured' };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (settings.otlpAuthorization) headers.Authorization = settings.otlpAuthorization;
  try {
    const response = await fetchImpl(settings.otlpEndpoint, {
      method: 'POST', headers, body: JSON.stringify(otlpMetrics(rows)), redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000),
    });
    // OTLP/HTTP JSON replies are small; cancel rather than buffering an unbounded receiver body.
    let body = '';
    const reader = response.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          body += new TextDecoder().decode(part.value);
          if (body.length > 16384) return { ok: false, status: response.status, samples: rows.length, error: 'response_too_large' };
        }
      } finally { await reader.cancel().catch(() => undefined); }
    }
    if (!response.ok) return { ok: false, status: response.status, samples: rows.length, error: 'http_' + response.status };
    const answer = body.trim() ? JSON.parse(body) as { partialSuccess?: { rejectedDataPoints?: string | number } } : {};
    const rejected = Number(answer.partialSuccess?.rejectedDataPoints ?? 0);
    if (!Number.isFinite(rejected) || rejected > 0) return { ok: false, status: response.status, samples: rows.length, error: 'partial_rejection' };
    return { ok: true, status: response.status, samples: rows.length, error: null };
  } catch { return { ok: false, status: 0, samples: rows.length, error: 'transport_or_protocol_error' }; }
}
