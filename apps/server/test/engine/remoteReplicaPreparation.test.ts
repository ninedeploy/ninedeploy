import { afterEach, expect, it, vi } from 'vitest';
import { createRemoteDockerBuilder } from '../../src/engine/builders/remoteDocker.js';
import type { BuildContext } from '../../src/engine/types.js';

const imageId = `sha256:${'f'.repeat(64)}`;
const context = (replicas: number): BuildContext => ({ deploymentId: 7, service: {
  id: 1, name: 'Web', slug: 'web', type: 'docker', image: 'registry.test/web:latest', serverId: 4,
  replicas, port: 3000, healthCheck: 'http-strict', healthPath: '/ready', cpuShares: 1024, cpuLimitMilli: 500,
  memLimitMb: 128, publishedPort: 8080, portMappings: [], runtimeOptions: null,
} as BuildContext['service'], env: { PORT: '3000' }, workDir: '/fixture', commitSha: '', log: () => undefined });

function fixture({ failAt = '', invalidImage = false, foreign = '', disabled = false } = {}) {
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [], containers = new Map<string, { id: string; name: string }>();
  const agent = vi.fn(async (op: string, params: Record<string, unknown>) => {
    calls.push({ op, params });
    if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.18.3', caps: disabled ? [] : ['docker.recovery', 'docker.readiness', 'docker.lifecycle', 'docker.probe', 'docker.runSpec', 'docker.runtimeOptions', 'docker.ports'] })}`] };
    if (op === 'docker.identity') {
      const name = String(params.name), found = containers.get(name) ?? [...containers.values()].find(c => c.id === name);
      const value = name === foreign ? { id: 'e'.repeat(64), name, managed: 'service', serviceId: '99', deploymentId: '99' }
        : found ? { ...found, managed: 'service', serviceId: '1', deploymentId: '7' } : null;
      return { exitCode: 0, lines: ['ND-CONTAINER ' + JSON.stringify(value)] };
    }
    if (op === 'file.writeEnv') return { exitCode: 0, lines: ['wrote .agent-env/web-7.env'] };
    if (op === 'docker.runEnv' || op === 'docker.runSpec') {
      if (params.name === failAt) throw Error('Run failed after create');
      const target = { id: String(containers.size + 1).padStart(64, 'a'), name: String(params.name) };
      containers.set(target.name, target); return { exitCode: 0, lines: [target.id] };
    }
    if (op === 'docker.inspect') return { exitCode: 0, lines: [params.format === 'health' ? 'running|none|0|0' : invalidImage ? 'mutable:tag' : imageId] };
    if (op === 'docker.probe') return { exitCode: 0, lines: ['ND-PROBE {"ready":true}'] };
    if (op === 'docker.retire') return { exitCode: 0, lines: ['ND-RETIRED ' + params.id] };
    if (op === 'docker.readiness') return { exitCode: 0, lines: ['ND-READINESS ' + JSON.stringify({ requestId: params.requestId, complete: true,
      items: (params.targets as Array<{ id: string; name: string }>).map(target => ({ ...target, status: 'running', health: 'none', ready: target.name !== 'web-7-r2', restarts: 0, failingStreak: 0 })) })] };
    return { exitCode: 0, lines: [] };
  });
  return { calls, agent, containers };
}
afterEach(() => vi.useRealTimers());

it('keeps the single-replica compatibility path', async () => {
  const f = fixture(); const result = await createRemoteDockerBuilder(f.agent).buildAndRun(context(1));
  expect(result.runtimeId).toBe('web-7'); expect(f.calls.filter(c => c.op === 'docker.runEnv')).toHaveLength(1);
});

it('keeps a ready single-replica runtime healthy on the compatibility path', async () => {
  const f = fixture(); const builder = createRemoteDockerBuilder(f.agent); const runtime = await builder.buildAndRun(context(1));
  vi.useFakeTimers(); const pending = builder.isHealthy(runtime, 6000, 1000);
  await vi.advanceTimersByTimeAsync(6001); expect(await pending).toBe(true);
});

it('refuses multiple replicas on an older agent that cannot fence competing lifecycle operations', async () => {
  const f = fixture(); const original = f.agent.getMockImplementation()!;
  f.agent.mockImplementation(async (op, params) => op === 'agent.ping'
    ? { exitCode: 0, lines: ['ND-AGENT {"version":"0.18.2","caps":["docker.recovery","docker.readiness","docker.probe"]}'] }
    : original(op, params));
  await expect(createRemoteDockerBuilder(f.agent).buildAndRun(context(2))).rejects.toThrow(/0\.18\.3/);
  expect(f.calls.some(c => c.op === 'file.writeEnv' || c.op.startsWith('docker.run'))).toBe(false);
});

it('does not prepare Docker container replicas for Swarm placement', async () => {
  const f = fixture(); const ctx = context(2); ctx.service = { ...ctx.service, orchestrator: 'swarm' };
  await expect(createRemoteDockerBuilder(f.agent).buildAndRun(ctx)).rejects.toThrow(/plain Docker/);
  expect(f.calls.some(c => c.op === 'file.writeEnv' || c.op.startsWith('docker.run'))).toBe(false);
});

it('prepares the complete labeled node replica set from the primary immutable image without duplicating host ports', async () => {
  const f = fixture(); const result = await createRemoteDockerBuilder(f.agent).buildAndRun(context(3));
  expect(result.replicas).toBe(3);
  const runs = f.calls.filter(c => c.op === 'docker.runEnv' || c.op === 'docker.runSpec').map(c => c.params);
  expect(runs.map(run => run.name)).toEqual(['web-7', 'web-7-r2', 'web-7-r3']);
  expect(runs.slice(1).map(run => run.image)).toEqual([imageId, imageId]);
  expect(runs[0]!.publish).toBe('8080:3000'); expect(runs.slice(1).every(run => run.publish === undefined && run.ports === undefined)).toBe(true);
  expect(runs.every(run => run.serviceId === 1 && run.deploymentId === 7)).toBe(true);
  expect(runs.every(run => String(run.cpuLimitMilli) === '500' && String(run.memLimitMb) === '128')).toBe(true);
});

it('refuses unavailable immutable identity support before writing secrets or starting any replica', async () => {
  const f = fixture({ disabled: true });
  await expect(createRemoteDockerBuilder(f.agent).buildAndRun(context(2))).rejects.toThrow(/agent|owner|replica/i);
  expect(f.calls.some(c => c.op === 'file.writeEnv' || c.op.startsWith('docker.run'))).toBe(false);
});

it('does not accept a mutable or malformed image observation for sibling replicas', async () => {
  const f = fixture({ invalidImage: true });
  await expect(createRemoteDockerBuilder(f.agent).buildAndRun(context(2))).rejects.toThrow(/image/i);
  expect(f.calls.filter(c => c.op === 'docker.runEnv' || c.op === 'docker.runSpec')).toHaveLength(1);
  expect(f.calls.some(c => c.op === 'docker.rm')).toBe(false);
});

it('retains an ambiguous creation receipt without guessing which container it may retire', async () => {
  const f = fixture(); const original = f.agent.getMockImplementation()!;
  f.agent.mockImplementation(async (op, params) => {
    const response = await original(op, params);
    return op === 'docker.runEnv' || op === 'docker.runSpec' ? { ...response, lines: [...response.lines, 'b'.repeat(64)] } : response;
  });
  await expect(createRemoteDockerBuilder(f.agent).buildAndRun(context(2))).rejects.toThrow(/creation receipt/);
  expect(f.calls.some(c => c.op === 'docker.retire' || c.op === 'docker.rm')).toBe(false);
});

it('retires only acknowledged immutable IDs after a partial preparation failure', async () => {
  const f = fixture({ failAt: 'web-7-r3' });
  await expect(createRemoteDockerBuilder(f.agent).buildAndRun(context(3))).rejects.toThrow('Run failed after create');
  const retired = f.calls.filter(c => c.op === 'docker.retire');
  expect(retired.map(c => c.params.id).sort()).toEqual([...f.containers.values()].map(c => c.id).sort());
  expect(retired).toHaveLength(2); expect(f.calls.some(c => c.op === 'docker.rm')).toBe(false);
});

it('retains an occupied sibling name instead of adopting or deleting a foreign container', async () => {
  const f = fixture({ foreign: 'web-7-r2' });
  await expect(createRemoteDockerBuilder(f.agent).buildAndRun(context(2))).rejects.toThrow(/occupied|ownership|exists/i);
  expect(f.calls.some(c => c.op === 'docker.retire' && c.params.id === 'e'.repeat(64))).toBe(false);
  expect(f.calls.some(c => c.op === 'docker.rm')).toBe(false);
});

it('does not promote a multi-replica runtime when only its primary is ready', async () => {
  const f = fixture(); const builder = createRemoteDockerBuilder(f.agent);
  const runtime = await builder.buildAndRun(context(2));
  vi.useFakeTimers(); const pending = builder.isHealthy(runtime, 6000, 1000);
  await vi.advanceTimersByTimeAsync(6001);
  expect(await pending).toBe(false);
  const samples = f.calls.filter(c => c.op === 'docker.readiness');
  expect(samples.length).toBeGreaterThan(0);
  expect(samples.every(c => (c.params.targets as unknown[]).length === 2)).toBe(true);
});

it('retires every immutable prepared replica when a candidate fails before routing recovery is established', async () => {
  const f = fixture(); const builder = createRemoteDockerBuilder(f.agent);
  const runtime = await builder.buildAndRun(context(3));
  await builder.stop(runtime.runtimeId);
  expect(f.calls.filter(c => c.op === 'docker.retire').map(c => c.params.id).sort()).toEqual([...f.containers.values()].map(c => c.id).sort());
  expect(f.calls.some(c => c.op === 'docker.stop' || c.op === 'docker.rm')).toBe(false);
});

it('retires the whole immutable set when a placed artifact identity does not match', async () => {
  const f = fixture();
  const builder = createRemoteDockerBuilder(f.agent, { prebuiltImage: { tag: 'ninedeploy/web:fixture', imageId: `sha256:${'c'.repeat(64)}` } });
  await expect(builder.buildAndRun(context(2))).rejects.toThrow(/artifact/);
  expect(f.calls.filter(c => c.op === 'docker.retire').map(c => c.params.id).sort()).toEqual([...f.containers.values()].map(c => c.id).sort());
  expect(f.calls.some(c => c.op === 'docker.rm')).toBe(false);
});

it('rediscovers and retires the full previous managed replica generation after the desired count changes', async () => {
  const f = fixture(); const original = f.agent.getMockImplementation()!;
  const previous = Array.from({ length: 3 }, (_, index) => ({ name: index ? `web-6-r${index + 1}` : 'web-6', id: String(index + 1).padStart(64, 'd') }));
  f.agent.mockImplementation(async (op, params) => {
    if (op === 'docker.identity' && String(params.name).startsWith('web-6')) {
      f.calls.push({ op, params }); const target = previous.find(t => t.name === params.name);
      return { exitCode: 0, lines: ['ND-CONTAINER ' + JSON.stringify(target ? { ...target, managed: 'service', serviceId: '1', deploymentId: '6' } : null)] };
    }
    return original(op, params);
  });
  const ctx = context(1); ctx.service = { ...ctx.service, runtimeReplicas: 3, publishedPort: null };
  const builder = createRemoteDockerBuilder(f.agent);
  await builder.buildAndRun(ctx, { runtimeId: 'web-6', port: 3000, healthPath: '/ready' });
  await builder.stop('web-6');
  expect(f.calls.filter(c => c.op === 'docker.retire').map(c => c.params.id).sort()).toEqual(previous.map(t => t.id).sort());
  expect(f.calls.some(c => c.op === 'docker.rm' || c.op === 'docker.stop')).toBe(false);
});
