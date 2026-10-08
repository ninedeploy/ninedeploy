import { eq } from 'drizzle-orm';
import { servers, type DB } from '@ninedeploy/db';
import { agentOp } from './agentClient.js';

/**
 * r660/r662: what the panel asks of a node's agent beyond the original op
 * table — whether it can build safely, and removing a service's checkout.
 * Policy on top of the transport in agentClient.ts: the build gate runs
 * through whichever caller the builder was given, so it sees exactly the node
 * the build is about to run on.
 */

/** A typed-op caller bound to one node (the builders' and fan-out's `agent`). */
export type AgentCaller = (
  op: string,
  params: Record<string, unknown>,
  sink: (line: string) => void,
) => Promise<{ exitCode: number; lines: string[] }>;

/**
 * r660: how a refusal names a node — `"edge-1" (#4)`. Cosmetic, so a failed
 * lookup degrades to the id instead of failing the deployment.
 */
export async function nodeLabel(db: DB, serverId: number): Promise<string> {
  try {
    const node = await db.query.servers.findFirst({ where: eq(servers.id, serverId) });
    return node ? `"${node.name}" (#${serverId})` : `#${serverId}`;
  } catch {
    return `#${serverId}`;
  }
}

/** r660: the first agent release whose node-side builds refuse symlinked repository paths. */
export const AGENT_BUILD_PATH_GUARD_VERSION = '0.10.42';

/**
 * r660: what an agent reports about itself inside the SEALED `agent.ping`
 * answer (`ND-AGENT {"version","caps"}`). Agents older than
 * {@link AGENT_BUILD_PATH_GUARD_VERSION} answer the ping with no lines, which
 * reads as "no version, no capabilities".
 */
export function parseAgentCapabilities(lines: string[]): { version: string | null; caps: ReadonlySet<string> } {
  for (const line of lines) {
    if (!line.startsWith('ND-AGENT ')) continue;
    try {
      const info = JSON.parse(line.slice('ND-AGENT '.length)) as { version?: unknown; caps?: unknown };
      return {
        version: typeof info.version === 'string' ? info.version : null,
        caps: new Set(Array.isArray(info.caps) ? info.caps.filter((c): c is string => typeof c === 'string') : []),
      };
    } catch {
      break;
    }
  }
  return { version: null, caps: new Set() };
}

/**
 * r660: refuse a SOURCE build on a node whose agent cannot refuse a symlinked
 * build path. An older agent runs `docker build` (as root, in a work root
 * every tenant on the node shares) on whatever context/Dockerfile the
 * repository's symlinks point at, so the panel must not ask it to. Image
 * deploys never take this path and keep working on any agent. The answer is
 * asked for on every source build — agents are updated separately from the
 * panel, so a cached answer could outlive an update either way.
 */
export async function assertAgentGuardsBuildPaths(agent: AgentCaller, nodeLabel: string): Promise<void> {
  let lines: string[];
  try {
    ({ lines } = await agent('agent.ping', {}, () => undefined));
  } catch (err) {
    throw new Error(
      `Could not confirm that the agent on node ${nodeLabel} can build safely: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const { version, caps } = parseAgentCapabilities(lines);
  if (caps.has('build-path-guard')) return;
  throw new Error(
    `The agent on node ${nodeLabel} (${version ? `version ${version}` : 'a release older than 0.10.42'}) cannot refuse ` +
      `symlinked build paths, so source builds on it are blocked. Update the node's agent to ` +
      `v${AGENT_BUILD_PATH_GUARD_VERSION} or newer (re-run the node's bootstrap from the Servers page, or pull and ` +
      'restart the matching ninedeploy agent image on the node). Image deployments to this node keep working.',
  );
}

/** 0.13 (T5): the capability an agent advertises when its git ops accept a per-job credential. */
export const AGENT_CAP_GIT_CREDENTIAL = 'git.credential';
/** 0.13 (T5): the first agent release that advertises {@link AGENT_CAP_GIT_CREDENTIAL}. */
export const AGENT_GIT_CREDENTIAL_VERSION = '0.13.0';

/** 0.13 (T5): whether a parsed `agent.ping` answer advertises the per-job Git credential. */
export function agentAcceptsGitCredential(info: { caps: ReadonlySet<string> }): boolean {
  return info.caps.has(AGENT_CAP_GIT_CREDENTIAL);
}

/**
 * 0.13 (T5): why this node cannot be handed a per-job GitHub App token, or
 * null when it can. Both must hold: the agent advertises `git.credential`
 * inside its SEALED `agent.ping` answer, and the panel reaches it over the
 * sealed transport (`sealed`, from `agentTransportSealed`). An older agent
 * ignores an operand it does not know and would clone anonymously, so a
 * missing capability is a refusal — never a send. Asked on every job: agents
 * are updated separately from the panel.
 */
export async function gitCredentialRefusal(agent: AgentCaller, nodeLabel: string, sealed: boolean): Promise<string | null> {
  const update =
    `Update the node agent to use GitHub App repositories on this node (v${AGENT_GIT_CREDENTIAL_VERSION} or newer: ` +
    "re-run the node's bootstrap from the Servers page, or pull and restart the matching ninedeploy agent image on the node).";
  if (!sealed) {
    return (
      `The panel reaches the agent on node ${nodeLabel} only over the unencrypted transport, and a GitHub App token is ` +
      `never sent in clear, so this repository cannot be cloned there. ${update}`
    );
  }
  let lines: string[];
  try {
    ({ lines } = await agent('agent.ping', {}, () => undefined));
  } catch (err) {
    return `Could not confirm that the agent on node ${nodeLabel} can receive a GitHub App token: ${err instanceof Error ? err.message : String(err)}`;
  }
  const info = parseAgentCapabilities(lines);
  if (agentAcceptsGitCredential(info)) return null;
  return (
    `The agent on node ${nodeLabel} (${info.version ? `version ${info.version}` : 'an older release'}) cannot receive a ` +
    `per-job GitHub App token, so this repository cannot be cloned there. ${update}`
  );
}

/**
 * r662: delete a service's checkout (`.agent-work/<slug>`) on a node it no
 * longer runs on — after a delete, a move away, or a fan-out target removal.
 * Nothing used to, so every service ever built on a node left its source and
 * build context there. Best effort and never throwing: an agent older than
 * the op answers `unknown_op`, which is logged as "update the agent" — the
 * caller's own change has already happened and must not be undone by this.
 */
export async function removeNodeWorkspace(
  db: DB,
  serverId: number,
  workspace: string,
  log: (line: string) => void,
): Promise<void> {
  try {
    await agentOp(db, serverId, 'workspace.remove', { workspace }, () => undefined);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(
      message.includes('unknown_op')
        ? `node #${serverId}: its agent predates workspace removal — .agent-work/${workspace} stays on the node until the agent is updated to v${AGENT_BUILD_PATH_GUARD_VERSION}+`
        : `node #${serverId}: could not remove the workspace .agent-work/${workspace}: ${message}`,
    );
  }
}

// ── 0.15 (T2b): node terminals ──────────────────────────────────────────────

/** 0.15: the capability an agent advertises when it serves `terminal.open` and `/agent/terminal`. */
export const AGENT_CAP_TERMINAL = 'terminal';
/** 0.15: advertised next to it while the node allows host shells (no `NINEDEPLOY_AGENT_HOST_TERMINAL=off`). */
export const AGENT_CAP_TERMINAL_HOST = 'terminal.host';
/** 0.15: the first agent release that advertises {@link AGENT_CAP_TERMINAL}. */
export const AGENT_TERMINAL_VERSION = '0.15.0';

/** Why a node terminal cannot be opened: the HTTP status and code the terminals route answers. */
export interface TerminalRefusal {
  status: number;
  code: 'node_terminal_unsupported' | 'node_unreachable' | 'host_terminal_disabled';
  message: string;
}

/** What a node's agent offers terminals, as `GET /v1/servers` reports it (additive field). */
export interface NodeTerminalCapability {
  host: boolean;
  container: boolean;
  reason?: string;
}

const terminalUpdateHint =
  `Update the node agent to v${AGENT_TERMINAL_VERSION} or newer for terminals on this node ` +
  "(re-run the node's bootstrap from the Servers page, or pull and restart the matching ninedeploy agent image on the node).";

/** The `GET /v1/servers` view of a parsed `agent.ping` answer. */
export function terminalCapabilityView(info: { version: string | null; caps: ReadonlySet<string> }): NodeTerminalCapability {
  if (!info.caps.has(AGENT_CAP_TERMINAL)) {
    return {
      host: false,
      container: false,
      reason: `The agent (${info.version ? `version ${info.version}` : 'an older release'}) has no terminal support. ${terminalUpdateHint}`,
    };
  }
  if (!info.caps.has(AGENT_CAP_TERMINAL_HOST)) {
    return { host: false, container: true, reason: 'Host shells are disabled on this node (NINEDEPLOY_AGENT_HOST_TERMINAL=off on the agent).' };
  }
  return { host: true, container: true };
}

/**
 * 0.15: why a terminal cannot be opened on this node, or null when it can —
 * modelled on {@link gitCredentialRefusal}. All must hold: the panel reaches
 * the agent over the SEALED transport (the channel key's salt travels in the
 * sealed reply, and terminal bytes never cross the network in clear), the
 * agent advertises `terminal` inside its sealed `agent.ping`, and for a host
 * shell also `terminal.host`. Asked on every session: agents are updated
 * separately from the panel. The answer refreshes the `GET /v1/servers` cache.
 */
export async function terminalRefusal(
  agent: AgentCaller,
  nodeLabel: string,
  sealed: boolean,
  opts: { host: boolean; serverId?: number },
): Promise<TerminalRefusal | null> {
  if (!sealed) {
    return {
      status: 422,
      code: 'node_terminal_unsupported',
      message:
        `The panel reaches the agent on node ${nodeLabel} only over the unencrypted transport, and a terminal is never ` +
        `opened in clear. ${terminalUpdateHint}`,
    };
  }
  let lines: string[];
  try {
    ({ lines } = await agent('agent.ping', {}, () => undefined));
  } catch (err) {
    return {
      status: 502,
      code: 'node_unreachable',
      message: `Could not reach the agent on node ${nodeLabel}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const info = parseAgentCapabilities(lines);
  if (opts.serverId !== undefined) rememberNodeCapabilities(opts.serverId, info);
  if (!info.caps.has(AGENT_CAP_TERMINAL)) {
    return {
      status: 422,
      code: 'node_terminal_unsupported',
      message: `The agent on node ${nodeLabel} (${info.version ? `version ${info.version}` : 'an older release'}) cannot open terminals. ${terminalUpdateHint}`,
    };
  }
  if (opts.host && !info.caps.has(AGENT_CAP_TERMINAL_HOST)) {
    return {
      status: 403,
      code: 'host_terminal_disabled',
      message: `Host shells are disabled on node ${nodeLabel} by its owner (NINEDEPLOY_AGENT_HOST_TERMINAL=off on the agent).`,
    };
  }
  return null;
}

/** How long a node's advertised capabilities are reused by `GET /v1/servers`. */
export const NODE_CAPABILITY_TTL_MS = 5 * 60 * 1000;
/** How long `GET /v1/servers` waits for one node's refresh before answering without it. */
const NODE_CAPABILITY_WAIT_MS = 3000;

type CachedCapabilities = { at: number; info: { version: string | null; caps: ReadonlySet<string> } | null; error: string | null };
const nodeCapabilities = new Map<number, CachedCapabilities>();

function rememberNodeCapabilities(serverId: number, info: { version: string | null; caps: ReadonlySet<string> }, now = Date.now()): void {
  nodeCapabilities.set(serverId, { at: now, info, error: null });
}

/** Test hook. */
export function resetNodeCapabilityCache(): void {
  nodeCapabilities.clear();
}

/**
 * 0.15: the `terminal` field of one node in `GET /v1/servers`, from the last
 * cached sealed `agent.ping`, refreshed at most every 5 minutes (and only for
 * a node that is online — an offline one answers from the cache or says it is
 * unknown). A refresh slower than a few seconds does not hold the listing up:
 * the node then reads as unknown until it lands.
 */
export async function nodeTerminalCapability(
  db: DB,
  serverId: number,
  opts: { online: boolean; now?: number },
): Promise<NodeTerminalCapability> {
  const now = opts.now ?? Date.now();
  let cached = nodeCapabilities.get(serverId);
  if (opts.online && (!cached || now - cached.at >= NODE_CAPABILITY_TTL_MS)) {
    const refresh = (async (): Promise<CachedCapabilities> => {
      try {
        const res = await agentOp(db, serverId, 'agent.ping', {}, () => undefined);
        return { at: now, info: parseAgentCapabilities(res.lines), error: null };
      } catch (err) {
        return { at: now, info: null, error: err instanceof Error ? err.message : String(err) };
      }
    })().then((entry) => {
      nodeCapabilities.set(serverId, entry);
      return entry;
    });
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), NODE_CAPABILITY_WAIT_MS);
      timer.unref?.();
    });
    cached = (await Promise.race([refresh, late])) ?? cached;
    clearTimeout(timer);
  }
  if (cached?.info) return terminalCapabilityView(cached.info);
  return {
    host: false,
    container: false,
    reason: cached?.error ? `The node agent did not answer: ${cached.error.slice(0, 200)}` : 'The node agent has not been reached yet.',
  };
}
