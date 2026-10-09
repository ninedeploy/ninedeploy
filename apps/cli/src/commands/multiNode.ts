import { AGENT_SWARM_MANAGER_VAR, type ImageTransfer, type ServicePlacementInput, type ServicePlacementView, type SwarmStatus } from '@ninedeploy/sdk';
import type { NineDeployClient } from '../client.js';
import { prompt, promptHidden } from '../prompts.js';
import { c, error, fmtBytes, fmtTime, header, info, kv, spinner, success, table } from '../lib/format.js';
import { plain } from './sources.js';

/**
 * 0.16 T8: multi-node surfaces (the routes shipped in 0.15.2-0.15.4).
 *
 *   ninedeploy servers list | roles <id> [--build-server on|off] [--build-concurrency <n>]
 *   ninedeploy services placement <id> [--build-on target|panel|server] [--build-server <id|none>]
 *                                      [--push-registry <sourceId|none> --push-repo <repo>] [--orchestrator container|swarm]
 *   ninedeploy services transfers <id> [--limit <n>] | swarm <id>
 *   ninedeploy swarm status | init --advertise-addr <ip> | enable | disable | join <serverId> | leave <serverId> [-y]
 *   ninedeploy volumes create <name> [--server <id>]   (list and rm take --server too)
 *   ninedeploy sources allow-on-nodes <id> on|off
 *
 * Every route here is operator only except the service reads. Step-up
 * passwords (swarm init, swarm enable, allow-on-nodes on) are read with a
 * hidden prompt, never from argv. Server-provided strings go through the
 * F1011 sanitiser.
 */

const message = (err: unknown): string => plain(err instanceof Error ? err.message : String(err));
const codeOf = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};

/** F537: canonical decimal ids only (`0x10`, `1e1` and `""` are refused, never reinterpreted). */
function positiveInt(raw: string | undefined, what: string): number | null {
  const n = raw !== undefined && /^[1-9]\d*$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n)) {
    error(`${what} must be a positive integer`);
    return null;
  }
  return n;
}

/** `on` / `off` (also true/false, yes/no); null after printing the usage error. */
function onOff(raw: string | undefined, what: string): boolean | null {
  const v = raw?.trim().toLowerCase();
  if (v === 'on' || v === 'true' || v === 'yes') return true;
  if (v === 'off' || v === 'false' || v === 'no') return false;
  error(`${what} must be on or off`);
  return null;
}

function warn(warnings: readonly string[] | undefined): void {
  for (const w of warnings ?? []) console.log(`  ${c.yellow('!')} ${c.yellow(plain(w))}`);
}

/** Step-up for a sensitive change: an empty answer leaves it to a recent sign-in (SSO-only accounts). */
async function stepUpPassword(): Promise<string | undefined> {
  return (await promptHidden('Your password (step-up re-check)')) || undefined;
}

// ── servers ───────────────────────────────────────────────────────────────

/** `ninedeploy servers list` */
export async function serversList(client: NineDeployClient): Promise<void> {
  try {
    const rows = await spinner('Loading servers', () => client.servers.list());
    header('Servers');
    if (rows.length === 0) return info('No servers registered. Add one in the panel (Servers) or with the bootstrap script.');
    table(
      rows.map((s) => ({
        id: s.id,
        name: plain(s.name),
        host: `${plain(s.host)}:${s.port}`,
        status: s.status,
        agent: s.agent?.version ? plain(s.agent.version) : c.gray('—'),
        build: s.isBuildServer ? `on (${s.buildConcurrency ?? 1})` : c.gray('off'),
        databases: s.databases ?? 0,
        swarm: s.swarmNodeId ? (s.swarmRole ?? 'member') : c.gray('—'),
      })),
      ['id', 'name', 'host', 'status', 'agent', 'build', 'databases', 'swarm'],
    );
    for (const s of rows) {
      if (s.features?.reason) info(`${plain(s.name)}: ${plain(s.features.reason)}`);
    }
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy servers roles <id> [--build-server on|off] [--build-concurrency <n>]` */
export async function serversRoles(client: NineDeployClient, idRaw: string, opts: { buildServer?: string; buildConcurrency?: string } = {}): Promise<void> {
  const id = positiveInt(idRaw, 'Server id');
  if (id === null) return;
  if (opts.buildServer === undefined && opts.buildConcurrency === undefined) {
    return error('Usage: ninedeploy servers roles <id> [--build-server on|off] [--build-concurrency 1-8]');
  }
  const isBuildServer = opts.buildServer === undefined ? undefined : onOff(opts.buildServer, '--build-server');
  if (isBuildServer === null) return;
  let buildConcurrency: number | undefined;
  if (opts.buildConcurrency !== undefined) {
    const n = /^[1-8]$/.test(opts.buildConcurrency) ? Number(opts.buildConcurrency) : Number.NaN;
    if (Number.isNaN(n)) return error('--build-concurrency must be an integer from 1 to 8');
    buildConcurrency = n;
  }
  try {
    const res = await spinner('Saving the role', () =>
      client.servers.update(id, { ...(isBuildServer !== undefined ? { isBuildServer } : {}), ...(buildConcurrency !== undefined ? { buildConcurrency } : {}) }),
    );
    success(`${plain(res.name)}: build server ${res.isBuildServer ? `on (concurrency ${res.buildConcurrency})` : 'off'}`);
    if (!res.isBuildServer && res.buildServiceIds.length > 0) {
      info(`Services still set to build here fail their next deploy until moved: ${res.buildServiceIds.join(', ')}`);
    }
  } catch (err) {
    error(message(err));
  }
}

// ── services: placement, transfers, swarm tasks ──────────────────────────

export interface PlacementOptions {
  buildOn?: string;
  buildServer?: string;
  pushRegistry?: string;
  pushRepo?: string;
  orchestrator?: string;
}

const BUILD_ON = ['target', 'panel', 'server'] as const;
const ORCHESTRATORS = ['container', 'swarm'] as const;

function printPlacement(p: ServicePlacementView): void {
  kv('Build on', p.buildOn ?? 'target (default)');
  kv('Build server', p.buildServerId === null ? null : `#${p.buildServerId}`);
  kv('Push registry', p.pushRegistrySourceId === null ? 'none (stream relay)' : `source #${p.pushRegistrySourceId} → ${plain(p.pushRepository)}`);
  kv('Orchestrator', p.orchestrator ?? 'container (default)');
}

/** The PUT body from the flags; null after printing the error. */
export function placementInput(opts: PlacementOptions): ServicePlacementInput | null {
  const input: ServicePlacementInput = {};
  if (opts.buildOn !== undefined) {
    if (!(BUILD_ON as readonly string[]).includes(opts.buildOn)) {
      error(`--build-on must be one of ${BUILD_ON.join(', ')}`);
      return null;
    }
    input.buildOn = opts.buildOn as ServicePlacementInput['buildOn'];
  }
  if (opts.buildServer !== undefined) {
    if (opts.buildServer === 'none') input.buildServerId = null;
    else {
      const id = positiveInt(opts.buildServer, '--build-server');
      if (id === null) return null;
      input.buildServerId = id;
    }
  }
  if (opts.pushRegistry !== undefined) {
    if (opts.pushRegistry === 'none') {
      input.pushRegistrySourceId = null;
      input.pushRepository = null;
    } else {
      const id = positiveInt(opts.pushRegistry, '--push-registry');
      if (id === null) return null;
      if (!opts.pushRepo) {
        error('--push-registry needs --push-repo <repository> (for example team/app)');
        return null;
      }
      input.pushRegistrySourceId = id;
      input.pushRepository = opts.pushRepo;
    }
  } else if (opts.pushRepo !== undefined) {
    error('--push-repo needs --push-registry <sourceId>');
    return null;
  }
  if (opts.orchestrator !== undefined) {
    if (!(ORCHESTRATORS as readonly string[]).includes(opts.orchestrator)) {
      error(`--orchestrator must be one of ${ORCHESTRATORS.join(', ')}`);
      return null;
    }
    input.orchestrator = opts.orchestrator as ServicePlacementInput['orchestrator'];
  }
  return input;
}

/** `ninedeploy services placement <id> [flags]`: show, or (operator) change, the build placement. */
export async function servicesPlacement(client: NineDeployClient, idRaw: string, opts: PlacementOptions = {}): Promise<void> {
  const id = positiveInt(idRaw, 'Service id');
  if (id === null) return;
  const input = placementInput(opts);
  if (input === null) return;
  try {
    if (Object.keys(input).length === 0) {
      const view = await spinner('Loading the placement', () => client.services.placement.get(id));
      header(`Service #${id} placement`);
      printPlacement(view);
      return;
    }
    const view = await spinner('Saving the placement', () => client.services.placement.set(id, input));
    success(`Placement of service #${id} saved; the next deploy uses it.`);
    printPlacement(view);
  } catch (err) {
    error(message(err));
  }
}

function transferHost(id: number | null): string {
  return id === null ? 'panel' : `#${id}`;
}

/** `ninedeploy services transfers <id> [--limit <n>]` */
export async function servicesTransfers(client: NineDeployClient, idRaw: string, opts: { limit?: string } = {}): Promise<void> {
  const id = positiveInt(idRaw, 'Service id');
  if (id === null) return;
  let limit: number | undefined;
  if (opts.limit !== undefined) {
    const n = /^[1-9]\d{0,2}$/.test(opts.limit) ? Number(opts.limit) : Number.NaN;
    if (Number.isNaN(n) || n > 100) return error('--limit must be an integer from 1 to 100');
    limit = n;
  }
  try {
    const rows: ImageTransfer[] = await spinner('Loading image transfers', () => client.services.imageTransfers(id, limit === undefined ? undefined : { limit }));
    header(`Image transfers of service #${id}`);
    if (rows.length === 0) return info('No image transfers yet: the service builds where it runs.');
    table(
      rows.map((t) => ({
        id: t.id,
        deploy: t.deploymentId ?? '—',
        method: t.method,
        route: `${transferHost(t.sourceServerId)} → ${transferHost(t.targetServerId)}`,
        size: fmtBytes(t.bytes),
        time: t.durationMs === null ? '—' : `${(t.durationMs / 1000).toFixed(1)}s`,
        status: t.status,
        started: fmtTime(t.startedAt),
        error: t.error ? plain(t.error).slice(0, 80) : '',
      })),
      ['id', 'deploy', 'method', 'route', 'size', 'time', 'status', 'started', 'error'],
    );
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy services swarm <id>` */
export async function servicesSwarm(client: NineDeployClient, idRaw: string): Promise<void> {
  const id = positiveInt(idRaw, 'Service id');
  if (id === null) return;
  try {
    const view = await spinner('Loading Swarm tasks', () => client.services.swarm(id));
    header(`Service #${id} on Swarm`);
    if (view.stack === null) return info('Not on Swarm (or not deployed yet). Switch with: ninedeploy services placement <id> --orchestrator swarm');
    kv('Stack', plain(view.stack));
    kv('Replicas', `${view.running} running / ${view.desired} desired`);
    table(
      view.tasks.map((t) => ({ node: plain(t.node), status: plain(t.state), image: plain(t.image), error: t.error ? plain(t.error) : '' })),
      ['node', 'status', 'image', 'error'],
    );
  } catch (err) {
    error(message(err));
  }
}

// ── swarm ─────────────────────────────────────────────────────────────────

function printSwarm(s: SwarmStatus): void {
  kv('Swarm deploys', s.enabled ? c.green('enabled') : 'disabled');
  kv('Panel host', plain(s.localState));
  kv('Manager', s.controlAvailable ? 'yes' : 'no');
  kv('Join address', s.managerAddr === null ? null : plain(s.managerAddr));
  if (s.nodes.length > 0) {
    console.log();
    table(
      s.nodes.map((n) => ({
        id: plain(n.id).slice(0, 12),
        hostname: plain(n.hostname),
        role: n.role,
        availability: plain(n.availability),
        status: plain(n.state),
        server: n.serverId === null ? c.gray('—') : `#${n.serverId}`,
      })),
      ['id', 'hostname', 'role', 'availability', 'status', 'server'],
    );
    for (const n of s.nodes) warn(n.warnings);
  }
  warn(s.warnings);
}

/** `ninedeploy swarm status` */
export async function swarmStatus(client: NineDeployClient): Promise<void> {
  try {
    const s = await spinner('Loading Swarm status', () => client.swarm.get());
    header('Swarm');
    printSwarm(s);
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy swarm init --advertise-addr <ip>`: asks for the password (step-up). */
export async function swarmInit(client: NineDeployClient, opts: { advertiseAddr?: string } = {}): Promise<void> {
  const advertiseAddr = opts.advertiseAddr?.trim();
  if (!advertiseAddr) return error('Usage: ninedeploy swarm init --advertise-addr <ip> (the address the nodes reach the panel host on)');
  const password = await stepUpPassword();
  try {
    const s = await spinner('Initialising Swarm on the panel host', () => client.swarm.init({ advertiseAddr, ...(password ? { password } : {}) }));
    success('Swarm initialised on the panel host. Enable Swarm deploys with: ninedeploy swarm enable');
    printSwarm(s);
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy swarm enable|disable`: enabling asks for the password (step-up). */
export async function swarmSetEnabled(client: NineDeployClient, enabled: boolean): Promise<void> {
  const password = enabled ? await stepUpPassword() : undefined;
  try {
    const s = await spinner(enabled ? 'Enabling Swarm deploys' : 'Disabling Swarm deploys', () =>
      client.swarm.settings({ enabled, ...(password ? { password } : {}) }),
    );
    success(enabled ? 'Swarm deploys enabled.' : 'Swarm deploys disabled; running stacks keep running.');
    printSwarm(s);
  } catch (err) {
    error(message(err));
  }
}

/** `ninedeploy swarm join <serverId>` */
export async function swarmJoin(client: NineDeployClient, idRaw: string): Promise<void> {
  const id = positiveInt(idRaw, 'Server id');
  if (id === null) return;
  try {
    const res = await spinner(`Joining server #${id} to the swarm`, () => client.servers.swarmJoin(id));
    success(`Server #${res.serverId} joined the swarm as a ${res.role} (node ${plain(res.nodeId).slice(0, 12)}).`);
    warn(res.warnings);
  } catch (err) {
    error(message(err));
    if (codeOf(err) === 'node_swarm_not_enabled') {
      info(`Swarm membership is opt-in on the node: set ${AGENT_SWARM_MANAGER_VAR}=<panel advertise address>:2377 in the agent's environment, restart the agent, and run this again.`);
    }
  }
}

/** `ninedeploy swarm leave <serverId> [-y]`: drains the node first (up to 5 minutes). */
export async function swarmLeave(client: NineDeployClient, idRaw: string, opts: { yes?: boolean } = {}): Promise<void> {
  const id = positiveInt(idRaw, 'Server id');
  if (id === null) return;
  if (!opts.yes) {
    const answer = await prompt(`Drain server #${id} and take it out of the swarm? Its Swarm tasks move to other nodes. Type "yes" to confirm`);
    if (answer.trim().toLowerCase() !== 'yes') return info('Cancelled');
  }
  try {
    const res = await spinner(`Draining server #${id} and leaving the swarm`, () => client.servers.swarmLeave(id));
    success(`Server #${res.serverId} left the swarm.`);
    if (!res.drained) info('Its tasks had not moved within 5 minutes; Swarm reschedules them on the remaining nodes.');
    warn(res.warnings);
  } catch (err) {
    error(message(err));
  }
}

// ── volumes on a node ─────────────────────────────────────────────────────

/** The `--server <id>` of the volume commands; undefined = the panel host, null = invalid (error printed). */
export function serverOption(raw: string | undefined): number | undefined | null {
  return raw === undefined ? undefined : positiveInt(raw, '--server');
}

/** `ninedeploy volumes create <name> [--server <id>]` */
export async function volumesCreate(client: NineDeployClient, name: string, opts: { server?: string } = {}): Promise<void> {
  if (!name) return error('Usage: ninedeploy volumes create <nd-svc-…|nd-db-…> [--server <id>]');
  const serverId = serverOption(opts.server);
  if (serverId === null) return;
  try {
    const res = await spinner('Creating the volume', () => client.volumes.create({ name, ...(serverId !== undefined ? { serverId } : {}) }));
    success(`Volume ${c.cyan(plain(res.name))} created on ${res.serverId === null ? 'the panel host' : `server #${res.serverId}`}.`);
  } catch (err) {
    error(message(err));
  }
}

// ── sources on nodes ─────────────────────────────────────────────────────

/** `ninedeploy sources allow-on-nodes <id> on|off`: turning it on asks for the password (step-up). */
export async function sourcesAllowOnNodes(client: NineDeployClient, idRaw: string, value: string): Promise<void> {
  const id = positiveInt(idRaw, 'Source id');
  if (id === null) return;
  const allow = onOff(value, 'The setting');
  if (allow === null) return;
  if (allow) info('The PAT or deploy key will be sent (sealed) to a node for each clone there. A node refuses it with NINEDEPLOY_AGENT_STATIC_CREDENTIALS=off.');
  const password = allow ? await stepUpPassword() : undefined;
  try {
    const src = await spinner('Saving', () => client.sources.update(id, { allowOnNodes: allow, ...(password ? { password } : {}) }));
    success(`${plain(src.name)}: ${allow ? 'allowed on nodes' : 'panel host only'}`);
  } catch (err) {
    error(message(err));
  }
}
