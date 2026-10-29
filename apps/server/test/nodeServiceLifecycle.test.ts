import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations, users, servers, services, deployments, auditLog, nodeLifecycleIntents, serviceTargets, eq } from '@ninedeploy/db';
import { containerLifecycleRequest } from '@ninedeploy/schemas';
import { asUser, buildTestApp } from './helpers.js';
import { servicesRoutes } from '../src/modules/services.js';
import { reconcileNodeLifecycleIntents } from '../src/lib/nodeLifecycleRuntime.js';
import { acceptNodeLifecycleIntent, claimNodeLifecycleIntent } from '../src/lib/nodeLifecycleIntent.js';
import runtimeStatePlugin, { createRuntimeStateReconciler } from '../src/plugins/runtimeState.js';
import nodeLifecyclePlugin from '../src/plugins/nodeLifecycle.js';

const network = vi.hoisted(() => ({ agentOp: vi.fn(), agentTransportSealed: vi.fn(async () => true), writeDynamicConfig: vi.fn(async () => undefined) }));
vi.mock('../src/lib/agentClient.js', async original => ({ ...await original<typeof import('../src/lib/agentClient.js')>(), agentOp: network.agentOp, agentTransportSealed: network.agentTransportSealed }));
vi.mock('../src/engine/proxy.js', async original => ({ ...await original<typeof import('../src/engine/proxy.js')>(), writeDynamicConfig: network.writeDynamicConfig }));

let c: ReturnType<typeof createDb>, effects: string[], running: boolean, available: typeof targets;
const instances: Awaited<ReturnType<typeof buildTestApp>>[] = [];
const targets = [{ id: 'a'.repeat(64), name: 'web-9' }, { id: 'b'.repeat(64), name: 'web-9-r2' }];
const service = async () => (await c.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
beforeEach(async () => {
  effects = []; running = false; available = [...targets]; vi.clearAllMocks(); network.agentTransportSealed.mockResolvedValue(true); network.writeDynamicConfig.mockResolvedValue(undefined);
  c = createDb({ url: 'file::memory:' }); await c.ready; await runMigrations(c.db);
  await c.db.insert(users).values({ id: 1, email: 'operator@example.test', passwordHash: 'fixture', isInstanceOperator: true });
  await c.db.insert(servers).values({ id: 4, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
  await c.db.insert(services).values({ id: 1, ownerUserId: 1, name: 'Web', slug: 'web', type: 'docker', serverId: 4, runtimeId: 'web-9', status: 'stopped', runtimeReplicas: 2,
    port: 3000, healthCheck: 'http-strict', healthTimeoutSeconds: 10 });
  network.agentOp.mockImplementation(async (_db, serverId, op, params) => {
    expect(serverId).toBe(4);
    if (op === 'agent.ping') return { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.18.3', caps: ['docker.lifecycle', 'docker.recovery', 'docker.readiness', 'proxy.routingAck'] })}`] };
    if (op === 'docker.inspect') return { exitCode: 0, lines: [running ? 'running|172.22.0.2' : 'exited|'] };
    if (op === 'docker.identity') {
      const target = available.find(t => t.name === params.name);
      return { exitCode: 0, lines: [`ND-CONTAINER ${target ? JSON.stringify({ ...target, managed: 'service', serviceId: '1', deploymentId: '9' }) : 'null'}`] };
    }
    if (op === 'docker.lifecycle') {
      const request = containerLifecycleRequest.parse(params); effects.push(request.targets.length ? request.action : 'fence');
      if (request.targets.length) running = request.action === 'start';
      return { exitCode: 0, lines: [`ND-LIFECYCLE ${JSON.stringify({ ...request, timeoutMs: undefined, targets: undefined, complete: true, items: request.targets.map(t => ({ ...t, running })) })}`] };
    }
    if (op === 'docker.readiness') return { exitCode: 0, lines: [`ND-READINESS ${JSON.stringify({ requestId: params.requestId, complete: true,
      items: params.targets.map((t: { id: string; name: string }) => ({ ...t, status: running ? 'running' : 'exited', health: 'none', restarts: 0, failingStreak: 0, ready: running })) })}`] };
    // An old successful legacy path is the RED control, never accepted as ordered execution.
    if (op === 'docker.start' || op === 'docker.stop') { effects.push(op); running = op === 'docker.start'; return { exitCode: 0, lines: [params.name] }; }
    throw Error(`Unexpected operation ${op}`);
  });
});
afterEach(async () => {
  vi.useRealTimers();
  // The worker and its callbacks must settle before their native SQLite client closes.
  await Promise.all(instances.splice(0).map(instance => instance.close()));
  c.client?.close();
});
async function app() { const instance = await buildTestApp({ db: c.db }); instances.push(instance); await instance.register(servicesRoutes); return instance; }
async function finish<T>(promise: Promise<T>): Promise<T> {
  let done = false; void promise.then(() => { done = true; }, () => { done = true; });
  for (let n = 0; n < 200 && !done; n++) await vi.advanceTimersByTimeAsync(250);
  expect(done).toBe(true); return promise;
}

describe('public ordered node lifecycle', () => {
  it('stops every accepted unselected node and clears pending fan-out state without mixing equal IDs across hosts', async () => {
    await c.db.update(services).set({ runtimeId: null, status: 'deploying' }).where(eq(services.id,1));
    await c.db.insert(deployments).values({id:9,serviceId:1,status:'building'});
    await c.db.insert(servers).values({id:5,name:'Additional node',host:'second.test',tokenEncrypted:'fixture'});
    await c.db.insert(serviceTargets).values({id:42,serviceId:1,serverId:5,runtimeId:null,status:'deploying'});
    const trace: string[] = [];
    network.writeDynamicConfig.mockImplementation(async (_db,opts) => { trace.push('route:'+opts.requireNode); });
    network.agentOp.mockImplementation(async (_db,serverId,op,params) => {
      if(op==='agent.ping') return {exitCode:0,lines:['ND-AGENT '+JSON.stringify({version:'0.19.0',caps:['docker.mutations','proxy.routingAck']})]};
      const header={requestId:params.requestId,serviceId:params.serviceId,revision:params.revision,complete:true};
      const target={id:'a'.repeat(64),name:serverId===4?'web-9':'web-t5-9',deploymentId:9};
      if(op==='docker.runtimeFence'){trace.push('fence:'+serverId);return{exitCode:0,lines:['ND-RUNTIME-FENCE '+JSON.stringify({...header,deploymentWatermark:params.deploymentWatermark})]};}
      if(op==='docker.runtimeInventory'){trace.push('inventory:'+serverId);expect(params.expectedNames).toContain(target.name);return{exitCode:0,lines:['ND-RUNTIME-INVENTORY '+JSON.stringify({...header,items:[{...target,running:true}]})]};}
      if(op==='docker.stopSet'){trace.push('stop:'+serverId);expect(params.targets).toEqual([target]);return{exitCode:0,lines:['ND-STOPPED-SET '+JSON.stringify({...header,items:[{...target,running:false}]})]};}
      if(op==='docker.runtimeLegacyHandoff'){trace.push('handoff:'+serverId);return{exitCode:0,lines:['ND-RUNTIME-LEGACY '+JSON.stringify({...header,deploymentWatermark:params.deploymentWatermark})]};}
      throw Error('Unexpected initial Stop operation '+op);
    });
    const instance=await app(),response=await instance.inject({method:'POST',url:'/1/stop',headers:asUser()});expect(response.statusCode).toBe(202);
    vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});
    expect(await finish(reconcileNodeLifecycleIntents(c.db))).toEqual([{id:response.json().lifecycle.id,state:'completed'}]);
    expect(trace).toEqual(['fence:4','fence:5','inventory:4','inventory:5','route:4','route:5','stop:4','handoff:4','stop:5','handoff:5']);
    expect((await c.db.query.serviceTargets.findFirst({where:eq(serviceTargets.id,42)}))?.status).toBe('idle');
  });

  it.each(['queued', 'awaiting_ci', 'awaiting_approval', 'building', 'deploying'] as const)('cancels initial %s work and retains Stop while an older node cannot fence creation', async status => {
    await c.db.update(services).set({ runtimeId: null, status: 'deploying' }).where(eq(services.id, 1));
    await c.db.insert(deployments).values({ id: 9, serviceId: 1, status });
    const instance = await app(), response = await instance.inject({ method: 'POST', url: '/1/stop', headers: asUser() });
    expect(response.statusCode).toBe(202);
    const again = await instance.inject({ method: 'POST', url: '/1/stop', headers: asUser() });
    expect(again.json().lifecycle.id).toBe(response.json().lifecycle.id);
    expect(await reconcileNodeLifecycleIntents(c.db)).toEqual([{ id: response.json().lifecycle.id, state: 'held' }]);
    const stored = (await c.db.select().from(nodeLifecycleIntents))[0]!;
    expect(stored.reason).toMatch(/0[.]19[.]0/); expect(stored.runtimeId).toBeNull(); expect(stored.targets).toBeNull();
    expect((await c.db.query.deployments.findFirst({ where: eq(deployments.id, 9) }))?.status).toBe('cancelled');
    expect(effects).toEqual([]); expect(network.agentOp.mock.calls.every(call => call[2] === 'agent.ping')).toBe(true);
  });
  it.each([true, false])('completes an unselected Stop only after fenced inventory, routing and physical effects; containers=%s', hasContainers => {
    return (async () => {
      await c.db.update(services).set({ runtimeId: null, status: 'deploying' }).where(eq(services.id, 1));
      await c.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'building' });
      const members = hasContainers ? [{ ...targets[0]!, deploymentId: 9, running: true }, { ...targets[1]!, deploymentId: 9, running: false }] : [];
      const trace: string[] = [];
      network.writeDynamicConfig.mockImplementation(async () => { trace.push('routing'); });
      network.agentOp.mockImplementation(async (_db, _server, op, params) => {
        if (op === 'agent.ping') return { exitCode: 0, lines: ['ND-AGENT '+JSON.stringify({ version: '0.19.0', caps: ['docker.mutations', 'proxy.routingAck'] })] };
        const header = { requestId: params.requestId, serviceId: params.serviceId, revision: params.revision, complete: true };
        expect(params).not.toHaveProperty('deploymentId');
        if (op === 'docker.runtimeFence') { trace.push('fence'); return { exitCode: 0, lines: ['ND-RUNTIME-FENCE '+JSON.stringify({ ...header, deploymentWatermark: params.deploymentWatermark })] }; }
        if (op === 'docker.runtimeInventory') { trace.push('inventory'); expect(params.expectedNames).toContain('web-9'); return { exitCode: 0, lines: ['ND-RUNTIME-INVENTORY '+JSON.stringify({ ...header, items: members })] }; }
        if (op === 'docker.stopSet') { trace.push('stop'); expect(trace).toContain('routing'); expect(params.targets).toEqual(members.map(({ running: _running, ...item }) => item)); return { exitCode: 0, lines: ['ND-STOPPED-SET '+JSON.stringify({ ...header, items: params.targets.map((item: object) => ({ ...item, running: false })) })] }; }
        if (op === 'docker.runtimeLegacyHandoff') { trace.push('handoff'); return { exitCode: 0, lines: ['ND-RUNTIME-LEGACY '+JSON.stringify({ ...header, deploymentWatermark: params.deploymentWatermark })] }; }
        throw Error('No legacy fallback during unselected Stop: '+op);
      });
      const instance = await app(), response = await instance.inject({ method: 'POST', url: '/1/stop', headers: asUser() }); expect(response.statusCode).toBe(202);
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      expect(await finish(reconcileNodeLifecycleIntents(c.db))).toEqual([{ id: response.json().lifecycle.id, state: 'completed' }]);
      expect(trace).toEqual(['fence', 'inventory', 'routing', 'stop', 'handoff']);
      const stored = (await c.db.select().from(nodeLifecycleIntents))[0]!; expect(stored.phase).toBe('completed'); expect(stored.runtimeId).toBeNull();
      expect((await service()).status).toBe('stopped');
    })();
  });

  it.each(['retry', 'supersede'] as const)('retains captured unselected Stop targets after routing loss: %s', async mode => {
    await c.db.update(services).set({ runtimeId: null, status: 'deploying' }).where(eq(services.id, 1));
    await c.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'building' });
    const target = { ...targets[0]!, deploymentId: 9 };
    const trace: string[] = [];
    network.agentOp.mockImplementation(async (_db, _server, op, params) => {
      if (op === 'agent.ping') return { exitCode: 0, lines: ['ND-AGENT '+JSON.stringify({ version: '0.19.0', caps: ['docker.mutations', 'docker.lifecycle', 'docker.recovery', 'docker.readiness', 'proxy.routingAck'] })] };
      const header = { requestId: params.requestId, serviceId: params.serviceId, revision: params.revision, complete: true };
      if (op === 'docker.runtimeFence') { trace.push('fence'); return { exitCode: 0, lines: ['ND-RUNTIME-FENCE '+JSON.stringify({ ...header, deploymentWatermark: params.deploymentWatermark })] }; }
      if (op === 'docker.runtimeInventory') { trace.push('inventory'); return { exitCode: 0, lines: ['ND-RUNTIME-INVENTORY '+JSON.stringify({ ...header, items: [{ ...target, running: true }] })] }; }
      if (op === 'docker.stopSet') { trace.push('stop'); expect(params.targets).toEqual([target]); return { exitCode: 0, lines: ['ND-STOPPED-SET '+JSON.stringify({ ...header, items: [{ ...target, running: false }] })] }; }
      if (op === 'docker.runtimeLegacyHandoff') { trace.push('handoff'); return { exitCode: 0, lines: ['ND-RUNTIME-LEGACY '+JSON.stringify({ ...header, deploymentWatermark: params.deploymentWatermark })] }; }
      throw Error('Unexpected unselected Stop operation: '+op);
    });
    const instance = await app(), response = await instance.inject({ method: 'POST', url: '/1/stop', headers: asUser() });
    expect(response.statusCode).toBe(202); const id = response.json().lifecycle.id;
    network.writeDynamicConfig.mockRejectedValueOnce(new Error('Routing unconfirmed'));
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    expect(await finish(reconcileNodeLifecycleIntents(c.db))).toEqual([{ id, state: 'held' }]);
    expect(trace).toEqual(['fence', 'inventory']);
    expect((await c.db.query.nodeLifecycleIntents.findFirst())!).toMatchObject({ phase: 'routing', targets: [target] });
    if (mode === 'supersede') await c.db.update(services).set({ runtimeId: 'web-10', status: 'running' }).where(eq(services.id, 1));
    const retry = await instance.inject({ method: 'POST', url: '/1/lifecycle/retry', headers: asUser() });
    expect(retry.statusCode).toBe(mode === 'retry' ? 202 : 409);
    if (mode === 'retry') {
      expect(await finish(reconcileNodeLifecycleIntents(c.db))).toEqual([{ id, state: 'completed' }]);
      expect(trace).toEqual(['fence', 'inventory', 'stop', 'handoff']);
    } else {
      await vi.advanceTimersByTimeAsync(600_000);
      await finish(reconcileNodeLifecycleIntents(c.db));
      expect(trace).toEqual(['fence', 'inventory']); expect((await service()).status).toBe('running');
    }
  });

  it('accepts a generation-independent Stop while the first node deployment is still building', async () => {
    await c.db.update(services).set({ runtimeId: null, runtimeReplicas: 1, status: 'deploying' }).where(eq(services.id, 1));
    await c.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'building' });
    const instance = await app();
    const response = await instance.inject({ method: 'POST', url: '/1/stop', headers: asUser() });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ pending: true, lifecycle: { action: 'stop', phase: 'fencing' } });
    expect((await c.db.query.deployments.findFirst({ where: eq(deployments.id, 9) }))?.status).toBe('cancelled');
    const intents = await c.db.select().from(nodeLifecycleIntents); expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ runtimeId: null, deploymentId: null, action: 'stop' });
    expect((await service()).status).toBe('stopped'); expect(effects).toEqual([]);
  });
  it('keeps Stop unavailable for a never-deployed idle service without active work', async () => {
    await c.db.update(services).set({ runtimeId: null, runtimeReplicas: 1, status: 'idle' }).where(eq(services.id, 1));
    const instance = await app();
    const response = await instance.inject({ method: 'POST', url: '/1/stop', headers: asUser() });
    expect(response.statusCode).toBe(404); expect(await c.db.select().from(nodeLifecycleIntents)).toHaveLength(0);
    expect(network.agentOp).not.toHaveBeenCalled();
  });

  it('completes a node Stop only after its fan-out node is stopped by immutable ordered effects', async () => {
    running = true;
    await c.db.update(services).set({ status: 'running' }).where(eq(services.id, 1));
    await c.db.insert(servers).values({ id: 5, name: 'Fan-out node', host: 'fanout.test', tokenEncrypted: 'fixture' });
    await c.db.insert(serviceTargets).values({ id: 42, serviceId: 1, serverId: 5, runtimeId: 'web-t42-9', status: 'running' });
    const target = { id: 'c'.repeat(64), name: 'web-t42-9' };
    let fanoutRunning = true;
    const original = network.agentOp.getMockImplementation()!;
    network.agentOp.mockImplementation(async (...args) => {
      if (args[1] !== 5) return original(...args);
      const op = args[2], params = args[3];
      if (op === 'agent.ping') return { exitCode: 0, lines: ['ND-AGENT ' + JSON.stringify({ version: '0.18.3', caps: ['docker.lifecycle', 'docker.recovery', 'docker.readiness', 'proxy.routingAck'] })] };
      if (op === 'docker.identity') return { exitCode: 0, lines: ['ND-CONTAINER ' + JSON.stringify(params.name === target.name || params.name === target.id ? { ...target, managed: 'service', serviceId: '1', deploymentId: '9' } : null)] };
      if (op === 'docker.inspect') return { exitCode: 0, lines: [fanoutRunning ? 'running|172.23.0.2' : 'exited|'] };
      if (op === 'docker.lifecycle') {
        const request = containerLifecycleRequest.parse(params);
        if (request.targets.length) { expect(request.action).toBe('stop'); expect(request.targets).toEqual([target]); fanoutRunning = false; }
        return { exitCode: 0, lines: ['ND-LIFECYCLE ' + JSON.stringify({ ...request, timeoutMs: undefined, targets: undefined, complete: true, items: request.targets.map(item => ({ ...item, running: fanoutRunning })) })] };
      }
      throw Error('Fan-out Stop requires ordered immutable effects, not a legacy fallback: ' + op);
    });
    const instance = await app();
    const response = await instance.inject({ method: 'POST', url: '/1/stop', headers: asUser() });
    expect(response.statusCode).toBe(202);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const result = await finish(reconcileNodeLifecycleIntents(c.db));
    expect(result).toEqual([{ id: response.json().lifecycle.id, state: 'completed' }]);
    expect(running).toBe(false);
    expect(fanoutRunning, 'A completed service Stop must not leave a fan-out runtime running').toBe(false);
    expect(network.agentOp.mock.calls.some(call => call[1] === 5 && call[2] === 'docker.lifecycle')).toBe(true);
  });

  it.each(['start', 'stop', 'restart'] as const)('accepts %s durably without reporting a completed runtime effect', async action => {
    const instance = await app();
    const response = await instance.inject({ method: 'POST', url: `/1/${action}`, headers: asUser() });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ ok: true, pending: true, lifecycle: { id: expect.any(Number), action } });
    expect(effects).toEqual([]);
    const intents = await c.db.select().from(nodeLifecycleIntents); expect(intents).toHaveLength(1); expect(intents[0]!.action).toBe(action);
    expect((await service()).status).toBe('stopped');
  });

  it('binds an acknowledgement to the accepted command when a newer Stop arrives before serialization', async () => {
    const original = c.db.query.nodeLifecycleIntents.findFirst.bind(c.db.query.nodeLifecycleIntents);
    let stopId = 0;
    vi.spyOn(c.db.query.nodeLifecycleIntents, 'findFirst').mockImplementation(async (...args) => {
      if (!stopId) stopId = (await acceptNodeLifecycleIntent(c.db, await service(), 'stop')).id;
      return original(...args);
    });
    const instance = await app();
    const result = await instance.inject({ method: 'POST', url: '/1/start', headers: asUser() });
    expect(result.statusCode).toBe(202);
    expect(result.json().lifecycle).toMatchObject({ action: 'start', phase: 'superseded', current: false });
    expect(result.json().lifecycle.id).toBeLessThan(stopId);
    expect((await service()).status).toBe('stopped'); expect(effects).toEqual([]);
  });

  it.each(['start', 'stop', 'restart'] as const)('executes accepted %s through the production recovery entry point', async action => {
    const instance = await app();
    const response = await instance.inject({ method: 'POST', url: `/1/${action}`, headers: asUser() });
    const command = response.json().lifecycle;
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    expect(await finish(reconcileNodeLifecycleIntents(c.db))).toEqual([{ id: command.id, state: 'completed' }]);
    expect((await service()).status).toBe(action === 'stop' ? 'stopped' : 'running');
    expect(effects).toEqual(action === 'start' ? ['start'] : action === 'stop' ? ['fence', 'stop'] : ['fence', 'stop', 'start']);
    expect(network.agentOp.mock.calls.some(call => call[2] === 'docker.start' || call[2] === 'docker.stop')).toBe(false);
    expect(network.writeDynamicConfig).toHaveBeenCalledWith(c.db, expect.objectContaining({ requireNode: 4, confirmNodeRouting: true, confirmServiceId: 1 }));
    const view = await instance.inject({ method: 'GET', url: '/1/lifecycle', headers: asUser() });
    expect(view.json()).toMatchObject({ command: { id: command.id, phase: 'completed', retryable: false, busy: false } });
    expect(view.body).not.toMatch(/ownerToken|requestId|leaseUntil|deploymentId|targets/);
  });

  it('holds lost routing acknowledgement and retries the original command without replaying Start', async () => {
    const instance = await app();
    const response = await instance.inject({ method: 'POST', url: '/1/start', headers: asUser() });
    const id = response.json().lifecycle.id;
    network.writeDynamicConfig.mockRejectedValueOnce(new Error('Routing unconfirmed'));
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    expect(await finish(reconcileNodeLifecycleIntents(c.db))).toEqual([{ id, state: 'held' }]);
    expect((await service()).status).toBe('deploying');
    const view = (await instance.inject({ method: 'GET', url: '/1/lifecycle', headers: asUser() })).json();
    expect(view).toMatchObject({ command: { id, phase: 'routing', reason: 'Routing unconfirmed', retryable: true } });
    const retry = await instance.inject({ method: 'POST', url: '/1/lifecycle/retry', headers: asUser() });
    expect(retry.statusCode).toBe(202); expect(retry.json()).toMatchObject({ command: { id } });
    expect(await finish(reconcileNodeLifecycleIntents(c.db))).toEqual([{ id, state: 'completed' }]);
    expect(effects).toEqual(['start']); expect(await c.db.select().from(nodeLifecycleIntents)).toHaveLength(1);
  });

  it('does not let a manual retry steal a live lease', async () => {
    const instance = await app();
    const response = await instance.inject({ method: 'POST', url: '/1/stop', headers: asUser() });
    const claimed = await claimNodeLifecycleIntent(c.db, response.json().lifecycle.id);
    expect((await instance.inject({ method: 'POST', url: '/1/lifecycle/retry', headers: asUser() })).statusCode).toBe(409);
    expect((await c.db.query.nodeLifecycleIntents.findFirst())!.ownerToken).toBe(claimed!.ownerToken);
    expect(effects).toEqual([]);
  });

  it('records Stop while the node is offline and holds its effects without restoring running', async () => {
    const instance = await app();
    await c.db.update(services).set({ status: 'running' }).where(eq(services.id, 1));
    network.agentOp.mockRejectedValue(new Error('Node offline'));
    const response = await instance.inject({ method: 'POST', url: '/1/stop', headers: asUser() });
    expect(response.statusCode).toBe(202); expect((await service()).status).toBe('stopped');
    expect(await reconcileNodeLifecycleIntents(c.db)).toEqual([{ id: response.json().lifecycle.id, state: 'held' }]);
    expect((await c.db.query.nodeLifecycleIntents.findFirst())!.reason).toMatch(/offline/);
    expect((await service()).status).toBe('stopped'); expect(effects).toEqual([]);
  });

  it.each(['start', 'restart'] as const)('refuses %s on an old agent before acceptance', async action => {
    network.agentOp.mockResolvedValue({ exitCode: 0, lines: ['ND-AGENT {"version":"0.18.2","caps":[]}'] });
    const instance = await app();
    const response = await instance.inject({ method: 'POST', url: `/1/${action}`, headers: asUser() });
    expect(response.statusCode).toBe(422); expect(response.json().error).toMatchObject({ code: 'node_agent_outdated', message: expect.stringContaining('0.18.3') });
    expect(await c.db.select().from(nodeLifecycleIntents)).toHaveLength(0); expect(effects).toEqual([]);
  });

  it.each(['start', 'restart'] as const)('refuses %s when the node owner disables ordered lifecycle', async action => {
    network.agentOp.mockResolvedValue({ exitCode: 0, lines: ['ND-AGENT {"version":"0.18.3","caps":["docker.recovery","docker.readiness","proxy.routingAck"]}'] });
    const instance = await app();
    const response = await instance.inject({ method: 'POST', url: `/1/${action}`, headers: asUser() });
    expect(response.statusCode).toBe(403); expect(response.json().error.code).toBe('node_feature_disabled');
    expect(await c.db.select().from(nodeLifecycleIntents)).toHaveLength(0); expect(effects).toEqual([]);
  });

  it('refuses unsealed Start without disclosing lifecycle parameters to the agent', async () => {
    network.agentTransportSealed.mockResolvedValue(false);
    const instance = await app();
    const response = await instance.inject({ method: 'POST', url: '/1/start', headers: asUser() });
    expect(response.statusCode).toBe(422); expect(response.json().error.code).toBe('node_transport_unsealed');
    expect(network.agentOp).not.toHaveBeenCalled(); expect(await c.db.select().from(nodeLifecycleIntents)).toHaveLength(0);
  });

  it('settles cancelled routing without waiting for a lost response and prevents its late Start publication', async () => {
    const instance = await app(); const abort = new AbortController();
    const response = await instance.inject({ method: 'POST', url: '/1/start', headers: asUser() });
    let answer!: () => void;
    network.writeDynamicConfig.mockImplementationOnce(() => new Promise<void>(resolve => { answer = resolve; }));
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const pending = reconcileNodeLifecycleIntents(c.db, { signal: abort.signal });
    for (let n = 0; n < 100 && !answer; n++) await vi.advanceTimersByTimeAsync(250);
    expect(answer).toBeTypeOf('function'); abort.abort(Error('Panel closing'));
    expect(await finish(pending)).toEqual([{ id: response.json().lifecycle.id, state: 'held' }]);
    const stop = await instance.inject({ method: 'POST', url: '/1/stop', headers: asUser() });
    expect(await finish(reconcileNodeLifecycleIntents(c.db))).toEqual([{ id: stop.json().lifecycle.id, state: 'completed' }]);
    answer(); await vi.advanceTimersByTimeAsync(1000);
    expect((await service()).status).toBe('stopped'); expect(running).toBe(false);
  });

  it('queues automatic node recovery and lets the production plugin verify it', async () => {
    await c.db.update(services).set({ status: 'running' }).where(eq(services.id, 1));
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const instance = await app(); await instance.register(runtimeStatePlugin); await instance.register(nodeLifecyclePlugin); await instance.ready();
    const completed = (async () => {
      for (let n = 0; n < 2000; n++) {
        const row = await c.db.query.nodeLifecycleIntents.findFirst();
        if (row?.phase === 'completed') return row;
        await new Promise(resolve => setImmediate(resolve));
      }
      throw Error('Automatic recovery did not complete');
    })();
    const result = await finish(completed);
    expect(result.action).toBe('start'); expect(effects).toEqual(['start']);
    expect(network.agentOp.mock.calls.some(call => call[2] === 'docker.start')).toBe(false);
    await instance.close();
  });

  it('announces a completed worker Stop to the activity trail and kernel after immutable effects', async () => {
    running = true;
    await c.db.update(services).set({ status: 'running' }).where(eq(services.id, 1));
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const instance = await app();
    const emit = vi.spyOn(instance.kernel.events, 'emit');
    await instance.register(nodeLifecyclePlugin); await instance.ready();
    try {
      const result = await instance.inject({ method: 'POST', url: '/1/stop', headers: asUser() });
      expect(result.statusCode).toBe(202);
      expect(emit).not.toHaveBeenCalledWith('service.stopped', expect.anything());
      const observed = (async () => {
        for (let n = 0; n < 100; n++) {
          if (emit.mock.calls.some(call => call[0] === 'service.stopped')) return;
          await new Promise(resolve => setImmediate(resolve));
        }
      })();
      await finish(observed);
      expect(emit.mock.calls.filter(call => call[0] === 'service.stopped')).toEqual([['service.stopped', { serviceId: 1 }]]);
      expect(effects).toEqual(['fence', 'stop']); expect(running).toBe(false);
      expect((await c.db.query.nodeLifecycleIntents.findFirst())!.phase).toBe('completed');
      expect((await c.db.select().from(auditLog)).filter(row => row.action === 'service.stop')).toMatchObject([
        { entity: 'Web #1', meta: { serviceId: 1, commandId: result.json().lifecycle.id } },
      ]);
    } finally { await instance.close(); emit.mockRestore(); }
  });

  it('alerts when the production worker holds a recovery command without declaring the service dead', async () => {
    await c.db.update(services).set({ status: 'running' }).where(eq(services.id, 1));
    await acceptNodeLifecycleIntent(c.db, await service(), 'start', { automatic: true });
    network.writeDynamicConfig.mockRejectedValue(new Error('Routing unconfirmed'));
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const instance = await app();
    await instance.register(nodeLifecyclePlugin); await instance.ready();
    try {
      let alerted = false;
      const observing = (async () => {
        for (let n = 0; n < 100; n++) {
          if ((await c.db.select().from(auditLog)).some(row => row.action === 'alert.service_recovery_held')) { alerted = true; return; }
          await new Promise(resolve => setImmediate(resolve));
        }
      })();
      await finish(observing);
      const command = (await c.db.query.nodeLifecycleIntents.findFirst())!;
      expect(command).toMatchObject({ action: 'start', phase: 'routing', reason: 'Routing unconfirmed' });
      expect(alerted, 'A held automatic recovery must reach the operator alert stream').toBe(true);
      expect((await service()).status).toBe('deploying');
      const alerts = (await c.db.select().from(auditLog)).filter(row => row.action.startsWith('alert.'));
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ action: 'alert.service_recovery_held', entity: 'Web #1', meta: { serviceId: 1, serverId: 4, commandId: command.id, action: 'start', phase: 'routing' } });
      expect(effects).toEqual(['start']);
    } finally { await instance.close(); }
  });

  it('alerts when an old agent blocks automatic recovery before a command can be accepted', async () => {
    await c.db.update(services).set({ status: 'running' }).where(eq(services.id, 1));
    const original = network.agentOp.getMockImplementation()!;
    network.agentOp.mockImplementation(async (...args) => args[2] === 'agent.ping'
      ? { exitCode: 0, lines: ['ND-AGENT {"version":"0.18.2","caps":[]}'] } : original(...args));
    const instance = await app(), patrol = createRuntimeStateReconciler(instance);
    try {
      await patrol.reconcile(); await patrol.reconcile();
      const alerts = (await c.db.select().from(auditLog)).filter(row => row.action.startsWith('alert.'));
      expect(alerts, 'A stopped runtime held by an incompatible agent must notify its operator').toHaveLength(1);
      expect(alerts[0]).toMatchObject({ action: 'alert.service_recovery_held', entity: 'Web #1', meta: { serviceId: 1, serverId: 4, code: 'node_agent_outdated' } });
      expect((await service()).status).toBe('running');
      expect(await c.db.select().from(nodeLifecycleIntents)).toEqual([]);
      expect(effects).toEqual([]);
    } finally { await patrol.close(); await instance.close(); }
  });

  it('keeps explicit Stop authoritative when automatic recovery was paused after reading running', async () => {
    await c.db.update(services).set({ status: 'running' }).where(eq(services.id, 1));
    let entered!: () => void, release!: () => void, paused = false;
    const entering = new Promise<void>(resolve => { entered = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
    const original = network.agentOp.getMockImplementation()!;
    network.agentOp.mockImplementation(async (...args) => {
      if (!paused && args[2] === 'agent.ping') { paused = true; entered(); await resume; }
      return original(...args);
    });
    const instance = await app(); await instance.register(runtimeStatePlugin); await instance.ready();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([entering, new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(Error('Automatic recovery barrier deadline')), 5000); })]);
      clearTimeout(deadline);
      const response = await instance.inject({ method: 'POST', url: '/1/stop', headers: asUser() }); expect(response.statusCode).toBe(202);
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      expect(await finish(reconcileNodeLifecycleIntents(c.db))).toEqual([{ id: response.json().lifecycle.id, state: 'completed' }]);
      vi.useRealTimers(); release(); await instance.close();
      expect(effects).toEqual(['fence', 'stop']); expect((await service()).status).toBe('stopped');
      expect((await c.db.select().from(nodeLifecycleIntents)).map(row => row.action)).toEqual(['stop']);
    } finally { clearTimeout(deadline); release(); vi.useRealTimers(); await instance.close(); }
  });

  it.each([
    { action: 'start', serving: 3, desired: 1, capacity: 4 }, { action: 'stop', serving: 3, desired: 1, capacity: 4 }, { action: 'restart', serving: 3, desired: 1, capacity: 4 },
    { action: 'start', serving: 3, desired: 4, capacity: 4 }, { action: 'stop', serving: 3, desired: 4, capacity: 4 }, { action: 'restart', serving: 3, desired: 4, capacity: 4 },
    { action: 'start', serving: 3, desired: 2, capacity: 4 }, { action: 'stop', serving: 3, desired: 2, capacity: 4 }, { action: 'restart', serving: 3, desired: 2, capacity: 4 },
    { action: 'start', serving: 1000, desired: 1, capacity: 10 }, { action: 'stop', serving: 1000, desired: 1, capacity: 10 }, { action: 'restart', serving: 1000, desired: 1, capacity: 10 },
  ] as const)('uses immutable serving/capacity shape for $action, recorded=$serving desired=$desired', async ({ action, serving, desired, capacity }) => {
    available = Array.from({ length: capacity }, (_, index) => ({ id: (index + 1).toString(16).padStart(64, '0'), name: index === 0 ? 'web-9' : `web-9-r${index + 1}` }));
    await c.db.update(services).set({ runtimeReplicas: serving, replicas: desired, autoscale: null }).where(eq(services.id, 1));
    const instance = await app();
    expect((await instance.inject({ method: 'POST', url: `/1/${action}`, headers: asUser() })).statusCode).toBe(202);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    expect((await finish(reconcileNodeLifecycleIntents(c.db)))[0]!.state).toBe('completed');
    const requests = network.agentOp.mock.calls.filter(call => call[2] === 'docker.lifecycle').map(call => containerLifecycleRequest.parse(call[3]));
    const starting = requests.find(request => request.action === 'start');
    const stopping = requests.find(request => request.action === 'stop' && request.targets.length > 0);
    if (action !== 'stop') expect(starting!.targets).toEqual(available.slice(0, Math.min(10, serving)));
    if (action !== 'start') expect(stopping!.targets).toEqual(available);
    expect(requests.every(request => request.targets.length <= 10)).toBe(true);
  });
});
