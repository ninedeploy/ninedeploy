import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deployments, services, primaryTransitions } from '@ninedeploy/db';
import { eq } from 'drizzle-orm';
import { observabilityDb } from './fixtures/observability.js';
const h = vi.hoisted(() => ({ http: vi.fn(), capture: vi.fn(), proxy: vi.fn(), spawn: vi.fn(), manager: 'm'.repeat(25), native: null as any, conflict: false, states: 'Shutdown 1 second ago', checks: 0 }));
vi.mock('../src/lib/dockerEngineApi.js', () => ({ dockerEngineRequest: h.http }));
vi.mock('../src/lib/exec.js', async original => ({ ...await original<typeof import('../src/lib/exec.js')>(), capture: h.capture }));
vi.mock('../src/lib/spawnValidated.js', () => ({ spawnValidated: h.spawn }));
vi.mock('../src/engine/proxy.js', async original => ({ ...await original<typeof import('../src/engine/proxy.js')>(), writeDynamicConfig: h.proxy }));
const { capturePreviousNative, retirePreviousNative, previousNativeRetired, previousNativeHealthy } = await import('../src/engine/previousNative.js');
const { SWARM_IMAGE_SERVICE_FORMAT, SWARM_IMAGE_TASK_FORMAT } = await import('../src/engine/swarmArtifact.js');
const { encrypt, decrypt } = await import('../src/lib/crypto.js');
const { beginPrimaryTransition } = await import('../src/engine/primaryRecovery.js');
const nativeId = 's'.repeat(25), task = 't'.repeat(25), imageId = 'sha256:'+'a'.repeat(64), container = 'c'.repeat(64), name = 'nd-web_web';
let f: Awaited<ReturnType<typeof observabilityDb>>;
beforeEach(async () => {
  f = await observabilityDb();
  await f.db.update(services).set({ slug: 'web', type: 'docker', orchestrator: 'container', serverId: null, runtimeId: name, status: 'deploying', port: 8080 }).where(eq(services.id, 1));
  await f.db.insert(deployments).values({ id: 7, serviceId: 1, status: 'running', imageDigest: imageId });
  h.manager = 'm'.repeat(25); h.conflict = false; h.states = 'Shutdown 1 second ago'; h.checks = 0;
  h.proxy.mockReset().mockResolvedValue(undefined);
  h.spawn.mockReset().mockImplementation(async (_exe, args, sink) => {
    if (args.at(-1) === 'web-9') { sink(JSON.stringify({ id: 'd'.repeat(64), name: '/web-9', managed: 'service', serviceId: '1', deploymentId: '9' })); return 0; }
    sink(`Error: No such object: ${args.at(-1)}`); return 1;
  });
  h.native = { ID: nativeId, Version: { Index: 17 }, Spec: { Name: name, Labels: { 'ninedeploy.managed': 'service', 'ninedeploy.service': '1', 'ninedeploy.deployment': '7' }, Mode: { Replicated: { Replicas: 1 } }, TaskTemplate: { ContainerSpec: { Image: 'fixture:7', Env: ['SECRET=private-fixture-secret'] } } } };
  h.http.mockReset().mockImplementation(async (method, path, body) => {
    if (method === 'GET') return { status: 200, body: structuredClone(h.native) };
    if (h.conflict || !path.endsWith('version='+h.native.Version.Index)) return { status: 409, body: {} };
    h.native.Spec = structuredClone(body); h.native.Version.Index++; return { status: 200, body: {} };
  });
  h.capture.mockReset().mockImplementation(async (_exe, args) => {
    if (args[0] === 'info') return JSON.stringify({ LocalNodeState: 'active', ControlAvailable: true, NodeID: h.manager });
    if (args.includes(SWARM_IMAGE_SERVICE_FORMAT)) return JSON.stringify({ id: nativeId, version: h.native.Version.Index, image: 'fixture:7', service: '1', deployment: '7' });
    if (args.includes(SWARM_IMAGE_TASK_FORMAT)) return JSON.stringify({ id: task, service: nativeId, node: h.manager, desired: 'running', state: 'running', container });
    if (args.includes('{{.CurrentState}}')) return h.states;
    if (args[0] === 'service' && args[1] === 'ps') return task;
    if (args[0] === 'inspect' && args.includes('{{.Image}}')) return imageId;
    throw Error('Unexpected Docker read '+args.join(' '));
  });
});
afterEach(() => { vi.useRealTimers(); f.close(); });
const receipt = async () => capturePreviousNative(f.db, (await f.db.query.services.findFirst({ where: eq(services.id, 1) }))!);
describe('native previous generation during Swarm → Docker migration', () => {
  it('the real primary controller retires native Swarm instead of certifying absent Docker container names', async () => {
    await f.db.insert(deployments).values({ id: 9, serviceId: 1, status: 'deploying' });
    const service = (await f.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
    const controller = await beginPrimaryTransition(f.db, service, 9, { runtimeId: 'web-9', port: 8080, healthPath: '/', healthCheck: 'running' }, { runtimeId: name, port: 8080, healthPath: '/' }, 'next');
    try {
      await controller.intentCandidate();
      await f.db.update(services).set({ runtimeId: 'web-9', status: 'running', runtimeReplicas: 1 }).where(eq(services.id, 1));
      await f.db.update(deployments).set({ status: 'running' }).where(eq(deployments.id, 9));
      await controller.confirm();
      await controller.retire(name);
      expect(h.native.Spec.Mode.Replicated.Replicas).toBe(0);
      expect(await controller.completeIfSafe()).toBe(true);
      expect(await f.db.select().from(primaryTransitions)).toEqual([]);
    } finally { await controller.release(); }
  });
  it('stores provenance and fingerprints encrypted without copying native environment values', async () => {
    const encoded = await receipt(), value = JSON.parse(decrypt(encoded));
    expect(encoded).not.toContain(nativeId); expect(encoded).not.toContain(value.fingerprint);
    expect(value).toMatchObject({ id: nativeId, deploymentId: 7, knownImageIds: [imageId], replicas: 1 });
    expect(JSON.stringify(value)).not.toContain('private-fixture-secret');
  });
  it('persists the zero-spec receipt before a revision-fenced update, then confirms drained tasks', async () => {
    let encoded = await receipt(); const order: string[] = [];
    const update = h.http.getMockImplementation()!;
    h.http.mockImplementation(async (...args) => { if (args[0] === 'POST') order.push('update'); return update(...args); });
    await retirePreviousNative(encoded, name, async () => { h.checks++; }, async value => { encoded = value; order.push('persist'); });
    expect(order).toEqual(['persist', 'update']); expect(h.checks).toBeGreaterThan(1);
    expect(h.native.Spec.Mode.Replicated.Replicas).toBe(0); expect(h.native.Spec.TaskTemplate.ContainerSpec.Env).toEqual(['SECRET=private-fixture-secret']);
    expect(h.http.mock.calls.find(c => c[0] === 'POST')?.[1]).toBe(`/services/${nativeId}/update?version=17`);
    expect(await previousNativeRetired(encoded, name)).toBe(true);
    h.http.mockClear(); await retirePreviousNative(encoded, name, async () => {}, async () => { throw Error('already persisted'); });
    expect(h.http.mock.calls.some(c => c[0] === 'POST')).toBe(false);
  });
  it('retains a concurrent native revision instead of blindly repeating an update or deleting the service', async () => {
    let encoded = await receipt(); h.conflict = true;
    await expect(retirePreviousNative(encoded, name, async () => {}, async value => { encoded = value; })).rejects.toThrow('retained');
    expect(h.native.Spec.Mode.Replicated.Replicas).toBe(1); expect(await previousNativeRetired(encoded, name)).toBe(false);
    expect(h.http.mock.calls.filter(c => c[0] === 'POST')).toHaveLength(1);
  });
  it.each(['id', 'manager', 'spec'])('refuses a changed %s before submitting retirement', async changed => {
    const encoded = await receipt();
    if (changed === 'id') h.native.ID = 'x'.repeat(25);
    else if (changed === 'manager') h.manager = 'x'.repeat(25);
    else h.native.Spec.TaskTemplate.ContainerSpec.Env = ['SECRET=changed'];
    await expect(retirePreviousNative(encoded, name, async () => {}, async () => {})).rejects.toThrow('retained');
    expect(h.http.mock.calls.some(c => c[0] === 'POST')).toBe(false);
  });
  it('honors a lost SQL owner before any native mutation', async () => {
    const encoded = await receipt();
    await expect(retirePreviousNative(encoded, name, async () => { throw Error('owner changed'); }, async () => {})).rejects.toThrow('owner changed');
    expect(h.http.mock.calls.some(c => c[0] === 'POST')).toBe(false);
  });
  it('cannot declare retirement complete while an old task is still running', async () => {
    let encoded = await receipt(); h.states = 'Running 2 seconds ago';
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const run = retirePreviousNative(encoded, name, async () => {}, async value => { encoded = value; });
    const assertion = expect(run).rejects.toThrow('still draining');
    await vi.advanceTimersByTimeAsync(31_000); await assertion;
    expect(await previousNativeRetired(encoded, name)).toBe(false);
    h.states = 'Shutdown 1 second ago'; expect(await previousNativeRetired(encoded, name)).toBe(true);
  });
  it.each(['wrong service', 'unmanaged', 'history missing', 'history wrong service'])('refuses unconfirmed initial provenance: %s', async changed => {
    if (changed === 'wrong service') h.native.Spec.Labels['ninedeploy.service'] = '2';
    if (changed === 'unmanaged') delete h.native.Spec.Labels['ninedeploy.managed'];
    if (changed === 'history missing') await f.db.delete(deployments).where(eq(deployments.id, 7));
    if (changed === 'history wrong service') {
      await f.db.insert(services).values({ id: 2, name: 'Other service', slug: 'other-service', type: 'docker' });
      await f.db.insert(deployments).values({ id: 8, serviceId: 2, status: 'running' });
      h.native.Spec.Labels['ninedeploy.deployment'] = '8';
    }
    await expect(receipt()).rejects.toThrow('retained'); expect(h.http.mock.calls.some(c => c[0] === 'POST')).toBe(false);
  });
  it('refuses an unreadable encrypted receipt and never guesses native ownership', async () => {
    await expect(retirePreviousNative(encrypt('{}'), name, async () => {}, async () => {})).rejects.toThrow('retained');
    await expect(previousNativeHealthy(f.db, 'broken', 1, { runtimeId: name, port: 8080, healthPath: '/' })).rejects.toThrow('retained');
    expect(h.http).not.toHaveBeenCalled();
  });
});
