import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { servers, type DB } from '@ninedeploy/db';
import { closeMigratedDb, migratedDb } from './lib/githubAppKit.js';
const h = vi.hoisted(() => ({ capture: vi.fn(), agent: vi.fn(), sealed: vi.fn() }));
vi.mock('../src/lib/exec.js', async original => ({ ...await original<typeof import('../src/lib/exec.js')>(), capture: h.capture }));
vi.mock('../src/lib/agentClient.js', async original => ({ ...await original<typeof import('../src/lib/agentClient.js')>(), agentOp: h.agent, agentTransportSealed: h.sealed }));
const { verifySwarmTaskImages, SWARM_IMAGE_SERVICE_FORMAT, SWARM_IMAGE_TASK_FORMAT } = await import('../src/engine/swarmArtifact.js');
const SVC = 'svc0000000000000000000001', MGR = 'mgr0000000000000000000001', WRK = 'wrk0000000000000000000001', TASK = 'tsk0000000000000000000001';
const IMAGE = `sha256:${'a'.repeat(64)}`, CID = 'b'.repeat(64);
const expected = { runtimeId: 'nd-web_web', imageRef: 'ninedeploy/web:source-b9', imageId: IMAGE, replicas: 1, serviceId: 1, deploymentId: 9, panelNodeId: MGR };
let db: DB;
let service: Record<string, unknown>, task: Record<string, unknown>, ids: string[];
let serviceReads: number, taskReads: number;
beforeEach(async () => {
  db = await migratedDb();
  await db.insert(servers).values({ id: 4, name: 'worker', host: 'worker.example.test', tokenEncrypted: 'fixture', swarmNodeId: WRK });
  service = { id: SVC, version: 7, image: expected.imageRef, service: '1', deployment: '9' };
  task = { id: TASK, service: SVC, node: MGR, desired: 'running', state: 'running', container: CID };
  ids = [TASK]; serviceReads = 0; taskReads = 0;
  h.capture.mockReset().mockImplementation(async (_cmd: string, args: string[]) => {
    if (args.includes(SWARM_IMAGE_SERVICE_FORMAT)) { serviceReads++; return JSON.stringify(service); }
    if (args[0] === 'service' && args[1] === 'ps') { taskReads++; return ids.join('\n'); }
    if (args.includes(SWARM_IMAGE_TASK_FORMAT)) return JSON.stringify(task);
    if (args.includes('container') && args.includes(CID)) return IMAGE;
    throw Error('Unexpected Docker read');
  });
  h.agent.mockReset().mockResolvedValue({ exitCode: 0, lines: [IMAGE] });
  h.sealed.mockReset().mockResolvedValue(true);
});
afterEach(() => closeMigratedDb(db));

describe('actual Swarm artifact task identities', () => {
  it.each([1, 2])('refuses failed or ambiguous worker health output (%s)', async kind => {
    task.node = WRK;
    h.agent.mockImplementation(async (_db, _server, _op, params) => params.format === 'health'
      ? { exitCode: kind === 1 ? 1 : 0, lines: kind === 1 ? ['running|healthy|0|0'] : ['running|healthy|0|0', 'running|healthy|0|0'] }
      : { exitCode: 0, lines: [IMAGE] });
    await expect(verifySwarmTaskImages(db, { ...expected, freshHealth: true, requireHealthy: true })).rejects.toThrow('image identity is unconfirmed');
  });
  it.each(['running|starting|0|0', 'running|unhealthy|3|0', 'exited|healthy|0|0', 'running|none|0|0', 'running|healthy', 'running|healthy|bad|0'])('refuses unready local command health: %s', async state => {
    const original = h.capture.getMockImplementation()!;
    h.capture.mockImplementation(async (...args) => args[1].some((value: string) => value.includes('.State.Status')) ? state : original(...args));
    await expect(verifySwarmTaskImages(db, { ...expected, freshHealth: true, requireHealthy: true })).rejects.toThrow('image identity is unconfirmed');
  });
  it('accepts fresh healthy sealed worker output and returns verified config identities', async () => {
    task.node = WRK;
    h.agent.mockImplementation(async (_db, _server, _op, params) => ({ exitCode: 0, lines: [params.format === 'health' ? 'running|healthy|0|0' : IMAGE] }));
    expect(await verifySwarmTaskImages(db, { ...expected, freshHealth: true, requireHealthy: true })).toEqual([IMAGE]);
  });
  it('reads an immutable local container ID and confirms stable manager/task snapshots', async () => {
    await verifySwarmTaskImages(db, expected);
    expect(h.capture).toHaveBeenCalledWith('docker', ['inspect', '--type', 'container', '--format', '{{.Image}}', CID], expect.anything());
    expect(serviceReads).toBe(2); expect(taskReads).toBe(2); expect(h.agent).not.toHaveBeenCalled();
  });
  it('verifies a registered worker through its sealed agent by full container ID', async () => {
    task.node = WRK;
    await verifySwarmTaskImages(db, expected);
    expect(h.sealed).toHaveBeenCalledWith(db, 4);
    expect(h.agent).toHaveBeenCalledWith(db, 4, 'docker.inspect', { name: CID, format: 'image' }, expect.any(Function));
  });
  it.each(['foreign node', 'unsealed node', 'wrong image', 'nonzero response', 'ambiguous response'])('refuses an unconfirmed worker: %s', async kind => {
    task.node = WRK;
    if (kind === 'foreign node') task.node = 'ext0000000000000000000001';
    if (kind === 'unsealed node') h.sealed.mockResolvedValue(false);
    if (kind === 'wrong image') h.agent.mockResolvedValue({ exitCode: 0, lines: [`sha256:${'c'.repeat(64)}`] });
    if (kind === 'nonzero response') h.agent.mockResolvedValue({ exitCode: 1, lines: [IMAGE] });
    if (kind === 'ambiguous response') h.agent.mockResolvedValue({ exitCode: 0, lines: [IMAGE, IMAGE] });
    await expect(verifySwarmTaskImages(db, expected)).rejects.toThrow('image identity is unconfirmed');
    if (kind === 'foreign node' || kind === 'unsealed node') expect(h.agent).not.toHaveBeenCalled();
  });
  it.each([{ service: '2' }, { deployment: '10' }, { image: 'other:tag' }, { id: 'unknown' }, { version: '7' }])('refuses a changed manager service: %j', async patch => {
    Object.assign(service, patch);
    await expect(verifySwarmTaskImages(db, expected)).rejects.toThrow('image identity is unconfirmed');
    expect(taskReads).toBe(0);
  });
  it.each([{ state: 'starting' }, { desired: 'shutdown' }, { container: '--help' }, { service: 'other' }, { id: 'other' }])('refuses an unconfirmed task: %j', async patch => {
    Object.assign(task, patch);
    await expect(verifySwarmTaskImages(db, expected)).rejects.toThrow('image identity is unconfirmed');
  });
  it.each([{ ids: [] }, { ids: [TASK, TASK] }, { ids: ['--help'] }])('refuses missing, duplicate or invalid task IDs: %j', async value => {
    ids = value.ids;
    await expect(verifySwarmTaskImages(db, expected)).rejects.toThrow('image identity is unconfirmed');
  });
  it('refuses a manager revision change during container verification', async () => {
    const original = h.capture.getMockImplementation()!;
    h.capture.mockImplementation(async (...args) => { const value = await original(...args); if (args[1].includes('container')) service.version = 8; return value; });
    await expect(verifySwarmTaskImages(db, expected)).rejects.toThrow('image identity is unconfirmed');
  });
  it('refuses a task replacement during verification', async () => {
    const original = h.capture.getMockImplementation()!;
    h.capture.mockImplementation(async (...args) => { const value = await original(...args); if (args[1].includes('container')) ids = ['tsk0000000000000000000002']; return value; });
    await expect(verifySwarmTaskImages(db, expected)).rejects.toThrow('image identity is unconfirmed');
  });
  it('rejects a local image mismatch even when the desired image name matches', async () => {
    const original = h.capture.getMockImplementation()!;
    h.capture.mockImplementation((...args) => args[1].includes('container') ? Promise.resolve(`sha256:${'c'.repeat(64)}`) : original(...args));
    await expect(verifySwarmTaskImages(db, expected)).rejects.toThrow('image identity is unconfirmed');
  });
});
