import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Split } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import {
  CANARY_DEFAULT_MAX_ERROR_RATE,
  CANARY_DEFAULT_MIN_REQUESTS,
  CANARY_DEFAULT_STEP_SECONDS,
  CANARY_DEFAULT_STEPS,
  CANARY_STEP_SECONDS_MAX,
  CANARY_STEP_SECONDS_MIN,
  CANARY_STEPS_MAX,
  type CanaryConfig,
  canaryConfig,
} from '@ninedeploy/schemas';
import type { Service } from '@ninedeploy/sdk';
import { api } from '../../lib/api.js';
import { useToast } from '../../components/Toast.js';
import { Button, Card, CardBody, Field, Input, Switch } from '../../components/ui.js';

export interface CanaryForm {
  steps: string;
  stepSeconds: string;
  maxErrorRate: string;
  maxP95Ms: string;
  minRequests: string;
}

type FieldKey = keyof CanaryForm;

/** The form for a stored configuration, or for the defaults. */
export function canaryFormFrom(cfg: CanaryConfig | null | undefined): CanaryForm {
  return {
    steps: (cfg?.steps ?? CANARY_DEFAULT_STEPS).join(', '),
    stepSeconds: String(cfg?.stepSeconds ?? CANARY_DEFAULT_STEP_SECONDS),
    maxErrorRate: String(cfg?.maxErrorRate ?? CANARY_DEFAULT_MAX_ERROR_RATE),
    maxP95Ms: cfg?.maxP95Ms != null ? String(cfg.maxP95Ms) : '',
    minRequests: String(cfg?.minRequests ?? CANARY_DEFAULT_MIN_REQUESTS),
  };
}

/** What each field takes, shown under it when the value does not fit. */
const FIELD_PROBLEM: Record<FieldKey, string> = {
  steps: `1 to ${CANARY_STEPS_MAX} whole percentages from 1 to 99, for example 10, 50`,
  stepSeconds: `A whole number of seconds, ${CANARY_STEP_SECONDS_MIN}–${CANARY_STEP_SECONDS_MAX}`,
  maxErrorRate: 'A percentage, 0–100',
  maxP95Ms: 'A whole number of milliseconds, 10 or more; blank turns it off',
  minRequests: 'A whole number, 1 or more',
};

/** A blank field takes the schema default; anything else must be a number. */
const num = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v.trim()));

/**
 * Validates the form with `canaryConfig`: the parsed configuration, or the
 * problem of each field that does not fit.
 */
export function parseCanaryForm(form: CanaryForm): { config: CanaryConfig | null; errors: Partial<Record<FieldKey, string>> } {
  const parts = form.steps.split(/[\s,]+/).filter((s) => s !== '');
  const res = canaryConfig.safeParse({
    steps: parts.map(Number),
    stepSeconds: num(form.stepSeconds),
    maxErrorRate: num(form.maxErrorRate),
    maxP95Ms: form.maxP95Ms.trim() === '' ? null : Number(form.maxP95Ms.trim()),
    minRequests: num(form.minRequests),
  });
  if (res.success) return { config: res.data, errors: {} };
  const errors: Partial<Record<FieldKey, string>> = {};
  for (const issue of res.error.issues) {
    const key = issue.path[0] as FieldKey;
    // The rising-steps rule carries its own message; the rest get the field's range.
    errors[key] ??= issue.code === 'custom' ? issue.message : FIELD_PROBLEM[key];
  }
  return { config: null, errors };
}

/**
 * 0.16.9 canary releases: a new release takes a growing share of the traffic
 * before it takes all of it. Docker services only, on a panel that reports
 * the field. Members may change it, like the other deploy settings.
 */
export function CanaryCard({ svc }: { svc: Service }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  // Initialised once from the service row, like the other settings cards.
  const [enabled, setEnabled] = useState(svc.canary != null);
  const [form, setForm] = useState<CanaryForm>(() => canaryFormFrom(svc.canary));

  const parsed = parseCanaryForm(form);
  const save = useMutation({
    mutationFn: (canary: CanaryConfig | null) => api.services.update(svc.id, { canary }),
    onSuccess: (_res, canary) => {
      qc.invalidateQueries({ queryKey: ['service', svc.id] });
      toast(canary ? 'Canary releases saved — used from the next deploy' : 'Canary releases turned off', 'success');
    },
    onError: (err) => toast(err instanceof Error && err.message ? err.message : 'Could not save the canary releases', 'error'),
  });

  if (svc.type !== 'docker' || svc.canary === undefined) return null;
  const set = (k: FieldKey) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <Card>
      <CardBody>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <Split size={15} className="text-slate-500" /> Canary releases
          </div>
          {/* With nothing stored the form already holds the defaults, so turning it on starts from them. */}
          <Switch checked={enabled} onChange={setEnabled} label="Canary releases" />
        </div>
        <p className="text-xs leading-relaxed text-slate-500">
          After the new container passes its healthcheck, it gets a growing share of the requests, step by step, and all of
          them after the last step. A step that fails sends every request back to the previous release and fails the
          deploy. For docker services on the panel host with a domain; rollbacks, and services on a node or on Swarm,
          switch all traffic at once.
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
          The 5xx and p95 limits need traffic analytics (an operator turns it on in{' '}
          <Link to="/traefik" className="text-indigo-200 underline-offset-2 hover:underline">Traefik → Traffic</Link>); without it,
          each step is judged on the healthcheck only.
        </p>
        {svc.serverId != null && (
          <p className="mt-1.5 text-xs text-amber-300">
            This service runs on a node, so its deploys switch all traffic at once for now.
          </p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!enabled) save.mutate(null);
            else if (parsed.config) save.mutate(parsed.config);
          }}
          className="mt-4 space-y-4"
        >
          {enabled && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Steps (%)" hint="Share of requests at each step, rising, up to 5." error={parsed.errors.steps}>
                <Input value={form.steps} onChange={set('steps')} placeholder="10, 50" aria-invalid={!!parsed.errors.steps} className="h-9 font-mono text-xs" />
              </Field>
              <Field label="Step length (s)" hint={`How long each step runs, ${CANARY_STEP_SECONDS_MIN}–${CANARY_STEP_SECONDS_MAX}.`} error={parsed.errors.stepSeconds}>
                <Input value={form.stepSeconds} onChange={set('stepSeconds')} inputMode="numeric" placeholder={String(CANARY_DEFAULT_STEP_SECONDS)} aria-invalid={!!parsed.errors.stepSeconds} className="h-9 font-mono text-xs" />
              </Field>
              <Field label="Max 5xx rate (%)" hint="A step fails when more of the new release's responses are 5xx." error={parsed.errors.maxErrorRate}>
                <Input value={form.maxErrorRate} onChange={set('maxErrorRate')} inputMode="decimal" placeholder={String(CANARY_DEFAULT_MAX_ERROR_RATE)} aria-invalid={!!parsed.errors.maxErrorRate} className="h-9 font-mono text-xs" />
              </Field>
              <Field label="Max p95 (ms)" hint="A step fails when the new release's p95 is slower. Blank = not judged." error={parsed.errors.maxP95Ms}>
                <Input value={form.maxP95Ms} onChange={set('maxP95Ms')} inputMode="numeric" placeholder="off" aria-invalid={!!parsed.errors.maxP95Ms} className="h-9 font-mono text-xs" />
              </Field>
              <Field label="Min requests" hint="Fewer in a step are too few to judge; the step passes on its healthcheck." error={parsed.errors.minRequests}>
                <Input value={form.minRequests} onChange={set('minRequests')} inputMode="numeric" placeholder={String(CANARY_DEFAULT_MIN_REQUESTS)} aria-invalid={!!parsed.errors.minRequests} className="h-9 font-mono text-xs" />
              </Field>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" disabled={save.isPending || (enabled ? !parsed.config : svc.canary == null)}>
              {save.isPending ? 'Saving…' : 'Save canary releases'}
            </Button>
            <span className="text-xs text-slate-500">Used from the next deploy.</span>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
