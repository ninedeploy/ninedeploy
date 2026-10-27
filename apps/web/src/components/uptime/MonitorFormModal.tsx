import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import {
  MONITOR_FAILURES_MAX,
  MONITOR_INTERVAL_MAX,
  MONITOR_INTERVAL_MIN,
  MONITOR_TIMEOUT_MAX,
  type MonitorKind,
  type MonitorView,
} from '@ninedeploy/schemas';
import { api } from '../../lib/api.js';
import { uptimeApi, uptimeKeys } from '../../lib/uptimeApi.js';
import {
  emptyMonitorForm,
  type FieldErrors,
  type MonitorForm,
  monitorToForm,
  targetPlaceholder,
  validateMonitorForm,
} from '../../lib/uptime.js';
import { useToast } from '../Toast.js';
import { useT } from '../../lib/i18n.js';
import { Button, Field, Input, Modal, Select, Switch, cn } from '../ui.js';

/**
 * Create or edit an uptime monitor (operators). Validated with the API's own
 * zod schema before it is sent; a refusal from the server shows its message.
 */
export function MonitorFormModal({
  monitor,
  prefill,
  onClose,
}: {
  /** The monitor being edited; absent for a new one. */
  monitor?: MonitorView;
  /** Starting values for a new monitor (the service card passes its service and URL). */
  prefill?: Partial<MonitorForm>;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  const mode = monitor ? 'edit' : 'create';
  const [form, setForm] = useState<MonitorForm>(() => (monitor ? monitorToForm(monitor) : emptyMonitorForm(prefill)));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const services = useQuery({ queryKey: ['services'], queryFn: () => api.services.list(), staleTime: 60_000 });

  const set = <K extends keyof MonitorForm>(key: K, value: MonitorForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const save = useMutation({
    mutationFn: ({ body }: Extract<ReturnType<typeof validateMonitorForm>, { ok: true }>) =>
      monitor ? uptimeApi.monitors.update(monitor.id, body) : uptimeApi.monitors.create(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: uptimeKeys.monitors });
      toast(monitor ? t('Monitor saved') : t('Monitor created'), 'success');
      onClose();
    },
    onError: (err: Error) => {
      const message = err.message || t('Could not save the monitor');
      setServerError(message);
      toast(message, 'error');
    },
  });

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    setServerError(null);
    const result = validateMonitorForm(form, mode);
    if (!result.ok) {
      setErrors(result.errors);
      // A problem in a collapsed field must be visible.
      if (result.errors.intervalSeconds || result.errors.timeoutSeconds || result.errors.failuresBeforeDown) setAdvanced(true);
      return;
    }
    setErrors({});
    save.mutate(result);
  };

  const pickKind = (kind: MonitorKind) => {
    setForm((f) => ({ ...f, kind }));
    setErrors((e) => ({ ...e, target: undefined, keyword: undefined }));
  };

  const http = form.kind === 'http';

  return (
    <Modal
      title={monitor ? t('Edit {name}', { name: monitor.name }) : t('New monitor')}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button onClick={() => submit()} disabled={save.isPending}>
            {save.isPending ? t('Saving…') : monitor ? t('Save monitor') : t('Create monitor')}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4" aria-label={t('Monitor')}>
        <fieldset className="grid min-w-0 grid-cols-2 gap-2">
          <legend className="sr-only">{t('Check kind')}</legend>
          {(['http', 'tcp'] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={form.kind === k}
              onClick={() => pickKind(k)}
              className={cn(
                'rounded-lg px-3 py-2 text-left text-xs ring-1 ring-inset transition',
                form.kind === k ? 'bg-indigo-500/15 text-indigo-300 ring-indigo-500/20' : 'bg-white/[0.03] text-slate-400 ring-white/10 hover:bg-white/[0.06]',
              )}
            >
              <span className="block text-sm font-semibold">{k === 'http' ? 'HTTP(S)' : t('TCP port')}</span>
              {k === 'http' ? t('Status code, optional keyword') : t('The port accepts a connection')}
            </button>
          ))}
        </fieldset>

        <Field label={t('Name')} error={errors.name}>
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="API health" maxLength={100} />
        </Field>

        <Field
          label={http ? 'URL' : t('Host and port')}
          error={errors.target}
          hint={http ? t('Checked from the panel host.') : t('An IPv6 address goes in brackets: [::1]:5432')}
        >
          <Input value={form.target} onChange={(e) => set('target', e.target.value)} placeholder={targetPlaceholder(form.kind)} className="font-mono text-xs" spellCheck={false} />
        </Field>

        {http && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t('Method')} error={errors.method}>
              <Select value={form.method} onChange={(e) => set('method', e.target.value as MonitorForm['method'])}>
                <option value="GET">GET</option>
                <option value="HEAD">HEAD</option>
              </Select>
            </Field>
            <div className="sm:col-span-2">
              <Field label={t('Expected status')} error={errors.expectedStatus} hint={t('Codes and ranges, such as 200-299,301')}>
                <Input value={form.expectedStatus} onChange={(e) => set('expectedStatus', e.target.value)} className="font-mono text-xs" />
              </Field>
            </div>
          </div>
        )}

        {http && (
          <Field label={t('Keyword (optional)')} error={errors.keyword} hint={t('Text the response body must contain. Needs GET.')}>
            <Input value={form.keyword} onChange={(e) => set('keyword', e.target.value)} placeholder="ok" />
          </Field>
        )}

        <Field
          label={t('Service (optional)')}
          hint={t('Members who can see the service see its monitor; without one only operators do.')}
          error={errors.serviceId}
        >
          <Select value={form.serviceId} onChange={(e) => set('serviceId', e.target.value)}>
            <option value="">{t('No service')}</option>
            {(services.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>

        <div className="flex items-center justify-between gap-3 rounded-lg bg-white/[0.02] px-3 py-2 ring-1 ring-inset ring-white/5">
          <span className="text-sm text-slate-300">{t('Enabled')}</span>
          <Switch checked={form.enabled} onChange={(v) => set('enabled', v)} label={t('Enabled')} />
        </div>

        <div className="rounded-lg border border-white/[0.06]">
          <button
            type="button"
            onClick={() => setAdvanced((v) => !v)}
            aria-expanded={advanced}
            className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-400 hover:text-slate-200"
          >
            {advanced ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {t('Advanced')}
          </button>
          {advanced && (
            <div className="space-y-3 border-t border-white/5 p-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label={t('Interval (s)')} error={errors.intervalSeconds} hint={`${MONITOR_INTERVAL_MIN}–${MONITOR_INTERVAL_MAX}`}>
                  <Input type="number" min={MONITOR_INTERVAL_MIN} max={MONITOR_INTERVAL_MAX} value={form.intervalSeconds} onChange={(e) => set('intervalSeconds', e.target.value)} />
                </Field>
                <Field label={t('Timeout (s)')} error={errors.timeoutSeconds} hint={`1–${MONITOR_TIMEOUT_MAX}`}>
                  <Input type="number" min={1} max={MONITOR_TIMEOUT_MAX} value={form.timeoutSeconds} onChange={(e) => set('timeoutSeconds', e.target.value)} />
                </Field>
                <Field
                  label={t('Failures before down')}
                  error={errors.failuresBeforeDown}
                  hint={t('1–{max} in a row', { max: MONITOR_FAILURES_MAX })}
                >
                  <Input type="number" min={1} max={MONITOR_FAILURES_MAX} value={form.failuresBeforeDown} onChange={(e) => set('failuresBeforeDown', e.target.value)} />
                </Field>
              </div>
              {http && (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-slate-300">{t('Follow redirects')}</span>
                    <Switch checked={form.followRedirects} onChange={(v) => set('followRedirects', v)} label={t('Follow redirects')} />
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 text-sm text-slate-300">
                      {t('Verify TLS certificate')}
                      <span className="block text-[11px] text-slate-500">{t('Off accepts a self-signed or expired certificate.')}</span>
                    </span>
                    <Switch checked={form.verifyTls} onChange={(v) => set('verifyTls', v)} label={t('Verify TLS certificate')} />
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {errors._ && <p className="text-xs text-rose-300">{errors._}</p>}
        {serverError && (
          <p role="alert" className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300 ring-1 ring-inset ring-rose-500/20">
            {serverError}
          </p>
        )}
        {/* Enter in a field submits; the visible buttons live in the modal footer. */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
