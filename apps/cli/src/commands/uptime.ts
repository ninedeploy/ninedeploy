import {
  monitorCreate,
  parseTcpTarget,
  statusPageCreate,
  statusPagePatch,
  type MonitorCheckView,
  type MonitorCreateInput,
  type MonitorView,
  type StatusPageView,
} from '@ninedeploy/schemas';
import { apiUrl, type NineDeployClient } from '../client.js';
import { prompt } from '../prompts.js';
import { c, error, fmtTime, header, info, kv, spinner, success, table } from '../lib/format.js';
import { plain } from './sources.js';

/**
 * 0.16.8 uptime monitors and public status pages:
 *
 *   ninedeploy monitors list [--service <id|slug>] [--json]
 *   ninedeploy monitors add <name> <target> [--tcp] [--service] [--interval] [--timeout] [--failures]
 *                           [--expect] [--keyword] [--head] [--no-follow-redirects] [--insecure] [--disabled]
 *   ninedeploy monitors show|check|pause|resume|rm <id>
 *   ninedeploy status-pages list | add <slug> <title> [--monitor <id>...] [--publish]
 *                           | publish|unpublish <id> | notice <id> [text] [--clear] | rm <id>
 *
 * Managing monitors and every status-page call is operator only on the
 * server. Names, targets, errors and notices are user text and go through
 * the F1011 sanitiser before they reach the terminal.
 */

const message = (err: unknown): string => plain(err instanceof Error ? err.message : String(err));

function positiveInt(raw: string | undefined, what: string): number | null {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n <= 0) {
    error(`${what} must be a positive integer`);
    return null;
  }
  return n;
}

/** Skip the spinner for `--json` so stdout stays parseable. */
const load = <T>(json: boolean | undefined, msg: string, fn: () => Promise<T>): Promise<T> => (json ? fn() : spinner(msg, fn));

/** A service id, or the id of the service with that slug (or name); null after printing why not. */
export async function resolveServiceRef(client: NineDeployClient, ref: string): Promise<number | null> {
  if (/^\d+$/.test(ref)) return positiveInt(ref, '--service');
  const found = (await client.services.list()).find((s) => s.slug === ref || s.name === ref);
  if (!found) {
    error(`No service named "${plain(ref)}".`);
    return null;
  }
  return found.id;
}

const pct = (v: number | null): string => (v === null ? c.gray('—') : `${v.toFixed(2)}%`);

function monitorStatus(s: MonitorView['status']): string {
  switch (s) {
    case 'up':
      return c.green(s);
    case 'down':
      return c.red(s);
    case 'pending':
      return c.yellow(s);
    default:
      return c.gray(s);
  }
}

/** Flag names for the schema fields, so a validation failure names what the user typed. */
const FLAG: Record<string, string> = {
  name: '<name>',
  target: '<target>',
  serviceId: '--service',
  intervalSeconds: '--interval',
  timeoutSeconds: '--timeout',
  failuresBeforeDown: '--failures',
  expectedStatus: '--expect',
  keyword: '--keyword',
  slug: '<slug>',
  title: '<title>',
  notice: '<text>',
  monitorIds: '--monitor',
};

/** A zod failure as one line, each issue led by the flag or argument it is about. */
export function validationMessage(err: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return err.issues
    .map((i) => {
      const field = String(i.path[0] ?? '');
      return `${FLAG[field] ?? (field || 'input')}: ${i.message}`;
    })
    .join('; ');
}

// ── monitors ──────────────────────────────────────────────────────────────

/** `ninedeploy monitors list [--service <id|slug>] [--json]` */
export async function monitorsList(client: NineDeployClient, opts: { service?: string; json?: boolean } = {}): Promise<void> {
  try {
    const serviceId = opts.service === undefined ? undefined : await resolveServiceRef(client, opts.service);
    if (serviceId === null) return;
    const rows = await load(opts.json, 'Loading monitors', () => client.monitors.list(serviceId === undefined ? undefined : { serviceId }));
    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    header('Uptime monitors');
    if (rows.length === 0) {
      info('No monitors yet. Add one with `ninedeploy monitors add <name> <url>`.');
      return;
    }
    table(
      rows.map((m) => ({
        id: m.id,
        status: monitorStatus(m.status),
        name: plain(m.name),
        target: `${m.kind === 'tcp' ? 'tcp ' : ''}${plain(m.target)}`,
        '24h': pct(m.uptime.h24),
        '30d': pct(m.uptime.d30),
        'last ms': m.lastResponseMs ?? c.gray('—'),
        'last checked': fmtTime(m.lastCheckedAt),
      })),
      ['id', 'status', 'name', 'target', '24h', '30d', 'last ms', 'last checked'],
    );
  } catch (err) {
    error(message(err));
  }
}

export interface MonitorAddOptions {
  tcp?: boolean;
  service?: string;
  interval?: string;
  timeout?: string;
  failures?: string;
  expect?: string;
  keyword?: string;
  head?: boolean;
  /** Commander's `--no-follow-redirects` sets this to false. */
  followRedirects?: boolean;
  insecure?: boolean;
  disabled?: boolean;
}

/** `--tcp`, or a target without a scheme that reads as host:port, is a TCP check; anything else HTTP. */
export function monitorKindFor(target: string, tcp?: boolean): 'http' | 'tcp' {
  if (tcp) return 'tcp';
  return !target.includes('://') && parseTcpTarget(target.trim()) ? 'tcp' : 'http';
}

function intFlag(raw: string | undefined, flag: string): number | undefined | null {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isInteger(n)) {
    error(`${flag} must be a whole number`);
    return null;
  }
  return n;
}

/** `ninedeploy monitors add <name> <target> [...]` */
export async function monitorsAdd(client: NineDeployClient, name: string, target: string, opts: MonitorAddOptions = {}): Promise<void> {
  const kind = monitorKindFor(target, opts.tcp);
  const intervalSeconds = intFlag(opts.interval, '--interval');
  const timeoutSeconds = intFlag(opts.timeout, '--timeout');
  const failuresBeforeDown = intFlag(opts.failures, '--failures');
  if (intervalSeconds === null || timeoutSeconds === null || failuresBeforeDown === null) return;
  try {
    const serviceId = opts.service === undefined ? undefined : await resolveServiceRef(client, opts.service);
    if (serviceId === null) return;
    const input: MonitorCreateInput = {
      name,
      kind,
      target,
      ...(serviceId !== undefined ? { serviceId } : {}),
      ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
      ...(failuresBeforeDown !== undefined ? { failuresBeforeDown } : {}),
      ...(opts.expect !== undefined ? { expectedStatus: opts.expect } : {}),
      ...(opts.keyword !== undefined ? { keyword: opts.keyword } : {}),
      ...(opts.head ? { method: 'HEAD' as const } : {}),
      ...(opts.followRedirects === false ? { followRedirects: false } : {}),
      ...(opts.insecure ? { verifyTls: false } : {}),
      ...(opts.disabled ? { enabled: false } : {}),
    };
    const parsed = monitorCreate.safeParse(input);
    if (!parsed.success) return error(validationMessage(parsed.error));
    const m = await spinner('Creating the monitor', () => client.monitors.create(input));
    success(`Monitor #${m.id} "${plain(m.name)}" created (${m.kind} ${plain(m.target)}, every ${m.intervalSeconds}s).`);
    if (m.enabled) info(`Run a check now: ninedeploy monitors check ${m.id}`);
    else info(`Paused. Start it with: ninedeploy monitors resume ${m.id}`);
  } catch (err) {
    error(message(err));
  }
}

function printChecks(checks: MonitorCheckView[]): void {
  if (checks.length === 0) {
    info('No checks recorded yet.');
    return;
  }
  table(
    checks.map((k) => ({
      time: fmtTime(k.ts),
      result: k.ok ? c.green('ok') : c.red('fail'),
      ms: k.responseMs ?? c.gray('—'),
      code: k.statusCode ?? c.gray('—'),
      error: k.error ? plain(k.error) : '',
    })),
    ['time', 'result', 'ms', 'code', 'error'],
  );
}

/** Hours of history that hold the last ten checks of a monitor with this interval (1–168, at least a day). */
const historyHours = (intervalSeconds: number): number => Math.min(168, Math.max(24, Math.ceil((10 * intervalSeconds) / 3600) + 1));

/** `ninedeploy monitors show <id> [--json]` — details and the last 10 checks. */
export async function monitorsShow(client: NineDeployClient, idRaw: string, opts: { json?: boolean } = {}): Promise<void> {
  const id = positiveInt(idRaw, 'Monitor id');
  if (id === null) return;
  try {
    const m = await load(opts.json, 'Loading the monitor', () => client.monitors.get(id));
    const checks = (await client.monitors.checks(id, { hours: historyHours(m.intervalSeconds) })).slice(0, 10);
    if (opts.json) {
      console.log(JSON.stringify({ monitor: m, checks }, null, 2));
      return;
    }
    header(`Monitor #${m.id}: ${plain(m.name)}`);
    kv('Status', `${monitorStatus(m.status)}${m.statusSince ? c.gray(` since ${m.statusSince}`) : ''}`);
    kv('Kind', m.kind);
    kv('Target', plain(m.target));
    kv('Service', m.serviceId === null ? c.gray('— (operator only)') : `#${m.serviceId}`);
    if (m.kind === 'http') {
      kv('Method', m.method);
      kv('Expect', m.expectedStatus);
      kv('Keyword', m.keyword === null ? null : plain(m.keyword));
      kv('Redirects', m.followRedirects ? 'followed' : 'not followed');
      kv('TLS', m.verifyTls ? 'verified' : c.yellow('not verified'));
    }
    kv('Interval', `${m.intervalSeconds}s (timeout ${m.timeoutSeconds}s, down after ${m.failuresBeforeDown} failures)`);
    kv('Uptime', `24h ${pct(m.uptime.h24)}  7d ${pct(m.uptime.d7)}  30d ${pct(m.uptime.d30)}`);
    kv('Last check', m.lastCheckedAt);
    kv('Last response', m.lastResponseMs === null ? null : `${m.lastResponseMs} ms${m.lastStatusCode !== null ? ` (HTTP ${m.lastStatusCode})` : ''}`);
    kv('Last error', m.lastError === null ? null : plain(m.lastError));
    if (m.certExpiresAt) kv('Cert expires', m.certExpiresAt);
    kv('Created', m.createdAt);
    console.log();
    console.log(`  ${c.bold('Last checks')}`);
    printChecks(checks);
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy monitors check <id>` — run a check now. */
export async function monitorsCheck(client: NineDeployClient, idRaw: string): Promise<void> {
  const id = positiveInt(idRaw, 'Monitor id');
  if (id === null) return;
  try {
    const { check, monitor } = await spinner('Checking', () => client.monitors.checkNow(id));
    const detail = [check.responseMs !== null ? `${check.responseMs} ms` : null, check.statusCode !== null ? `HTTP ${check.statusCode}` : null]
      .filter(Boolean)
      .join(', ');
    if (check.ok) success(`Check passed${detail ? ` (${detail})` : ''}.`);
    else error(`Check failed${detail ? ` (${detail})` : ''}: ${check.error ? plain(check.error) : 'no detail'}`);
    info(`Monitor #${monitor.id} is ${monitor.status}.`);
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy monitors pause|resume <id>` */
export async function monitorsSetEnabled(client: NineDeployClient, idRaw: string, enabled: boolean): Promise<void> {
  const id = positiveInt(idRaw, 'Monitor id');
  if (id === null) return;
  try {
    const m = await spinner(enabled ? 'Resuming' : 'Pausing', () => client.monitors.update(id, { enabled }));
    success(`Monitor #${m.id} ${enabled ? 'resumed' : 'paused'} (${m.status}).`);
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy monitors rm <id> [--yes]` */
export async function monitorsRemove(client: NineDeployClient, idRaw: string, opts: { yes?: boolean } = {}): Promise<void> {
  const id = positiveInt(idRaw, 'Monitor id');
  if (id === null) return;
  if (!opts.yes) {
    const answer = await prompt(`Delete monitor #${id} and its check history? Type "yes" to confirm`);
    if (answer.trim().toLowerCase() !== 'yes') return info('Cancelled');
  }
  try {
    await spinner('Deleting', () => client.monitors.delete(id));
    success(`Monitor #${id} deleted.`);
  } catch (err) {
    error(message(err));
  }
}

// ── status pages ──────────────────────────────────────────────────────────

/** The public address of a status page: the panel URL plus its path. */
export const statusPageUrl = (p: Pick<StatusPageView, 'path'>): string => apiUrl(p.path);

/** `ninedeploy status-pages list [--json]` */
export async function statusPagesList(client: NineDeployClient, opts: { json?: boolean } = {}): Promise<void> {
  try {
    const rows = await load(opts.json, 'Loading status pages', () => client.statusPages.list());
    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    header('Status pages');
    if (rows.length === 0) {
      info('No status pages yet. Add one with `ninedeploy status-pages add <slug> <title>`.');
      return;
    }
    table(
      rows.map((p) => ({
        id: p.id,
        slug: plain(p.slug),
        title: plain(p.title),
        published: p.published ? c.green('yes') : c.gray('no'),
        monitors: p.monitorIds.length,
        notice: p.notice ? 'yes' : '',
        url: statusPageUrl(p),
      })),
      ['id', 'slug', 'title', 'published', 'monitors', 'notice', 'url'],
    );
  } catch (err) {
    error(message(err));
  }
}

function printPageUrl(p: StatusPageView): void {
  if (p.published) info(`Public URL: ${statusPageUrl(p)}`);
  else info(`Not published (answers 404). Publish it with: ninedeploy status-pages publish ${p.id}`);
}

/** `ninedeploy status-pages add <slug> <title> [--monitor <id>...] [--publish]` */
export async function statusPagesAdd(
  client: NineDeployClient,
  slug: string,
  title: string,
  opts: { monitor?: string[]; publish?: boolean } = {},
): Promise<void> {
  const monitorIds: number[] = [];
  for (const raw of opts.monitor ?? []) {
    const id = positiveInt(raw, '--monitor');
    if (id === null) return;
    monitorIds.push(id);
  }
  const input = { slug, title, monitorIds, published: opts.publish === true };
  const parsed = statusPageCreate.safeParse(input);
  if (!parsed.success) return error(validationMessage(parsed.error));
  try {
    const p = await spinner('Creating the status page', () => client.statusPages.create(input));
    success(`Status page #${p.id} "${plain(p.title)}" created with ${p.monitorIds.length} monitor(s).`);
    printPageUrl(p);
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy status-pages publish|unpublish <id>` */
export async function statusPagesSetPublished(client: NineDeployClient, idRaw: string, published: boolean): Promise<void> {
  const id = positiveInt(idRaw, 'Status page id');
  if (id === null) return;
  try {
    const p = await spinner(published ? 'Publishing' : 'Unpublishing', () => client.statusPages.update(id, { published }));
    success(`Status page #${p.id} ${published ? 'published' : 'unpublished'}.`);
    printPageUrl(p);
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy status-pages notice <id> [text] [--clear]` */
export async function statusPagesNotice(client: NineDeployClient, idRaw: string, text: string | undefined, opts: { clear?: boolean } = {}): Promise<void> {
  const id = positiveInt(idRaw, 'Status page id');
  if (id === null) return;
  if (opts.clear && text !== undefined) return error('Pass the notice text or --clear, not both.');
  if (!opts.clear && !text?.trim()) return error('Usage: ninedeploy status-pages notice <id> <text> | --clear');
  const notice = opts.clear ? null : text!;
  const parsed = statusPagePatch.safeParse({ notice });
  if (!parsed.success) return error(validationMessage(parsed.error));
  try {
    const p = await spinner(notice === null ? 'Clearing the notice' : 'Setting the notice', () => client.statusPages.update(id, { notice }));
    success(notice === null ? `Notice cleared on status page #${p.id}.` : `Notice set on status page #${p.id}.`);
    printPageUrl(p);
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy status-pages rm <id> [--yes]` */
export async function statusPagesRemove(client: NineDeployClient, idRaw: string, opts: { yes?: boolean } = {}): Promise<void> {
  const id = positiveInt(idRaw, 'Status page id');
  if (id === null) return;
  if (!opts.yes) {
    const answer = await prompt(`Delete status page #${id}? Its public URL stops working. Type "yes" to confirm`);
    if (answer.trim().toLowerCase() !== 'yes') return info('Cancelled');
  }
  try {
    await spinner('Deleting', () => client.statusPages.delete(id));
    success(`Status page #${id} deleted.`);
  } catch (err) {
    error(message(err));
  }
}
