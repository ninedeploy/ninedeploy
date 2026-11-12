import type { DB } from '@ninedeploy/db';
import { capture } from './exec.js';
import { localSwarmTaskFor, serverForSwarmNode } from './swarm.js';
import { nodeContainerTool } from './nodeContainerTools.js';

/**
 * P1 (docs/plans/COMPETITIVE_ROADMAP_2026-11.md): the container of one replica
 * of a Swarm service, wherever it runs, for a terminal, inspect and files.
 *
 * A task on the panel host resolves exactly as before (localSwarmTaskFor). A
 * task elsewhere is found through the manager — its node, state and container
 * id — and reached through the NineDeploy agent of that node, never by a name
 * the panel builds: the worker inspects the container by its id and must
 * report this task's and this service's Swarm labels, and the name it reports
 * is what the terminal or file tool then uses. A task that moves gets a new
 * task id and container, so nothing pinned to the old one reaches it.
 *
 * Deploys' one-off commands and jobs keep localSwarmTaskFor (panel host only).
 */

export type SwarmTaskTarget =
  | { where: 'local'; container: string }
  | { where: 'node'; serverId: number; nodeName: string; container: string; containerId: string; taskId: string }
  | { refusal: string };

const RE_TASK_ID = /^[a-z0-9]{25}$/;
const RE_NODE_ID = /^[a-z0-9]{25}$/;
const RE_CONTAINER_ID = /^[a-f0-9]{64}$/;

export interface SwarmTaskDeps {
  docker?: (args: string[]) => Promise<string>;
  local?: typeof localSwarmTaskFor;
  nodeTool?: typeof nodeContainerTool;
  serverFor?: typeof serverForSwarmNode;
}

export async function swarmTaskTarget(db: DB, runtimeId: string, replica = 1, deps: SwarmTaskDeps = {}): Promise<SwarmTaskTarget> {
  const local = await (deps.local ?? localSwarmTaskFor)(runtimeId, replica);
  if ('container' in local) return { where: 'local', container: local.container };
  const docker = deps.docker ?? ((args: string[]) => capture('docker', args, { timeoutMs: 15_000 }));

  // The running task of this slot, as the manager knows it.
  const listed = await docker(['service', 'ps', '--filter', 'desired-state=running', '--no-trunc', '--format', '{{.ID}} {{.Name}}', runtimeId]).catch(() => '');
  const tasks = listed.split('\n').map((l) => l.trim().split(/\s+/)).filter(([id, name]) => id && RE_TASK_ID.test(id) && name?.startsWith(`${runtimeId}.`));
  const task = tasks.find(([, name]) => name === `${runtimeId}.${replica}`) ?? (replica === 1 ? tasks[0] : undefined);
  if (!task) return { refusal: `No running replica ${replica} of this Swarm service was found.` };
  const taskId = task[0]!;
  const raw = await docker(['inspect', '--type', 'task', '--format', '{{.NodeID}}|{{.Status.State}}|{{.Status.ContainerStatus.ContainerID}}', taskId]).catch(() => '');
  const [nodeId = '', state = '', containerId = ''] = raw.trim().split('|');
  if (!RE_NODE_ID.test(nodeId)) return { refusal: `Where replica ${replica} of this Swarm service runs could not be confirmed.` };
  if (state !== 'running' || !RE_CONTAINER_ID.test(containerId)) return { refusal: `Replica ${replica} of this Swarm service is not running (${state || 'unknown state'}).` };

  const server = await (deps.serverFor ?? serverForSwarmNode)(db, nodeId);
  if (!server) {
    return { refusal: `Replica ${replica} of this Swarm service runs on a Swarm node that is not enrolled in NineDeploy (node ${nodeId.slice(0, 12)}), so the panel cannot reach it.` };
  }
  // Identity on the worker, by the container id the manager reported.
  const seen = await (deps.nodeTool ?? nodeContainerTool)(db, server.id, containerId, 'inspect');
  const labels = seen.labels ?? {};
  if (seen.id !== containerId || labels['com.docker.swarm.task.id'] !== taskId || labels['com.docker.swarm.service.name'] !== runtimeId) {
    return { refusal: `The container of replica ${replica} on node ${server.name} does not carry this task's identity; it was not opened.` };
  }
  if (!seen.state?.running) return { refusal: `Replica ${replica} of this Swarm service is not running on node ${server.name}.` };
  return { where: 'node', serverId: server.id, nodeName: server.name, container: seen.name, containerId, taskId };
}
