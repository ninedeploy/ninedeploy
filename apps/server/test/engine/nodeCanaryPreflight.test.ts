import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { domains, servers, services, eq } from '@ninedeploy/db';
import { observabilityDb } from '../fixtures/observability.js';
import { preflightNodeCanary } from '../../src/engine/nodeCanaryPreflight.js';

const io = vi.hoisted(() => ({ agent: vi.fn(), sealed: vi.fn(), config: { wildcardDomain: '' } }));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: io.agent, agentTransportSealed: io.sealed }));
vi.mock('../../src/config.js', () => ({ config: io.config }));
const config = { steps: [50], stepSeconds: 30, maxErrorRate: 5, maxP95Ms: null, minRequests: 20 };
const required = ['proxy.traffic', 'proxy.routingAck', 'docker.recovery', 'docker.probe', 'docker.readiness'];
let f: Awaited<ReturnType<typeof observabilityDb>>, caps: string[], version: string;
beforeEach(async () => {
  vi.resetAllMocks(); io.config.wildcardDomain = ''; caps = [...required]; version = '0.18.0';
  io.sealed.mockResolvedValue(true);
  io.agent.mockImplementation(async () => ({ exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version, caps })}`] }));
  f = await observabilityDb();
  await f.db.insert(servers).values({ id: 2, name: 'Node', host: 'node.test', tokenEncrypted: 'fixture' });
  await f.db.update(services).set({ serverId: 2, healthCheck: 'http-strict', replicas: 1, runtimeReplicas: 1, canary: config }).where(eq(services.id, 1));
  await f.db.insert(domains).values({ serviceId: 1, hostname: 'app.test', status: 'active', ssl: false });
});
afterEach(() => f?.close());
const row = async () => (await f.db.query.services.findFirst({ where: eq(services.id, 1) }))!;
describe('node canary admission before candidate creation', () => {
  it('checks only the selected sealed agent for the complete required capability set', async () => {
    await preflightNodeCanary(f.db, await row(), false, async () => undefined);
    expect(io.agent).toHaveBeenCalledTimes(1); expect(io.agent.mock.calls[0]!.slice(1, 4)).toEqual([2, 'agent.ping', {}]);
  });
  it.each(required)('refuses a missing capability before any Docker operation: %s', async cap => {
    caps = caps.filter(item => item !== cap); version = '0.17.1';
    await expect(preflightNodeCanary(f.db, await row(), false, async () => undefined)).rejects.toThrow(/Update the node agent/);
    expect(io.agent.mock.calls.every(args => args[2] === 'agent.ping')).toBe(true);
  });
  it('names the node owner opt-in on an updated agent', async () => {
    caps = caps.filter(cap => cap !== 'proxy.traffic');
    await expect(preflightNodeCanary(f.db, await row(), false, async () => undefined)).rejects.toThrow(/NINEDEPLOY_AGENT_PROXY_TRAFFIC/);
  });
  it('refuses plaintext transport without contacting the agent', async () => {
    io.sealed.mockResolvedValue(false);
    await expect(preflightNodeCanary(f.db, await row(), false, async () => undefined)).rejects.toThrow(/unencrypted/);
    expect(io.agent).not.toHaveBeenCalled();
  });
  it.each([{ canary: { steps: [50, 10] } }, { type: 'compose' }, { orchestrator: 'swarm' }, { replicas: 2 }, { runtimeReplicas: 2 },
    { healthCheck: 'running' }, { healthCheck: 'tcp' }, { publishedPort: 8080 }, { portMappings: [{ hostPort: 8080, containerPort: 3000, protocol: 'tcp' }] }])('refuses an unsupported node shape before agent access: %j', async patch => {
    await f.db.update(services).set(patch as never).where(eq(services.id, 1));
    await expect(preflightNodeCanary(f.db, await row(), false, async () => undefined)).rejects.toThrow(/Node canary/);
    expect(io.agent).not.toHaveBeenCalled();
  });
  it('requires a route while allowing a configured automatic URL before its domain row exists', async () => {
    await f.db.delete(domains); const service = await row();
    await expect(preflightNodeCanary(f.db, service, false, async () => undefined)).rejects.toThrow(/active domain/);
    io.config.wildcardDomain = 'apps.test';
    await expect(preflightNodeCanary(f.db, service, false, async () => undefined)).resolves.toBeUndefined();
  });
  it.each(['local', 'disabled', 'rollback'])('keeps ordinary deployment behavior for %s', async mode => {
    const service = await row();
    await preflightNodeCanary(f.db, { ...service, ...(mode === 'local' ? { serverId: null } : mode === 'disabled' ? { canary: null } : {}) }, mode === 'rollback', async () => undefined);
    expect(io.agent).not.toHaveBeenCalled();
  });
  it('rechecks cancellation after an in-flight capability reply', async () => {
    let count = 0;
    await expect(preflightNodeCanary(f.db, await row(), false, async () => { if (++count === 2) throw new Error('Deployment cancelled'); })).rejects.toThrow('Deployment cancelled');
  });
});
