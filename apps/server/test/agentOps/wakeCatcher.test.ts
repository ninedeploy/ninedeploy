import { describe, expect, it, vi } from 'vitest';
import { AGENT_OPS, advertisedCapabilities, runRegisteredOp } from '../../src/agentOps/index.js';

vi.mock('../../src/lib/nodeWakeCatcher.js', () => ({
  ensureWakeCatcher: vi.fn(async () => ({ id: 'c'.repeat(64), image: `sha256:${'a'.repeat(64)}`, created: true })),
  removeWakeCatcher: vi.fn(async () => ({ removed: true })),
  readWakeDemand: vi.fn(async () => { throw new Error('The wake catcher is not running on the node'); }),
}));

describe('sealed node wake catcher operations (R2 scale to zero)', () => {
  it('registers three sealed operations under one capability', () => {
    for (const op of ['wake.catcher.ensure', 'wake.catcher.remove', 'wake.demand']) expect(AGENT_OPS.get(op)).toMatchObject({ cap: 'wake.catcher', sealedOnly: true });
  });
  it('needs the proxy-traffic opt-in and stops with the container mutations switch', () => {
    expect(advertisedCapabilities({})).not.toContain('wake.catcher');
    expect(advertisedCapabilities({ NINEDEPLOY_AGENT_PROXY_TRAFFIC: 'on' })).toContain('wake.catcher');
    expect(advertisedCapabilities({ NINEDEPLOY_AGENT_PROXY_TRAFFIC: 'on', NINEDEPLOY_AGENT_CONTAINER_MUTATIONS: 'off' })).not.toContain('wake.catcher');
  });
  it('refuses plaintext and answers one reply line, with a failure as an error frame', async () => {
    vi.stubEnv('NINEDEPLOY_AGENT_PROXY_TRAFFIC', 'on');
    try {
      await expect(runRegisteredOp('wake.catcher.ensure', {}, () => {}, { sealed: false })).rejects.toThrow(/sealed/);
      const lines: string[] = [];
      expect(await runRegisteredOp('wake.catcher.ensure', { key: 'b'.repeat(64) }, line => lines.push(line), { sealed: true })).toBe(0);
      expect(lines).toEqual([`ND-WAKE-CATCHER {"id":"${'c'.repeat(64)}","image":"sha256:${'a'.repeat(64)}","created":true}`]);
      lines.length = 0;
      expect(await runRegisteredOp('wake.demand', { sinceMs: 0 }, line => lines.push(line), { sealed: true })).toBe(1);
      expect(JSON.parse(lines[0]!.slice('ND-WAKE-CATCHER '.length))).toEqual({ error: { status: 502, code: 'wake_catcher_failed', message: 'The wake catcher is not running on the node' } });
    } finally { vi.unstubAllEnvs(); }
  });
});
