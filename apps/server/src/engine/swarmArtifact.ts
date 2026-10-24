import { isNotNull } from 'drizzle-orm';
import { type DB, servers } from '@ninedeploy/db';
import { agentOp, agentTransportSealed } from '../lib/agentClient.js';
import { capture } from '../lib/exec.js';
import { RE_SWARM_NODE_ID } from '../lib/swarm.js';
import { nodeImageInfo, panelImageInfo } from '../lib/imageTransfer.js';
import { MAX_REPLICAS } from './dockerNames.js';

export const SWARM_IMAGE_SERVICE_FORMAT = '{"id":{{json .ID}},"version":{{json .Version.Index}},"image":{{json .Spec.TaskTemplate.ContainerSpec.Image}},"service":{{json (index .Spec.Labels "ninedeploy.service")}},"deployment":{{json (index .Spec.Labels "ninedeploy.deployment")}}}';
export const SWARM_IMAGE_TASK_FORMAT = '{"id":{{json .ID}},"service":{{json .ServiceID}},"node":{{json .NodeID}},"desired":{{json .DesiredState}},"state":{{json .Status.State}},"container":{{if .Status.ContainerStatus}}{{json .Status.ContainerStatus.ContainerID}}{{else}}null{{end}}}';
const TIMEOUT_MS = 30_000;
const refused = () => new Error('Swarm task image identity is unconfirmed; the recorded artifact cannot be reported live');

/** Verify actual containers by immutable ID; task tags and desired image names are insufficient. */
export async function verifySwarmTaskImages(db: DB, expected: { runtimeId: string; imageRef: string; imageId: string | null; replicas: number; serviceId: number; deploymentId: number; panelNodeId: string | null; nativeServiceId?: string; knownImageIds?: string[]; freshHealth?: boolean; requireHealthy?: boolean }): Promise<string[]> {
  if (expected.imageId != null && !/^sha256:[a-f0-9]{64}$/.test(expected.imageId) || !expected.panelNodeId || !RE_SWARM_NODE_ID.test(expected.panelNodeId) || !Number.isInteger(expected.replicas) || expected.replicas < 1 || expected.replicas > MAX_REPLICAS) throw refused();
  const inspect = () => capture('docker', ['service', 'inspect', '--format', SWARM_IMAGE_SERVICE_FORMAT, expected.runtimeId], { timeoutMs: TIMEOUT_MS });
  const before = await inspect();
  let service: { id: string; version: number; image: string; service: string; deployment: string };
  try { service = JSON.parse(before); } catch { throw refused(); }
  if (!service || !RE_SWARM_NODE_ID.test(service.id) || expected.nativeServiceId != null && service.id !== expected.nativeServiceId || !Number.isSafeInteger(service.version) || service.version < 0 || service.image !== expected.imageRef || service.service !== String(expected.serviceId) || service.deployment !== String(expected.deploymentId)) throw refused();
  const taskIds = async () => {
    const raw = await capture('docker', ['service', 'ps', '--filter', 'desired-state=running', '--no-trunc', '--quiet', expected.runtimeId], { timeoutMs: TIMEOUT_MS });
    const ids = raw.trim() ? raw.trim().split(/\s+/).sort() : [];
    if (ids.length !== expected.replicas || new Set(ids).size !== ids.length || ids.some(id => !RE_SWARM_NODE_ID.test(id))) throw refused();
    return ids;
  };
  const ids = await taskIds();
  const nodes = await db.select({ id: servers.id, node: servers.swarmNodeId }).from(servers).where(isNotNull(servers.swarmNodeId));
  const byNode = new Map(nodes.filter(n => n.node).map(n => [n.node!, n.id]));
  const verified = new Set<string>();
  // Keep argv bounded even when a service has many replicas.
  for (let i = 0; i < ids.length; i += 64) {
    const batch = ids.slice(i, i + 64);
    const raw = await capture('docker', ['inspect', '--type', 'task', '--format', SWARM_IMAGE_TASK_FORMAT, ...batch], { timeoutMs: TIMEOUT_MS });
    const lines = raw.trim().split('\n').filter(l => l.trim());
    if (lines.length !== batch.length) throw refused();
    const seen = new Set<string>();
    for (const line of lines) {
      let task: { id: string; service: string; node: string; desired: string; state: string; container: string };
      try { task = JSON.parse(line); } catch { throw refused(); }
      if (!task || !batch.includes(task.id) || seen.has(task.id) || task.service !== service.id || !RE_SWARM_NODE_ID.test(task.node) || task.desired !== 'running' || task.state !== 'running' || !/^[a-f0-9]{64}$/.test(task.container)) throw refused();
      seen.add(task.id);
      let image: string;
      let resolved = expected.imageId;
      if (task.node === expected.panelNodeId) {
        image = (await capture('docker', ['inspect', '--type', 'container', '--format', '{{.Image}}', task.container], { timeoutMs: TIMEOUT_MS })).trim();
        resolved ??= (await panelImageInfo(expected.imageRef)).id;
      } else {
        const serverId = byNode.get(task.node);
        if (serverId == null || !(await agentTransportSealed(db, serverId))) throw refused();
        const result = await agentOp(db, serverId, 'docker.inspect', { name: task.container, format: 'image' }, () => undefined);
        const values = result.lines.map(l => l.trim()).filter(Boolean);
        if (result.exitCode !== 0 || values.length !== 1) throw refused();
        image = values[0]!;
        resolved ??= (await nodeImageInfo((op, params, sink) => agentOp(db, serverId, op, params, sink), expected.imageRef, `#${serverId}`)).id;
      }
      if (!/^sha256:[a-f0-9]{64}$/.test(image) || image !== resolved || expected.knownImageIds?.length && !expected.knownImageIds.includes(image)) throw refused();
      verified.add(image);
      if (expected.freshHealth) {
        let health: string;
        if (task.node === expected.panelNodeId) {
          health = (await capture('docker', ['inspect', '--type', 'container', '--format', '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}|{{.State.Health.FailingStreak}}{{else}}none|0{{end}}|{{.RestartCount}}', task.container], { timeoutMs: TIMEOUT_MS })).trim();
        } else {
          const result = await agentOp(db, byNode.get(task.node)!, 'docker.inspect', { name: task.container, format: 'health' }, () => undefined);
          const values = result.lines.map(line => line.trim()).filter(Boolean);
          if (result.exitCode !== 0 || values.length !== 1) throw refused();
          health = values[0]!;
        }
        const [state, status, failures, restarts, extra] = health.split('|');
        if (extra !== undefined || !/^\d+$/.test(failures ?? '') || !/^\d+$/.test(restarts ?? '')) throw refused();
        if (state !== 'running' || status !== 'healthy' && (status !== 'none' || expected.requireHealthy)) throw refused();
      }
    }
  }
  if ((await taskIds()).join('\n') !== ids.join('\n') || (await inspect()) !== before) throw refused();
  return [...verified].sort();
}
