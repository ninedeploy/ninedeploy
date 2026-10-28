import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setImmediate as yieldIO } from 'node:timers';
import { eq } from 'drizzle-orm';
import { domains, fanoutTransitions, servers, services, serviceTargets } from '@ninedeploy/db';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observabilityDb } from './fixtures/observability.js';

const h = vi.hoisted(() => ({ agent: vi.fn(), sealed: vi.fn(async () => true), config: { paths: { dataDir: '' }, acmeEmail: null } }));
vi.mock('../src/config.js', () => ({ config: h.config }));
vi.mock('../src/lib/agentClient.js', () => ({ agentOp: h.agent, agentTransportSealed: h.sealed }));
vi.mock('../src/lib/exec.js', () => ({ capture: vi.fn(async () => ''), run: vi.fn(async () => {}), sleep: (ms: number) => new Promise(r => setTimeout(r, ms)) }));
const temp = mkdtempSync(path.join(os.tmpdir(), 'nd-fanout-routing-'));
h.config.paths.dataDir = temp;
const { deployToTargets, recordFanoutResults } = await import('../src/engine/fanout.js');
// Load the real dynamic writer before fake time; Vite's first module transform
// is not a deployment timer or an agent acknowledgement gate.
await import('../src/lib/nodeProxy.js');
const { reconcileFanoutTransitions } = await import('../src/engine/fanoutRecovery.js');
let f: Awaited<ReturnType<typeof observabilityDb>>;
let caps: string[];
let confirm: (content: string) => Promise<void>;
let writes: string[];
const logs: string[] = [];
const service = { id: 1, slug: 'web', type: 'docker', image: 'app:1', port: 8080, cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0, volumeMount: null, publishedPort: null };
const old = 'web-t5-8', candidate = 'web-t5-9';
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
beforeEach(async () => {
  f = await observabilityDb();
  await f.db.update(services).set({ port: 8080 }).where(eq(services.id, 1));
  await f.db.insert(servers).values({ id: 5, name: 'Edge', host: 'edge.test', tokenEncrypted: 'unused' });
  await f.db.insert(serviceTargets).values({ id: 1, serviceId: 1, serverId: 5, runtimeId: old, status: 'running' });
  await f.db.insert(domains).values({ serviceId: 1, hostname: 'app.test', ssl: false, status: 'active' });
  caps = ['proxy.routingAck', 'docker.recovery', 'docker.probe']; writes = []; logs.length = 0; confirm = async () => {};
  h.sealed.mockResolvedValue(true);
  h.agent.mockReset().mockImplementation(async (_db, _id, op, p) => {
    if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.17.2', caps })}`] };
    if (op === 'file.writeEnv') return { exitCode: 0, lines: [`wrote .agent-env/${String(p.name)}.env`] };
    if (op === 'docker.inspect') return { exitCode: 0, lines: [p.format === 'health' ? 'running|none|0|0' : 'running|172.18.0.2'] };
    if (op === 'docker.identity') {
      const isOld = p.name === old || p.name === 'a'.repeat(64);
      return { exitCode: 0, lines: [`ND-CONTAINER ${JSON.stringify({ id: (isOld ? 'a' : 'b').repeat(64), name: isOld ? old : candidate, managed: 'service', serviceId: '1', deploymentId: isOld ? '8' : '9' })}`] };
    }
    if (op === 'docker.probe') return { exitCode: 0, lines: [`ND-PROBE ${JSON.stringify({ ready: true, protocol: p.protocol, ...(p.protocol === 'http' ? { status: 200 } : {}) })}`] };
    if (op === 'docker.retire') return { exitCode: 0, lines: [`ND-RETIRED ${p.id}`] };
    if (op === 'proxy.writeConfig') { if (p.kind === 'dynamic') writes.push(p.content); return { exitCode: 0, lines: ['proxy-config x unchanged'] }; }
    if (op === 'proxy.confirmRouting') { await confirm(p.content); return { exitCode: 0, lines: [`ND-PROXY-ROUTING ${createHash('sha256').update(p.content).digest('hex')}`] }; }
    return { exitCode: 0, lines: [] };
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => { vi.useRealTimers(); f?.close(); });
afterAll(() => rmSync(temp, { recursive: true, force: true }));
function start() { return deployToTargets(f.db, { service, deploymentId: 9, primaryRuntimeId: 'web-7', image: 'app:1', env: {}, primaryServerId: null }, line => logs.push(line)).then(async result => { await recordFanoutResults(f.db, 1, result); return result; }); }
async function pump(run: Promise<unknown>, pending = false) {
  let done = false; void run.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 2000 && !done; i++) {
    if (pending && h.agent.mock.calls.some(c => c[2] === 'proxy.confirmRouting')) return;
    // Advance readiness/drain timers, but do not expire their deadlines while
    // SQLite is yielding through native I/O with no timer to complete.
    // Heartbeats use real intervals; only readiness and drain timeouts are fake.
    if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
    await new Promise<void>(resolve => yieldIO(resolve));
  }
  if (!done) throw new Error(`Fan-out fixture did not reach its explicit completion gate: ${JSON.stringify({ pending, ops: h.agent.mock.calls.map(c => c[2]), logs, timers: vi.getTimerCount() })}`);
}
async function finish<T>(run: Promise<T>) { await pump(run); return run; }
const stops = () => h.agent.mock.calls.filter(c => c[2] === 'docker.stop' || c[2] === 'docker.retire').map(c => c[3].name);
const target = () => f.db.query.serviceTargets.findFirst({ where: eq(serviceTargets.id, 1) });
describe('routed fan-out promotion through SQLite and the real renderer/writer', () => {
  it('keeps the old runtime until the node confirms the loaded generation', async () => {
    const ack = gate(); confirm = () => ack.promise;
    const run = start(); await pump(run, true);
    const before = { stops: stops(), writes: [...writes], confirms: h.agent.mock.calls.filter(c => c[2] === 'proxy.confirmRouting').length };
    ack.release(); const result = await finish(run);
    expect(before.stops).not.toContain(old);
    expect(before.confirms).toBe(1);
    expect(before.writes.at(-1)).toContain(`http://${candidate}:8080`);
    expect(result[0]).toMatchObject({ ok: true, runtimeId: candidate });
    expect(stops()).toContain(old);
    expect((await target())?.runtimeId).toBe(candidate);
  });
  it('confirms rollback before removing a candidate after a failed routing acknowledgement', async () => {
    let calls = 0; confirm = async () => { if (++calls === 1) throw Error('reload not observed'); };
    const result = await finish(start());
    expect(result[0]).toMatchObject({ ok: false, runtimeId: old });
    expect(calls).toBe(2);
    expect(writes.at(-1)).toContain(`http://${old}:8080`);
    expect(stops()).not.toContain(old); expect(stops()).toContain(candidate);
    expect((await target())?.runtimeId).toBe(old);
  });
  it('keeps both possible serving generations when rollback also remains unconfirmed', async () => {
    confirm = async () => { throw Error('reload not observed'); };
    const result = await finish(start());
    expect(result[0]).toMatchObject({ ok: false, runtimeId: old });
    expect(stops()).toEqual([]);
    expect(logs.join('\n')).toContain('both runtime generations are kept running');
  });
  it('does not overwrite a target replaced while acknowledgement was pending', async () => {
    const ack = gate(); confirm = () => ack.promise;
    const run = start(); await pump(run, true);
    await f.db.update(serviceTargets).set({ runtimeId: 'new-owner', status: 'running' }).where(eq(serviceTargets.id, 1));
    ack.release(); await finish(run);
    expect((await target())?.runtimeId).toBe('new-owner'); expect(stops()).not.toContain(old);
  });
  it('does not resurrect a target removed during acknowledgement', async () => {
    const ack = gate(); confirm = () => ack.promise;
    const run = start(); await pump(run, true);
    await f.db.delete(serviceTargets).where(eq(serviceTargets.id, 1)); ack.release(); await finish(run);
    expect(await target()).toBeUndefined(); expect(stops()).not.toContain(old);
  });
  it('does not publish or retire the previous target after the service was stopped during acknowledgement', async () => {
    const ack = gate(); confirm = () => ack.promise;
    const run = start(); await pump(run, true);
    await f.db.update(services).set({ status: 'stopped' }).where(eq(services.id, 1));
    ack.release(); await finish(run);
    expect((await f.db.query.services.findFirst({ where: eq(services.id, 1) }))?.status).toBe('stopped');
    expect((await target())?.status).not.toBe('running'); expect(stops()).not.toContain(old);
  });
  it('does not overwrite a replacement target after a gated image pull failure', async () => {
    const pull = gate(); const original = h.agent.getMockImplementation()!; let pulling = false;
    h.agent.mockImplementation(async (...args) => {
      if (args[2] === 'docker.pull') { pulling = true; await pull.promise; throw Error('pull failed'); }
      return original(...args);
    });
    const run = start();
    for (let i = 0; i < 2000 && !pulling; i++) { await vi.advanceTimersByTimeAsync(100); await new Promise<void>(resolve => yieldIO(resolve)); }
    expect(pulling).toBe(true);
    await f.db.update(serviceTargets).set({ runtimeId: 'new-owner' }).where(eq(serviceTargets.id, 1));
    pull.release(); await finish(run);
    expect((await target())?.runtimeId).toBe('new-owner'); expect(stops()).toEqual([]);
  });
  it('refuses an old routing agent before starting or retiring a routed target', async () => {
    caps = [];
    expect((await finish(start()))[0]).toMatchObject({ ok: false, runtimeId: old, error: expect.stringMatching(/confirm loaded HTTP\/TLS routing/) });
    expect(h.agent.mock.calls.map(c => c[2])).not.toContain('docker.runEnv'); expect(stops()).toEqual([]);
  });
  it('still deploys an unrouted worker with a legacy agent (unaffected control)', async () => {
    caps = []; await f.db.delete(domains);
    expect((await finish(start()))[0]).toMatchObject({ ok: true, runtimeId: candidate });
    expect(stops()).toContain(old); expect(writes).toEqual([]);
  });
});

async function journal(overrides: Partial<typeof fanoutTransitions.$inferInsert> = {}) {
  await f.db.insert(fanoutTransitions).values({ serviceId: 1, serverId: 5, targetId: 1, deploymentId: 9, primaryRuntimeId: 'web-7',
    previousRuntimeId: old, candidateRuntimeId: candidate, previousContainerId: 'a'.repeat(64), candidateContainerId: 'b'.repeat(64),
    port: 8080, phase: 'retained', ...overrides });
}
const pendingJournal = () => f.db.select().from(fanoutTransitions);
const recover = () => reconcileFanoutTransitions(f.db, { serviceId: 1, force: true });
describe('durable fan-out reconciliation', () => {
  it('restores a healthy previous generation before retiring an unhealthy uncommitted candidate', async () => {
    await journal({ healthCheck: 'http-strict' }); await f.db.update(serviceTargets).set({ runtimeId: candidate, status: 'idle' });
    const original = h.agent.getMockImplementation()!;
    h.agent.mockImplementation(async (...args) => args[2] === 'docker.probe'
      ? { exitCode: 0, lines: [`ND-PROBE ${JSON.stringify({ ready: args[3].name === 'a'.repeat(64), protocol: args[3].protocol, status: args[3].name === 'a'.repeat(64) ? 200 : 503 })}`] } : original(...args));
    expect(await finish(recover())).toEqual({ recovered: 1, held: 0 });
    expect((await target())?.runtimeId).toBe(old); expect(stops()).toEqual([candidate]);
    expect(writes.at(-1)).toContain(`http://${old}:8080`);
  });
  it('retains both generations when neither generation passes fresh HTTP readiness', async () => {
    await journal({ healthCheck: 'http-strict' }); await f.db.update(serviceTargets).set({ runtimeId: candidate, status: 'idle' });
    const original = h.agent.getMockImplementation()!;
    h.agent.mockImplementation(async (...args) => args[2] === 'docker.probe'
      ? { exitCode: 0, lines: [`ND-PROBE ${JSON.stringify({ ready: false, protocol: args[3].protocol })}`] } : original(...args));
    expect(await finish(recover())).toEqual({ recovered: 0, held: 1 });
    expect((await target())?.runtimeId).toBe(candidate); expect(stops()).toEqual([]); expect(writes).toEqual([]);
  });
  it('does not finalize or retire a generation after losing its lease during routing acknowledgement', async () => {
    await journal(); await f.db.update(serviceTargets).set({ runtimeId: candidate, status: 'idle' });
    const ack = gate(); confirm = () => ack.promise;
    const run = recover(); await pump(run, true);
    await f.db.update(fanoutTransitions).set({ ownerToken: 'new-owner', leaseUntil: new Date(Date.now() + 90_000) });
    ack.release(); expect(await finish(run)).toEqual({ recovered: 0, held: 1 });
    expect(stops()).toEqual([]); expect((await target())?.status).toBe('idle');
    expect((await pendingJournal())[0]?.ownerToken).toBe('new-owner');
  });
  it('resumes an interrupted candidate routing phase and retires the old immutable container', async () => {
    await journal(); await f.db.update(serviceTargets).set({ runtimeId: candidate, status: 'idle' });
    expect(await finish(recover())).toEqual({ recovered: 1, held: 0 });
    expect((await target())?.status).toBe('running'); expect(await pendingJournal()).toEqual([]);
    expect(h.agent.mock.calls.find(c => c[2] === 'docker.retire')?.[3]).toEqual({ id: 'a'.repeat(64), name: old });
  });
  it('keeps confirmed previous routing and removes an abandoned candidate after restart', async () => {
    await journal(); expect(await finish(recover())).toEqual({ recovered: 1, held: 0 });
    expect((await target())?.runtimeId).toBe(old); expect(stops()).toEqual([candidate]);
  });
  it('retains both generations and an actionable journal when routing is unavailable', async () => {
    await journal(); confirm = async () => { throw Error('node routing unavailable'); };
    expect(await finish(recover())).toEqual({ recovered: 0, held: 1 });
    expect(stops()).toEqual([]); expect((await pendingJournal())[0]).toMatchObject({ phase: 'retained', ownerToken: null, attempts: 1 });
  });
  it('never starts or removes containers for an explicitly stopped service', async () => {
    await journal(); await f.db.update(services).set({ status: 'stopped' });
    expect(await finish(recover())).toEqual({ recovered: 0, held: 1 }); expect(stops()).toEqual([]);
    expect(h.agent.mock.calls.map(c => c[2])).not.toContain('docker.start');
  });
  it('does not steal a live deploy lease even when the operator retries', async () => {
    await journal({ ownerToken: 'active-deployment', leaseUntil: new Date(Date.now() + 90_000) });
    expect(await recover()).toEqual({ recovered: 0, held: 0 }); expect(h.agent).not.toHaveBeenCalled();
  });
  it('allows only one reconciler to claim the same persisted transition', async () => {
    await journal(); const a = recover(), b = recover(); await pump(Promise.all([a, b]));
    expect((await a).recovered + (await b).recovered).toBe(1); expect(stops()).toEqual([candidate]);
  });
  it('does not delete by a reused container name when its original immutable ID disappeared', async () => {
    await journal(); const original = h.agent.getMockImplementation()!;
    h.agent.mockImplementation(async (...args) => args[2] === 'docker.identity' && args[3].name === 'a'.repeat(64)
      ? { exitCode: 0, lines: ['ND-CONTAINER null'] } : original(...args));
    expect(await finish(recover())).toEqual({ recovered: 0, held: 1 }); expect(stops()).toEqual([]);
  });
  it('captures a post-crash candidate only when its managed service/deployment labels match', async () => {
    await journal({ candidateContainerId: null }); expect((await finish(recover())).recovered).toBe(1);
    expect(stops()).toEqual([candidate]);
  });
  it('refuses an unrecorded candidate belonging to another deployment', async () => {
    await journal({ candidateContainerId: null }); const original = h.agent.getMockImplementation()!;
    h.agent.mockImplementation(async (...args) => args[2] === 'docker.identity' && args[3].name === candidate
      ? { exitCode: 0, lines: [`ND-CONTAINER ${JSON.stringify({ id: 'c'.repeat(64), name: candidate, managed: 'service', serviceId: '1', deploymentId: '99' })}`] } : original(...args));
    expect((await finish(recover())).held).toBe(1); expect(stops()).toEqual([]);
  });
  it('confirms target removal before clearing both retained generations without recreating the target', async () => {
    await journal(); await f.db.delete(serviceTargets);
    const result = await finish(recover());
    expect(result.recovered, JSON.stringify(await pendingJournal())).toBe(1); expect(await target()).toBeUndefined();
    expect(stops()).toEqual([old, candidate]); expect(writes.at(-1)).not.toContain(`http://${old}:8080`);
  });
  it('does not retire anything after a newer primary owner arrives during routing confirmation', async () => {
    await journal(); const ack = gate(); confirm = () => ack.promise;
    const run = recover(); await pump(run, true); await f.db.update(services).set({ runtimeId: 'web-99' }); ack.release();
    expect((await finish(run)).held).toBe(1); expect(stops()).toEqual([]); expect((await target())?.runtimeId).toBe(old);
  });
  it('never restores a generation whose retirement was already committed by a previous owner', async () => {
    await journal({ phase: 'retiring', desiredRuntimeId: candidate, healthCheck: 'http-strict' });
    await f.db.update(serviceTargets).set({ runtimeId: candidate, status: 'running' });
    const original = h.agent.getMockImplementation()!;
    h.agent.mockImplementation(async (...args) => args[2] === 'docker.probe'
      ? { exitCode: 0, lines: [`ND-PROBE ${JSON.stringify({ ready: args[3].name !== 'b'.repeat(64), protocol: args[3].protocol, status: args[3].name !== 'b'.repeat(64) ? 200 : 503 })}`] } : original(...args));
    expect((await finish(recover())).held).toBe(1);
    expect((await target())?.runtimeId).toBe(candidate); expect(stops()).toEqual([]);
  });
});
