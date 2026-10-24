import fp from 'fastify-plugin';
import { readObservabilitySettings } from '../lib/observabilitySettings.js';
import { exportOtlpMetrics, resourceMetrics, type ExportResult } from '../lib/metricExport.js';

export interface MetricExportStatus {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  result: ExportResult | null;
}
declare module 'fastify' {
  interface FastifyInstance {
    observability: { status: () => MetricExportStatus; exportNow: () => Promise<ExportResult> };
  }
}
export default fp(async (app) => {
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined, cycle: Promise<ExportResult> | undefined;
  let running = true;
  let status: MetricExportStatus = { lastAttemptAt: null, lastSuccessAt: null, result: null };
  const exportNow = () => {
    if (cycle) return cycle;
    cycle = (async () => {
      try {
        const cfg = await readObservabilitySettings(app.db);
        if (!cfg.otlpEndpoint) return { ok: false, status: 0, samples: 0, error: 'not_configured' };
        const result = await exportOtlpMetrics(cfg, await resourceMetrics(app.db), abort.signal);
        status = { lastAttemptAt: new Date().toISOString(), lastSuccessAt: result.ok ? new Date().toISOString() : status.lastSuccessAt, result };
        return result;
      } catch {
        const result = { ok: false, status: 0, samples: 0, error: 'settings_or_samples_unavailable' };
        status = { ...status, lastAttemptAt: new Date().toISOString(), result };
        return result;
      }
    })().finally(() => { cycle = undefined; });
    return cycle;
  };
  const tick = async () => {
    await exportNow();
    if (running) { timer = setTimeout(() => void tick(), 30000); timer.unref(); }
  };
  app.decorate('observability', { status: () => status, exportNow });
  app.addHook('onClose', async () => { running = false; clearTimeout(timer); abort.abort(); await cycle; });
  timer = setTimeout(() => void tick(), 15000); timer.unref();
}, { name: 'ninedeploy-observability' });
