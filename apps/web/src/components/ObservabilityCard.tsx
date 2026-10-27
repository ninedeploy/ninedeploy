import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ObservabilityPatch, ObservabilityResponse } from '@ninedeploy/sdk';
import { api } from '../lib/api.js';
import { fill, useT } from '../lib/i18n.js';
import { useToast } from './Toast.js';
import { Button, Card, CardBody, ErrorCard, Input } from './ui.js';

export function ObservabilityCard() {
  const t = useT();
  const query = useQuery({ queryKey: ['observability'], queryFn: () => api.stats.observability.get(), refetchInterval: 15000, retry: false });
  if (query.isError) return <ErrorCard title={t('Monitoring settings unavailable')} error={query.error} onRetry={() => query.refetch()} />;
  if (!query.data) return <p className="text-xs text-slate-400">{t('Loading monitoring settings…')}</p>;
  return <ObservabilityForm key={JSON.stringify(query.data.settings)} value={query.data} />;
}

function ObservabilityForm({ value }: { value: ObservabilityResponse }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [retentionDays, setDays] = useState(value.settings.retentionDays);
  const [prometheusEnabled, setPrometheus] = useState(value.settings.prometheusEnabled);
  const [otlpEndpoint, setEndpoint] = useState(value.settings.otlpEndpoint);
  const [authorization, setAuthorization] = useState('');
  const [clearAuthorization, setClearAuthorization] = useState(false);
  const [logQueueMaxMb, setQueueSize] = useState(value.settings.logQueueMaxMb);
  const save = useMutation({
    mutationFn: (input: ObservabilityPatch) => api.stats.observability.update(input),
    onSuccess: (data) => {
      setAuthorization(''); setClearAuthorization(false);
      qc.setQueryData(['observability'], data);
      toast(t('Monitoring settings saved'), 'success');
    },
    onError: () => toast(t('Monitoring settings could not be saved'), 'error'),
  });
  const test = useMutation({
    mutationFn: () => api.stats.observability.test(),
    onSuccess: (result) => {
      toast(result.ok ? t('Collector accepted {n} metric samples', { n: String(result.samples) }) : t('Export failed: {error}', { error: String(result.error) }), result.ok ? 'success' : 'error');
      void qc.invalidateQueries({ queryKey: ['observability'] });
    },
    onError: () => toast(t('Metrics export could not be tested'), 'error'),
  });
  const valid = Number.isInteger(retentionDays) && retentionDays >= 1 && retentionDays <= 90
    && Number.isInteger(logQueueMaxMb) && logQueueMaxMb >= 1 && logQueueMaxMb <= 256;
  return <Card><CardBody>
    <details>
      <summary className="cursor-pointer text-sm font-semibold text-slate-100">{t('History & metrics export')}</summary>
      <form className="mt-4 space-y-4" onSubmit={(event) => {
        event.preventDefault();
        save.mutate({ retentionDays, prometheusEnabled, otlpEndpoint, logQueueMaxMb,
          ...(authorization ? { otlpAuthorization: authorization } : clearAuthorization ? { otlpAuthorization: '' } : {}) });
      }}>
        <p className="text-xs text-slate-400">{t('Instance-wide settings. History grows from collection; enabling longer retention cannot recover samples already deleted.')}</p>
        {retentionDays < value.settings.retentionDays && <p className="text-xs text-amber-300">{t('Saving will remove history older than {n} days at the next cleanup.', { n: retentionDays })}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-slate-300">{t('Service history retention (days)')}
            <Input aria-label={t('Service history retention (days)')} type="number" min={1} max={90} value={retentionDays} onChange={(e) => setDays(Number(e.target.value))} />
            <span className="block text-slate-500">{t('Raw samples for 24 hours, five-minute summaries through day 7, then hourly summaries.')}</span>
          </label>
          <label className="space-y-1 text-xs text-slate-300">{t('Log queue limit per destination (MiB)')}
            <Input aria-label={t('Log queue limit per destination (MiB)')} type="number" min={1} max={256} value={logQueueMaxMb} onChange={(e) => setQueueSize(Number(e.target.value))} />
            <span className="block text-slate-500">{t('Encrypted payload storage. A full queue pauses capture; queued batches are kept until acknowledged or explicitly discarded.')}</span>
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={prometheusEnabled} onChange={(e) => setPrometheus(e.target.checked)} /> {t('Enable Prometheus scraping')}
        </label>
        {prometheusEnabled && <p className="break-all text-xs text-slate-400">{fill(t('Scrape {path} with an operator API token. Only fresh service CPU and memory samples are exposed.'), { path: <code>/v1/stats/prometheus</code> })}</p>}
        <label className="block space-y-1 text-xs text-slate-300">{t('OTLP/HTTP JSON metrics endpoint')}
          <Input aria-label={t('OTLP/HTTP JSON metrics endpoint')} value={otlpEndpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://collector.example/v1/metrics" />
        </label>
        <label className="block space-y-1 text-xs text-slate-300">{t('Collector Authorization header')}
          <Input aria-label={t('Collector Authorization header')} type="password" autoComplete="off" value={authorization} onChange={(e) => setAuthorization(e.target.value)}
            placeholder={value.settings.hasOtlpAuthorization ? t('Saved — leave blank to keep') : t('Bearer … (optional)')} />
        </label>
        {value.settings.hasOtlpAuthorization && <label className="flex items-center gap-2 text-xs text-slate-400">
          <input type="checkbox" checked={clearAuthorization} onChange={(e) => setClearAuthorization(e.target.checked)} /> {t('Remove saved authorization')}
        </label>}
        <p className="text-xs text-slate-400" role="status">
          {value.exportStatus.lastAttemptAt
            ? (value.exportStatus.result?.ok ? t('Last export accepted') : t('Last export failed: {error}', { error: String(value.exportStatus.result?.error) }))
              + ' · ' + new Date(value.exportStatus.lastAttemptAt).toLocaleString()
            : t('No export attempted since this panel started.')}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!valid || save.isPending}>{save.isPending ? t('Saving…') : t('Save monitoring settings')}</Button>
          <Button type="button" variant="secondary" disabled={test.isPending || !value.settings.otlpEndpoint} onClick={() => test.mutate()}>
            {test.isPending ? t('Testing…') : t('Test saved collector')}
          </Button>
        </div>
      </form>
    </details>
  </CardBody></Card>;
}
