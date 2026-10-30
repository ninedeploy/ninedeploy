import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { deployments, services, swarmTransitions } from '@ninedeploy/db';
import { observabilityDb } from './fixtures/observability.js';
import type { StackSpec } from '../src/kernel/types.js';
const h = vi.hoisted(() => ({ http: vi.fn(), capture: vi.fn(), run: vi.fn(), spawn: vi.fn(), proxy: vi.fn(), docker: new Map<string, { id: string; name: string; managed: string | null; serviceId: string; deploymentId: string }>(), manager: 'mgr0000000000000000000001', native: null as any, image: new Map<string, string>(), beforeUpdate: undefined as undefined | (() => void) }));
vi.mock('../src/lib/dockerEngineApi.js', () => ({ dockerEngineRequest: h.http }));
vi.mock('../src/lib/exec.js', async original => ({ ...await original<typeof import('../src/lib/exec.js')>(), capture: h.capture, run: h.run }));
vi.mock('../src/lib/spawnValidated.js', () => ({ spawnValidated: h.spawn }));
vi.mock('../src/engine/proxy.js', async original => ({ ...await original<typeof import('../src/engine/proxy.js')>(), writeDynamicConfig: h.proxy }));
const { beginSwarmTransition, reconcileSwarmTransitions, listSwarmRecovery } = await import('../src/engine/swarmRecovery.js');
const { managedSwarmServiceSpec } = await import('../src/engine/swarmServiceSpec.js');
const { SWARM_IMAGE_SERVICE_FORMAT, SWARM_IMAGE_TASK_FORMAT } = await import('../src/engine/swarmArtifact.js');
const SVC = 'svc0000000000000000000001', TASK = 'tsk0000000000000000000001', CID = 'c'.repeat(64), OLD = `sha256:${'a'.repeat(64)}`, NEXT = `sha256:${'b'.repeat(64)}`;
const OLD_REF = 'ninedeploy/web:old-b7', NEXT_REF = 'ninedeploy/web:next-b9';
let f: Awaited<ReturnType<typeof observabilityDb>>;
const controllers: Array<Awaited<ReturnType<typeof beginSwarmTransition>>> = [];
function stack(id: number, image: string): StackSpec { return { name: 'nd-web', services: [{ name: 'web', image, replicas: 1, port: 8080, env: { SECRET: id === 7 ? 'old-fixture-secret' : 'next-fixture-secret' }, networks: ['nd-swarm-web'], secrets: [], configs: [], labels: { 'ninedeploy.managed': 'service', 'ninedeploy.service': '1', 'ninedeploy.deployment': String(id) }, healthCommand: 'ready' }], networks: [{ name: 'nd-swarm-web', driver: 'overlay', attachable: true }], volumes: [], secrets: [], configs: [] }; }
const ref = () => h.native?.Spec.TaskTemplate.ContainerSpec.Image;
beforeEach(async () => {
  h.manager = 'mgr0000000000000000000001'; h.beforeUpdate = undefined; h.native = null; h.image = new Map([[OLD_REF, OLD], [NEXT_REF, NEXT]]);
  h.proxy.mockReset().mockResolvedValue(undefined);
  h.docker = new Map(); h.run.mockReset().mockResolvedValue(undefined);
  h.spawn.mockReset().mockImplementation(async (_cmd, args, sink) => {
    const row = [...h.docker.values()].find(c => c.name === args.at(-1) || c.id === args.at(-1));
    if (!row) { sink(`Error: No such object: ${args.at(-1)}`); return 1; }
    if (args[0] === 'rm') { h.docker.delete(row.id); return 0; }
    if (args[0] === 'stop') return 0;
    if (args.includes('{{.Name}}')) sink('/'+row.name);
    else sink(JSON.stringify({ ...row, name: '/'+row.name }));
    return 0;
  });
  h.capture.mockReset().mockImplementation(async (_cmd: string, args: string[]) => {
    if (args[0] === 'info') return JSON.stringify({ LocalNodeState: 'active', ControlAvailable: true, NodeID: h.manager });
    if (args[0] === 'network') return 'net0000000000000000000001';
    if (args.includes('{{.State.Status}}')) return 'running';
    if (args.includes(SWARM_IMAGE_SERVICE_FORMAT)) return JSON.stringify({ id: h.native.ID, version: h.native.Version.Index, image: ref(), service: h.native.Spec.Labels['ninedeploy.service'], deployment: h.native.Spec.Labels['ninedeploy.deployment'] });
    if (args[0] === 'service' && args[1] === 'ps') return TASK;
    if (args[0] === 'service' && args[1] === 'ls') return `nd-web_web ${h.native.Spec.Mode.Replicated.Replicas}/${h.native.Spec.Mode.Replicated.Replicas}`;
    if (args.includes(SWARM_IMAGE_TASK_FORMAT)) return JSON.stringify({ id: TASK, service: h.native.ID, node: h.manager, desired: 'running', state: 'running', container: CID });
    if (args.includes('container')) return args.includes('{{.Image}}') ? h.image.get(ref()) : 'running|healthy|0|0';
    if (args[0] === 'image') return h.image.get(args.at(-1)!) + '|100';
    if (args[0] === 'exec') return '';
    throw Error('Unexpected Docker read '+args.slice(0,2).join(' '));
  });
  h.http.mockReset().mockImplementation(async (method: string, path: string, body?: any) => {
    if (method === 'GET') return { status: h.native ? 200 : 404, body: h.native ? structuredClone(h.native) : null };
    if (path === '/services/create') {
      if (h.native) return { status: 409, body: {} };
      h.native = { ID: SVC, Version: { Index: 1 }, Spec: structuredClone(body), UpdateStatus: { State: 'completed' } };
      return { status: 201, body: { ID: SVC } };
    }
    h.beforeUpdate?.(); h.beforeUpdate = undefined;
    if (!h.native || new URL('http://engine'+path).searchParams.get('version') !== String(h.native.Version.Index)) return { status: 500, body: { message: 'update out of sequence' } };
    const taskChanged = JSON.stringify(h.native.Spec.TaskTemplate) !== JSON.stringify(body.TaskTemplate) || JSON.stringify(h.native.Spec.Mode) !== JSON.stringify(body.Mode);
    h.native.PreviousSpec = h.native.Spec; h.native.Spec = structuredClone(body); h.native.Version.Index++;
    if (taskChanged) h.native.UpdateStatus = { State: 'completed' };
    return { status: 200, body: {} };
  });
  f = await observabilityDb();
  await f.db.update(services).set({ slug: 'web', type: 'docker', image: null, repoUrl: 'https://github.com/acme/web.git', orchestrator: 'swarm', serverId: null, status: 'deploying', runtimeId: 'nd-web_web', replicas: 1, port: 8080, healthCheck: 'command', healthCommand: 'ready', healthTimeoutSeconds: 0, commitSha: 'a'.repeat(40) }).where(eq(services.id, 1));
  await f.db.insert(deployments).values([{ id: 7, serviceId: 1, status: 'running', commitSha: 'a'.repeat(40), imageDigest: OLD, configSnapshot: '{"port":8080}' }, { id: 9, serviceId: 1, status: 'building', commitSha: 'b'.repeat(40) }]);
  h.native = { ID: SVC, Version: { Index: 7 }, Spec: await managedSwarmServiceSpec(stack(7, OLD_REF)), UpdateStatus: { State: 'completed' } };
});
afterEach(async () => { for (const controller of controllers.splice(0)) await controller.release(); f?.close(); vi.useRealTimers(); });
async function begin(port = 8080) {
  const service = (await f.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
  const controller = await beginSwarmTransition(f.db, service, 9, stack(9, NEXT_REF), { runtimeId: 'nd-web_web', port, healthPath: '/', healthCheck: 'command', imageDigest: NEXT }, 'b'.repeat(40));
  controllers.push(controller); return controller;
}
const job = () => f.db.query.deployments.findFirst({ where: eq(deployments.id, 9) });
const svc = () => f.db.query.services.findFirst({ where: eq(services.id, 1) });
const mutations = () => h.http.mock.calls.filter(c => c[0] === 'POST');
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
describe('durable Swarm service transitions', () => {
  it('rechecks backoff when it changes after the scheduled scan', async () => {
    const controller = await begin(); await controller.release('retry later');
    await f.db.update(swarmTransitions).set({ nextAttemptAt: new Date(0), attempts: 0 });
    h.http.mockClear(); h.capture.mockClear(); h.run.mockClear();
    const selected = gate(), resume = gate(); let first = true;
    const db = new Proxy(f.db, { get(real, property, receiver) {
      if (property !== 'select') return Reflect.get(real, property, receiver);
      return (...args: Parameters<typeof real.select>) => {
        const query = real.select(...args);
        if (!first) return query;
        first = false;
        return { from: (table: typeof swarmTransitions) => ({ where: (condition: Parameters<ReturnType<typeof query.from>['where']>[0]) => ({
          limit: async (count: number) => { const found = await query.from(table).where(condition).limit(count); selected.release(); await resume.promise; return found; },
        }) }) };
      };
    } }) as typeof f.db;
    const run = reconcileSwarmTransitions(db);
    try {
      await selected.promise;
      await f.db.update(swarmTransitions).set({ nextAttemptAt: new Date(Date.now() + 60_000), attempts: 4 });
    } finally { resume.release(); }
    expect(await run).toEqual({ recovered: 0, held: 0 });
    expect(h.http).not.toHaveBeenCalled(); expect(h.capture).not.toHaveBeenCalled(); expect(h.run).not.toHaveBeenCalled();
    expect((await f.db.select().from(swarmTransitions))[0]).toMatchObject({ attempts: 4, ownerToken: null });
  });
  describe('Docker → Swarm migration', () => {
    beforeEach(async () => {
      h.native = null;
      await f.db.update(services).set({ runtimeId: 'web-7', runtimeReplicas: 1 }).where(eq(services.id, 1));
      h.docker.set('d'.repeat(64), { id: 'd'.repeat(64), name: 'web-7', managed: 'service', serviceId: '1', deploymentId: '7' });
    });
    it('journals immutable Docker identities before native submission and refuses early retirement', async () => {
      const controller = await begin();
      expect(controller.payload.previousDocker?.containers[0]).toEqual({ name: 'web-7', id: 'd'.repeat(64) });
      expect(h.native).toBeNull();
      const wrapped = controller.wrap({ buildAndRun: vi.fn(), isHealthy: vi.fn(), stop: vi.fn() });
      await expect(wrapped.stop('web-7')).rejects.toThrow('unconfirmed');
      expect(h.docker.size).toBe(1); expect(h.run).not.toHaveBeenCalled();
    });
    it('recovers an interrupted native cutover and retires Docker only after readiness and routing', async () => {
      const controller = await begin(); await controller.submit(); await controller.release('crash');
      h.proxy.mockImplementation(async () => { expect(h.docker.size).toBe(1); });
      expect(await reconcileSwarmTransitions(f.db, { force: true })).toEqual({ recovered: 1, held: 0 });
      expect((await svc())?.runtimeId).toBe('nd-web_web'); expect((await job())?.status).toBe('running');
      expect(h.docker.size).toBe(0); expect(await listSwarmRecovery(f.db, 1)).toBeNull();
    });
    it('restores the healthy previous Docker generation when cancelled before submission', async () => {
      const controller = await begin(); await controller.release('crash');
      await f.db.update(deployments).set({ status: 'cancelled' }).where(eq(deployments.id, 9));
      expect(await reconcileSwarmTransitions(f.db, { force: true })).toEqual({ recovered: 1, held: 0 });
      expect(await svc()).toMatchObject({ runtimeId: 'web-7', status: 'running' }); expect(h.docker.size).toBe(1);
      expect(h.native).toBeNull(); expect(mutations()).toEqual([]); expect((await job())?.status).toBe('cancelled');
    });
    it('preserves explicit Stop and retires the known old Docker generation without starting Swarm', async () => {
      const controller = await begin(); await controller.release('crash');
      await f.db.update(services).set({ status: 'stopped' }).where(eq(services.id, 1));
      expect(await reconcileSwarmTransitions(f.db, { force: true })).toEqual({ recovered: 1, held: 0 });
      expect(await svc()).toMatchObject({ runtimeId: null, status: 'stopped' }); expect(h.docker.size).toBe(0);
      expect(h.native).toBeNull(); expect(mutations()).toEqual([]); expect((await job())?.status).toBe('cancelled');
    });
    it('accepts the service/deployment labels from 0.17 without requiring the new managed label', async () => {
      h.docker.get('d'.repeat(64))!.managed = null;
      expect((await begin()).payload.previousDocker?.deploymentId).toBe(7);
    });
    it.each(['serviceId', 'deploymentId', 'managed'])('refuses a conflicting previous Docker %s before native submission', async field => {
      h.docker.get('d'.repeat(64))![field as 'serviceId' | 'deploymentId' | 'managed'] = 'foreign';
      await expect(begin()).rejects.toThrow('ownership'); expect(h.native).toBeNull(); expect(mutations()).toEqual([]);
    });
    it('retires stopped spare containers with the same owned generation', async () => {
      h.docker.set('e'.repeat(64), { id: 'e'.repeat(64), name: 'web-7-r2', managed: null, serviceId: '1', deploymentId: '7' });
      const controller = await begin(); await controller.submit(); await controller.release('crash');
      expect(await reconcileSwarmTransitions(f.db, { force: true })).toEqual({ recovered: 1, held: 0 });
      expect(h.docker.size).toBe(0); expect((await job())?.status).toBe('running');
    });
    it('rolls back a paused native candidate to Docker without stopping its previous generation', async () => {
      const controller = await begin(); await controller.submit(); h.native.UpdateStatus.State = 'paused'; await controller.release('crash');
      expect(await reconcileSwarmTransitions(f.db, { force: true })).toEqual({ recovered: 1, held: 0 });
      expect(await svc()).toMatchObject({ runtimeId: 'web-7', status: 'running' }); expect((await job())?.status).toBe('failed');
      expect(h.native.Spec.Mode.Replicated.Replicas).toBe(0); expect(h.docker.size).toBe(1);
    });
    it('retains Docker across unconfirmed routing, then resumes the same native deployment safely', async () => {
      const controller = await begin(); await controller.submit(); await controller.release('crash');
      h.proxy.mockRejectedValueOnce(Error('routing unconfirmed'));
      expect(await reconcileSwarmTransitions(f.db, { force: true })).toEqual({ recovered: 0, held: 1 });
      expect(h.docker.size).toBe(1); expect((await job())?.status).toBe('building');
      expect(await reconcileSwarmTransitions(f.db, { force: true })).toEqual({ recovered: 1, held: 0 });
      expect(h.docker.size).toBe(0); expect((await job())?.status).toBe('running');
    });
    it('retains a renamed previous container rather than guessing ownership from its old name', async () => {
      const controller = await begin(); await controller.submit(); await controller.release('crash');
      h.docker.get('d'.repeat(64))!.name = 'operator-renamed';
      expect(await reconcileSwarmTransitions(f.db, { force: true })).toEqual({ recovered: 0, held: 1 });
      expect(h.docker.size).toBe(1); expect((await job())?.status).toBe('building'); expect(await listSwarmRecovery(f.db, 1)).not.toBeNull();
    });
  });
  it('encrypts both runtime specs before submission and exposes only operator-safe recovery fields', async () => {
    await begin(); const [row] = await f.db.select().from(swarmTransitions);
    expect(row?.phase).toBe('prepared'); expect(row?.payloadEncrypted).not.toContain('fixture-secret');
    const view = await listSwarmRecovery(f.db, 1);
    expect(view).toMatchObject({ deploymentId: 9, busy: true, phase: 'prepared' });
    expect(JSON.stringify(view)).not.toMatch(/fixture-secret|ownerToken|payloadEncrypted|TaskTemplate|fingerprint/);
    expect(mutations()).toHaveLength(0); expect(ref()).toBe(OLD_REF);
  });
  it('submits using the exact observed service revision and prepared image', async () => {
    const controller = await begin(); await controller.submit();
    expect(mutations()[0]?.[1]).toBe(`/services/${SVC}/update?version=7`);
    expect(ref()).toBe(NEXT_REF); expect((await f.db.select().from(swarmTransitions))[0]?.phase).toBe('submitted');
  });
  it('does not steal a live lease even for an operator retry', async () => {
    const controller = await begin();
    expect(await reconcileSwarmTransitions(f.db, { force: true })).toEqual({ recovered: 0, held: 0 });
    expect(mutations()).toHaveLength(0); await controller.check();
  });
  it.each(['before apply', 'after apply'])('recovers the original deployment without replaying a build: %s', async stage => {
    const controller = await begin(); if (stage === 'after apply') await controller.submit();
    await controller.release('simulated process loss');
    expect(await reconcileSwarmTransitions(f.db, { force: true })).toEqual({ recovered: 1, held: 0 });
    expect(ref()).toBe(NEXT_REF); expect(await job()).toMatchObject({ status: 'running', imageDigest: NEXT });
    expect(await svc()).toMatchObject({ status: 'running', runtimeId: 'nd-web_web', commitSha: 'b'.repeat(40) });
    expect(await f.db.select().from(swarmTransitions)).toHaveLength(0);
    expect(h.proxy).toHaveBeenCalledWith(f.db, { confirmServiceId: 1 });
  });
  it('keeps the resolved deployment snapshot when routing intent has no replacement snapshot', async () => {
    const controller = await begin(); await controller.submit(); await controller.intentCandidate(); await controller.release('crash');
    expect(await reconcileSwarmTransitions(f.db, { force: true })).toEqual({ recovered: 1, held: 0 });
    expect(JSON.parse((await job())!.configSnapshot!)).toMatchObject({ port: 8080 });
  });
  it('keeps old controller mutations fenced after a new owner recovers', async () => {
    const controller = await begin(); await controller.submit(); await controller.release('crash');
    await reconcileSwarmTransitions(f.db, { force: true }); const calls = mutations().length;
    await expect(controller.submit()).rejects.toThrow('ownership changed'); expect(mutations()).toHaveLength(calls);
  });
  it('restores the encrypted previous spec after an owned candidate pauses', async () => {
    const controller = await begin(); await controller.submit(); h.native.UpdateStatus.State = 'paused'; await controller.release('crash');
    expect(await reconcileSwarmTransitions(f.db, { force: true })).toEqual({ recovered: 1, held: 0 });
    expect(ref()).toBe(OLD_REF); expect(h.native.Spec.TaskTemplate.ContainerSpec.Env).toContain('SECRET=old-fixture-secret');
    expect(await job()).toMatchObject({ status: 'failed' }); expect(await svc()).toMatchObject({ status: 'running', commitSha: 'a'.repeat(40) });
  });
  it('cancels before apply without ever starting the candidate', async () => {
    const controller = await begin(); await controller.release('crash');
    await f.db.update(deployments).set({ status: 'cancelled', finishedAt: new Date() }).where(eq(deployments.id, 9));
    expect(await reconcileSwarmTransitions(f.db, { force: true })).toEqual({ recovered: 1, held: 0 });
    expect(ref()).toBe(OLD_REF); expect(mutations().every(c => c[2].TaskTemplate.ContainerSpec.Image === OLD_REF)).toBe(true); expect((await job())?.status).toBe('cancelled');
  });
  it('preserves explicit Stop and never restores a positive replica count', async () => {
    const controller = await begin(); await controller.submit(); await controller.release('crash');
    await f.db.update(services).set({ status: 'stopped', runtimeId: null }).where(eq(services.id, 1));
    await f.db.update(deployments).set({ status: 'cancelled' }).where(eq(deployments.id, 9));
    expect(await reconcileSwarmTransitions(f.db, { force: true })).toEqual({ recovered: 1, held: 0 });
    expect(h.native.Spec.Mode.Replicated.Replicas).toBe(0); expect(await svc()).toMatchObject({ status: 'stopped', runtimeId: null }); expect((await job())?.status).toBe('cancelled');
  });
  it('settles Stop before candidate submission when Docker has already scaled the previous spec to zero', async () => {
    const controller = await begin(); await controller.release('crash');
    h.native.Spec.Mode.Replicated.Replicas = 0; h.native.Version.Index++;
    await f.db.update(services).set({ status: 'stopped', runtimeId: null }).where(eq(services.id, 1));
    await f.db.update(deployments).set({ status: 'cancelled' }).where(eq(deployments.id, 9));
    expect(await reconcileSwarmTransitions(f.db, { force: true })).toEqual({ recovered: 1, held: 0 });
    expect(h.native.Spec.Mode.Replicated.Replicas).toBe(0);
    expect(mutations().every(call => call[2].Mode.Replicated.Replicas === 0)).toBe(true);
    expect(await f.db.select().from(swarmTransitions)).toHaveLength(0);
  });
  it.each(['spec', 'identity', 'manager'])('retains an unknown native %s without writing it', async kind => {
    const controller = await begin(); await controller.submit(); await controller.release('crash');
    if (kind === 'spec') h.native.Spec.TaskTemplate.ContainerSpec.Env = ['OPERATOR=changed'];
    if (kind === 'identity') h.native.ID = 'oth0000000000000000000001';
    if (kind === 'manager') h.manager = 'oth0000000000000000000001';
    const count = mutations().length;
    expect(await reconcileSwarmTransitions(f.db, { force: true })).toEqual({ recovered: 0, held: 1 });
    expect(mutations()).toHaveLength(count); expect((await job())?.status).toBe('building'); expect((await f.db.select().from(swarmTransitions))[0]?.reason).toBeTruthy();
  });
  it('never retries a rejected native revision with the new operator version', async () => {
    const controller = await begin(); h.beforeUpdate = () => { h.native.Version.Index++; h.native.Spec.TaskTemplate.ContainerSpec.Env = ['OPERATOR=changed']; };
    await expect(controller.submit()).rejects.toThrow('revision update was not confirmed');
    expect(mutations()).toHaveLength(1); expect(h.native.Spec.TaskTemplate.ContainerSpec.Env).toEqual(['OPERATOR=changed']);
  });
  it('keeps a routing failure pending and safely retries the same deployment', async () => {
    const controller = await begin(); await controller.submit(); await controller.release('crash'); h.proxy.mockRejectedValueOnce(Error('fixture-secret-in-error'));
    expect(await reconcileSwarmTransitions(f.db, { force: true })).toEqual({ recovered: 0, held: 1 });
    expect((await f.db.select().from(swarmTransitions))[0]?.reason).not.toContain('fixture-secret'); expect(ref()).toBe(NEXT_REF);
    expect(await reconcileSwarmTransitions(f.db, { force: true })).toEqual({ recovered: 1, held: 0 }); expect((await job())?.status).toBe('running');
  });
  it('releases an unreadable journal lease and holds its reason without native writes', async () => {
    const controller = await begin(); await controller.release('crash');
    await f.db.update(swarmTransitions).set({ payloadEncrypted: 'broken-ciphertext' });
    expect(await reconcileSwarmTransitions(f.db, { force: true })).toEqual({ recovered: 0, held: 1 });
    const [row] = await f.db.select().from(swarmTransitions); expect(row?.ownerToken).toBeNull(); expect(row?.reason).toContain('journal cannot be read'); expect(mutations()).toHaveLength(0);
  });
  it('refuses a routed port change before applying a native update', async () => {
    await expect(begin(9090)).rejects.toThrow('before changing its routed container port');
    expect(mutations()).toHaveLength(0); expect(await f.db.select().from(swarmTransitions)).toHaveLength(0);
  });
});
