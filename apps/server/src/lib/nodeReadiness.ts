import { randomBytes } from 'node:crypto';
import { containerReadinessReply, containerReadinessRequest, type ContainerReadinessRequest } from '@ninedeploy/schemas';
import type { AgentCall } from '../engine/builders/remoteDocker.js';

/** All replicas remain sampled until every one passes three consecutive rounds without a restart. */
export async function verifyNodeReadiness(agent: AgentCall, spec: Omit<ContainerReadinessRequest, 'requestId' | 'timeoutMs'>,
  timeoutMs: number, checkpoint: () => Promise<void>, log: (line: string) => void): Promise<boolean> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;
  spec = containerReadinessRequest.parse({ ...spec, requestId: '0'.repeat(32), timeoutMs: 1 });
  const deadline = Date.now() + timeoutMs;
  const stable = new Map(spec.targets.map(target => [target.id, 0]));
  const baseline = new Map<string, number>(), previous = new Map<string, number>();
  while (Date.now() < deadline) {
    await checkpoint();
    let sample: ReturnType<typeof containerReadinessReply.parse> | undefined;
    try {
      const request = containerReadinessRequest.parse({ ...spec, requestId: randomBytes(16).toString('hex'), timeoutMs: Math.max(1, Math.min(10_000, Math.floor(deadline - Date.now()))) });
      if (Date.now() >= deadline) return false;
      const result = await agent('docker.readiness', request, () => undefined, { timeoutMs: Math.max(1, deadline - Date.now()) });
      const lines = result.lines.filter(line => line.startsWith('ND-READINESS '));
      if (result.exitCode !== 0 || lines.length !== 1 || lines[0]!.length > 64 * 1024) throw new Error('Node readiness receipt unavailable');
      const reply = containerReadinessReply.parse(JSON.parse(lines[0]!.slice(13)));
      if (!reply.complete || reply.requestId !== request.requestId || reply.items.length !== spec.targets.length ||
        new Set(reply.items.map(item => item.id)).size !== spec.targets.length || spec.targets.some(target => !reply.items.some(item => item.id === target.id && item.name === target.name))) {
        throw new Error('Node readiness identity or coverage changed');
      }
      sample = reply;
    } catch {
      for (const id of stable.keys()) stable.set(id, 0);
      log('Node readiness sample unavailable or incomplete; retrying within the original deadline.');
    }
    await checkpoint();
    if (Date.now() >= deadline) return false;
    if (sample) {
      for (const item of sample.items) {
        baseline.set(item.id, baseline.get(item.id) ?? item.restarts);
        if (['exited', 'dead', 'removing'].includes(item.status) || item.failingStreak >= 15 || item.restarts - baseline.get(item.id)! >= 3 ||
          previous.has(item.id) && item.restarts < previous.get(item.id)!) return false;
        if (previous.has(item.id) && previous.get(item.id) !== item.restarts) stable.set(item.id, 0);
        previous.set(item.id, item.restarts);
        const ready = item.ready && item.status === 'running' && (item.health === 'healthy' || item.health === 'none' && spec.mode !== 'command');
        stable.set(item.id, ready ? stable.get(item.id)! + 1 : 0);
      }
      if ([...stable.values()].every(samples => samples >= 3)) { log(`All ${spec.targets.length} candidate replicas passed three consecutive node readiness samples.`); return true; }
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(2000, remaining)));
  }
  return false;
}
