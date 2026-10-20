import {
  AUTOSCALE_METRICS,
  autoscaleConfig,
  type AutoscaleConfig,
  type AutoscaleConfigInput,
  type AutoscaleMetric,
  type AutoscaleStatusView,
} from '@ninedeploy/schemas';
import type { NineDeployClient } from '../client.js';
import { c, error, fmtTime, header, info, kv, spinner, success } from '../lib/format.js';
import { fmtSeconds } from './canary.js';
import { plain } from './sources.js';
import { resolveServiceRef } from './uptime.js';

/**
 * 0.16.10 autoscaling:
 *
 *   ninedeploy autoscale show <service> [--json]
 *   ninedeploy autoscale set <service> [--min N] [--max N] [--metric cpu|memory|rps] [--target X]
 *                                      [--up-seconds N] [--down-seconds N] [--json]
 *   ninedeploy autoscale off <service>
 *
 * `<service>` is an id, a slug or a name. Turning it on applies fully at the
 * next deploy, which creates the spare containers.
 */

const message = (err: unknown): string => plain(err instanceof Error ? err.message : String(err));

/** Skip the spinner for `--json` so stdout stays parseable. */
const load = <T>(json: boolean | undefined, msg: string, fn: () => Promise<T>): Promise<T> => (json ? fn() : spinner(msg, fn));

export interface AutoscaleSetOptions {
  min?: string;
  max?: string;
  metric?: string;
  target?: string;
  upSeconds?: string;
  downSeconds?: string;
  json?: boolean;
}

type NumberField = 'minReplicas' | 'maxReplicas' | 'target' | 'scaleUpSeconds' | 'scaleDownSeconds';

/** Flag names for the schema fields, so a validation failure names what the user typed. */
const FLAG: Record<string, string> = {
  minReplicas: '--min',
  maxReplicas: '--max',
  metric: '--metric',
  target: '--target',
  scaleUpSeconds: '--up-seconds',
  scaleDownSeconds: '--down-seconds',
};

const NUMBERS: Array<[keyof AutoscaleSetOptions, NumberField]> = [
  ['min', 'minReplicas'],
  ['max', 'maxReplicas'],
  ['target', 'target'],
  ['upSeconds', 'scaleUpSeconds'],
  ['downSeconds', 'scaleDownSeconds'],
];

/**
 * The fields the user gave, as a partial autoscale configuration; null after
 * printing why one is not valid. Ranges are left to the schema.
 */
export function autoscaleOptions(opts: AutoscaleSetOptions): Partial<AutoscaleConfigInput> | null {
  const out: Partial<AutoscaleConfigInput> = {};
  for (const [opt, field] of NUMBERS) {
    const raw = opts[opt];
    if (typeof raw !== 'string') continue;
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n)) {
      error(`${FLAG[field]} must be a number`);
      return null;
    }
    out[field] = n;
  }
  if (opts.metric !== undefined) {
    const metric = opts.metric.trim().toLowerCase();
    if (!(AUTOSCALE_METRICS as readonly string[]).includes(metric)) {
      error(`--metric must be one of ${AUTOSCALE_METRICS.join(', ')}`);
      return null;
    }
    out.metric = metric as AutoscaleMetric;
  }
  return out;
}

/**
 * What `autoscale set` sends. A service that has a configuration keeps the
 * values not given (the PATCH replaces the whole object). Without one, only
 * the given values go and the server fills in the defaults; `--max` and
 * `--target` have none, so they are named when missing.
 */
export function autoscaleBody(
  current: AutoscaleConfig | null | undefined,
  given: Partial<AutoscaleConfigInput>,
): { body: AutoscaleConfigInput } | { missing: string[] } {
  if (current) return { body: { ...current, ...given } };
  const missing = (['maxReplicas', 'target'] as const).filter((f) => given[f] === undefined).map((f) => FLAG[f]!);
  if (missing.length > 0) return { missing };
  return { body: given as AutoscaleConfigInput };
}

/** A zod failure as one line, each issue led by the flag it is about. */
function validationMessage(err: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return err.issues.map((i) => `${FLAG[String(i.path[0])] ?? 'autoscale'}: ${i.message}`).join('; ');
}

/** A metric value with its unit: `70%` for cpu and memory, `120 req/s` for rps. */
export function fmtMetric(metric: AutoscaleMetric, v: number): string {
  return metric === 'rps' ? `${v} req/s` : `${v}%`;
}

const containers = (n: number): string => `${n} container${n === 1 ? '' : 's'}`;

function printConfig(cfg: AutoscaleConfig | null | undefined): void {
  if (!cfg) {
    kv('Autoscaling', c.gray('off: the service runs its fixed replicas'));
    return;
  }
  kv('Bounds', `${cfg.minReplicas}–${cfg.maxReplicas} containers`);
  kv('Metric', `${cfg.metric}, target ${fmtMetric(cfg.metric, cfg.target)} per container`);
  kv('Scale up after', fmtSeconds(cfg.scaleUpSeconds));
  kv('Scale down after', fmtSeconds(cfg.scaleDownSeconds));
}

function printStatus(st: AutoscaleStatusView): void {
  console.log();
  kv('Serving', containers(st.replicas));
  if (!st.enabled) return;
  const metric = st.metric ?? 'cpu';
  kv('Last value', st.value === null || st.value === undefined ? c.gray('not read yet') : `${fmtMetric(metric, st.value)} per container`);
  kv('Desired', st.desired === null || st.desired === undefined ? null : containers(st.desired));
  if (st.holding) info(`Not scaling now: ${plain(st.holding)}.`);
  const ev = st.lastEvent;
  kv('Last change', ev ? `${ev.from} → ${ev.to} containers, ${plain(ev.reason)}, ${fmtTime(ev.at)}` : c.gray('none yet'));
}

/** `ninedeploy autoscale show <service> [--json]` */
export async function autoscaleShow(client: NineDeployClient, ref: string, opts: { json?: boolean } = {}): Promise<void> {
  try {
    const id = await resolveServiceRef(client, ref);
    if (id === null) return;
    const [svc, status] = await load(opts.json, 'Loading autoscaling', () => Promise.all([client.services.get(id), client.services.autoscale(id)]));
    if (opts.json) {
      console.log(JSON.stringify({ config: svc.autoscale ?? null, status }, null, 2));
      return;
    }
    header(`Autoscaling: ${plain(svc.name)}`);
    printConfig(svc.autoscale);
    printStatus(status);
    console.log();
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy autoscale set <service> [...]` */
export async function autoscaleSet(client: NineDeployClient, ref: string, opts: AutoscaleSetOptions = {}): Promise<void> {
  const given = autoscaleOptions(opts);
  if (given === null) return;
  try {
    const id = await resolveServiceRef(client, ref);
    if (id === null) return;
    const svc = await client.services.get(id);
    const built = autoscaleBody(svc.autoscale, given);
    if ('missing' in built) {
      error(`Autoscaling is off for this service: give ${built.missing.join(' and ')} to turn it on.`);
      return;
    }
    const parsed = autoscaleConfig.safeParse(built.body);
    if (!parsed.success) {
      error(validationMessage(parsed.error));
      return;
    }
    const body = built.body;
    const updated = await load(opts.json, 'Saving the autoscaling configuration', () => client.services.update(id, { autoscale: body }));
    if (opts.json) {
      console.log(JSON.stringify(updated.autoscale ?? null, null, 2));
      return;
    }
    success(`Autoscaling on for ${plain(updated.name)}.`);
    printConfig(updated.autoscale);
    info('It applies fully at the next deploy, which creates the spare containers.');
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy autoscale off <service>` */
export async function autoscaleOff(client: NineDeployClient, ref: string): Promise<void> {
  try {
    const id = await resolveServiceRef(client, ref);
    if (id === null) return;
    const updated = await spinner('Turning autoscaling off', () => client.services.update(id, { autoscale: null }));
    success(`Autoscaling off for ${plain(updated.name)}. The containers serving now keep running until the next deploy, which runs the fixed replicas again.`);
  } catch (err) {
    error(message(err));
  }
}
