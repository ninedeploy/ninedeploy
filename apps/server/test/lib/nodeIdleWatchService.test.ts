import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { databases, databaseAttachments, deployments, nodeAutoscaleCapacity, services, type Service } from '@ninedeploy/db';
import { idleWatchOpen } from '@ninedeploy/schemas';
import { openServiceNodeIdleWatch } from '../../src/lib/nodeIdleWatchService.js';
import { servingReceiptFixture } from '../fixtures/servingTrafficReceipt.js';
import { NodeIdleWatch } from '../../src/lib/nodeIdleWatch.js';
import sleeperPlugin from '../../src/plugins/sleeper.js';
import { reserveServiceRuntimeOwner } from '../../src/lib/serviceRuntimeOwner.js';
import { config } from '../../src/config.js';
import { readServiceSleepStatus } from '../../src/lib/serviceSleepStatus.js';

const io = vi.hoisted(() => ({ op: vi.fn(), sealed: vi.fn(async () => true) }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: io.op, agentTransportSealed: io.sealed }));
let f: Awaited<ReturnType<typeof servingReceiptFixture>>, service: Service, sequence: number, engine: NodeIdleWatch, caps: string[];
const readers = new Set<(line: string) => void>();
const identity = (name: string) => ({ id: (name.endsWith('-r2') ? 'b' : 'a').repeat(64), name, managed: 'service', serviceId: '1', deploymentId: '9' });
beforeEach(async () => {
  vi.clearAllMocks(); io.sealed.mockResolvedValue(true);
  f = await servingReceiptFixture('file::memory:');
  await f.c.db.update(services).set({ sleepAfterMinutes: 5, runtimeReplicas: 2 });
  service = (await f.c.db.query.services.findFirst())!;
  caps = ['docker.recovery', 'proxy.idleWatch']; sequence = 0;
  engine = new NodeIdleWatch({ inspect: async () => ({ proxyId: 'f'.repeat(64), sourceId: 'e'.repeat(64) }),
    connect: (_proxy, line) => { readers.add(line); return { ready: Promise.resolve(), close: () => readers.delete(line) }; },
    heartbeat: async (_proxy, path) => { const current = ++sequence; for (const line of readers) line(`127.0.0.1 - - [02/Nov/2026:12:00:00 +0000] "GET ${path} HTTP/1.1" 404 0 "-" "-" ${current} "-" "-" 1ms`); },
  });
  io.op.mockImplementation(async (_db, _node, op, args) => {
    if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.19.0', caps })}`] };
    if (op === 'docker.identity') return { exitCode: 0, lines: [`ND-CONTAINER ${JSON.stringify(identity(args.name))}`] };
    let result: unknown;
    if (op === 'proxy.idleWatch.open') result = { kind: 'open', snapshot: await engine.open(args) };
    else if (op === 'proxy.idleWatch.sample') result = { kind: 'sample', items: await engine.sample(args) };
    else if (op === 'proxy.idleWatch.finish') result = { kind: 'finish', snapshot: await engine.finish(args) };
    else if (op === 'proxy.idleWatch.close') result = { kind: 'close', ...engine.close(args) };
    else throw new Error(`Unexpected agent operation ${op}`);
    return { exitCode: 0, lines: [`ND-IDLE-WATCH ${JSON.stringify(result)}`] };
  });
});
afterEach(() => { engine.closeAll(); expect(readers.size).toBe(0); vi.restoreAllMocks(); vi.useRealTimers(); f.c.client?.close(); });

it('resolves every normal serving replica by immutable identity with sealed calls and no spare-capacity dependency', async () => {
  await f.c.db.delete(nodeAutoscaleCapacity);
  const abort = new AbortController(), window = await openServiceNodeIdleWatch(f.c.db, service, abort.signal);
  expect(window.input.serving).toEqual([{ name: 'web-9', id: 'a'.repeat(64), port: 3000 }, { name: 'web-9-r2', id: 'b'.repeat(64), port: 3000 }]);
  expect(idleWatchOpen.parse(window.input).durationMs).toBe(60_000);
  const identities = io.op.mock.calls.filter(args => args[2] === 'docker.identity');
  expect(identities).toHaveLength(2); expect(identities.every(args => args[1] === 4 && args[5].signal === abort.signal)).toBe(true);
  await window.close();
});
it.each([{ type: 'compose' }, { orchestrator: 'swarm' }, { serverId: null }, { runtimeId: 'other-9' }, { runtimeReplicas: 0 }, { runtimeReplicas: 11 }])('refuses invalid placement before agent contact: %j', async patch => {
  await expect(openServiceNodeIdleWatch(f.c.db, { ...service, ...patch } as Service, new AbortController().signal)).rejects.toThrow(/placement|generation/);
  expect(io.op).not.toHaveBeenCalled();
});
it('requires sealed recovery and idle-watch capabilities before resolving serving IDs', async () => {
  caps = ['proxy.idleWatch']; await expect(openServiceNodeIdleWatch(f.c.db, service, new AbortController().signal)).rejects.toThrow(/unavailable/);
  caps = ['docker.recovery']; await expect(openServiceNodeIdleWatch(f.c.db, service, new AbortController().signal)).rejects.toThrow(/unavailable/);
  io.sealed.mockResolvedValue(false); await expect(openServiceNodeIdleWatch(f.c.db, service, new AbortController().signal)).rejects.toThrow(/unencrypted/);
  expect(io.op.mock.calls.some(args => args[2] === 'docker.identity')).toBe(false);
});
it('refuses another deployment serving identity before opening a watch', async () => {
  const original = io.op.getMockImplementation()!;
  io.op.mockImplementation(async (...args) => args[2] === 'docker.identity'
    ? { exitCode: 0, lines: [`ND-CONTAINER ${JSON.stringify({ ...identity(args[3].name), deploymentId: '10' })}`] } : original(...args));
  await expect(openServiceNodeIdleWatch(f.c.db, service, new AbortController().signal)).rejects.toThrow(/labels/);
  expect(io.op.mock.calls.some(args => args[2] === 'proxy.idleWatch.open')).toBe(false);
});
it.each([
  { exitCode: 1, lines: [] }, { exitCode: 0, lines: [] },
  { exitCode: 0, lines: ['ND-CONTAINER {'] },
  { exitCode: 0, lines: ['ND-CONTAINER {}', 'ND-CONTAINER {}'] },
  { exitCode: 0, lines: [`ND-CONTAINER ${'é'.repeat(9000)}`] },
])('refuses missing, failed or malformed identity replies %#', async reply => {
  const original = io.op.getMockImplementation()!;
  io.op.mockImplementation(async (...args) => args[2] === 'docker.identity' ? reply : original(...args));
  await expect(openServiceNodeIdleWatch(f.c.db, service, new AbortController().signal)).rejects.toThrow(/identity/);
  expect(io.op.mock.calls.some(args => args[2] === 'proxy.idleWatch.open')).toBe(false);
});
it('detects a Stop/deploy owner arriving while capability preflight is in flight', async () => {
  const original = io.op.getMockImplementation()!;
  io.op.mockImplementation(async (...args) => {
    if (args[2] === 'agent.ping') await reserveServiceRuntimeOwner(f.c.db, 1, 'deploy', null, '2'.repeat(32));
    return original(...args);
  });
  await expect(openServiceNodeIdleWatch(f.c.db, service, new AbortController().signal)).rejects.toThrow(/unavailable/);
  expect(io.op.mock.calls.some(args => args[2] === 'proxy.idleWatch.open')).toBe(false);
});
it('refuses active deployment work before opening its observation window', async () => {
  await f.c.db.insert(deployments).values({ serviceId: 1, status: 'queued' });
  await expect(openServiceNodeIdleWatch(f.c.db, service, new AbortController().signal)).rejects.toThrow(/active runtime work/);
  expect(readers.size).toBe(0);
});
it('retains database topology checks even without autoscale capacity', async () => {
  await f.c.db.delete(nodeAutoscaleCapacity);
  await f.c.db.insert(databases).values({ id: 1, name: 'Database', slug: 'pg', engine: 'postgres', serverId: null, status: 'running', passwordEncrypted: 'fixture' });
  await f.c.db.insert(databaseAttachments).values({ serviceId: 1, databaseId: 1, envAlias: 'DATABASE_URL' });
  await expect(openServiceNodeIdleWatch(f.c.db, service, new AbortController().signal)).rejects.toThrow(/placement|capacity/);
  expect(readers.size).toBe(0);
});
it('runs the real plugin on the 15-second cadence and closes all windows on server shutdown without sleeping', async () => {
  vi.useFakeTimers();
  const app = Fastify(); app.decorate('db', f.c.db); await app.register(sleeperPlugin); await app.ready();
  try {
    expect((await readServiceSleepStatus(f.c.db, service)).nodeControllerActive).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000); await vi.waitFor(() => expect(readers.size).toBe(1));
    await vi.advanceTimersByTimeAsync(15_000); await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(readers.size).toBe(2));
    expect((await f.c.db.query.services.findFirst())!.asleepAt).toBeNull();
  } finally { await app.close(); }
  expect(readers.size).toBe(0);
  expect((await readServiceSleepStatus(f.c.db, service)).nodeControllerActive).toBe(false);
  expect(io.op.mock.calls.every(args => ['agent.ping', 'docker.identity', 'proxy.idleWatch.open', 'proxy.idleWatch.sample', 'proxy.idleWatch.finish', 'proxy.idleWatch.close'].includes(args[2]))).toBe(true);
});

it('keeps the observation-only path when automatic node workers are explicitly paused', async () => {
  vi.useFakeTimers();
  const settings = config as { nodeSleepAutomation: boolean }, previous = settings.nodeSleepAutomation;
  settings.nodeSleepAutomation = false;
  const app = Fastify(); app.decorate('db', f.c.db);
  try {
    await app.register(sleeperPlugin); await app.ready();
    await vi.advanceTimersByTimeAsync(15_000); await vi.waitFor(() => expect(readers.size).toBe(1));
    expect((await readServiceSleepStatus(f.c.db, service)).nodeControllerActive).toBe(false);
    expect((await f.c.db.query.services.findFirst())!.asleepAt).toBeNull();
  } finally { await app.close(); settings.nodeSleepAutomation = previous; }
  expect(readers.size).toBe(0);
});
