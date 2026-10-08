import process from 'node:process';
import type {
  AccessGrant,
  AccessGrantCreate,
  AccessGrantRole,
  AccessGrantUpdate,
  CreateTerminalSessionInput,
  TerminalSession,
  TerminalSessionStatus,
  TerminalSocketFactory,
  TerminalSocketLike,
  TerminalTargetKind,
  TrafficRange,
  TrafficScopeTotal,
  TrafficSettingsView,
} from '@ninedeploy/sdk';
import type { NineDeployClient } from '../client.js';
import { prompt, promptHidden } from '../prompts.js';
import { c, error, fmtBytes, fmtTime, header, info, kv, spinner, success, table } from '../lib/format.js';
import { plain } from './sources.js';

/**
 * 0.15 operations surfaces:
 *
 *   ninedeploy terminals list|show <id>|kill <id>
 *   ninedeploy terminal service <id> | db <id> [--client] | container <name> | host [serverId]
 *   ninedeploy traffic settings [--enable|--disable] [--retention <days>] | summary | service <id>
 *   ninedeploy access grants list|add|update <grantId> [--role|--suspend|--reinstate]|remove <grantId> --workspace <id>
 *   ninedeploy access me
 *
 * Terminals and the instance traffic routes are operator only on the
 * server. The host-shell password is read with a hidden prompt, never from
 * argv. Every server-provided string goes through the F1011 sanitiser.
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

const STATUSES: TerminalSessionStatus[] = ['pending', 'active', 'ended', 'failed', 'expired'];
const KINDS: TerminalTargetKind[] = ['service', 'database', 'container', 'host'];
const RANGES: TrafficRange[] = ['1h', '24h', '7d', '30d'];
const ROLES: AccessGrantRole[] = ['viewer', 'member', 'admin'];

function duration(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// ── terminals ─────────────────────────────────────────────────────────────

export interface TerminalsListOptions {
  status?: string;
  target?: string;
  limit?: string;
  before?: string;
}

/** `ninedeploy terminals list [--status] [--target] [--limit] [--before]` */
export async function terminalsList(client: NineDeployClient, opts: TerminalsListOptions = {}): Promise<void> {
  if (opts.status && !STATUSES.includes(opts.status as TerminalSessionStatus)) return error(`--status must be one of ${STATUSES.join(', ')}`);
  if (opts.target && !KINDS.includes(opts.target as TerminalTargetKind)) return error(`--target must be one of ${KINDS.join(', ')}`);
  const limit = opts.limit === undefined ? undefined : positiveInt(opts.limit, '--limit');
  const before = opts.before === undefined ? undefined : positiveInt(opts.before, '--before');
  if (limit === null || before === null) return;
  try {
    const page = await spinner('Loading terminal sessions', () =>
      client.terminals.list({
        ...(opts.status ? { status: opts.status as TerminalSessionStatus } : {}),
        ...(opts.target ? { targetKind: opts.target as TerminalTargetKind } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(before !== undefined ? { before } : {}),
      }),
    );
    header('Terminal sessions');
    table(
      page.items.map((s) => ({
        id: s.id,
        target: `${s.targetKind}: ${plain(s.targetLabel)}`,
        user: plain(s.userEmail ?? '—'),
        status: s.status,
        started: fmtTime(s.startedAt ?? s.createdAt),
        duration: duration(s.durationMs),
        ended: s.endReason ? plain(s.endReason) : '',
      })),
      ['id', 'target', 'user', 'status', 'started', 'duration', 'ended'],
    );
    if (page.nextBefore !== null) info(`Older sessions: ninedeploy terminals list --before ${page.nextBefore}`);
  } catch (err) {
    error(message(err));
  }
}

function printSession(s: TerminalSession): void {
  kv('Session', `#${s.id}`);
  kv('Target', `${s.targetKind}: ${plain(s.targetLabel)}`);
  kv('Node', s.serverId === null ? 'panel host' : `#${s.serverId}`);
  kv('User', s.userEmail === null ? null : plain(s.userEmail));
  kv('Status', s.status);
  kv('Created', s.createdAt);
  kv('Started', s.startedAt);
  kv('Ended', s.endedAt);
  kv('Duration', duration(s.durationMs));
  kv('Bytes in/out', `${fmtBytes(s.bytesIn)} / ${fmtBytes(s.bytesOut)}`);
  kv('End reason', s.endReason === null ? null : plain(s.endReason));
  kv('Exit code', s.exitCode);
  kv('Client IP', s.clientIp);
}

/** `ninedeploy terminals show <id>` */
export async function terminalsShow(client: NineDeployClient, idRaw: string): Promise<void> {
  const id = positiveInt(idRaw, 'Session id');
  if (id === null) return;
  try {
    const s = await spinner('Loading the session', () => client.terminals.get(id));
    header(`Terminal session #${s.id}`);
    printSession(s);
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy terminals kill <id> [--yes]` */
export async function terminalsKill(client: NineDeployClient, idRaw: string, opts: { yes?: boolean } = {}): Promise<void> {
  const id = positiveInt(idRaw, 'Session id');
  if (id === null) return;
  if (!opts.yes) {
    const answer = await prompt(`Terminate terminal session #${id}? Type "yes" to confirm`);
    if (answer.trim().toLowerCase() !== 'yes') return info('Cancelled');
  }
  try {
    const res = await spinner('Terminating', () => client.terminals.terminate(id));
    success(res.wasLive ? `Session #${id} terminated` : `Pending session #${id} revoked`);
  } catch (err) {
    error(message(err));
  }
}

// ── interactive terminal ──────────────────────────────────────────────────

/** The process streams the interactive terminal drives (injectable for tests). */
export interface TerminalIo {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  /** Builds the attach socket; defaults to the `ws` package (sends no Origin). */
  socketFactory?: TerminalSocketFactory;
}

async function wsSocketFactory(): Promise<TerminalSocketFactory> {
  const { WebSocket } = await import('ws');
  return (url, protocols) => new WebSocket(url, protocols) as unknown as TerminalSocketLike;
}

export interface TerminalOpenOptions {
  replica?: string;
  node?: string;
  client?: boolean;
}

/** Build the session target from `terminal <kind> <ref>`; prints the usage error and returns null when invalid. */
export function terminalTarget(kind: string, ref: string | undefined, opts: TerminalOpenOptions = {}): CreateTerminalSessionInput['target'] | null {
  switch (kind) {
    case 'service': {
      const serviceId = positiveInt(ref, 'Service id');
      if (serviceId === null) return null;
      const replica = opts.replica === undefined ? undefined : positiveInt(opts.replica, '--replica');
      const serverId = opts.node === undefined ? undefined : positiveInt(opts.node, '--node');
      if (replica === null || serverId === null) return null;
      return { kind: 'service', serviceId, ...(replica !== undefined ? { replica } : {}), ...(serverId !== undefined ? { serverId } : {}) };
    }
    case 'db': {
      const databaseId = positiveInt(ref, 'Database id');
      if (databaseId === null) return null;
      return { kind: 'database', databaseId, mode: opts.client ? 'client' : 'shell' };
    }
    case 'container':
      if (!ref || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/.test(ref)) {
        error('Usage: ninedeploy terminal container <name>');
        return null;
      }
      return { kind: 'container', name: ref };
    case 'host': {
      if (ref === undefined) return { kind: 'host', serverId: null };
      const serverId = positiveInt(ref, 'Server id');
      return serverId === null ? null : { kind: 'host', serverId };
    }
    default:
      error('Usage: ninedeploy terminal service <id> | db <id> | container <name> | host [serverId]');
      return null;
  }
}

/**
 * `ninedeploy terminal <kind> <ref>`: an interactive shell over protocol v1.
 * The local terminal is put in raw mode, window resizes are forwarded, and
 * the shell's exit code becomes the CLI's.
 */
export async function terminalOpen(
  client: NineDeployClient,
  kind: string,
  ref: string | undefined,
  opts: TerminalOpenOptions = {},
  io: TerminalIo = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
): Promise<void> {
  const target = terminalTarget(kind, ref, opts);
  if (target === null) return;
  const { stdin, stdout, stderr } = io;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return error('An interactive terminal needs a TTY on stdin.');
  }
  let password: string | undefined;
  if (target.kind === 'host') {
    // Step-up for every host shell. SSO-only accounts: leave it empty within 10 minutes of signing in.
    password = (await promptHidden('Your password (host shell re-check)')) || undefined;
  }
  let created: Awaited<ReturnType<NineDeployClient['terminals']['create']>>;
  try {
    created = await client.terminals.create({
      target,
      cols: Math.min(500, Math.max(10, stdout.columns || 120)),
      rows: Math.min(200, Math.max(5, stdout.rows || 32)),
      ...(password ? { password } : {}),
    });
  } catch (err) {
    return error(message(err));
  }
  const socketFactory = io.socketFactory ?? (await wsSocketFactory());
  await new Promise<void>((resolve) => {
    let exitCode: number | null = null;
    const onInput = (chunk: Buffer | string) => conn.write(typeof chunk === 'string' ? chunk : new Uint8Array(chunk));
    const onResize = () => conn.resize(stdout.columns, stdout.rows);
    const conn = client.terminals.connect(
      created,
      {
        onReady: (ready) => {
          stderr.write(c.dim(`Connected to ${plain(ready.target.label)} (session #${ready.sessionId}). The shell's exit closes it.\r\n`));
        },
        onData: (bytes) => stdout.write(bytes),
        onNotice: (text) => stderr.write(`\r\n${c.yellow(plain(text))}\r\n`),
        onExit: (exit) => {
          exitCode = exit.code;
        },
        onClose: (close) => {
          stdin.removeListener('data', onInput);
          stdout.removeListener('resize', onResize);
          stdin.setRawMode(false);
          stdin.pause();
          if (close.code === 1000) {
            process.exitCode = exitCode ?? 0;
          } else {
            stderr.write(`\r\n${c.red(close.message)}\r\n`);
            process.exitCode = 1;
          }
          resolve();
        },
      },
      { socketFactory },
    );
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onInput);
    stdout.on('resize', onResize);
  });
}

// ── traffic ───────────────────────────────────────────────────────────────

function printTrafficSettings(v: TrafficSettingsView): void {
  kv('Enabled', v.enabled ? c.green('yes') : 'no');
  kv('Status', v.status);
  kv('Retention', `${v.retentionDays} days (hour rows; minute rows 48h)`);
  kv('Last ingest', v.lastIngestAt ? fmtTime(v.lastIngestAt) : null);
  kv('Log file', fmtBytes(v.logBytes));
  kv('Malformed', v.malformedLines);
  kv('Log driver', v.dockerLogDriver);
  if (v.lastError) kv('Last error', c.red(plain(v.lastError)));
}

/** `ninedeploy traffic settings [--enable|--disable] [--retention <days>] [--yes]` */
export async function trafficSettings(
  client: NineDeployClient,
  opts: { enable?: boolean; disable?: boolean; retention?: string; yes?: boolean } = {},
): Promise<void> {
  if (opts.enable && opts.disable) return error('Use either --enable or --disable');
  const retentionDays = opts.retention === undefined ? undefined : positiveInt(opts.retention, '--retention');
  if (retentionDays === null) return;
  const enabled = opts.enable ? true : opts.disable ? false : undefined;
  try {
    if (enabled === undefined && retentionDays === undefined) {
      const v = await spinner('Reading traffic settings', () => client.traffic.settings.get());
      header('Traffic analytics');
      printTrafficSettings(v);
      return;
    }
    if (enabled !== undefined && !opts.yes) {
      info('Turning analytics on or off recreates Traefik once: about 1–2 seconds of refused connections on every domain.');
      const answer = await prompt('Continue? Type "yes" to confirm');
      if (answer.trim().toLowerCase() !== 'yes') return info('Cancelled');
    }
    const v = await spinner('Saving traffic settings', () =>
      client.traffic.settings.set({ ...(enabled !== undefined ? { enabled } : {}), ...(retentionDays !== undefined ? { retentionDays } : {}) }),
    );
    success('Traffic settings saved');
    printTrafficSettings(v);
  } catch (err) {
    error(message(err));
    // A recreate can cut this very connection: say how to read the real state.
    if (enabled !== undefined) info('Check the current state with `ninedeploy traffic settings`.');
  }
}

function parseRange(raw: string | undefined): TrafficRange | null | undefined {
  if (raw === undefined) return undefined;
  if (RANGES.includes(raw as TrafficRange)) return raw as TrafficRange;
  error(`--range must be one of ${RANGES.join(', ')}`);
  return null;
}

const ms = (v: number | null) => (v === null ? '—' : `${Math.round(v)}ms`);
const scopeRows = (rows: TrafficScopeTotal[]) =>
  rows.map((r) => ({
    host: plain(r.host ?? r.scopeKey),
    requests: r.requests,
    '5xx': r.status5xx,
    p95: ms(r.p95Ms),
    sent: fmtBytes(r.bytesOut),
  }));

/** `ninedeploy traffic summary [--range] [--top]` */
export async function trafficSummary(client: NineDeployClient, opts: { range?: string; top?: string } = {}): Promise<void> {
  const range = parseRange(opts.range);
  const top = opts.top === undefined ? undefined : positiveInt(opts.top, '--top');
  if (range === null || top === null) return;
  try {
    const s = await spinner('Loading traffic', () =>
      client.traffic.summary({ ...(range ? { range } : {}), ...(top !== undefined ? { top } : {}) }),
    );
    header(`Traffic (${s.range})`);
    if (!s.enabled) info('Traffic analytics is off. Turn it on with `ninedeploy traffic settings --enable`.');
    kv('Requests', s.totals.requests);
    kv('2xx / 4xx / 5xx', `${s.totals.status2xx} / ${s.totals.status4xx} / ${s.totals.status5xx}`);
    kv('p50 / p95 / p99', `${ms(s.totals.p50Ms)} / ${ms(s.totals.p95Ms)} / ${ms(s.totals.p99Ms)}`);
    kv('Sent', fmtBytes(s.totals.bytesOut));
    console.log();
    table(scopeRows([...s.topDomains, ...[s.panel, s.custom].filter((r) => r !== null)]), ['host', 'requests', '5xx', 'p95', 'sent']);
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy traffic service <id> [--range]` */
export async function trafficService(client: NineDeployClient, idRaw: string, opts: { range?: string } = {}): Promise<void> {
  const id = positiveInt(idRaw, 'Service id');
  const range = parseRange(opts.range);
  if (id === null || range === null) return;
  try {
    const s = await spinner('Loading traffic', () => client.traffic.service(id, range ? { range } : {}));
    header(`Service #${id} traffic (${s.range})`);
    if (!s.enabled) return info('Traffic analytics is off on this panel.');
    kv('Requests', s.totals.requests);
    kv('5xx', s.totals.status5xx);
    kv('p50 / p95 / p99', `${ms(s.totals.p50Ms)} / ${ms(s.totals.p95Ms)} / ${ms(s.totals.p99Ms)}`);
    console.log();
    table(scopeRows(s.domains), ['host', 'requests', '5xx', 'p95', 'sent']);
  } catch (err) {
    error(message(err));
  }
}

// ── access grants ─────────────────────────────────────────────────────────

const grantTarget = (g: AccessGrant) =>
  [g.project ? `project ${plain(g.project.name)}` : null, g.environment ? `env ${plain(g.environment.name)}` : null].filter(Boolean).join(' · ');

function printGrants(grants: AccessGrant[]): void {
  table(
    grants.map((g) => ({
      id: g.id,
      workspace: g.workspaceId,
      user: plain(g.user.email),
      target: grantTarget(g),
      role: g.role,
      flags: [g.isGuest ? 'guest' : '', g.suspended ? 'suspended' : ''].filter(Boolean).join(','),
    })),
    ['id', 'workspace', 'user', 'target', 'role', 'flags'],
  );
}

function parseRole(raw: string | undefined): AccessGrantRole | null {
  if (raw && ROLES.includes(raw as AccessGrantRole)) return raw as AccessGrantRole;
  error(`--role must be one of ${ROLES.join(', ')}`);
  return null;
}

/** `ninedeploy access grants list --workspace <id> [--user <id>] [--project <id>]` */
export async function accessGrantsList(client: NineDeployClient, opts: { workspace?: string; user?: string; project?: string; environment?: string } = {}): Promise<void> {
  const workspaceId = positiveInt(opts.workspace, '--workspace');
  if (workspaceId === null) return;
  const filters: Record<string, number> = {};
  for (const [flag, key] of [['user', 'userId'], ['project', 'projectId'], ['environment', 'environmentId']] as const) {
    if (opts[flag] === undefined) continue;
    const v = positiveInt(opts[flag], `--${flag}`);
    if (v === null) return;
    filters[key] = v;
  }
  try {
    const grants = await spinner('Loading access grants', () => client.accessGrants.list(workspaceId, filters));
    header(`Access grants in workspace #${workspaceId}`);
    printGrants(grants);
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy access grants add --workspace <id> (--email|--user) (--project|--environment) --role <role>` */
export async function accessGrantsAdd(
  client: NineDeployClient,
  opts: { workspace?: string; email?: string; user?: string; project?: string; environment?: string; role?: string } = {},
): Promise<void> {
  const workspaceId = positiveInt(opts.workspace, '--workspace');
  if (workspaceId === null) return;
  if ((opts.email === undefined) === (opts.user === undefined)) return error('Name the user with exactly one of --email or --user');
  if (opts.project === undefined && opts.environment === undefined) return error('A grant needs --project, --environment, or both');
  const role = parseRole(opts.role);
  if (role === null) return;
  const input: AccessGrantCreate = { role };
  if (opts.email !== undefined) input.email = opts.email.trim().toLowerCase();
  for (const [flag, key] of [['user', 'userId'], ['project', 'projectId'], ['environment', 'environmentId']] as const) {
    if (opts[flag] === undefined) continue;
    const v = positiveInt(opts[flag], `--${flag}`);
    if (v === null) return;
    input[key] = v;
  }
  try {
    const g = await spinner('Granting access', () => client.accessGrants.create(workspaceId, input));
    success(`Grant #${g.id}: ${plain(g.user.email)} is ${g.role} on ${grantTarget(g)}${g.isGuest ? ' (guest)' : ''}`);
  } catch (err) {
    error(message(err));
  }
}

/**
 * `ninedeploy access grants update <grantId> --workspace <id> [--role <role>] [--suspend | --reinstate]`
 *
 * A suspended grant stays listed but gives no access; `--reinstate` makes it
 * count again (refused while the user's identity provider has them suspended).
 */
export async function accessGrantsUpdate(
  client: NineDeployClient,
  grantRaw: string,
  opts: { workspace?: string; role?: string; suspend?: boolean; reinstate?: boolean } = {},
): Promise<void> {
  const workspaceId = positiveInt(opts.workspace, '--workspace');
  const grantId = workspaceId === null ? null : positiveInt(grantRaw, 'Grant id');
  if (workspaceId === null || grantId === null) return;
  if (opts.suspend && opts.reinstate) return error('Pass only one of --suspend or --reinstate');
  const suspended = opts.suspend ? true : opts.reinstate ? false : undefined;
  if (opts.role === undefined && suspended === undefined) return error('Pass --role, --suspend or --reinstate');
  const input: AccessGrantUpdate = {};
  if (opts.role !== undefined) {
    const role = parseRole(opts.role);
    if (role === null) return;
    input.role = role;
  }
  if (suspended !== undefined) input.suspended = suspended;
  try {
    const g = await spinner(suspended === undefined ? 'Changing the role' : 'Updating the grant', () =>
      client.accessGrants.update(workspaceId, grantId, input),
    );
    if (suspended === undefined) success(`Grant #${g.id} is now ${g.role}`);
    else success(`Grant #${g.id} is now ${input.role !== undefined ? `${g.role}, ` : ''}${g.suspended ? 'suspended' : 'active'}`);
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy access grants remove <grantId> --workspace <id> [--yes]` */
export async function accessGrantsRemove(client: NineDeployClient, grantRaw: string, opts: { workspace?: string; yes?: boolean } = {}): Promise<void> {
  const workspaceId = positiveInt(opts.workspace, '--workspace');
  const grantId = workspaceId === null ? null : positiveInt(grantRaw, 'Grant id');
  if (workspaceId === null || grantId === null) return;
  if (!opts.yes) {
    const answer = await prompt(`Revoke grant #${grantId}? Type "yes" to confirm`);
    if (answer.trim().toLowerCase() !== 'yes') return info('Cancelled');
  }
  try {
    await spinner('Revoking', () => client.accessGrants.delete(workspaceId, grantId));
    success(`Grant #${grantId} revoked`);
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy access me` */
export async function accessMe(client: NineDeployClient): Promise<void> {
  try {
    const me = await spinner('Loading your access', () => client.access.me());
    header('Your access grants');
    printGrants(me.grants);
    if (me.guestWorkspaces.length > 0) {
      header('Guest workspaces (reached through grants only)');
      table(
        me.guestWorkspaces.map((w) => ({ id: w.id, name: plain(w.name), slug: plain(w.slug) })),
        ['id', 'name', 'slug'],
      );
    }
  } catch (err) {
    error(message(err));
  }
}
