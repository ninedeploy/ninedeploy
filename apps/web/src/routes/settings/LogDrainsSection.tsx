import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Activity, Plus, Radio, Trash2 } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { msg, useT } from '../../lib/i18n.js';
import { LogDrainQueue } from '../../components/LogDrainQueue.js';
import { Button, Card, CardBody, Input, Modal, Select, cn } from '../../components/ui.js';
import type { LogDrain, LogDrainCreateInput, LogDrainFormat, LogDrainType } from '@ninedeploy/sdk';

interface DrainFormState {
  name: string;
  type: LogDrainType;
  url: string;
  apiKey: string;
  format: LogDrainFormat;
  serviceId?: number;
  enabled: boolean;
}

const INITIAL_FORM: DrainFormState = {
  name: '',
  type: 'loki',
  url: '',
  apiKey: '',
  format: 'json',
  enabled: true,
};

const DRAIN_TYPES: Array<{ id: LogDrainType; label: string; desc: string; defaultFormat: LogDrainFormat; url?: string; key?: string }> = [
  { id: 'loki', label: msg('Grafana Loki'), desc: 'Push logs via Loki /loki/api/v1/push endpoint', defaultFormat: 'json' },
  { id: 'datadog', label: msg('Datadog'), desc: 'Push logs to Datadog HTTP Log Ingestion API', defaultFormat: 'json' },
  { id: 'vector', label: msg('Vector / Aggregator'), desc: 'Push to Vector, Fluentd, or custom HTTP sinks', defaultFormat: 'json' },
  { id: 'syslog', label: msg('Syslog (RFC5424)'), desc: 'RFC5424 formatted logs over HTTP/HTTPS', defaultFormat: 'rfc5424' },
  { id: 'http', label: msg('Custom HTTP Webhook'), desc: 'Raw or JSON structured HTTP POST webhooks', defaultFormat: 'json' },
  // G3.4: the body format is the target's own, so the format setting does not apply to these.
  { id: 'elasticsearch', label: msg('Elasticsearch / OpenSearch'), desc: '', defaultFormat: 'json', url: 'https://es.example.com:9200/logs-ninedeploy', key: msg('user:password, or an Elasticsearch API key') },
  { id: 'splunk', label: msg('Splunk HEC'), desc: '', defaultFormat: 'json', url: 'https://splunk.example.com:8088/services/collector/event', key: msg('HEC token') },
  { id: 'betterstack', label: msg('Better Stack'), desc: '', defaultFormat: 'json', url: 'https://in.logs.betterstack.com', key: msg('Source token') },
  { id: 'newrelic', label: msg('New Relic'), desc: '', defaultFormat: 'json', url: 'https://log-api.newrelic.com/log/v1', key: msg('License or ingest key') },
  { id: 'axiom', label: msg('Axiom'), desc: '', defaultFormat: 'json', url: 'https://api.axiom.co/v1/datasets/<dataset>/ingest', key: msg('API token with ingest access') },
  { id: 'cloudwatch', label: msg('AWS CloudWatch Logs'), desc: '', defaultFormat: 'json', url: 'https://logs.<region>.amazonaws.com/?group=<log group>&stream=<log stream>', key: msg('ACCESS_KEY_ID:SECRET_ACCESS_KEY') },
];

export function LogDrainsSection() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useT();
  const [createOpen, setCreateOpen] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);

  const drains = useQuery({
    queryKey: ['log-drains'],
    queryFn: () => api.logDrains.list(),
  });

  const services = useQuery({
    queryKey: ['services'],
    queryFn: () => api.services.list(),
  });

  const [formData, setFormData] = useState<DrainFormState>(INITIAL_FORM);

  const createDrain = useMutation({
    mutationFn: (data: LogDrainCreateInput) => api.logDrains.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['log-drains'] });
      setCreateOpen(false);
      setFormData(INITIAL_FORM);
      toast(t('Log drain destination created'), 'success');
    },
    onError: () => toast(t('Failed to create log drain destination'), 'error'),
  });

  const toggleDrain = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => api.logDrains.update(id, { enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['log-drains'] });
      toast(t('Log drain status updated'), 'success');
    },
    onError: () => toast(t('Failed to update log drain'), 'error'),
  });

  const deleteDrain = useMutation({
    mutationFn: (id: number) => api.logDrains.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['log-drains'] });
      toast(t('Log drain removed'), 'success');
    },
    onError: () => toast(t('Failed to remove log drain'), 'error'),
  });

  const testConnection = async (drain: LogDrain) => {
    setTestingId(drain.id);
    try {
      const res = await api.logDrains.test(drain.id);
      if (res.ok) {
        toast(t('Probe successful ({ms}ms): {message}', { ms: res.latencyMs, message: String(res.message) }), 'success');
      } else {
        toast(t('Probe failed: {message}', { message: String(res.message) }), 'error');
      }
    } catch {
      toast(t('Failed to test log drain connection'), 'error');
    } finally {
      setTestingId(null);
    }
  };

  const drainList = drains.data ?? [];
  const serviceList = services.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium text-slate-100">{t('External Log Drains')}</h2>
          <p className="text-xs text-slate-400">{t('Forward Docker and primary Compose container logs to external destinations. Captured batches are encrypted and retained for retry.')}</p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5">
          <Plus size={15} /> {t('Add Log Drain')}
        </Button>
      </div>

      {drainList.length === 0 ? (
        <Card>
          <CardBody className="flex flex-col items-center justify-center py-12 text-center">
            <Radio size={32} className="mb-3 text-slate-600" />
            <p className="text-sm font-medium text-slate-300">{t('No external log drains configured')}</p>
            <p className="max-w-md text-xs text-slate-500 mt-1">
              {t('Connect external log aggregation sinks to persist, query, and alert on system and container logs outside the server.')}
            </p>
            <Button size="sm" variant="secondary" onClick={() => setCreateOpen(true)} className="mt-4 gap-1.5">
              <Plus size={14} /> {t('Add First Log Drain')}
            </Button>
          </CardBody>
        </Card>
      ) : (
        <div className="space-y-3">
          {drainList.map((d) => (
            <Card key={d.id}>
              <CardBody className="flex flex-col items-start justify-between gap-4 p-4 sm:flex-row sm:items-center">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                    <Radio size={18} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-slate-200">{d.name}</span>
                      <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] uppercase font-semibold text-slate-400 border border-white/[0.05]">
                        {d.type}
                      </span>
                      <span className="rounded bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-slate-400">
                        {d.format}
                      </span>
                      {d.serviceName ? (
                        <span className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-[10px] text-indigo-300">
                          {d.serviceName}
                        </span>
                      ) : (
                        <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300">
                          {t('Global')}
                        </span>
                      )}
                    </div>
                    <p className="font-mono text-xs text-slate-400 truncate max-w-md">{d.url}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={testingId === d.id}
                    onClick={() => testConnection(d)}
                    className="text-xs gap-1"
                  >
                    <Activity size={13} className={testingId === d.id ? 'animate-spin' : ''} />
                    {testingId === d.id ? t('Testing...') : t('Test Connection')}
                  </Button>

                  <button
                    type="button"
                    onClick={() => toggleDrain.mutate({ id: d.id, enabled: !d.enabled })}
                    className={cn(
                      'rounded-full px-2.5 py-1 text-xs font-medium border transition',
                      d.enabled
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                        : 'bg-slate-800 text-slate-400 border-slate-700',
                    )}
                  >
                    {d.enabled ? t('Active') : t('Disabled')}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(t('Remove log drain destination "{name}"?', { name: d.name }))) {
                        deleteDrain.mutate(d.id);
                      }
                    }}
                    className="p-2 text-slate-500 hover:text-rose-400 transition"
                    title={t('Delete log drain')}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </CardBody>
              <LogDrainQueue id={d.id} enabled={d.enabled} />
            </Card>
          ))}
        </div>
      )}

      {createOpen && (
        <Modal onClose={() => setCreateOpen(false)} title={t('Add Log Drain Sink')}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!formData.name || !formData.url) return;
              createDrain.mutate({
                name: formData.name,
                type: formData.type,
                url: formData.url,
                apiKey: formData.apiKey ? formData.apiKey : undefined,
                serviceId: formData.serviceId,
                format: formData.format,
                enabled: formData.enabled,
              });
            }}
            className="space-y-4"
          >
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-300">{t('Destination Name')}</label>
              <Input
                placeholder={t('e.g. Production Loki, Datadog US1')}
                value={formData.name}
                onChange={(e) => {
                  const val = e.target.value;
                  setFormData((prev) => ({ ...prev, name: val }));
                }}
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-300">{t('Sink Type')}</label>
                <Select
                  value={formData.type}
                  onChange={(e) => {
                    const selectedType = e.target.value as LogDrainType;
                    const def = DRAIN_TYPES.find((dt) => dt.id === selectedType);
                    setFormData((prev) => ({
                      ...prev,
                      type: selectedType,
                      format: (def as (typeof DRAIN_TYPES)[number]).defaultFormat,
                    }));
                  }}
                >
                  {DRAIN_TYPES.map((dt) => (
                    <option key={dt.id} value={dt.id}>
                      {t(dt.label)}
                    </option>
                  ))}
                </Select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-slate-300">{t('Log Format')}</label>
                <Select
                  value={formData.format}
                  onChange={(e) => {
                    const val = e.target.value as LogDrainFormat;
                    setFormData((prev) => ({ ...prev, format: val }));
                  }}
                >
                  <option value="json">{t('JSON Structured')}</option>
                  <option value="raw">{t('Raw Line Plaintext')}</option>
                  <option value="rfc5424">{t('RFC5424 Syslog')}</option>
                </Select>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-300">{t('Endpoint Ingestion URL')}</label>
              <Input
                placeholder={DRAIN_TYPES.find((dt) => dt.id === formData.type)?.url ?? 'https://loki.example.com/loki/api/v1/push'}
                value={formData.url}
                onChange={(e) => {
                  const val = e.target.value;
                  setFormData((prev) => ({ ...prev, url: val }));
                }}
                required
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-300">{t('API Key / Ingest Token (Optional)')}</label>
              <Input
                type="password"
                placeholder={(() => {
                  const hint = DRAIN_TYPES.find((dt) => dt.id === formData.type)?.key;
                  return hint ? t(hint) : t('Bearer token or Datadog API Key');
                })()}
                value={formData.apiKey}
                onChange={(e) => {
                  const val = e.target.value;
                  setFormData((prev) => ({ ...prev, apiKey: val }));
                }}
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-300">{t('Scope Service Filter')}</label>
              <Select
                value={formData.serviceId !== undefined ? String(formData.serviceId) : ''}
                onChange={(e) => {
                  const val = e.target.value;
                  setFormData((prev) => ({ ...prev, serviceId: val ? parseInt(val, 10) : undefined }));
                }}
              >
                <option value="">{t('All Services (Global Stream)')}</option>
                {serviceList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.slug})
                  </option>
                ))}
              </Select>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>
                {t('Cancel')}
              </Button>
              <Button type="submit" disabled={createDrain.isPending}>
                {t('Save Log Drain')}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
