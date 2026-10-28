import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deployToTargets } from '../src/engine/fanout.js';
import { createFakeDb } from './helpers.js';

const h = vi.hoisted(() => ({ agent: vi.fn(), sealed: vi.fn(async () => true) }));
vi.mock('../src/lib/agentClient.js', () => ({ agentOp: h.agent, agentTransportSealed: h.sealed }));
const service = { id: 1, slug: 'web', type: 'docker', image: 'app:1', port: 8080, healthPath: '/ready', cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0, volumeMount: null, publishedPort: null };
let ready = true;
beforeEach(() => {
  vi.useFakeTimers(); ready = true; h.sealed.mockResolvedValue(true);
  h.agent.mockReset().mockImplementation(async (_db, _id, op, p) => {
    if (op === 'agent.ping') return { exitCode: 0, lines: ['ND-AGENT {"version":"0.17.2","caps":["docker.probe"]}'] };
    if (op === 'docker.inspect') return { exitCode: 0, lines: ['running|none|0|0'] };
    if (op === 'docker.probe') return { exitCode: 0, lines: [`ND-PROBE ${JSON.stringify({ ready, protocol: p.protocol, ...(p.protocol === 'http' ? { status: ready ? 200 : 503 } : {}) })}`] };
    if (op === 'file.writeEnv') return { exitCode: 0, lines: [`wrote .agent-env/${p.name}.env`] };
    return { exitCode: 0, lines: [] };
  });
});
afterEach(() => vi.useRealTimers());
async function run(healthCheck = 'http-strict', healthTimeoutSeconds = 6) {
  const db = createFakeDb({ select: { serviceTargets: [{ serverId: 5, runtimeId: 'web-t5-8' }] } });
  const result = deployToTargets(db as never, { service: { ...service, healthCheck, healthTimeoutSeconds }, image: 'app:1', deploymentId: 9, env: {}, primaryServerId: null }, vi.fn());
  const settled = result.catch(e => { throw e; });
  await vi.advanceTimersByTimeAsync(65_000);
  return settled;
}
const stopped = () => h.agent.mock.calls.filter(c => c[2] === 'docker.stop').map(c => c[3].name);
describe('fan-out application readiness', () => {
  it('keeps the previous generation when an open HTTP listener returns 503', async () => {
    ready = false;
    const result = await run();
    expect(result[0]).toMatchObject({ ok: false, runtimeId: 'web-t5-8' });
    expect(stopped()).not.toContain('web-t5-8');
    expect(h.agent.mock.calls.filter(c => c[2] === 'docker.probe').map(c => c[3])).toContainEqual({ name: 'web-t5-9', port: 8080, protocol: 'http', path: '/ready' });
    expect(h.agent.mock.calls.filter(c => c[2] === 'docker.probe')).toHaveLength(3);
  });
  it('promotes a ready HTTP application (unaffected control)', async () => {
    expect((await run())[0]).toMatchObject({ ok: true, runtimeId: 'web-t5-9' });
  });
  it('uses the configured TCP readiness protocol', async () => {
    await run('tcp');
    expect(h.agent.mock.calls.find(c => c[2] === 'docker.probe')?.[3]).toMatchObject({ protocol: 'tcp', port: 8080 });
  });
  it('refuses an agent without readiness support before starting or retiring anything', async () => {
    const original = h.agent.getMockImplementation()!;
    h.agent.mockImplementation(async (...args) => args[2] === 'agent.ping' ? { exitCode: 0, lines: ['ND-AGENT {"version":"0.16.0","caps":[]}'] } : original(...args));
    expect((await run())[0]).toMatchObject({ ok: false, error: expect.stringMatching(/probe application readiness/) });
    expect(h.agent.mock.calls.map(c => c[2])).not.toContain('docker.runEnv');
    expect(stopped()).toEqual([]);
  });
  it('retains container-state compatibility when application readiness is not requested', async () => {
    expect((await run('http'))[0]).toMatchObject({ ok: true });
    expect(h.agent.mock.calls.map(c => c[2])).not.toContain('docker.probe');
  });
  it('refuses plaintext transport before sending a sealed-only readiness operation', async () => {
    h.sealed.mockResolvedValue(false);
    expect((await run())[0]).toMatchObject({ ok: false });
    expect(h.agent.mock.calls.map(c => c[2])).not.toContain('docker.runEnv');
  });
});
