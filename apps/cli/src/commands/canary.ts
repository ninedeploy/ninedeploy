import {
  CANARY_DEFAULT_STEPS,
  canaryConfig,
  type CanaryConfig,
  type CanaryConfigInput,
  type CanaryReleaseStats,
  type CanaryStatusView,
} from '@ninedeploy/schemas';
import type { NineDeployClient } from '../client.js';
import { c, error, header, info, kv, spinner, success } from '../lib/format.js';
import { plain } from './sources.js';
import { resolveServiceRef } from './uptime.js';

/**
 * 0.16.9 canary releases:
 *
 *   ninedeploy canary show <service> [--json]
 *   ninedeploy canary set <service> [--steps 10,50] [--step-seconds 120] [--max-error-rate 5]
 *                                   [--max-p95 <ms>|off] [--min-requests 20] [--json]
 *   ninedeploy canary off <service>
 *   ninedeploy canary promote <service> [--deployment <id>]
 *
 * `<service>` is an id, a slug or a name. Stopping a running canary is
 * `ninedeploy deploys cancel <serviceId> <deployId>`: all traffic goes back
 * to the previous release.
 */

const message = (err: unknown): string => plain(err instanceof Error ? err.message : String(err));

/** Skip the spinner for `--json` so stdout stays parseable. */
const load = <T>(json: boolean | undefined, msg: string, fn: () => Promise<T>): Promise<T> => (json ? fn() : spinner(msg, fn));

export interface CanarySetOptions {
  steps?: string;
  stepSeconds?: string;
  maxErrorRate?: string;
  maxP95?: string;
  minRequests?: string;
  json?: boolean;
}

/** Flag names for the schema fields, so a validation failure names what the user typed. */
const FLAG: Record<string, string> = {
  steps: '--steps',
  stepSeconds: '--step-seconds',
  maxErrorRate: '--max-error-rate',
  maxP95Ms: '--max-p95',
  minRequests: '--min-requests',
};

/** A number option; null after printing why not. */
function numberOption(raw: string, flag: string): number | null {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n)) {
    error(`${flag} must be a number`);
    return null;
  }
  return n;
}

/**
 * The fields the user gave, as a partial canary configuration; null after
 * printing why one is not valid. Ranges are left to the schema.
 */
export function canaryOptions(opts: CanarySetOptions): Partial<CanaryConfigInput> | null {
  const out: Partial<CanaryConfigInput> = {};
  if (opts.steps !== undefined) {
    const parts = opts.steps.split(',').map((s) => s.trim());
    const steps = parts.map(Number);
    if (parts.some((p) => p === '') || steps.some((n) => !Number.isFinite(n))) {
      error('--steps must be percentages separated by commas, for example 10,50');
      return null;
    }
    out.steps = steps;
  }
  const numbers: Array<[keyof CanarySetOptions, 'stepSeconds' | 'maxErrorRate' | 'minRequests']> = [
    ['stepSeconds', 'stepSeconds'],
    ['maxErrorRate', 'maxErrorRate'],
    ['minRequests', 'minRequests'],
  ];
  for (const [opt, field] of numbers) {
    const raw = opts[opt];
    if (typeof raw !== 'string') continue;
    const n = numberOption(raw, FLAG[field]!);
    if (n === null) return null;
    out[field] = n;
  }
  if (opts.maxP95 !== undefined) {
    if (opts.maxP95.trim().toLowerCase() === 'off') out.maxP95Ms = null;
    else {
      const n = numberOption(opts.maxP95, '--max-p95');
      if (n === null) return null;
      out.maxP95Ms = n;
    }
  }
  return out;
}

/**
 * What `canary set` sends. A service that has a configuration keeps the
 * values not given (the PATCH replaces the whole object). Without one, only
 * the given values go, and the server fills in the rest; `steps` has no
 * server default, so the documented default (10, 50) is sent when not given.
 */
export function canaryBody(current: CanaryConfig | null | undefined, given: Partial<CanaryConfigInput>): CanaryConfigInput {
  if (current) return { ...current, ...given };
  return { ...given, steps: given.steps ?? [...CANARY_DEFAULT_STEPS] };
}

/** A zod failure as one line, each issue led by the flag it is about. */
function validationMessage(err: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return err.issues.map((i) => `${FLAG[String(i.path[0])] ?? 'canary'}: ${i.message}`).join('; ');
}

/** Seconds as `1m 20s`. */
export function fmtSeconds(total: number): string {
  const s = Math.max(0, Math.round(total));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function printConfig(cfg: CanaryConfig | null | undefined): void {
  if (!cfg) {
    kv('Canary', c.gray('off: a deploy switches all traffic at once'));
    return;
  }
  kv('Steps', cfg.steps.map((s) => `${s}%`).join(', '));
  kv('Step length', fmtSeconds(cfg.stepSeconds));
  kv('Max 5xx rate', `${cfg.maxErrorRate}%`);
  kv('Max p95', cfg.maxP95Ms === null ? c.gray('not judged') : `${cfg.maxP95Ms} ms`);
  kv('Min requests', cfg.minRequests);
}

function stats(s: CanaryReleaseStats | undefined): string {
  if (!s) return c.gray('—');
  const rate = s.errorRate === null ? '—' : `${s.errorRate}%`;
  const p95 = s.p95Ms === null ? '—' : `${s.p95Ms} ms`;
  return `${s.requests} requests, 5xx ${rate}, p95 ${p95}`;
}

function printStatus(st: CanaryStatusView, now: number): void {
  console.log();
  if (!st.active) {
    info('No canary is running.');
    return;
  }
  console.log(`  ${c.bold('Running canary')}`);
  kv('Deployment', `#${st.deploymentId}`);
  kv('Step', `${st.step}/${st.steps}`);
  kv('Traffic', `${st.weight}% to the new release`);
  if (st.stepEndsAt) kv('Step ends in', fmtSeconds((Date.parse(st.stepEndsAt) - now) / 1000));
  kv('New release', stats(st.canary));
  kv('Previous', stats(st.stable));
  if (st.measured === false) {
    info('Traffic analytics is off: steps are judged on the healthcheck only.');
  }
  if (st.promoting) info('Promote requested: all traffic is switching to the new release.');
}

/** `ninedeploy canary show <service> [--json]` */
export async function canaryShow(client: NineDeployClient, ref: string, opts: { json?: boolean } = {}): Promise<void> {
  try {
    const id = await resolveServiceRef(client, ref);
    if (id === null) return;
    const [svc, status] = await load(opts.json, 'Loading the canary', () => Promise.all([client.services.get(id), client.deploys.canary(id)]));
    if (opts.json) {
      console.log(JSON.stringify({ config: svc.canary ?? null, status }, null, 2));
      return;
    }
    header(`Canary releases: ${plain(svc.name)}`);
    printConfig(svc.canary);
    printStatus(status, Date.now());
    console.log();
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy canary set <service> [...]` */
export async function canarySet(client: NineDeployClient, ref: string, opts: CanarySetOptions = {}): Promise<void> {
  const given = canaryOptions(opts);
  if (given === null) return;
  try {
    const id = await resolveServiceRef(client, ref);
    if (id === null) return;
    const svc = await client.services.get(id);
    const body = canaryBody(svc.canary, given);
    const parsed = canaryConfig.safeParse(body);
    if (!parsed.success) {
      error(validationMessage(parsed.error));
      return;
    }
    const updated = await load(opts.json, 'Saving the canary configuration', () => client.services.update(id, { canary: body }));
    if (opts.json) {
      console.log(JSON.stringify(updated.canary ?? null, null, 2));
      return;
    }
    success(`Canary releases on for ${plain(updated.name)}. The next deploy uses them.`);
    printConfig(updated.canary);
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy canary off <service>` */
export async function canaryOff(client: NineDeployClient, ref: string): Promise<void> {
  try {
    const id = await resolveServiceRef(client, ref);
    if (id === null) return;
    const updated = await spinner('Turning canary releases off', () => client.services.update(id, { canary: null }));
    success(`Canary releases off for ${plain(updated.name)}. A deploy switches all traffic at once.`);
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy canary promote <service> [--deployment <id>]` */
export async function canaryPromote(client: NineDeployClient, ref: string, opts: { deployment?: string } = {}): Promise<void> {
  let depId: number | undefined;
  if (opts.deployment !== undefined) {
    const n = Number(opts.deployment);
    if (!Number.isInteger(n) || n <= 0) {
      error('--deployment must be a positive integer');
      return;
    }
    depId = n;
  }
  try {
    const id = await resolveServiceRef(client, ref);
    if (id === null) return;
    if (depId === undefined) {
      const status = await client.deploys.canary(id);
      if (!status.active || status.deploymentId === undefined) {
        error('No canary is running on this service.');
        return;
      }
      depId = status.deploymentId;
    }
    const target = depId;
    await spinner('Promoting the canary', () => client.deploys.promoteCanary(id, target));
    success(`Deployment #${target}: all traffic is switching to the new release.`);
  } catch (err) {
    error(message(err));
  }
}
