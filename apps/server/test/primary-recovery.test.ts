import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setImmediate as yieldIO } from 'node:timers';
import { eq } from 'drizzle-orm';
import { deploymentRuntimeOwners, deployments, domains, nodeAutoscaleCapacity, nodeDeploymentPreparations, primaryTransitions, servers, services, type PrimaryRuntimeSnapshot } from '@ninedeploy/db';
import { reserveServiceRuntimeOwner } from '../src/lib/serviceRuntimeOwner.js';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observabilityDb } from './fixtures/observability.js';
import { createRemoteDockerBuilder } from '../src/engine/builders/remoteDocker.js';
import { prepareNodeAutoscaleDeployment } from '../src/engine/builders/nodeAutoscaleDeployment.js';
import { createNodeDeploymentAuthority } from '../src/lib/nodeDeploymentOwner.js';
import { beginNodeDeploymentPreparation, completeNodeDeploymentPreparation, handoffNodeDeploymentPreparation } from '../src/lib/nodeDeploymentPreparation.js';

const h = vi.hoisted(() => ({ agent: vi.fn(), sealed: vi.fn(async () => true), config: { paths: { dataDir: '', logsDir: '' }, acmeEmail: null } }));
vi.mock('../src/config.js', () => ({ config: h.config }));
vi.mock('../src/lib/agentClient.js', () => ({ agentOp: h.agent, agentTransportSealed: h.sealed }));
vi.mock('../src/lib/exec.js', () => ({ capture: vi.fn(async () => ''), run: vi.fn(async () => {}), sleep: (ms: number) => new Promise(r => setTimeout(r, ms)) }));
const temp = mkdtempSync(path.join(os.tmpdir(), 'nd-primary-recovery-'));
h.config.paths.dataDir = temp; h.config.paths.logsDir = temp;
await import('../src/lib/nodeProxy.js');
const { beginPrimaryTransition, reconcilePrimaryTransitions, listPrimaryRecovery } = await import('../src/engine/primaryRecovery.js');
let f: Awaited<ReturnType<typeof observabilityDb>>;
const old = 'web-7', candidate = 'web-9';
const oldId = 'a'.repeat(64), candidateId = 'b'.repeat(64);
type Identity = { id: string; name: string; managed: string; serviceId: string; deploymentId: string };
let containers: Map<string, Identity>, unready: Set<string>, confirm: () => Promise<void>, writes: string[], caps: string[];
function group(name: string, id: string): PrimaryRuntimeSnapshot {
  return { runtimeId: name, port: 8080, healthPath: '/', healthCheck: 'http-strict', replicas: 1, commitSha: name,
    containers: [{ name, id, observed: true }] };
}
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
beforeEach(async () => {
  f = await observabilityDb();
  await f.db.insert(servers).values({ id: 5, name: 'Edge', host: 'edge.test', tokenEncrypted: 'unused' });
  await f.db.update(services).set({ serverId: 5, port: 8080, healthCheck: 'http-strict', status: 'deploying' });
  await f.db.insert(deployments).values([{ id: 8, serviceId: 1, status: 'running' }, { id: 9, serviceId: 1, status: 'deploying' }]);
  await f.db.insert(domains).values({ serviceId: 1, hostname: 'app.test', ssl: false, status: 'active' });
  containers = new Map([
    [oldId, { id: oldId, name: old, managed: 'service', serviceId: '1', deploymentId: '7' }],
    [candidateId, { id: candidateId, name: candidate, managed: 'service', serviceId: '1', deploymentId: '9' }],
  ]);
  unready = new Set(); writes = []; caps = ['proxy.routingAck', 'docker.recovery', 'docker.probe']; confirm = async () => {};
  h.sealed.mockResolvedValue(true);
  h.agent.mockReset().mockImplementation(async (_db, _id, op, p) => {
    if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.18.0', caps })}`] };
    if (op === 'docker.identity') return { exitCode: 0, lines: [`ND-CONTAINER ${JSON.stringify(containers.get(p.name) ?? [...containers.values()].find(v => v.name === p.name) ?? null)}`] };
    if (op === 'docker.inspect') return { exitCode: 0, lines: [p.format === 'health' ? 'running|none|0|0' : 'running|172.18.0.2'] };
    if (op === 'docker.probe') return { exitCode: 0, lines: [`ND-PROBE ${JSON.stringify({ ready: !unready.has(p.name), protocol: p.protocol, ...(p.protocol === 'http' ? { status: unready.has(p.name) ? 503 : 200 } : {}) })}`] };
    if (op === 'docker.retire') { containers.delete(p.id); return { exitCode: 0, lines: [`ND-RETIRED ${p.id}`] }; }
    if (op === 'proxy.writeConfig') { if (p.kind === 'dynamic') writes.push(p.content); return { exitCode: 0, lines: ['proxy-config x unchanged'] }; }
    if (op === 'proxy.confirmRouting') { await confirm(); return { exitCode: 0, lines: [`ND-PROXY-ROUTING ${createHash('sha256').update(p.content).digest('hex')}`] }; }
    return { exitCode: 0, lines: [] };
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => { vi.useRealTimers(); f?.close(); });
afterAll(() => {
  if (!temp.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(temp).startsWith('nd-primary-recovery-')) throw Error('Unexpected scratch path');
  rmSync(temp, { recursive: true, force: true });
});
async function journal(overrides: Partial<typeof primaryTransitions.$inferInsert> = {}) {
  await f.db.insert(primaryTransitions).values({ serviceId: 1, serverId: 5, deploymentId: 9, previous: group(old, oldId), candidate: group(candidate, candidateId),
    phase: 'routing', routingTouched: true, interrupted: true, desiredRuntimeId: candidate, ...overrides });
}
const service = () => f.db.query.services.findFirst({ where: eq(services.id, 1) });
const job = () => f.db.query.deployments.findFirst({ where: eq(deployments.id, 9) });
const rows = () => f.db.select().from(primaryTransitions);
const stops = () => h.agent.mock.calls.filter(c => c[2] === 'docker.stop' || c[2] === 'docker.retire');
const recover = () => reconcilePrimaryTransitions(f.db, { serviceId: 1, force: true });
async function pump(run: Promise<unknown>, pending = false) {
  let done = false; void run.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 3000 && !done; i++) {
    if (pending && h.agent.mock.calls.some(c => c[2] === 'proxy.confirmRouting')) return;
    if (vi.getTimerCount()) await vi.advanceTimersToNextTimerAsync();
    await new Promise<void>(resolve => yieldIO(resolve));
  }
  if (!done) throw Error('Recovery did not reach its bounded fixture gate');
}
async function finish<T>(run: Promise<T>) { await pump(run); return run; }

describe('primary recovery through SQLite and the real routing writer', () => {
  it('does not adopt a candidate identity returned by a failed Docker inspection', async () => {
    const original = h.agent.getMockImplementation()!;
    h.agent.mockImplementation(async (...args) => {
      if (args[2] === 'docker.identity' && args[3].name === candidate) return { exitCode: 1,
        lines: [`ND-CONTAINER ${JSON.stringify(containers.get(candidateId))}`] };
      return original(...args);
    });
    const runtime = { runtimeId: candidate, port: 8080, healthPath: '/' };
    await expect(beginPrimaryTransition(f.db, (await service())!, 9, runtime, { ...runtime, runtimeId: old }, null)).rejects.toThrow(/identit/i);
    expect((await rows())[0]?.candidate.containers[0]).toMatchObject({ id: null, observed: false });
    expect(writes).toEqual([]); expect(stops()).toEqual([]);
  });
  it('retains the candidate when its identity receipt exceeds the limit', async () => {
    const original = h.agent.getMockImplementation()!;
    h.agent.mockImplementation(async (...args) => {
      if (args[2] === 'docker.identity' && args[3].name === candidate) return { exitCode: 0,
        lines: [`ND-CONTAINER ${JSON.stringify({ ...containers.get(candidateId), padding: 'x'.repeat(16_384) })}`] };
      return original(...args);
    });
    const runtime = { runtimeId: candidate, port: 8080, healthPath: '/' };
    await expect(beginPrimaryTransition(f.db, (await service())!, 9, runtime, { ...runtime, runtimeId: old }, null)).rejects.toThrow(/identit/i);
    expect((await rows())[0]?.candidate.containers[0]).toMatchObject({ id: null, observed: false });
    expect(writes).toEqual([]); expect(stops()).toEqual([]);
  });
  it('does not adopt a replacement that reused the candidate name after creation', async () => {
    const replacement = 'c'.repeat(64);
    containers.delete(candidateId);
    containers.set(replacement, { id: replacement, name: candidate, managed: 'service', serviceId: '1', deploymentId: '9' });
    const runtime = { runtimeId: candidate, nodeReadinessId: candidateId, port: 8080, healthPath: '/' };
    await expect(beginPrimaryTransition(f.db, (await service())!, 9, runtime, { runtimeId: old, port: 8080, healthPath: '/' }, null)).rejects.toThrow(/identit/i);
    expect((await rows())[0]?.candidate.containers[0]).toMatchObject({ name: candidate, id: candidateId, observed: false });
    expect(writes).toEqual([]); expect(stops()).toEqual([]);
  });
  it('checks each immutable creation receipt when capturing a replica set', async () => {
    const secondId = 'd'.repeat(64), replacement = 'e'.repeat(64), second = `${candidate}-r2`;
    containers.set(replacement, { id: replacement, name: second, managed: 'service', serviceId: '1', deploymentId: '9' });
    const runtime = { runtimeId: candidate, replicas: 2, port: 8080, healthPath: '/', nodeTargets: [{ id: candidateId, name: candidate }, { id: secondId, name: second }] };
    await expect(beginPrimaryTransition(f.db, (await service())!, 9, runtime, { runtimeId: old, port: 8080, healthPath: '/' }, null)).rejects.toThrow(/identit/i);
    expect((await rows())[0]?.candidate.containers).toMatchObject([{ name: candidate, id: candidateId, observed: true }, { name: second, id: secondId, observed: false }]);
    expect(writes).toEqual([]); expect(stops()).toEqual([]);
  });
  it('uses the persisted deployment authority to retire an old node generation in one ordered batch', async () => {
    const authority = await reserveServiceRuntimeOwner(f.db, 1, 'deploy', null, 'c'.repeat(32));
    const owner = { deploymentId: 9, serviceId: 1, serverId: 5, epoch: authority.epoch, requestId: authority.requestId! };
    await f.db.insert(deploymentRuntimeOwners).values(owner);
    caps.push('docker.mutations');
    const normal = h.agent.getMockImplementation()!;
    h.agent.mockImplementation(async (...args) => {
      if (args[2] === 'docker.retireSet') {
        const request = args[3]; for (const target of request.targets) containers.delete(target.id);
        return { exitCode: 0, lines: [`ND-RETIRED-SET ${JSON.stringify({ requestId: request.requestId, serviceId: request.serviceId,
          revision: request.revision, complete: true, items: request.targets.map((target: object) => ({ ...target, removed: true })) })}`] };
      }
      return normal(...args);
    });
    const runtime = { runtimeId: candidate, port: 8080, healthPath: '/', nodeDeploymentOwner: owner };
    const lease = await beginPrimaryTransition(f.db, (await service())!, 9, runtime, { ...runtime, runtimeId: old }, null);
    try {
      await lease.intentCandidate(); await f.db.update(services).set({ runtimeId: candidate }).where(eq(services.id, 1));
      await lease.confirm(); await lease.retire(old);
      const calls = h.agent.mock.calls.filter(call => call[2] === 'docker.retireSet');
      expect(calls).toHaveLength(1); expect(calls[0]![3].targets).toEqual([{ id: oldId, name: old, deploymentId: 7 }]);
      expect(h.agent.mock.calls.filter(call => call[2] === 'docker.retire')).toEqual([]);
      expect(containers.has(candidateId)).toBe(true); expect(containers.has(oldId)).toBe(false);
    } finally { await lease.release(); }
  });
  it('replays the same ordered retirement after a lost receipt and recovery', async () => {
    const authority = await reserveServiceRuntimeOwner(f.db, 1, 'deploy', null, 'c'.repeat(32));
    const owner = { deploymentId: 9, serviceId: 1, serverId: 5, epoch: authority.epoch, requestId: authority.requestId! };
    await f.db.insert(deploymentRuntimeOwners).values(owner); caps.push('docker.mutations');
    const normal = h.agent.getMockImplementation()!; let lost = true;
    h.agent.mockImplementation(async (...args) => {
      if (args[2] === 'docker.retireSet') {
        const request = args[3]; for (const target of request.targets) containers.delete(target.id);
        if (lost) { lost = false; throw new Error('retirement reply lost'); }
        return { exitCode: 0, lines: [`ND-RETIRED-SET ${JSON.stringify({ requestId: request.requestId, serviceId: request.serviceId,
          revision: request.revision, complete: true, items: request.targets.map((target: object) => ({ ...target, removed: true })) })}`] };
      }
      return normal(...args);
    });
    const runtime = { runtimeId: candidate, port: 8080, healthPath: '/', nodeDeploymentOwner: owner };
    const lease = await beginPrimaryTransition(f.db, (await service())!, 9, runtime, { ...runtime, runtimeId: old }, null);
    await lease.intentCandidate(); await f.db.update(services).set({ runtimeId: candidate }).where(eq(services.id, 1)); await lease.confirm();
    await expect(lease.retire(old)).rejects.toThrow('retirement reply lost');
    expect((await rows())[0]?.orderedRetirement).toEqual({ runtimeId: old, graceSeconds: 5 });
    await lease.release();
    expect(await finish(recover())).toEqual({ recovered: 1, held: 0 });
    const attempts = h.agent.mock.calls.filter(call => call[2] === 'docker.retireSet');
    expect(attempts).toHaveLength(2);
    const { timeoutMs: _firstTimeout, ...first } = attempts[0]![3], { timeoutMs: _secondTimeout, ...second } = attempts[1]![3];
    expect(second).toEqual(first);
    expect(containers.has(candidateId)).toBe(true); expect(await rows()).toEqual([]);
  });
  it('does not send ordered retirement after a newer lifecycle owner wins', async () => {
    const authority = await reserveServiceRuntimeOwner(f.db, 1, 'deploy', null, 'c'.repeat(32));
    const owner = { deploymentId: 9, serviceId: 1, serverId: 5, epoch: authority.epoch, requestId: authority.requestId! };
    await f.db.insert(deploymentRuntimeOwners).values(owner); caps.push('docker.mutations');
    const runtime = { runtimeId: candidate, port: 8080, healthPath: '/', nodeDeploymentOwner: owner };
    const lease = await beginPrimaryTransition(f.db, (await service())!, 9, runtime, { ...runtime, runtimeId: old }, null);
    try {
      await lease.intentCandidate(); await f.db.update(services).set({ runtimeId: candidate }).where(eq(services.id, 1)); await lease.confirm();
      await reserveServiceRuntimeOwner(f.db, 1, 'stop', authority, 'd'.repeat(32));
      await expect(lease.retire(old)).rejects.toThrow(/ownership|authority/i);
      expect(h.agent.mock.calls.filter(call => call[2] === 'docker.retireSet' || call[2] === 'docker.retire')).toEqual([]);
      expect(containers.has(oldId)).toBe(true); expect(containers.has(candidateId)).toBe(true);
    } finally { await lease.release(); }
  });
  it.each([false, true])('honors the caller cancellation checkpoint before any candidate probe (batch=%s)', async batch => {
    if (batch) caps.push('docker.readiness');
    const runtime = { runtimeId: candidate, port: 8080, healthPath: '/' };
    const lease = await beginPrimaryTransition(f.db, (await service())!, 9, runtime, { ...runtime, runtimeId: old }, null);
    const builder = { buildAndRun: async () => runtime, stop: async () => undefined, isHealthy: vi.fn(async () => true) };
    const cancelled = new Error('Deployment cancelled');
    try {
      const settled = lease.verifyCandidate(builder, runtime, 100, () => undefined, async () => { throw cancelled; }).then(() => null, error => error);
      expect(await finish(settled)).toBe(cancelled);
      expect(builder.isHealthy).not.toHaveBeenCalled();
      expect(h.agent.mock.calls.filter(args => args[2] === 'docker.readiness')).toEqual([]);
    } finally { await lease.release(); }
  });
  it.each([true, false])('qualifies every immutable candidate replica through the advertised batch protocol (last ready=%s)', async lastReady => {
    caps.push('docker.readiness');
    const original = h.agent.getMockImplementation()!;
    h.agent.mockImplementation(async (...args) => {
      const request = args[3];
      if (args[2] === 'docker.readiness') return { exitCode: 0, lines: [`ND-READINESS ${JSON.stringify({ requestId: request.requestId, complete: true,
        items: request.targets.map((target: { id: string; name: string }, index: number) => ({ ...target, status: 'running', health: 'healthy', restarts: 0, failingStreak: 0, ready: index !== 9 || lastReady })) })}`] };
      return original(...args);
    });
    for (let i = 2; i <= 10; i++) {
      const id = i.toString(16).padStart(64, '0');
      containers.set(id, { id, name: `${candidate}-r${i}`, managed: 'service', serviceId: '1', deploymentId: '9' });
    }
    const runtime = { runtimeId: candidate, replicas: 10, port: 8080, healthPath: '/ready?db=1', healthCheck: 'http-strict' as const };
    const lease = await beginPrimaryTransition(f.db, (await service())!, 9, runtime, { ...runtime, runtimeId: old, replicas: 1 }, null);
    if (!lastReady) unready.add((10).toString(16).padStart(64, '0'));
    const builder = createRemoteDockerBuilder((op, args, sink, options) => h.agent(f.db, 5, op, args, sink, options));
    const legacyProbe = vi.spyOn(builder, 'isHealthy');
    try {
      const settled = lease.verifyCandidate(builder, runtime, 10_000, () => undefined).then(() => ({ error: null }), error => ({ error }));
      const result = await finish(settled);
      if (lastReady) expect(result.error).toBe(null);
      else expect(result.error).toHaveProperty('message', expect.stringMatching(/readiness/));
      const calls = h.agent.mock.calls.filter(call => call[2] === 'docker.readiness');
      expect(calls).toHaveLength(lastReady ? 3 : 5);
      expect(calls[0]![3]).toMatchObject({ path: '/ready?db=1', targets: lease.row.candidate.containers.map(item => ({ id: item.id, name: item.name })) });
      expect(legacyProbe).not.toHaveBeenCalled();
    } finally { await lease.release(); }
  });
  it('keeps an older agent on the existing primary builder readiness path', async () => {
    const runtime = { runtimeId: candidate, port: 8080, healthPath: '/' };
    const lease = await beginPrimaryTransition(f.db, (await service())!, 9, runtime, { ...runtime, runtimeId: old }, null);
    const builder = { buildAndRun: async () => runtime, stop: async () => undefined, isHealthy: vi.fn(async () => true) };
    try {
      await finish(lease.verifyCandidate(builder, runtime, 10_000, () => undefined));
      expect(builder.isHealthy).toHaveBeenCalledTimes(1);
      expect(h.agent.mock.calls.filter(call => call[2] === 'docker.readiness')).toEqual([]);
    } finally { await lease.release(); }
  });
  it('keeps the name and immutable identity paired on the legacy node readiness path', async () => {
    const runtime = { runtimeId: candidate, nodeReadinessId: candidateId, port: 8080, healthPath: '/' };
    const lease = await beginPrimaryTransition(f.db, (await service())!, 9, runtime, { ...runtime, runtimeId: old, nodeReadinessId: oldId }, null);
    const builder = { isHealthy: vi.fn(async () => true) };
    try {
      await finish(lease.verifyCandidate(builder as never, runtime, 10_000, () => undefined));
      expect(builder.isHealthy.mock.calls[0]![0]).toMatchObject({ runtimeId: candidate, nodeReadinessId: candidateId });
    } finally { await lease.release(); }
  });
  it.each([true, false])('rechecks the default node port before candidate promotion (listening=%s)', async listening => {
    caps.push('docker.readiness'); const original = h.agent.getMockImplementation()!;
    h.agent.mockImplementation(async (...args) => {
      const request = args[3];
      if (args[2] === 'docker.readiness') return { exitCode: 0, lines: [`ND-READINESS ${JSON.stringify({ requestId: request.requestId, complete: true,
        items: request.targets.map((target: { id: string; name: string }) => ({ ...target, status: 'running', health: 'none', restarts: 0, failingStreak: 0, ready: listening })) })}`] };
      return original(...args);
    });
    const runtime = { runtimeId: candidate, port: 8080, healthPath: '/' };
    const lease = await beginPrimaryTransition(f.db, (await service())!, 9, runtime, { ...runtime, runtimeId: old }, null);
    try {
      const outcome = await finish(lease.verifyCandidate({ isHealthy: vi.fn() } as never, runtime, 10_000, () => undefined).then(() => null, error => error));
      if (listening) expect(outcome).toBeNull(); else expect(outcome).toHaveProperty('message', expect.stringMatching(/readiness/));
      const calls = h.agent.mock.calls.filter(call => call[2] === 'docker.readiness');
      expect(calls).toHaveLength(listening ? 3 : 5); expect(calls.every(call => call[3].mode === 'tcp' && call[3].port === 8080)).toBe(true);
    } finally { await lease.release(); }
  });
  it('finishes an interrupted cutover only after fresh readiness and loaded routing acknowledgement', async () => {
    await journal(); const ack = gate(); confirm = () => ack.promise;
    const run = recover(); await pump(run, true);
    expect(stops()).toEqual([]); expect((await job())?.status).toBe('deploying');
    expect(writes.at(-1)).toContain(`http://${candidate}:8080`);
    ack.release(); expect(await finish(run)).toEqual({ recovered: 1, held: 0 });
    expect((await service())?.runtimeId).toBe(candidate); expect((await job())?.status).toBe('running');
    expect(containers.has(oldId)).toBe(false); expect(containers.has(candidateId)).toBe(true); expect(await rows()).toEqual([]);
    expect(h.agent.mock.calls.find(c => c[2] === 'docker.retire')?.[3]).toEqual({ id: oldId, name: old });
  });

  it('retires a node generation through the immutable recovery operation when legacy Stop is fenced', async () => {
    caps.push('docker.lifecycle');
    await journal(); const original = h.agent.getMockImplementation()!;
    h.agent.mockImplementation(async (...args) => {
      if (args[2] === 'docker.stop') throw Error('Legacy Docker lifecycle is fenced by ordered lifecycle');
      return original(...args);
    });
    expect(await finish(recover())).toEqual({ recovered: 1, held: 0 });
    expect(containers.has(oldId)).toBe(false); expect(containers.has(candidateId)).toBe(true);
    expect(h.agent.mock.calls.some(call => call[2] === 'docker.stop')).toBe(false);
    expect(h.agent.mock.calls.find(call => call[2] === 'docker.retire')?.[3]).toMatchObject({ id: oldId, name: old, graceSeconds: '5' });
  });
  it('ends an interrupted canary on the previous generation before removing its candidate', async () => {
    await journal({ desiredRuntimeId: old });
    expect(await finish(recover())).toEqual({ recovered: 1, held: 0 });
    expect((await service())?.runtimeId).toBe(old); expect((await job())?.status).toBe('failed');
    expect(writes.at(-1)).toContain(`http://${old}:8080`); expect(containers.has(oldId)).toBe(true); expect(containers.has(candidateId)).toBe(false);
  });
  it('recovers the first deployment without inventing an older runtime', async () => {
    await f.db.update(services).set({ runtimeId: null }); await journal({ previous: null });
    expect(await finish(recover())).toEqual({ recovered: 1, held: 0 });
    expect((await service())?.runtimeId).toBe(candidate); expect((await job())?.status).toBe('running'); expect(stops()).toEqual([]);
  });
  it('retains both generations and the original job when the proxy cannot acknowledge routing', async () => {
    await journal(); confirm = async () => { throw Error('proxy unavailable'); };
    expect(await finish(recover())).toEqual({ recovered: 0, held: 1 });
    expect(stops()).toEqual([]); expect((await job())?.status).toBe('deploying');
    expect((await rows())[0]).toMatchObject({ ownerToken: null, attempts: 1, reason: expect.stringContaining('routing on node #5 was not confirmed') });
  });
  it('does not steal a live lease even on an explicit retry', async () => {
    await journal({ ownerToken: 'live-owner', leaseUntil: new Date(Date.now() + 90_000) });
    expect(await finish(recover())).toEqual({ recovered: 0, held: 0 }); expect(h.agent).not.toHaveBeenCalled();
    expect((await rows())[0]?.ownerToken).toBe('live-owner');
  });
  it('retains both generations when its lease changes during acknowledgement', async () => {
    await journal(); const ack = gate(); confirm = () => ack.promise;
    const run = recover(); await pump(run, true);
    await f.db.update(primaryTransitions).set({ ownerToken: 'new-owner', leaseUntil: new Date(Date.now() + 90_000) });
    ack.release(); expect(await finish(run)).toEqual({ recovered: 0, held: 1 });
    expect(stops()).toEqual([]); expect((await job())?.status).toBe('deploying'); expect((await rows())[0]?.ownerToken).toBe('new-owner');
  });
  it('preserves explicit Stop and the selected container for a later Start', async () => {
    await journal(); await f.db.update(services).set({ status: 'stopped' });
    expect(await finish(recover())).toEqual({ recovered: 1, held: 0 });
    expect((await service())?.status).toBe('stopped'); expect((await job())?.status).toBe('cancelled');
    expect(containers.has(oldId)).toBe(true); expect(containers.has(candidateId)).toBe(false);
    expect(h.agent.mock.calls.map(c => c[2])).not.toContain('docker.start'); expect(writes.at(-1)).not.toContain(`http://${old}:8080`);
  });
  it('does not resurrect a cancelled deployment', async () => {
    await journal(); await f.db.update(services).set({ runtimeId: candidate }); await f.db.update(deployments).set({ status: 'cancelled' }).where(eq(deployments.id, 9));
    expect(await finish(recover())).toEqual({ recovered: 1, held: 0 });
    expect((await job())?.status).toBe('cancelled'); expect((await service())?.runtimeId).toBe(old); expect(containers.has(candidateId)).toBe(false);
  });
  it('retains both generations when cancellation arrives while routing is pending', async () => {
    await journal(); const ack = gate(); confirm = () => ack.promise;
    const run = recover(); await pump(run, true); await f.db.update(deployments).set({ status: 'cancelled' }).where(eq(deployments.id, 9));
    ack.release(); expect(await finish(run)).toEqual({ recovered: 0, held: 1 }); expect(stops()).toEqual([]); expect((await job())?.status).toBe('cancelled');
  });
  it.each([{ runtimeId: 'replacement' }, { serverId: null }, { type: 'compose' as const }, { orchestrator: 'swarm' as const }])('holds when service placement changes: %j', async change => {
    await journal(); await f.db.update(services).set(change);
    expect(await finish(recover())).toEqual({ recovered: 0, held: 1 }); expect(stops()).toEqual([]); expect(writes).toEqual([]);
  });
  it('holds when a newer deployment owns the service', async () => {
    await journal(); await f.db.insert(deployments).values({ id: 10, serviceId: 1, status: 'running' });
    expect(await finish(recover())).toEqual({ recovered: 0, held: 1 }); expect(stops()).toEqual([]);
  });
  it('falls back to healthy previous routing if an uncommitted candidate is unhealthy', async () => {
    await journal(); unready.add(candidateId);
    expect(await finish(recover())).toEqual({ recovered: 1, held: 0 }); expect((await service())?.runtimeId).toBe(old);
    expect((await job())?.status).toBe('failed'); expect(containers.has(candidateId)).toBe(false);
  });
  it('never rolls back a committed retirement even if the selected generation becomes unhealthy', async () => {
    await journal({ phase: 'retiring' }); await f.db.update(services).set({ runtimeId: candidate, status: 'running' }); unready.add(candidateId);
    expect(await finish(recover())).toEqual({ recovered: 0, held: 1 }); expect((await service())?.runtimeId).toBe(candidate); expect(stops()).toEqual([]);
  });
  it('retains generations when every replica is not ready', async () => {
    const replicaId = 'c'.repeat(64); containers.set(replicaId, { id: replicaId, name: `${candidate}-r2`, managed: 'service', serviceId: '1', deploymentId: '9' });
    const multiple = group(candidate, candidateId); multiple.replicas = 2; multiple.containers.push({ id: replicaId, name: `${candidate}-r2`, observed: true });
    await journal({ candidate: multiple }); unready.add(replicaId); unready.add(oldId);
    expect(await finish(recover())).toEqual({ recovered: 0, held: 1 }); expect(stops()).toEqual([]); expect(writes).toEqual([]);
  });
  it('retains a renamed obsolete immutable ID without removing it by its reused name', async () => {
    await journal(); containers.get(oldId)!.name = 'renamed-by-operator';
    expect(await finish(recover())).toEqual({ recovered: 0, held: 1 }); expect(stops()).toEqual([]); expect(containers.has(oldId)).toBe(true);
    expect((await rows())[0]?.phase).toBe('retiring');
  });
  it('protects current replica ownership from metadata restoration', async () => {
    await journal(); await f.db.update(services).set({ runtimeId: candidate, runtimeReplicas: 2 });
    expect(await finish(recover())).toEqual({ recovered: 0, held: 1 }); expect((await service())?.runtimeReplicas).toBe(2); expect(stops()).toEqual([]);
  });
  it('does not retire a possible restricted TCP backend using only an HTTP routing receipt', async () => {
    await f.db.update(services).set({ portMappings: [{ hostPort: 9000, containerPort: 8080, protocol: 'tcp', allowFrom: ['127.0.0.1'] }] });
    await journal();
    expect(await finish(recover())).toEqual({ recovered: 0, held: 1 });
    expect(stops()).toEqual([]); expect(containers.size).toBe(2);
    expect((await rows())[0]?.reason).toContain('Restricted TCP port proxy');
  });
  it('retires obsolete stopped autoscale spares without probing them as serving replicas', async () => {
    const spareId = 'c'.repeat(64), previous = group(old, oldId);
    containers.set(spareId, { id: spareId, name: old + '-r2', managed: 'service', serviceId: '1', deploymentId: '7' });
    (previous as PrimaryRuntimeSnapshot & { spares: unknown[] }).spares = [{ id: spareId, name: old + '-r2', observed: true }];
    await journal({ previous }); unready.add(spareId);
    expect(await finish(recover())).toEqual({ recovered: 1, held: 0 });
    expect(containers.has(spareId)).toBe(false); expect(containers.has(candidateId)).toBe(true);
    expect(h.agent.mock.calls.filter(c => c[2] === 'docker.probe').map(c => c[3].name)).not.toContain(spareId);
  });
  it('captures candidate spares as capacity and checks readiness only on serving replicas', async () => {
    const spareId = 'c'.repeat(64);
    containers.set(spareId, { id: spareId, name: candidate + '-r2', managed: 'service', serviceId: '1', deploymentId: '9' });
    const svc = (await service())!, runtime = { runtimeId: candidate, port: 8080, healthPath: '/', healthCheck: 'http-strict' as const };
    const lease = await beginPrimaryTransition(f.db, svc, 9, runtime, { runtimeId: old, port: 8080, healthPath: '/' }, null);
    try {
      expect(lease.row.candidate.spares?.[0]).toEqual({ id: spareId, name: candidate + '-r2', observed: true });
      const probe = vi.fn(async () => true);
      await lease.verifyCandidate({ isHealthy: probe } as never, runtime, 1000, () => {});
      expect(probe.mock.calls).toHaveLength(1);
    } finally { await lease.release(); }
  });
  it('refuses a spare whose immutable creation receipt changed before recovery captures it', async () => {
    const actualSpare = 'd'.repeat(64), expectedSpare = 'c'.repeat(64);
    containers.set(actualSpare, { id: actualSpare, name: candidate + '-r2', managed: 'service', serviceId: '1', deploymentId: '9' });
    const runtime = { runtimeId: candidate, port: 8080, healthPath: '/', replicas: 1,
      nodeTargets: [{ id: candidateId, name: candidate }], nodeCapacityTargets: [
        { id: candidateId, name: candidate }, { id: expectedSpare, name: candidate + '-r2' },
      ] };
    await expect(beginPrimaryTransition(f.db, (await service())!, 9, runtime, { runtimeId: old, port: 8080, healthPath: '/' }, null))
      .rejects.toThrow(/identit/i);
    expect(stops()).toEqual([]);
    expect((await rows())[0]?.candidate.spares?.[0]).toMatchObject({ id: expectedSpare, observed: false });
  });
  it('records unchanged creation receipts for serving and spare capacity', async () => {
    const spareId = 'c'.repeat(64);
    containers.set(spareId, { id: spareId, name: candidate + '-r2', managed: 'service', serviceId: '1', deploymentId: '9' });
    const runtime = { runtimeId: candidate, port: 8080, healthPath: '/', replicas: 1,
      nodeTargets: [{ id: candidateId, name: candidate }], nodeCapacityTargets: [
        { id: candidateId, name: candidate }, { id: spareId, name: candidate + '-r2' },
      ] };
    const lease = await beginPrimaryTransition(f.db, (await service())!, 9, runtime, { runtimeId: old, port: 8080, healthPath: '/' }, null);
    try { expect(lease.row.candidate.spares?.[0]).toEqual({ id: spareId, name: candidate + '-r2', observed: true }); }
    finally { await lease.release(); }
  });
  it('transfers prepared serving and spare receipts into ordered primary recovery', async () => {
    await f.db.update(services).set({ runtimeReplicas: 1, autoscale: { minReplicas: 1, maxReplicas: 3, metric: 'cpu', target: 70,
      scaleUpSeconds: 60, scaleDownSeconds: 120 } }).where(eq(services.id, 1));
    const authority = await reserveServiceRuntimeOwner(f.db, 1, 'deploy', null, 'c'.repeat(32));
    const owner = { deploymentId: 9, serviceId: 1, serverId: 5, epoch: authority.epoch, requestId: authority.requestId! };
    await f.db.insert(deploymentRuntimeOwners).values(owner);
    const supported = ['docker.mutations', 'docker.prepareAttemptEnv', 'docker.startSet', 'docker.readiness', 'proxy.routingAck', 'proxy.orderedWrite', 'image.manage', 'docker.runSpec'];
    const prepareAgent = async (op: string, params: Record<string, unknown>) => {
      if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.19.0', caps: supported })}`] };
      if (op === 'docker.imageInspect') return { exitCode: 0, lines: [`sha256:${'f'.repeat(64)}|123`] };
      if (op === 'file.writeEnv') return { exitCode: 0, lines: [`wrote .agent-env/${params.name}.env`] };
      if (op === 'file.deleteEnv') return { exitCode: 0, lines: [] };
      throw new Error(`Unexpected preparation operation ${op}`);
    };
    const client = {
      fence: async ({ timeoutMs: _timeout, ...input }: { requestId: string; serviceId: number; revision: number; timeoutMs: number; deploymentWatermark: number }) => ({ ...input, complete: true }),
      prepare: async (input: Parameters<Parameters<typeof prepareNodeAutoscaleDeployment>[0]['client']['prepare']>[0]) => {
        const ids = [candidateId, 'd'.repeat(64), 'e'.repeat(64)];
        const items = input.specs.map((spec, index) => {
          const item = { id: ids[index]!, name: spec.name, deploymentId: input.deploymentId, running: input.startNames!.includes(spec.name) };
          containers.set(item.id, { id: item.id, name: item.name, managed: 'service', serviceId: '1', deploymentId: '9' });
          return item;
        });
        return { requestId: input.requestId, serviceId: input.serviceId, deploymentId: input.deploymentId, revision: input.revision, complete: true, items };
      },
    };
    const svc = (await service())!;
    const journal = { begin: (spec: Parameters<typeof beginNodeDeploymentPreparation>[2]) => beginNodeDeploymentPreparation(f.db, owner, spec),
      complete: (targets: Parameters<typeof completeNodeDeploymentPreparation>[2]) => completeNodeDeploymentPreparation(f.db, owner, targets) };
    const prepared = await prepareNodeAutoscaleDeployment({ service: svc, owner, image: 'fixture:latest', creationWatermark: 9, env: {},
      agent: prepareAgent, client, sealed: true, checkpoint: () => createNodeDeploymentAuthority(f.db, owner).check(), log: () => {}, journal });
    expect(await f.db.select().from(nodeDeploymentPreparations)).toHaveLength(1);
    const lease = await beginPrimaryTransition(f.db, svc, 9, prepared.runtime, { runtimeId: old, port: 8080, healthPath: '/' }, null);
    try {
      expect(lease.row.orderedOwner).toMatchObject(owner);
      expect(lease.row.candidate.containers[0]).toEqual({ id: candidateId, name: candidate, observed: true });
      expect(lease.row.candidate.spares?.slice(0, 2)).toEqual([
        { id: 'd'.repeat(64), name: candidate + '-r2', observed: true }, { id: 'e'.repeat(64), name: candidate + '-r3', observed: true },
      ]);
      expect(stops()).toEqual([]);
      expect(await f.db.select().from(nodeDeploymentPreparations)).toEqual([]);
      expect(await f.db.select().from(nodeAutoscaleCapacity)).toMatchObject([{ deploymentId: 9, serviceId: 1, serverId: 5,
        runtimeId: candidate, imageId: prepared.imageId, targets: prepared.capacity }]);
    } finally { await lease.release(); }
  });
  it('retains preparation evidence when the recovery lease, image or observed identity does not match', async () => {
    const authority = await reserveServiceRuntimeOwner(f.db, 1, 'deploy', null, 'c'.repeat(32));
    const owner = { deploymentId: 9, serviceId: 1, serverId: 5, epoch: authority.epoch, requestId: authority.requestId! };
    const imageId = `sha256:${'f'.repeat(64)}`, token = 'recovery-owner';
    await f.db.insert(deploymentRuntimeOwners).values(owner);
    await beginNodeDeploymentPreparation(f.db, owner, { runtimeId: candidate, imageId, serving: 1, capacity: 1 });
    await completeNodeDeploymentPreparation(f.db, owner, [{ name: candidate, id: candidateId }]);
    await f.db.insert(primaryTransitions).values({ serviceId: 1, serverId: 5, deploymentId: 9, orderedOwner: owner,
      previous: group(old, oldId), candidate: { ...group(candidate, candidateId), spares: [] }, imageDigest: imageId,
      ownerToken: token, leaseUntil: new Date(Date.now() + 60_000) });
    await expect(handoffNodeDeploymentPreparation(f.db, owner, 'wrong-owner')).rejects.toThrow(/handoff/);
    await f.db.update(primaryTransitions).set({ imageDigest: `sha256:${'a'.repeat(64)}` });
    await expect(handoffNodeDeploymentPreparation(f.db, owner, token)).rejects.toThrow(/handoff/);
    await f.db.update(primaryTransitions).set({ imageDigest: imageId, candidate: { ...group(candidate, candidateId),
      containers: [{ name: candidate, id: candidateId, observed: false }], spares: [] } });
    await expect(handoffNodeDeploymentPreparation(f.db, owner, token)).rejects.toThrow(/handoff/);
    expect(await f.db.select().from(nodeDeploymentPreparations)).toHaveLength(1);
    await f.db.update(primaryTransitions).set({ candidate: { ...group(candidate, candidateId), spares: [] } });
    await f.db.insert(nodeAutoscaleCapacity).values({ deploymentId: 9, serviceId: 1, serverId: 5, runtimeId: candidate, imageId,
      targets: [{ name: candidate, id: 'e'.repeat(64) }] });
    await expect(handoffNodeDeploymentPreparation(f.db, owner, token)).rejects.toThrow(/capacity receipt changed/);
    expect(await f.db.select().from(nodeDeploymentPreparations)).toHaveLength(1);
    expect(stops()).toEqual([]);
  });
  it('completes a preparation handoff after recovery claims an interrupted transition', async () => {
    const authority = await reserveServiceRuntimeOwner(f.db, 1, 'deploy', null, 'c'.repeat(32));
    const owner = { deploymentId: 9, serviceId: 1, serverId: 5, epoch: authority.epoch, requestId: authority.requestId! };
    const imageId = `sha256:${'f'.repeat(64)}`;
    await f.db.insert(deploymentRuntimeOwners).values(owner);
    await beginNodeDeploymentPreparation(f.db, owner, { runtimeId: candidate, imageId, serving: 1, capacity: 1 });
    await completeNodeDeploymentPreparation(f.db, owner, [{ name: candidate, id: candidateId }]);
    await f.db.insert(primaryTransitions).values({ serviceId: 1, serverId: 5, deploymentId: 9, orderedOwner: owner,
      previous: group(old, oldId), candidate: { ...group(candidate, candidateId),
        containers: [{ name: candidate, id: candidateId, observed: false }], spares: [] }, imageDigest: imageId });
    unready.add(oldId);
    expect(await finish(recover())).toMatchObject({ recovered: 0, held: 1 });
    expect(await f.db.select().from(nodeDeploymentPreparations)).toEqual([]);
    expect((await rows())[0]?.candidate.containers[0]).toMatchObject({ id: candidateId, observed: true });
    expect(stops()).toEqual([]);
  });
  it('refuses malformed capacity receipts before creating a recovery record', async () => {
    const svc = (await service())!, serving = { id: candidateId, name: candidate }, spare = { id: 'c'.repeat(64), name: candidate + '-r2' };
    for (const nodeCapacityTargets of [[], [serving, { ...spare, id: candidateId }], [serving, { ...spare, name: candidate + '-r3' }],
      [{ ...serving, id: 'd'.repeat(64) }, spare]]) {
      await expect(beginPrimaryTransition(f.db, svc, 9, { runtimeId: candidate, port: 8080, healthPath: '/', replicas: 1,
        nodeTargets: [serving], nodeCapacityTargets }, { runtimeId: old, port: 8080, healthPath: '/' }, null)).rejects.toThrow(/capacity creation identities/);
    }
    expect(await rows()).toEqual([]); expect(stops()).toEqual([]);
  });
  it('does not adopt an unrelated container occupying a possible spare name', async () => {
    containers.set('c'.repeat(64), { id: 'c'.repeat(64), name: candidate + '-r2', managed: 'service', serviceId: '999', deploymentId: '9' });
    await expect(beginPrimaryTransition(f.db, (await service())!, 9, { runtimeId: candidate, port: 8080, healthPath: '/', healthCheck: 'http-strict' }, { runtimeId: old, port: 8080, healthPath: '/' }, null)).rejects.toThrow('Container identity is unconfirmed');
    expect(stops()).toEqual([]); expect(writes).toEqual([]); expect(containers.has('c'.repeat(64))).toBe(true);
  });
  it('keeps selected stopped spares and excludes them from serving readiness', async () => {
    const spareId = 'c'.repeat(64), selected = group(candidate, candidateId);
    selected.spares = [{ id: spareId, name: candidate + '-r2', observed: true }];
    containers.set(spareId, { id: spareId, name: candidate + '-r2', managed: 'service', serviceId: '1', deploymentId: '9' });
    await journal({ candidate: selected }); unready.add(spareId);
    expect(await finish(recover())).toEqual({ recovered: 1, held: 0 }); expect(containers.has(spareId)).toBe(true);
    expect(h.agent.mock.calls.filter(c => c[2] === 'docker.probe').map(c => c[3].name)).not.toContain(spareId);
  });
  it('keeps tokens and immutable container IDs out of the recovery view', async () => {
    await journal({ ownerToken: 'secret-token', leaseUntil: new Date(Date.now() + 90_000) });
    const view = JSON.stringify(await listPrimaryRecovery(f.db, 1)); expect(view).not.toContain('secret-token'); expect(view).not.toContain(candidateId); expect(view).toContain('"busy":true');
  });
  it('refuses an unknown candidate owner before any routing or name-based removal', async () => {
    containers.get(candidateId)!.serviceId = '999';
    const svc = (await service())!;
    await expect(beginPrimaryTransition(f.db, svc, 9, { runtimeId: candidate, port: 8080, healthPath: '/', healthCheck: 'http-strict' }, { runtimeId: old, port: 8080, healthPath: '/' }, null)).rejects.toThrow('Container identity is unconfirmed');
    expect(stops()).toEqual([]); expect(writes).toEqual([]); expect(await rows()).toHaveLength(1);
  });
});

describe('a queued deploy shortens the recovery backoff', () => {
  const backedOff = () => journal({ nextAttemptAt: new Date(Date.now() + 3600_000), updatedAt: new Date(Date.now() - 120_000), interrupted: false });
  const sweep = async () => { h.agent.mockRejectedValue(new Error('node offline')); await pump(reconcilePrimaryTransitions(f.db)); };

  it('waits out the backoff while nothing is queued', async () => {
    await backedOff();
    await sweep();
    expect((await rows())[0]!.attempts).toBe(0);
  });

  it('retries a minute after the last attempt while a deploy of the service is queued', async () => {
    await backedOff();
    await f.db.insert(deployments).values({ id: 10, serviceId: 1, status: 'queued' });
    await sweep();
    expect((await rows())[0]!.attempts).toBe(1);
    // The failed attempt just touched the row: the next sweep waits again.
    await sweep();
    expect((await rows())[0]!.attempts).toBe(1);
  });
  it('rechecks eligibility when backoff changes after the scan', async () => {
    await journal();
    const selected = gate(), resume = gate(); let first = true;
    const db = new Proxy(f.db, { get(real, property, receiver) {
      if (property !== 'select') return Reflect.get(real, property, receiver);
      return (...args: Parameters<typeof real.select>) => {
        const query = real.select(...args);
        if (!first || args.length) return query;
        first = false;
        return { from: (table: typeof primaryTransitions) => ({ where: (condition: Parameters<ReturnType<typeof query.from>['where']>[0]) => ({
          limit: async (count: number) => { const found = await query.from(table).where(condition).limit(count); selected.release(); await resume.promise; return found; },
        }) }) };
      };
    } }) as typeof f.db;
    const run = reconcilePrimaryTransitions(db);
    try {
      await selected.promise;
      await f.db.update(primaryTransitions).set({ nextAttemptAt: new Date(Date.now() + 60_000), updatedAt: new Date(), attempts: 4 });
    } finally { resume.release(); }
    expect(await finish(run)).toEqual({ recovered: 0, held: 0 });
    expect(h.agent).not.toHaveBeenCalled();
    expect((await rows())[0]).toMatchObject({ attempts: 4, ownerToken: null });
  });
});
