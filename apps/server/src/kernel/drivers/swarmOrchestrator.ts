import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { swarmStacks, type DB } from '@ninedeploy/db';
import { config } from '../../config.js';
import { capture, run, sleep } from '../../lib/exec.js';
import type { IOrchestrator, StackServiceSpec, StackSpec, StackStatus } from '../types.js';

// Swarm-backed orchestrator (Sprint 5 G-10; rewritten for multi-node, design
// §7.3, which fixes D7a–f).
//
// Every apply is ONE declarative `docker stack deploy` of a compose file the
// driver renders under `<dataDir>/swarm/<stack>/stack.yml`:
//   - create-or-update in one step, so env, replica, label, constraint and
//     network changes all apply on a redeploy (D7a; the old driver ran
//     `service update --image` only);
//   - env reaches the service through a 0600 `env_file` next to it, removed
//     after the apply — never an argv element (D7b);
//   - no `ports:` and no `--publish`: Traefik on the attachable overlay is the
//     only ingress (D7c);
//   - state under the panel's data directory, which a docker install's
//     non-root user can write (D7d; /var/lib/ninedeploy/stacks could not);
//   - secrets and configs named `<name>-<sha8 of the content>`, so a rotated
//     value is a new object the service switches to, and the superseded one
//     is pruned (D7e; "already exists" used to be swallowed);
//   - `resolveImage` and per-service placement constraints, so an image
//     preloaded onto some nodes is never resolved against a registry and no
//     task lands where it is missing (D7f; the deploy flow distributes it).
// Rolling updates are start-first, one task at a time, rolled back by Swarm
// itself when a new task fails (`failure_action: rollback`).
//
// State lives in swarm_stacks (state_json) and in stack.json next to the
// stack file; the row is the source of truth across a restart.
export const STACK_LABEL = 'ninedeploy.stack';
/** Convergence wait for one apply (design §7.4 step 5). */
export const STACK_DEPLOY_TIMEOUT_MS = 10 * 60_000;
/** How long removeStack waits for tasks to stop before removing networks. */
const STACK_RM_WAIT_MS = 60_000;
const READ_TIMEOUT_MS = 30_000;

/** A stack name this driver accepts: it becomes a path segment and a Docker name prefix. */
const STACK_NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/** `<dataDir>/swarm` — writable by the panel in every install (fixes D7d). */
export function swarmStackRoot(): string {
  return join(config.paths.dataDir, 'swarm');
}

export interface SwarmStackState {
  name: string;
  networks: string[];
  secrets: string[];
  configs: string[];
  /** The Swarm service names (`<stack>_<service>`). Rows written before 0.16 hold bare names. */
  serviceNames: string[];
  appliedAt: string;
  /** Why the last apply failed (absent after a successful one). */
  error?: string;
}

/** `<name>-<first 8 hex of sha256(data)>`: a rotation is a new object (D7e). */
export function hashedObjectName(name: string, data: string): string {
  return `${name}-${createHash('sha256').update(data).digest('hex').slice(0, 8)}`;
}

/**
 * `docker stack deploy` interpolates `${VAR}` / `$VAR` in every string of the
 * compose file from the CLI's own environment; `$$` is a literal `$`. The
 * env file is not interpolated, so only the stack file is escaped.
 */
function escapeInterpolation<T>(value: T): T {
  if (typeof value === 'string') return value.replace(/\$/g, '$$$$') as T;
  if (Array.isArray(value)) return value.map((v) => escapeInterpolation(v)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, escapeInterpolation(v)])) as T;
  }
  return value;
}

/**
 * The env file one service reads (`KEY=VALUE` per line, Docker's env-file
 * format: no quoting, no interpolation). A value spanning lines cannot be
 * expressed there, so it is refused by name rather than silently cut.
 */
export function renderEnvFile(env: Record<string, string>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) throw new Error(`Environment variable name "${key}" cannot be passed to a Swarm service`);
    if (/[\r\n\0]/.test(value)) {
      throw new Error(`Environment variable ${key} spans several lines, which a Swarm service's env file cannot carry; store it on one line (for example base64-encoded)`);
    }
    lines.push(`${key}=${value}`);
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/** The compose v3.9 document for one stack (JSON, which is YAML). Pure. */
export function renderStackFile(
  stack: StackSpec,
  refs: { envFiles: Record<string, string>; secrets: Record<string, string>; configs: Record<string, string> },
): string {
  const services: Record<string, unknown> = {};
  for (const svc of stack.services) services[svc.name] = renderService(svc, stack, refs);
  const doc: Record<string, unknown> = {
    version: '3.9',
    services,
    // Created (and joined by Traefik) before the apply; never owned by the stack file.
    networks: Object.fromEntries(stack.networks.map((n) => [n.name, { external: true, name: n.name }])),
  };
  if (stack.secrets.length > 0) {
    doc['secrets'] = Object.fromEntries(stack.secrets.map((s) => [s.name, { external: true, name: refs.secrets[s.name] }]));
  }
  if (stack.configs.length > 0) {
    doc['configs'] = Object.fromEntries(stack.configs.map((c) => [c.name, { external: true, name: refs.configs[c.name] }]));
  }
  return `${JSON.stringify(escapeInterpolation(doc), null, 2)}\n`;
}

function renderService(
  svc: StackServiceSpec,
  stack: StackSpec,
  refs: { envFiles: Record<string, string> },
): Record<string, unknown> {
  const limits: Record<string, string> = {};
  if (svc.cpuLimitMilli && svc.cpuLimitMilli > 0) limits['cpus'] = String(svc.cpuLimitMilli / 1000);
  if (svc.memLimitMb && svc.memLimitMb > 0) limits['memory'] = `${svc.memLimitMb}M`;
  const deploy: Record<string, unknown> = {
    replicas: svc.replicas,
    update_config: { parallelism: 1, order: 'start-first', failure_action: 'rollback', monitor: '30s' },
    rollback_config: { parallelism: 1, order: 'start-first' },
    restart_policy: { condition: 'any' },
    // Service-level labels (never on the task containers: the r593 orphan
    // cleanup removes containers by their deployment label).
    labels: { ...svc.labels, [STACK_LABEL]: stack.name },
  };
  if (svc.constraints && svc.constraints.length > 0) deploy['placement'] = { constraints: svc.constraints };
  if (Object.keys(limits).length > 0) deploy['resources'] = { limits };
  const out: Record<string, unknown> = { image: svc.image };
  if (svc.command && svc.command.length > 0) out['command'] = svc.command;
  const envFile = refs.envFiles[svc.name];
  if (envFile) out['env_file'] = [envFile];
  out['networks'] = svc.networks;
  if (svc.secrets.length > 0) out['secrets'] = svc.secrets.map((s) => ({ source: s, target: s }));
  if (svc.configs.length > 0) out['configs'] = svc.configs.map((c) => ({ source: c, target: `/${c}` }));
  if (typeof svc.stopGraceSeconds === 'number' && svc.stopGraceSeconds >= 0) out['stop_grace_period'] = `${Math.min(Math.floor(svc.stopGraceSeconds), 300)}s`;
  // No `ports:` — Traefik is the only ingress (D7c). No generated healthcheck:
  // the image's own HEALTHCHECK still applies, and the deploy flow probes the
  // service over the overlay (a generated `curl` check failed every image
  // without curl, and Swarm would roll such a service back on every deploy).
  out['deploy'] = deploy;
  return out;
}

/** The `docker stack deploy` argv for one apply (design §7.3). */
export function stackDeployArgs(stack: Pick<StackSpec, 'name' | 'resolveImage'>, file: string, opts: { detach?: boolean } = {}): string[] {
  return [
    'stack',
    'deploy',
    '--prune',
    '--with-registry-auth',
    ...(opts.detach === false ? ['--detach=false'] : []),
    ...(stack.resolveImage ? ['--resolve-image', stack.resolveImage] : []),
    '-c',
    file,
    stack.name,
  ];
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class SwarmOrchestrator implements IOrchestrator {
  readonly name = 'swarm';
  private readonly db: DB;
  private readonly root: () => string;

  constructor(db: DB, opts: { root?: string } = {}) {
    this.db = db;
    this.root = opts.root !== undefined ? () => opts.root as string : swarmStackRoot;
  }

  /**
   * Apply the whole spec. Resolves with the status after the apply; a failed
   * apply (Swarm rolled the update back, the convergence wait expired, the
   * CLI refused the file) resolves with `error` set and the state recorded,
   * so removeStack can still find what was created.
   */
  async deployStack(stack: StackSpec, opts: { log?: (line: string) => void; timeoutMs?: number } = {}): Promise<StackStatus> {
    assertStackName(stack.name);
    const log = opts.log ?? (() => undefined);
    const dir = join(this.root(), stack.name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    for (const n of stack.networks) await ensureNetwork(n.name, n.driver, n.attachable, log);

    const secretNames: Record<string, string> = {};
    for (const s of stack.secrets) secretNames[s.name] = await ensureObject('secret', stack.name, s.name, s.data, dir);
    const configNames: Record<string, string> = {};
    for (const c of stack.configs) configNames[c.name] = await ensureObject('config', stack.name, c.name, c.data, dir);

    const envFiles: Record<string, string> = {};
    const file = join(dir, 'stack.yml');
    let error: string | undefined;
    try {
      for (const svc of stack.services) {
        const body = renderEnvFile(svc.env);
        if (!body) continue;
        const path = join(dir, `${svc.name}.env`);
        writeFileSync(path, body, { mode: 0o600 });
        envFiles[svc.name] = path;
      }
      writeFileSync(file, renderStackFile(stack, { envFiles, secrets: secretNames, configs: configNames }), { mode: 0o600 });
      await applyStack(stack, file, opts.timeoutMs ?? STACK_DEPLOY_TIMEOUT_MS, log);
    } catch (err) {
      error = msg(err);
    } finally {
      // The values are in the service spec now; the file must not outlive the apply.
      for (const path of Object.values(envFiles)) rmSync(path, { force: true });
    }

    if (!error) {
      await pruneObjects('secret', stack.name, new Set(Object.values(secretNames)));
      await pruneObjects('config', stack.name, new Set(Object.values(configNames)));
    }
    const state: SwarmStackState = {
      name: stack.name,
      networks: stack.networks.map((n) => n.name),
      secrets: Object.values(secretNames),
      configs: Object.values(configNames),
      serviceNames: stack.services.map((s) => `${stack.name}_${s.name}`),
      appliedAt: new Date().toISOString(),
      ...(error ? { error } : {}),
    };
    writeFileSync(join(dir, 'stack.json'), JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    await this.upsertRow(state);
    return await this.snapshotStatus(stack, error);
  }

  async removeStack(name: string): Promise<void> {
    assertStackName(name);
    const state = await this.readState(name);
    // Idempotent on an unknown stack: nothing this driver applied, nothing to remove.
    if (state) await this.removeApplied(name, state);
    try {
      rmSync(join(this.root(), name), { recursive: true, force: true });
    } catch {
      // Missing
    }
    await this.db.delete(swarmStacks).where(eq(swarmStacks.name, name));
  }

  /** `docker stack rm`, wait for the tasks to stop, then the stack's objects and networks (best effort). */
  private async removeApplied(name: string, state: SwarmStackState): Promise<void> {
    await run('docker', ['stack', 'rm', name], { timeoutMs: 120_000 }, () => undefined).catch(() => undefined);
    // Tasks stop asynchronously; a network with live endpoints cannot go yet.
    const deadline = Date.now() + STACK_RM_WAIT_MS;
    while (Date.now() < deadline) {
      const left = await capture('docker', ['stack', 'ps', name, '-q'], { timeoutMs: READ_TIMEOUT_MS }).catch(() => '');
      if (left.trim() === '') break;
      await sleep(2000);
    }
    for (const kind of ['secret', 'config'] as const) {
      const recorded = (kind === 'secret' ? state.secrets : state.configs) ?? [];
      const labelled = await listOwnedObjects(kind, name);
      for (const obj of new Set([...recorded, ...labelled])) {
        await run('docker', [kind, 'rm', obj], { timeoutMs: READ_TIMEOUT_MS }, () => undefined).catch(() => undefined);
      }
    }
    for (const n of state.networks ?? []) {
      await run('docker', ['network', 'rm', n], { timeoutMs: READ_TIMEOUT_MS }, () => undefined).catch(() => undefined);
    }
  }

  async listStacks(): Promise<Array<{ name: string; serviceCount: number }>> {
    const rows: Array<{ name: string; stateJson: string }> = await this.db
      .select({ name: swarmStacks.name, stateJson: swarmStacks.stateJson })
      .from(swarmStacks);
    return rows.map((r) => ({
      name: r.name,
      serviceCount: parseJson<SwarmStackState>(r.stateJson).serviceNames?.length ?? 0,
    }));
  }

  async getStackStatus(name: string): Promise<StackStatus | null> {
    const state = await this.readState(name);
    if (!state) return null;
    const counts = await stackServiceCounts(name);
    const services: StackStatus['services'] = (state.serviceNames ?? []).map((recorded) => {
      // A pre-0.16 state names services bare; `docker stack services` names them `<stack>_<svc>`.
      const svc = recorded.startsWith(`${name}_`) ? recorded : `${name}_${recorded}`;
      const row = counts?.get(svc);
      if (!counts || !row) return { name: svc, state: 'unknown' as const, replicas: 0 };
      const label: StackStatus['services'][number]['state'] =
        row.desired > 0 && row.running >= row.desired ? 'running' : row.running === 0 ? 'stopped' : 'partial';
      return { name: svc, state: label, replicas: row.running, desired: row.desired };
    });
    return { name, services, appliedAt: state.appliedAt, ...(state.error ? { error: state.error } : {}) };
  }

  // --- private helpers ---------------------------------------------------

  private async snapshotStatus(stack: StackSpec, error: string | undefined): Promise<StackStatus> {
    const status = (await this.getStackStatus(stack.name)) ?? {
      name: stack.name,
      services: stack.services.map((s) => ({ name: `${stack.name}_${s.name}`, state: 'unknown' as const, replicas: 0 })),
      appliedAt: new Date().toISOString(),
    };
    return error ? { ...status, error } : status;
  }

  private async readState(name: string): Promise<SwarmStackState | null> {
    if (!STACK_NAME_RE.test(name)) return null;
    const filePath = join(this.root(), name, 'stack.json');
    if (existsSync(filePath)) {
      try {
        return JSON.parse(readFileSync(filePath, 'utf8')) as SwarmStackState;
      } catch {
        // Fall through to the DB row.
      }
    }
    const row = await this.db.query.swarmStacks.findFirst({
      where: eq(swarmStacks.name, name),
    });
    if (!row) return null;
    return parseJson(row.stateJson);
  }

  private async upsertRow(state: SwarmStackState): Promise<void> {
    const existing = await this.db.query.swarmStacks.findFirst({
      where: eq(swarmStacks.name, state.name),
    });
    if (existing) {
      await this.db
        .update(swarmStacks)
        .set({
          stateJson: JSON.stringify(state),
          lastAppliedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(swarmStacks.id, existing.id));
    } else {
      await this.db.insert(swarmStacks).values({
        name: state.name,
        stateJson: JSON.stringify(state),
      });
    }
  }
}

function assertStackName(name: string): void {
  if (!STACK_NAME_RE.test(name)) throw new Error(`Invalid stack name "${name}"`);
}

/**
 * Run the apply. `--detach=false` waits for convergence (Docker ≥ 26); an
 * older CLI that does not know the flag gets the same apply without it, and
 * the caller's convergence poll does the waiting. Output goes to `log` (it
 * names services and tasks, never env values: those are in the env file).
 */
async function applyStack(stack: StackSpec, file: string, timeoutMs: number, log: (line: string) => void): Promise<void> {
  const lines: string[] = [];
  const sink = (line: string) => {
    lines.push(line);
    log(line);
  };
  try {
    await run('docker', stackDeployArgs(stack, file, { detach: false }), { timeoutMs, heartbeatMs: 30_000, heartbeatLabel: `swarm stack deploy ${stack.name}` }, sink);
  } catch (err) {
    if (!lines.some((l) => /unknown flag: --detach/.test(l)) && !/unknown flag: --detach/.test(msg(err))) {
      throw new Error(`docker stack deploy ${stack.name} failed: ${lines.slice(-5).join(' ').slice(-800) || msg(err)}`);
    }
    log('this Docker CLI has no `stack deploy --detach`; applying without waiting, then polling for convergence');
    await run('docker', stackDeployArgs(stack, file), { timeoutMs, heartbeatMs: 30_000, heartbeatLabel: `swarm stack deploy ${stack.name}` }, log);
  }
}

/**
 * Every overlay NineDeploy creates carries an IPsec-encrypted data plane:
 * Swarm nodes are usually separate hosts, often across the public internet,
 * and task-to-task (and Traefik-to-task) traffic must not cross it in clear.
 * There is no switch to turn it off. Nodes must allow ESP (IP protocol 50)
 * between each other; encrypted overlays do not work on Windows nodes.
 */
export const ENCRYPTED_OVERLAY_ARGS = ['--driver', 'overlay', '--opt', 'encrypted'] as const;

/** `missing`, or whether an existing network carries the `encrypted` option (whose value is empty when set). */
export async function overlayNetworkState(name: string): Promise<'missing' | 'encrypted' | 'unencrypted'> {
  let raw: string;
  try {
    raw = await capture('docker', ['network', 'inspect', '--format', '{{json .Options}}', name], { timeoutMs: READ_TIMEOUT_MS });
  } catch {
    return 'missing';
  }
  try {
    const options = JSON.parse(raw.trim() || 'null') as Record<string, string> | null;
    return options && Object.hasOwn(options, 'encrypted') ? 'encrypted' : 'unencrypted';
  } catch {
    return 'unencrypted';
  }
}

/**
 * Create the encrypted overlay unless it exists; a create that fails is
 * re-checked (a concurrent create won the race), never swallowed. An existing
 * overlay WITHOUT encryption is reported on `log` and reused — recreating it
 * would cut every running task off the network — so the operator can move the
 * service off it deliberately.
 */
export async function ensureEncryptedOverlay(name: string, attachable: boolean, log: (line: string) => void): Promise<void> {
  const state = await overlayNetworkState(name);
  if (state === 'unencrypted') {
    log(
      `⚠ The overlay network ${name} exists WITHOUT data-plane encryption; its traffic between nodes is not encrypted. ` +
        'NineDeploy does not recreate it (that would disconnect the running tasks): remove the stack and the network during a maintenance window, then redeploy to get an encrypted one.',
    );
    return;
  }
  if (state === 'encrypted') return;
  log(`creating the encrypted overlay network ${name}`);
  try {
    await run(
      'docker',
      ['network', 'create', ...ENCRYPTED_OVERLAY_ARGS, attachable ? '--attachable' : '--attachable=false', name],
      { timeoutMs: READ_TIMEOUT_MS, heartbeatMs: 20_000, heartbeatLabel: `swarm network ${name}` },
      log,
    );
  } catch (err) {
    if ((await overlayNetworkState(name)) === 'missing') {
      throw new Error(
        `Could not create the encrypted overlay network ${name}: ${msg(err)} (encrypted overlays need IPsec — ESP, IP protocol 50 — between the nodes, and do not work on Windows nodes)`,
      );
    }
  }
}

/** One stack network: overlays are always encrypted; anything else (never used for a Swarm stack) is created as asked. */
async function ensureNetwork(name: string, driver: string, attachable: boolean, log: (line: string) => void): Promise<void> {
  if (driver === 'overlay') return ensureEncryptedOverlay(name, attachable, log);
  const exists = async () =>
    capture('docker', ['network', 'inspect', '--format', '{{.Name}}', name], { timeoutMs: READ_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);
  if (await exists()) return;
  try {
    await run('docker', ['network', 'create', '--driver', driver, attachable ? '--attachable' : '--attachable=false', name], { timeoutMs: READ_TIMEOUT_MS }, log);
  } catch (err) {
    if (!(await exists())) throw new Error(`Could not create the ${driver} network ${name}: ${msg(err)}`);
  }
}

/** Create `<name>-<sha8>` from a 0600 temp file unless it exists; returns the object name (D7e). */
async function ensureObject(kind: 'secret' | 'config', stack: string, name: string, data: string, dir: string): Promise<string> {
  const objectName = hashedObjectName(name, data);
  const present = await capture('docker', [kind, 'inspect', '--format', '{{.ID}}', objectName], { timeoutMs: READ_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);
  if (present) return objectName;
  const tmp = join(dir, `${objectName}.${kind}.tmp`);
  writeFileSync(tmp, data, { mode: 0o600 });
  try {
    await run('docker', [kind, 'create', '--label', `${STACK_LABEL}=${stack}`, objectName, tmp], { timeoutMs: READ_TIMEOUT_MS }, () => undefined);
  } finally {
    rmSync(tmp, { force: true });
  }
  return objectName;
}

async function listOwnedObjects(kind: 'secret' | 'config', stack: string): Promise<string[]> {
  const out = await capture('docker', [kind, 'ls', '--filter', `label=${STACK_LABEL}=${stack}`, '--format', '{{.Name}}'], { timeoutMs: READ_TIMEOUT_MS }).catch(
    () => '',
  );
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Remove this stack's superseded objects; one still in use is refused by Docker and kept. */
async function pruneObjects(kind: 'secret' | 'config', stack: string, keep: ReadonlySet<string>): Promise<void> {
  for (const obj of await listOwnedObjects(kind, stack)) {
    if (keep.has(obj)) continue;
    await run('docker', [kind, 'rm', obj], { timeoutMs: READ_TIMEOUT_MS }, () => undefined).catch(() => undefined);
  }
}

/** `<service> → {running, desired}` from `docker stack services`, or null when it cannot be read. */
async function stackServiceCounts(stack: string): Promise<Map<string, { running: number; desired: number }> | null> {
  let out: string;
  try {
    out = await capture('docker', ['stack', 'services', stack, '--format', '{{.Name}} {{.Replicas}}'], { timeoutMs: READ_TIMEOUT_MS });
  } catch {
    return null;
  }
  const counts = new Map<string, { running: number; desired: number }>();
  for (const line of out.split('\n')) {
    const [svc, replicas] = line.trim().split(/\s+/);
    const m = /^(\d+)\/(\d+)/.exec(replicas ?? '');
    if (svc && m) counts.set(svc, { running: Number(m[1]), desired: Number(m[2]) });
  }
  return counts;
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}
