import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { services } from '@ninedeploy/db';
import { servingReceiptFixture } from '../fixtures/servingTrafficReceipt.js';
import { nodeSleepEvidence } from '../fixtures/nodeSleepEvidence.js';
import { admitNodeSleep, advanceNodeSleep, bindNodeSleepCatcher, completeNodeSleep, nodeSleepCommand } from '../../src/lib/nodeSleepAuthority.js';
import { acceptNodeLifecycleIntent, retryNodeLifecycleIntent } from '../../src/lib/nodeLifecycleIntent.js';
import { executeNodeLifecycleIntent } from '../../src/lib/nodeLifecycleController.js';
import { nodeLifecycleRuntime } from '../../src/lib/nodeLifecycleRuntime.js';
import { nodeWakeKey } from '../../src/lib/nodeWakeKey.js';
import { renderDynamicConfig, writeDynamicConfig } from '../../src/engine/proxy.js';

const io = vi.hoisted(() => ({ agent: vi.fn(), sealed: vi.fn() }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: io.agent, agentTransportSealed: io.sealed }));
let f: Awaited<ReturnType<typeof servingReceiptFixture>>, running: boolean, configs: string[], badAck: boolean, ready: boolean;
let during: ((op: string) => Promise<void>) | undefined;
let afterRoute: (() => Promise<void>) | undefined;
const service = async () => (await f.c.db.query.services.findFirst())!;
const target = { id: 'a'.repeat(64), name: 'web-9' };
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  f = await servingReceiptFixture('file::memory:'); running = false; configs = []; badAck = false; ready = true; during = undefined; afterRoute = undefined;
  await f.c.db.update(services).set({ sleepAfterMinutes: 5, healthCheck: 'tcp', healthTimeoutSeconds: 10 }); await nodeWakeKey(f.c.db, 4, true);
  const proof = await nodeSleepEvidence(f.c.db), admission = (await admitNodeSleep(f.c.db, await service(), proof.token))!;
  await advanceNodeSleep(f.c.db, admission, 'accepted', 'fencing');
  await bindNodeSleepCatcher(f.c.db, admission, { id: 'c'.repeat(64), image: `sha256:${'d'.repeat(64)}` });
  for (const [from, to] of [['fencing', 'prepared'], ['prepared', 'routing'], ['routing', 'routed'], ['routed', 'stopping']] as const) await advanceNodeSleep(f.c.db, admission, from, to);
  await completeNodeSleep(f.c.db, admission, { ...nodeSleepCommand(admission, 'stop'), complete: true, items: [{ ...target, deploymentId: 9, running: false }] });
  expect((await renderDynamicConfig(f.c.db, { serverId: 4 })).includes('http://ninedeploy-wake:8080')).toBe(true);
  io.sealed.mockReset().mockResolvedValue(true); io.agent.mockReset().mockImplementation(async (_db, node, op, params) => {
    expect(node).toBe(4);
    await during?.(op);
    if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.19.0',
      caps: ['docker.lifecycle', 'docker.recovery', 'docker.readiness', 'proxy.routingAck', 'proxy.orderedWrite'] })}`] };
    if (op === 'docker.identity') return { exitCode: 0, lines: [`ND-CONTAINER ${params.name === target.name ? JSON.stringify({ ...target, managed: 'service', serviceId: '1', deploymentId: '9' }) : 'null'}`] };
    if (op === 'docker.lifecycle') {
      if (params.targets.length) running = params.action === 'start';
      return { exitCode: 0, lines: [`ND-LIFECYCLE ${JSON.stringify({ requestId: params.requestId, serviceId: params.serviceId, deploymentId: params.deploymentId,
        action: params.action, revision: params.revision, complete: true, items: params.targets.map((item: object) => ({ ...item, running: params.action === 'start' })) })}`] };
    }
    if (op === 'docker.readiness') return { exitCode: 0, lines: [`ND-READINESS ${JSON.stringify({ requestId: params.requestId, complete: true,
      items: params.targets.map((item: object) => ({ ...item, status: running ? 'running' : 'exited', health: 'none', restarts: 0, failingStreak: 0, ready: running && ready })) })}`] };
    if (op === 'proxy.writeConfig') return { exitCode: 0, lines: ['proxy-config x unchanged'] };
    if (op === 'proxy.writeOrderedConfig') {
      configs.push(params.content);
      return { exitCode: 0, lines: [`ND-PROXY-WRITE ${JSON.stringify({ revision: params.revision, requestId: params.requestId,
        contentHash: createHash('sha256').update(params.content).digest('hex'), complete: true, changed: true })}`] };
    }
    // An existing ordered head is not required on the first explicit-command proof.
    if (op === 'docker.inspect') return { exitCode: 0, lines: ['running'] };
    if (op === 'proxy.confirmRouting') return { exitCode: 0, lines: [`ND-PROXY-ROUTING ${badAck ? '0'.repeat(64) : createHash('sha256').update(params.content).digest('hex')}`] };
    throw new Error(`Unexpected operation ${op}`);
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); f.c.client?.close(); });
async function execute(action: 'start' | 'restart' | 'stop') {
  const intent = await acceptNodeLifecycleIntent(f.c.db, await service(), action);
  return run(intent.id);
}
async function run(id: number) {
  const abort = new AbortController();
  const runtime = nodeLifecycleRuntime(f.c.db, { signal: abort.signal });
  const pending = executeNodeLifecycleIntent(f.c.db, id, { ...runtime, route: async (...args) => {
    await runtime.route(...args);
    // Model a valid scheduling order without overlapping libSQL's single in-memory connection.
    await afterRoute?.();
  } });
  let done = false; void pending.then(() => { done = true; }, () => { done = true; });
  for (const deadline = performance.now() + 5000; performance.now() < deadline && !done;) {
    // Let native SQLite finish its awaited work before moving the lease clock.
    await setImmediate();
    if (vi.getTimerCount()) await vi.advanceTimersToNextTimerAsync();
  }
  const settled = done;
  if (!done) { abort.abort(new Error('fixture deadline')); await pending; }
  expect(settled, JSON.stringify({ id, operations: io.agent.mock.calls.map(call => call[2]) })).toBe(true); return pending;
}
it.each(['start', 'restart'] as const)('settles a sleeping service to a confirmed ready app route after explicit %s', async action => {
  expect(await execute(action)).toEqual({ state: 'completed' });
  expect(running).toBe(true); expect((await service()).status).toBe('running');
  const output = await renderDynamicConfig(f.c.db, { serverId: 4 });
  expect(output.includes('http://ninedeploy-wake:8080'), 'completed explicit command must stop routing visitors to the wake catcher').toBe(false);
  expect(output.includes('http://web-9:3000')).toBe(true);
  expect((await f.c.db.query.nodeSleepTransitions.findFirst())!.fallbackRouting).toBe(false);
  expect(configs.at(-1)?.includes('http://web-9:3000')).toBe(true);
});
it('keeps explicit Stop withdrawn from the wake catcher and does not start the application', async () => {
  expect(await execute('stop')).toEqual({ state: 'completed' });
  expect(running).toBe(false); expect((await service()).status).toBe('stopped');
  expect((await renderDynamicConfig(f.c.db, { serverId: 4 })).includes('http://ninedeploy-wake:8080')).toBe(false);
});
it('retains fallback after an unconfirmed app write and settles the same command on retry', async () => {
  badAck = true; expect(await execute('start')).toEqual({ state: 'held' });
  expect((await f.c.db.query.nodeSleepTransitions.findFirst())!.fallbackRouting).toBe(true);
  expect((await service()).status).toBe('deploying');
  badAck = false; const retried = await retryNodeLifecycleIntent(f.c.db, await service());
  expect(await run(retried.id)).toEqual({ state: 'completed' });
  expect((await f.c.db.query.nodeSleepTransitions.findFirst())!.fallbackRouting).toBe(false);
});
it('does not publish or clear fallback when application readiness fails', async () => {
  ready = false; expect(await execute('start')).toEqual({ state: 'held' });
  expect(configs).toHaveLength(0);
  expect((await f.c.db.query.nodeSleepTransitions.findFirst())!.fallbackRouting).toBe(true);
});
it('does not revive the service if explicit Stop supersedes the app routing acknowledgement', async () => {
  during = async op => {
    if (op !== 'proxy.confirmRouting') return;
    during = undefined; await acceptNodeLifecycleIntent(f.c.db, await service(), 'stop');
  };
  expect((await execute('start')).state).not.toBe('completed');
  expect((await service()).status).toBe('stopped');
  expect((await f.c.db.query.nodeSleepTransitions.findFirst())!.fallbackRouting).toBe(true);
});
it('clears the fallback inside the routing queue before the next ordinary render', async () => {
  let queued: Promise<void> | undefined;
  afterRoute = async () => { await queued; };
  during = async op => {
    if (op !== 'proxy.confirmRouting') return;
    during = undefined; queued = writeDynamicConfig(f.c.db, { requireNode: 4, confirmNodeRouting: true, requireOrderedNode: true });
  };
  expect(await execute('start')).toEqual({ state: 'completed' }); await queued;
  expect(configs).toHaveLength(2);
  expect(configs.every(content => !content.includes('http://ninedeploy-wake:8080'))).toBe(true);
});
