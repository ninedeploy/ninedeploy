import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Gauge } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { AUTOSCALE_MAX_REPLICAS, type AutoscaleConfig, type AutoscaleMetric, autoscaleConfig } from '@ninedeploy/schemas';
import type { ServiceDetail } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { autoscaleKeys } from '../../lib/autoscaleApi.js';
import { useToast } from '../../components/Toast.js';
import { type Translate, fill, msg, translate, useT } from '../../lib/i18n.js';
import { Button, Card, CardBody, Field, Input, Select, Switch } from '../../components/ui.js';
import { AutoscaleSchedules, browserTimeZone, type ScheduleRow, scheduleRowsFrom, schedulesFromRows } from './AutoscaleSchedules.js';

export interface AutoscaleForm {
  minReplicas: string;
  maxReplicas: string;
  metric: AutoscaleMetric;
  target: string;
  scaleUpSeconds: string;
  scaleDownSeconds: string;
  /** G5.6 scheduled floors and the time zone they are in. */
  schedules: ScheduleRow[];
  timezone: string;
}

type FieldKey = keyof AutoscaleForm;

/** The schema defaults, shown in the form and taken by a blank field. */
const DEFAULT_MIN = 1;
const DEFAULT_UP_SECONDS = 60;
const DEFAULT_DOWN_SECONDS = 300;

/** The form for a stored configuration, or for the defaults (no maximum or target: those have none). */
export function autoscaleFormFrom(cfg: AutoscaleConfig | null | undefined): AutoscaleForm {
  return {
    minReplicas: String(cfg?.minReplicas ?? DEFAULT_MIN),
    maxReplicas: cfg ? String(cfg.maxReplicas) : '',
    metric: cfg?.metric ?? 'cpu',
    target: cfg ? String(cfg.target) : '',
    scaleUpSeconds: String(cfg?.scaleUpSeconds ?? DEFAULT_UP_SECONDS),
    scaleDownSeconds: String(cfg?.scaleDownSeconds ?? DEFAULT_DOWN_SECONDS),
    schedules: scheduleRowsFrom(cfg?.schedules),
    timezone: cfg?.timezone ?? browserTimeZone(),
  };
}

/** What each field takes, shown under it when the value does not fit. */
function fieldProblem(key: FieldKey, metric: AutoscaleMetric, t: Translate): string {
  switch (key) {
    case 'minReplicas':
      return t('A whole number of containers, 1–{max}', { max: AUTOSCALE_MAX_REPLICAS });
    case 'maxReplicas':
      return t('A whole number of containers above the minimum, up to {max}', { max: AUTOSCALE_MAX_REPLICAS });
    case 'metric':
      return t('cpu, memory or rps');
    case 'target':
      return metric === 'rps' ? t('Requests per second per container, above 0') : t('A percentage above 0, at most 100');
    case 'scaleUpSeconds':
      return t('A whole number of seconds, 30–3600');
    case 'scaleDownSeconds':
      return t('A whole number of seconds, 60–3600');
    case 'schedules':
      return t('Each window needs at least one day, different start and end times, and a minimum of 1 up to the maximum');
    case 'timezone':
      return t('An IANA time zone, such as Europe/Istanbul');
  }
}

/** English, for callers outside a component (and the unit tests). */
const ENGLISH: Translate = (text, vars) => translate('en', text, vars);

/** A blank field takes the schema default (or is missing); anything else must be a number. */
const num = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v.trim()));

/**
 * Validates the form with `autoscaleConfig`: the parsed configuration, or the
 * problem of each field that does not fit.
 */
export function parseAutoscaleForm(form: AutoscaleForm, t: Translate = ENGLISH): { config: AutoscaleConfig | null; errors: Partial<Record<FieldKey, string>> } {
  const res = autoscaleConfig.safeParse({
    minReplicas: num(form.minReplicas),
    maxReplicas: num(form.maxReplicas),
    metric: form.metric,
    target: num(form.target),
    scaleUpSeconds: num(form.scaleUpSeconds),
    scaleDownSeconds: num(form.scaleDownSeconds),
    ...(form.schedules.length > 0 ? { schedules: schedulesFromRows(form.schedules), timezone: form.timezone.trim() || 'UTC' } : {}),
  });
  if (res.success) return { config: res.data, errors: {} };
  const errors: Partial<Record<FieldKey, string>> = {};
  for (const issue of res.error.issues) {
    const key = issue.path[0] as FieldKey;
    // The schema's own messages name the API fields; the form names what it takes.
    errors[key] ??= fieldProblem(key, form.metric, t);
  }
  return { config: null, errors };
}

const METRIC_LABEL: Record<AutoscaleMetric, string> = {
  cpu: msg('CPU (cpu)'),
  memory: msg('Memory (memory)'),
  rps: msg('Requests per second (rps)'),
};

/**
 * 0.16.10 autoscaling: a docker service on the panel host runs between a
 * minimum and a maximum number of containers, set by load, without a
 * redeploy. Docker services only, on a panel that reports the field. Members
 * may change it, like the other deploy settings.
 */
export function AutoscaleCard({ svc }: { svc: ServiceDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const { toast } = useToast();
  // Initialised once from the service row, like the other settings cards.
  const [enabled, setEnabled] = useState(svc.autoscale != null);
  const [form, setForm] = useState<AutoscaleForm>(() => autoscaleFormFrom(svc.autoscale));
  const [advanced, setAdvanced] = useState(false);

  const parsed = parseAutoscaleForm(form, t);
  const save = useMutation({
    mutationFn: (autoscale: AutoscaleConfig | null) => api.services.update(svc.id, { autoscale }),
    onSuccess: (_res, autoscale) => {
      qc.invalidateQueries({ queryKey: ['service', svc.id] });
      qc.invalidateQueries({ queryKey: autoscaleKeys.status(svc.id) });
      toast(autoscale ? t('Autoscaling saved — it applies fully at the next deploy') : t('Autoscaling turned off'), 'success');
    },
    onError: (err) => toast(err instanceof Error && err.message ? err.message : t('Could not save the autoscaling'), 'error'),
  });

  if (svc.type !== 'docker' || svc.autoscale === undefined) return null;
  const set = (k: FieldKey) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const unit = form.metric === 'rps' ? 'req/s' : '%';
  // A problem in a collapsed part opens it, so the error is never hidden.
  const advancedOpen = advanced || parsed.errors.scaleUpSeconds !== undefined || parsed.errors.scaleDownSeconds !== undefined;
  const scheduleError = parsed.errors.schedules ?? parsed.errors.timezone;

  return (
    <Card>
      <CardBody>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <Gauge size={15} className="text-slate-500" /> {t('Autoscaling')}
          </div>
          <Switch checked={enabled} onChange={setEnabled} label={t('Autoscaling')} />
        </div>
        <p className="text-xs leading-relaxed text-slate-500">
          {t('Runs between a minimum and a maximum number of containers, set by load, without a redeploy. Every 30 s it compares the metric per container with the target (within 10 % of it nothing changes), and adds or removes containers once the need has lasted the scale-up or scale-down window.')}
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
          {t('It applies fully at the next deploy, which creates the spare containers; until then it can only scale down. Turned off, the containers serving now keep serving until the next deploy, which runs the Replicas count again.')}
        </p>
        {svc.serverId != null ? (
          <p className="mt-1.5 text-xs text-amber-300">{t('Node autoscaling requires confirmed replica capacity and supports CPU or memory; request-rate scaling is not available yet.')}</p>
        ) : svc.placement?.orchestrator === 'swarm' ? (
          <p className="mt-1.5 text-xs text-amber-300">{t('This service runs on Swarm, which scales with its own replicas; the autoscaler holds for it.')}</p>
        ) : null}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!enabled) save.mutate(null);
            else if (parsed.config) save.mutate(parsed.config);
          }}
          className="mt-4 space-y-4"
        >
          {enabled && (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Field label={t('Min containers')} hint={t('Never fewer, 1–{max}.', { max: AUTOSCALE_MAX_REPLICAS })} error={parsed.errors.minReplicas}>
                  <Input value={form.minReplicas} onChange={set('minReplicas')} inputMode="numeric" placeholder={String(DEFAULT_MIN)} aria-invalid={!!parsed.errors.minReplicas} className="h-9 font-mono text-xs" />
                </Field>
                <Field label={t('Max containers')} hint={t('Never more, up to {max}. Each deploy creates this many.', { max: AUTOSCALE_MAX_REPLICAS })} error={parsed.errors.maxReplicas}>
                  <Input value={form.maxReplicas} onChange={set('maxReplicas')} inputMode="numeric" placeholder="4" aria-invalid={!!parsed.errors.maxReplicas} className="h-9 font-mono text-xs" />
                </Field>
                <Field label={t('Metric')} error={parsed.errors.metric}>
                  <Select value={form.metric} onChange={set('metric')} className="h-9 text-xs">
                    {(Object.keys(METRIC_LABEL) as AutoscaleMetric[]).map((m) => (
                      <option key={m} value={m}>{t(METRIC_LABEL[m])}</option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('Target')} hint={form.metric === 'rps' ? t('Requests per second per container.') : t('Percent per container, at most 100.')} error={parsed.errors.target}>
                  <div className="relative">
                    <Input value={form.target} onChange={set('target')} inputMode="decimal" placeholder={form.metric === 'rps' ? '50' : '70'} aria-label={t('Target')} aria-invalid={!!parsed.errors.target} className="h-9 pr-14 font-mono text-xs" />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500">{unit}</span>
                  </div>
                </Field>
              </div>
              <div className="space-y-1.5 text-xs leading-relaxed text-slate-500">
                <p>
                  {fill(
                    t("{cpu} is a percentage of the service's CPU limit (of one core without one). {memory} is a percentage of its memory limit, so it needs one. {rps} is requests per second over the last minute, and needs traffic analytics (an operator turns it on in {link}); without it, the autoscaler holds and says so."),
                    {
                      cpu: <span className="font-mono text-slate-400">cpu</span>,
                      memory: <span className="font-mono text-slate-400">memory</span>,
                      rps: <span className="font-mono text-slate-400">rps</span>,
                      link: <Link to="/traefik" className="text-indigo-200 underline-offset-2 hover:underline">{t('Traefik → Traffic')}</Link>,
                    },
                  )}
                </p>
                {form.metric === 'memory' && !svc.memLimitMb && (
                  <p className="text-amber-300">{t("This service has no memory limit, so memory would read the host's memory. Set one under Resource limits.")}</p>
                )}
              </div>
              <div className="rounded-lg border border-white/[0.06] p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{t('Scheduled minimums')}</div>
                <AutoscaleSchedules
                  rows={form.schedules}
                  onRows={(schedules) => setForm({ ...form, schedules })}
                  timezone={form.timezone}
                  onTimezone={(timezone) => setForm({ ...form, timezone })}
                  {...(scheduleError ? { error: scheduleError } : {})}
                />
              </div>
              <div className="rounded-lg border border-white/[0.06]">
                <button
                  type="button"
                  onClick={() => setAdvanced((v) => !v)}
                  aria-expanded={advancedOpen}
                  className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-400 hover:text-slate-200"
                >
                  {advancedOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {t('Advanced')}
                </button>
                {advancedOpen && (
                  <div className="grid grid-cols-1 gap-4 border-t border-white/5 p-3 sm:grid-cols-2">
                    <Field label={t('Scale-up window (s)')} hint={t('How long the need must last before it adds containers, 30–3600.')} error={parsed.errors.scaleUpSeconds}>
                      <Input value={form.scaleUpSeconds} onChange={set('scaleUpSeconds')} inputMode="numeric" placeholder={String(DEFAULT_UP_SECONDS)} aria-invalid={!!parsed.errors.scaleUpSeconds} className="h-9 font-mono text-xs" />
                    </Field>
                    <Field label={t('Scale-down window (s)')} hint={t('How long the need must last before it removes containers, 60–3600.')} error={parsed.errors.scaleDownSeconds}>
                      <Input value={form.scaleDownSeconds} onChange={set('scaleDownSeconds')} inputMode="numeric" placeholder={String(DEFAULT_DOWN_SECONDS)} aria-invalid={!!parsed.errors.scaleDownSeconds} className="h-9 font-mono text-xs" />
                    </Field>
                  </div>
                )}
              </div>
            </>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" disabled={save.isPending || (enabled ? !parsed.config : svc.autoscale == null)}>
              {save.isPending ? t('Saving…') : t('Save autoscaling')}
            </Button>
            <span className="text-xs text-slate-500">{t('Applies fully at the next deploy.')}</span>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
