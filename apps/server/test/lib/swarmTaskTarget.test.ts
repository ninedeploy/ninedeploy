/** P1: a Swarm replica's container, wherever it runs (`lib/swarmTaskTarget.ts`). */
import { describe, expect, it, vi } from 'vitest';
import { swarmTaskTarget, type SwarmTaskDeps } from '../../src/lib/swarmTaskTarget.js';

const RT = 'nd-shop_web';
const TASK1 = 'a'.repeat(25), TASK2 = 'b'.repeat(25), NODE = 'n'.repeat(25), CID = 'c'.repeat(64);
const db = {} as never;

function deps(over: { local?: boolean; state?: string; enrolled?: boolean; labels?: Record<string, string>; running?: boolean; id?: string; ps?: string } = {}) {
  const docker = vi.fn(async (args: string[]) => {
    if (args[0] === 'service') return over.ps ?? `${TASK1} ${RT}.1\n${TASK2} ${RT}.2\n`;
    if (args[0] === 'inspect') return `${NODE}|${over.state ?? 'running'}|${CID}\n`;
    return '';
  });
  const nodeTool = vi.fn(async () => ({
    id: over.id ?? CID, name: `${RT}.2.${TASK2}`, image: 'x', state: { status: 'running', running: over.running ?? true, startedAt: '', finishedAt: '', exitCode: 0, error: '' },
    labels: over.labels ?? { 'com.docker.swarm.task.id': TASK2, 'com.docker.swarm.service.name': RT }, traefikTags: {}, env: [], ports: {}, mounts: [],
  }));
  const d: SwarmTaskDeps = {
    docker,
    local: vi.fn(async (_rt: string, replica = 1) => (over.local && replica === 1 ? { container: `${RT}.1.${TASK1}` } : { refusal: 'elsewhere' })),
    nodeTool: nodeTool as never,
    serverFor: vi.fn(async (_db: unknown, id: string) => (over.enrolled === false || id !== NODE ? null : { id: 7, name: 'edge-7' })),
  };
  return { d, docker, nodeTool };
}

describe('swarmTaskTarget', () => {
  it('keeps a task on the panel host on the local path, asking nothing else', async () => {
    const { d, docker, nodeTool } = deps({ local: true });
    expect(await swarmTaskTarget(db, RT, 1, d)).toEqual({ where: 'local', container: `${RT}.1.${TASK1}` });
    expect(docker).not.toHaveBeenCalled();
    expect(nodeTool).not.toHaveBeenCalled();
  });

  it('reaches a task on an enrolled worker by the container id the manager reports, and uses the name the worker reports', async () => {
    const { d, docker, nodeTool } = deps();
    expect(await swarmTaskTarget(db, RT, 2, d)).toEqual({ where: 'node', serverId: 7, nodeName: 'edge-7', container: `${RT}.2.${TASK2}`, containerId: CID, taskId: TASK2 });
    expect(docker.mock.calls[1]![0]).toEqual(['inspect', '--type', 'task', '--format', expect.any(String), TASK2]);
    expect(nodeTool).toHaveBeenCalledWith(db, 7, CID, 'inspect');
  });

  it('refuses a worker NineDeploy does not manage, a task that is not running, and a missing slot', async () => {
    expect(await swarmTaskTarget(db, RT, 2, deps({ enrolled: false }).d)).toEqual({ refusal: expect.stringMatching(/not enrolled in NineDeploy/) });
    expect(await swarmTaskTarget(db, RT, 2, deps({ state: 'starting' }).d)).toEqual({ refusal: expect.stringMatching(/is not running \(starting\)/) });
    expect(await swarmTaskTarget(db, RT, 3, deps().d)).toEqual({ refusal: expect.stringMatching(/No running replica 3/) });
    expect(await swarmTaskTarget(db, RT, 2, deps({ running: false }).d)).toEqual({ refusal: expect.stringMatching(/not running on node edge-7/) });
  });

  it('never opens a container that does not carry this task and this service, or another container than the manager named', async () => {
    for (const over of [
      { labels: { 'com.docker.swarm.task.id': TASK1, 'com.docker.swarm.service.name': RT } },
      { labels: { 'com.docker.swarm.task.id': TASK2, 'com.docker.swarm.service.name': 'nd-other_web' } },
      { labels: {} },
      { id: 'd'.repeat(64) },
    ]) {
      expect(await swarmTaskTarget(db, RT, 2, deps(over).d), JSON.stringify(over)).toEqual({ refusal: expect.stringMatching(/does not carry this task's identity/) });
    }
  });

  it('ignores task lines that are not this service or not task ids', async () => {
    const ps = `${TASK2} nd-other_web.2\nnot-an-id ${RT}.2\n`;
    expect(await swarmTaskTarget(db, RT, 2, deps({ ps }).d)).toEqual({ refusal: expect.stringMatching(/No running replica 2/) });
  });
});
