import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { eq, domains, nodeSleepTransitions, servers, services, settings } from '@ninedeploy/db';
import { servingReceiptFixture } from '../fixtures/servingTrafficReceipt.js';
import { nodeSleepEvidence } from '../fixtures/nodeSleepEvidence.js';
import { admitNodeSleep, admitNodeWake, advanceNodeSleep, bindNodeSleepCatcher, completeNodeSleep, nodeSleepCommand, prepareNodeWakeRouting } from '../../src/lib/nodeSleepAuthority.js';
import { reserveServiceRuntimeOwner } from '../../src/lib/serviceRuntimeOwner.js';
import { nodeWakeKey } from '../../src/lib/nodeWakeKey.js';
import { WAKE_PREFIX, renderDynamicConfig } from '../../src/engine/proxy.js';
import { encrypt } from '../../src/lib/crypto.js';
import { rotateSecrets } from '../../src/lib/keyRotation.js';
import type { NodeWakeRoutePromotion } from '../../src/lib/nodeWakeRoutePromotion.js';
import { syncAllNodeProxies, syncNodeProxy } from '../../src/lib/nodeProxy.js';

const io = vi.hoisted(() => ({ agent: vi.fn(), sealed: vi.fn() }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: io.agent, agentTransportSealed: io.sealed }));
let caps: string[], badRoutingAck: boolean, afterAgent: ((op: string) => Promise<void>) | undefined;

let f: Awaited<ReturnType<typeof servingReceiptFixture>>;
beforeEach(async () => {
  f = await servingReceiptFixture('file::memory:'); await f.c.db.update(services).set({ sleepAfterMinutes: 5 });
  caps = ['proxy.orderedWrite', 'proxy.routingAck']; badRoutingAck = false; afterAgent = undefined;
  io.sealed.mockReset().mockResolvedValue(true); io.agent.mockReset().mockImplementation(async (_db, _node, op, params) => {
    await afterAgent?.(op);
    if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.19.0', caps })}`] };
    if (op === 'proxy.writeConfig') return { exitCode: 0, lines: ['proxy-config x unchanged'] };
    if (op === 'proxy.writeOrderedConfig') return { exitCode: 0, lines: [`ND-PROXY-WRITE ${JSON.stringify({ revision: params.revision, requestId: params.requestId,
      contentHash: createHash('sha256').update(params.content).digest('hex'), complete: true, changed: true })}`] };
    if (op === 'docker.inspect') return { exitCode: 0, lines: ['running'] };
    if (op === 'proxy.confirmRouting') return { exitCode: 0, lines: [`ND-PROXY-ROUTING ${badRoutingAck ? '0'.repeat(64) : createHash('sha256').update(params.content).digest('hex')}`] };
    throw new Error(`Unexpected operation ${op}`);
  });
});
afterEach(() => { vi.restoreAllMocks(); f.c.client?.close(); });
const render = (serverId: number | null = 4) => renderDynamicConfig(f.c.db, { serverId });
const router = (output: string) => output.split('    web_1:\n')[1]?.split(/\n {4}\S/)[0];
const selected = async () => (await f.c.db.query.services.findFirst())!;
async function fallback() {
  const service = await selected(), proof = await nodeSleepEvidence(f.c.db);
  const admission = (await admitNodeSleep(f.c.db, service, proof.token))!;
  await nodeWakeKey(f.c.db, 4, true);
  await advanceNodeSleep(f.c.db, admission, 'accepted', 'fencing');
  await bindNodeSleepCatcher(f.c.db, admission, { id: 'c'.repeat(64), image: `sha256:${'d'.repeat(64)}` });
  await advanceNodeSleep(f.c.db, admission, 'fencing', 'prepared');
  await advanceNodeSleep(f.c.db, admission, 'prepared', 'routing');
  return admission;
}
async function wakePublishing() {
  const sleep = await fallback();
  await advanceNodeSleep(f.c.db, sleep, 'routing', 'routed');
  await advanceNodeSleep(f.c.db, sleep, 'routed', 'stopping');
  const row = (await f.c.db.query.nodeSleepTransitions.findFirst())!;
  await completeNodeSleep(f.c.db, sleep, { ...nodeSleepCommand(sleep, 'stop'), complete: true,
    items: row.targets.map(target => ({ id: target.id, name: target.name, deploymentId: target.deploymentId, running: false })) });
  const wake = (await admitNodeWake(f.c.db, await selected(), { nodeId: 4, token: row.wakeToken, catcherId: row.catcherId!, receivedAt: Date.now(), demandAt: Date.now() }))!;
  await expect(prepareNodeWakeRouting(f.c.db, wake)).rejects.toThrow();
  for (const [from, to] of [['accepted', 'fencing'], ['fencing', 'starting'], ['starting', 'readiness'], ['readiness', 'publishing']] as const) {
    await advanceNodeSleep(f.c.db, wake, from, to);
  }
  return { wake, token: await prepareNodeWakeRouting(f.c.db, wake) };
}
it('leaves ordinary node routing unchanged before any fallback publication', async () => {
  const output = await render(); expect(router(output)).toContain('service: svc_web_1');
  expect(output).not.toContain('svc_ninedeploy_node_wake');
  expect(await nodeWakeKey(f.c.db, 4)).toBeNull();
});
it('routes the pending generation through auth and IP checks before adding the wake token and credential', async () => {
  // Configure domain security before admission; its configuration is bound by the journal.
  await f.c.db.update(domains).set({ basicAuth: 'alice:password', ipAllowlist: '10.0.0.0/8' });
  await fallback(); const output = await render(), row = (await f.c.db.query.nodeSleepTransitions.findFirst())!;
  expect(router(output)).toContain('service: svc_ninedeploy_node_wake');
  expect(router(output)).toContain(['      middlewares:', '        - mw_web_1_auth', '        - mw_web_1_ip', '        - mw_web_1_node_wake', '        - mw_ninedeploy_node_wake_key'].join('\n'));
  expect(output).toContain(`prefix: "${WAKE_PREFIX}/${row.wakeToken}"`);
  expect(output).toContain(`x-nd-wake-key: "${await nodeWakeKey(f.c.db, 4)}"`);
  expect(output).toContain('url: "http://ninedeploy-wake:8080"');
});
it('keeps fallback routing through owner supersession even while the app still has no asleep flag', async () => {
  const admission = await fallback(); await reserveServiceRuntimeOwner(f.c.db, 1, 'restart', admission.owner);
  expect((await selected()).asleepAt).toBeNull();
  expect((await f.c.db.query.nodeSleepTransitions.findFirst())!.phase).toBe('superseded');
  expect(router(await render())).toContain('service: svc_ninedeploy_node_wake');
});
it('does not reuse a prior fallback on a newly selected generation or another proxy', async () => {
  await fallback(); await f.c.db.update(services).set({ runtimeId: 'web-10' });
  expect(router(await render())).toContain('service: svc_web_1');
  expect(await render()).not.toContain('svc_ninedeploy_node_wake');
  expect(router(await render(null))).toBeUndefined();
  expect(router(await render(5))).toBeUndefined();
});
it('refuses missing credentials and invalid catcher identities rather than silently returning app routing', async () => {
  await fallback(); await f.c.db.delete(settings).where(eq(settings.key, 'node_wake_key_4'));
  await expect(render()).rejects.toThrow(/credential/);
  await nodeWakeKey(f.c.db, 4, true); await f.c.db.update(nodeSleepTransitions).set({ catcherId: 'invalid' });
  await expect(render()).rejects.toThrow(/identity/);
});
it('creates a stable encrypted per-node credential and refuses corrupt existing state', async () => {
  const key = await nodeWakeKey(f.c.db, 4, true);
  expect(key).toMatch(/^[a-f0-9]{64}$/); expect(await nodeWakeKey(f.c.db, 4, true)).toBe(key);
  expect(await nodeWakeKey(f.c.db, 5, true)).not.toBe(key);
  const stored = await f.c.db.query.settings.findFirst({ where: eq(settings.key, 'node_wake_key_4') });
  expect(stored!.value).not.toBe(key);
  await f.c.db.update(settings).set({ value: 'invalid' }).where(eq(settings.key, 'node_wake_key_4'));
  await expect(nodeWakeKey(f.c.db, 4, true)).rejects.toThrow();
});
it('withdraws a stopped service even when a prior fallback and its credential remain', async () => {
  await fallback(); await f.c.db.update(services).set({ status: 'stopped' });
  await f.c.db.delete(settings).where(eq(settings.key, 'node_wake_key_4'));
  expect(router(await render())).toBeUndefined();
});
it('shares the credential and catcher across domains while keeping each token middleware after domain security', async () => {
  await f.c.db.insert(domains).values({ serviceId: 1, hostname: 'second.test', path: '/app', status: 'active', ssl: true });
  await fallback(); const output = await render();
  expect(output.match(/ {4}svc_ninedeploy_node_wake:/g)).toHaveLength(1);
  expect(output.match(/ {4}mw_ninedeploy_node_wake_key:/g)).toHaveLength(1);
  expect(output).toContain('mw_web_2_node_wake:');
  expect(output).toContain('web_2_http:'); expect(output).toContain('PathPrefix(`/app`)');
});
it('retains the exact wake credential when a legacy encryption envelope is rotated', async () => {
  await f.c.db.update(servers).set({ tokenEncrypted: encrypt('fixture') });
  const key = await nodeWakeKey(f.c.db, 4, true);
  const before = String((await f.c.db.query.settings.findFirst({ where: eq(settings.key, 'node_wake_key_4') }))!.value).replace(/^v0:/, '');
  await f.c.db.update(settings).set({ value: before }).where(eq(settings.key, 'node_wake_key_4'));
  expect(await rotateSecrets(f.c.db)).toBe(2);
  expect((await f.c.db.query.settings.findFirst({ where: eq(settings.key, 'node_wake_key_4') }))!.value).not.toBe(before);
  expect(await nodeWakeKey(f.c.db, 4)).toBe(key);
});
it('publishes the app only with a current publishing worker permission, leaving durable fallback intact until completion', async () => {
  const { token } = await wakePublishing();
  const output = await renderDynamicConfig(f.c.db, { serverId: 4, wakePromotion: token });
  expect(router(output)).toContain('service: svc_web_1');
  expect(router(output)).not.toContain('mw_web_1_node_wake');
  expect((await selected()).asleepAt).not.toBeNull();
  expect((await f.c.db.query.nodeSleepTransitions.findFirst())!.fallbackRouting).toBe(true);
  expect(router(await render())).toContain('service: svc_ninedeploy_node_wake');
});
it('rejects manufactured, cross-node and expired permissions', async () => {
  const { token } = await wakePublishing();
  await expect(renderDynamicConfig(f.c.db, { serverId: 4, wakePromotion: {} as NodeWakeRoutePromotion })).rejects.toThrow(/promotion/);
  await expect(renderDynamicConfig(f.c.db, { serverId: 5, wakePromotion: token })).rejects.toThrow(/promotion/);
  await expect(renderDynamicConfig(f.c.db, { serverId: null, wakePromotion: token })).rejects.toThrow();
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_001);
  await expect(renderDynamicConfig(f.c.db, { serverId: 4, wakePromotion: token })).rejects.toThrow(/expired/);
});
it('rechecks the journal and owner instead of trusting a previously issued permission', async () => {
  const { wake, token } = await wakePublishing();
  await reserveServiceRuntimeOwner(f.c.db, 1, 'stop', wake.owner);
  await expect(renderDynamicConfig(f.c.db, { serverId: 4, wakePromotion: token })).rejects.toThrow(/authority/);
  expect(router(await render())).toContain('service: svc_ninedeploy_node_wake');
});
it('requires ordered writes and confirms the exact app routing before reporting publication success', async () => {
  const { token } = await wakePublishing();
  expect(await syncNodeProxy(f.c.db, 4, undefined, { confirmRouting: true, wakePromotion: token })).toEqual({ ok: true });
  const write = io.agent.mock.calls.find(call => call[2] === 'proxy.writeOrderedConfig');
  expect(router(write![3].content)).toContain('service: svc_web_1');
  expect(io.agent.mock.calls.some(call => call[2] === 'proxy.confirmRouting')).toBe(true);
  expect((await f.c.db.query.nodeSleepTransitions.findFirst())!.fallbackRouting).toBe(true);
});
it.each(['proxy.writeConfig', 'proxy.writeOrderedConfig', 'proxy.confirmRouting'])('refuses a wake superseded during %s', async operation => {
  const { wake, token } = await wakePublishing();
  afterAgent = async op => { if (op === operation) { afterAgent = undefined; await reserveServiceRuntimeOwner(f.c.db, 1, 'stop', wake.owner); } };
  expect(await syncNodeProxy(f.c.db, 4, undefined, { confirmRouting: true, wakePromotion: token })).toMatchObject({ ok: false, reason: expect.stringMatching(/authority/) });
  if (operation === 'proxy.writeConfig') expect(io.agent.mock.calls.some(call => call[2] === 'proxy.writeOrderedConfig')).toBe(false);
  expect((await f.c.db.query.nodeSleepTransitions.findFirst())!.fallbackRouting).toBe(true);
});
it('does not publish with missing confirmation, an older agent or a batch targeting another node', async () => {
  const { token } = await wakePublishing();
  expect(await syncNodeProxy(f.c.db, 4, undefined, { wakePromotion: token })).toMatchObject({ ok: false });
  expect(io.agent).not.toHaveBeenCalled();
  caps = ['proxy.routingAck'];
  expect(await syncNodeProxy(f.c.db, 4, undefined, { confirmRouting: true, wakePromotion: token })).toMatchObject({ ok: false });
  expect(io.agent.mock.calls.some(call => call[2] === 'proxy.writeConfig')).toBe(false);
  await expect(syncAllNodeProxies(f.c.db, [4, 5], undefined, { confirmNode: 5, wakePromotion: token })).rejects.toThrow(/promotion/);
});
it('retains the journal fallback when the loaded app route cannot be confirmed', async () => {
  const { token } = await wakePublishing(); badRoutingAck = true;
  expect(await syncNodeProxy(f.c.db, 4, undefined, { confirmRouting: true, wakePromotion: token })).toMatchObject({ ok: false, routingUnconfirmed: true });
  expect((await f.c.db.query.nodeSleepTransitions.findFirst())!.fallbackRouting).toBe(true);
  expect((await selected()).asleepAt).not.toBeNull();
});
