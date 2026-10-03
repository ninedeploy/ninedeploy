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
