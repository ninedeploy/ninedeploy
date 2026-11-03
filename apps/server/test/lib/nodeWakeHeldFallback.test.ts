// R2 regression: with NINEDEPLOY_NODE_SLEEP_AUTOMATION=off nothing recovers an
// interrupted sleep, so a sleep held in `restoring` keeps visitors on the
// catcher while the app runs and asleepAt is null. Explicit Start/Wake must
// still settle that fallback; POST /wake used to answer 400 not_asleep.
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { services } from '@ninedeploy/db';
import { servingReceiptFixture } from '../fixtures/servingTrafficReceipt.js';
import { nodeSleepEvidence } from '../fixtures/nodeSleepEvidence.js';
import { abortNodeSleep, admitNodeSleep, advanceNodeSleep, bindNodeSleepCatcher, holdNodeSleep } from '../../src/lib/nodeSleepAuthority.js';
import { acceptNodeLifecycleIntent } from '../../src/lib/nodeLifecycleIntent.js';
import { executeNodeLifecycleIntent } from '../../src/lib/nodeLifecycleController.js';
import { nodeLifecycleRuntime } from '../../src/lib/nodeLifecycleRuntime.js';
import { nodeWakeKey } from '../../src/lib/nodeWakeKey.js';
import { renderDynamicConfig } from '../../src/engine/proxy.js';

const io = vi.hoisted(() => ({ agent: vi.fn(), sealed: vi.fn() }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: io.agent, agentTransportSealed: io.sealed }));
let f: Awaited<ReturnType<typeof servingReceiptFixture>>, running: boolean, configs: string[], slowMs: number;
const service = async () => (await f.c.db.query.services.findFirst())!;
const target = { id: 'a'.repeat(64), name: 'web-9' };
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  // The app is still running: the sleep was interrupted before any Stop.
  f = await servingReceiptFixture('file::memory:'); running = true; configs = []; slowMs = 0;
  await f.c.db.update(services).set({ sleepAfterMinutes: 5, healthCheck: 'tcp', healthTimeoutSeconds: 10 }); await nodeWakeKey(f.c.db, 4, true);
  const proof = await nodeSleepEvidence(f.c.db), admission = (await admitNodeSleep(f.c.db, await service(), proof.token))!;
  await advanceNodeSleep(f.c.db, admission, 'accepted', 'fencing');
  await bindNodeSleepCatcher(f.c.db, admission, { id: 'c'.repeat(64), image: `sha256:${'d'.repeat(64)}` });
  for (const [from, to] of [['fencing', 'prepared'], ['prepared', 'routing'], ['routing', 'routed']] as const) await advanceNodeSleep(f.c.db, admission, from, to);
  // What executeNodeSleep's catch path does when the coordinator's signal is aborted at shutdown.
  expect(await abortNodeSleep(f.c.db, admission, 'Node sleep coordinator stopped')).toBe('restoring');
  await holdNodeSleep(f.c.db, admission, 'Node sleep coordinator stopped; restoration unavailable');
  io.sealed.mockReset().mockResolvedValue(true); io.agent.mockReset().mockImplementation(async (_db, node, op, params) => {
    if (node !== 4) {
      // An unreachable node: agentOp gives up after the 15 s fan-out budget.
      vi.setSystemTime(Date.now() + slowMs);
      throw new Error(`agent ${op} on n${node}.test: no answer within the panel's timeout for this operation`);
    }
    if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.19.0',
      caps: ['docker.lifecycle', 'docker.recovery', 'docker.readiness', 'proxy.routingAck', 'proxy.orderedWrite'] })}`] };
    if (op === 'docker.identity') return { exitCode: 0, lines: [`ND-CONTAINER ${params.name === target.name ? JSON.stringify({ ...target, managed: 'service', serviceId: '1', deploymentId: '9' }) : 'null'}`] };
    if (op === 'docker.lifecycle') {
      if (params.targets.length) running = params.action === 'start';
      return { exitCode: 0, lines: [`ND-LIFECYCLE ${JSON.stringify({ requestId: params.requestId, serviceId: params.serviceId, deploymentId: params.deploymentId,
        action: params.action, revision: params.revision, complete: true, items: params.targets.map((item: object) => ({ ...item, running: params.action === 'start' })) })}`] };
    }
    if (op === 'docker.readiness') return { exitCode: 0, lines: [`ND-READINESS ${JSON.stringify({ requestId: params.requestId, complete: true,
      items: params.targets.map((item: object) => ({ ...item, status: running ? 'running' : 'exited', health: 'none', restarts: 0, failingStreak: 0, ready: running })) })}`] };
    if (op === 'proxy.writeConfig') return { exitCode: 0, lines: ['proxy-config x unchanged'] };
    if (op === 'proxy.writeOrderedConfig') {
      configs.push(params.content);
      return { exitCode: 0, lines: [`ND-PROXY-WRITE ${JSON.stringify({ revision: params.revision, requestId: params.requestId,
        contentHash: createHash('sha256').update(params.content).digest('hex'), complete: true, changed: true })}`] };
    }
    if (op === 'docker.inspect') return { exitCode: 0, lines: ['running'] };
    if (op === 'proxy.confirmRouting') return { exitCode: 0, lines: [`ND-PROXY-ROUTING ${createHash('sha256').update(params.content).digest('hex')}`] };
    throw new Error(`Unexpected operation ${op}`);
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); f.c.client?.close(); });
async function run(id: number) {
  const abort = new AbortController();
  const pending = executeNodeLifecycleIntent(f.c.db, id, nodeLifecycleRuntime(f.c.db, { signal: abort.signal }));
  let done = false; void pending.then(() => { done = true; }, () => { done = true; });
  for (const deadline = performance.now() + 5000; performance.now() < deadline && !done;) {
    await setImmediate();
    if (vi.getTimerCount()) await vi.advanceTimersToNextTimerAsync();
  }
  if (!done) { abort.abort(new Error('fixture deadline')); }
  return pending;
}
const fallbackRouting = async () => (await f.c.db.query.nodeSleepTransitions.findFirst())!.fallbackRouting;


it('an explicit Start settles a held restoring fallback: visitors go back to the running app', async () => {
  const before = await service();
  expect(before.asleepAt).toBeNull(); expect(before.status).toBe('running');
  expect(await renderDynamicConfig(f.c.db, { serverId: 4 })).toContain('http://ninedeploy-wake:8080');
  const intent = await acceptNodeLifecycleIntent(f.c.db, before, 'start');
  expect(await run(intent.id)).toEqual({ state: 'completed' });
  expect(await fallbackRouting()).toBe(false);
  expect(await renderDynamicConfig(f.c.db, { serverId: 4 })).not.toContain('http://ninedeploy-wake:8080');
});
