import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const seam = vi.hoisted(() => ({
  getGitopsConfig: vi.fn(), getLastCheck: vi.fn(), runGitopsCheck: vi.fn(), audit: vi.fn(async () => undefined),
  driftFingerprint: (drift: unknown[]) => JSON.stringify(drift),
}));
vi.mock('../../apps/server/src/lib/instanceGitops.js', () => seam);
vi.mock('../../apps/server/src/lib/audit.js', () => ({ audit: seam.audit }));
const plugin = (await import('../../apps/server/src/plugins/gitopsScheduler.js')).default;
const values = {
  getGitopsConfig: { enabled: true, intervalMinutes: 1 },
  getLastCheck: null,
  runGitopsCheck: { check: { error: null, commit: 'synthetic', drift: [{ change: 'changed', kind: 'service', key: 'shop/api' }] }, previous: null },
};
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
const checkpoint = () => new Promise<void>((resolve) => setImmediate(resolve));
async function boot() {
  const app = Fastify({ logger: false }); app.decorate('db', {} as never);
  await app.register(plugin); await app.ready(); return app;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  for (const name of ['getGitopsConfig', 'getLastCheck', 'runGitopsCheck'] as const) seam[name].mockReset().mockResolvedValue(values[name]);
  seam.audit.mockClear();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
for (const stage of ['getGitopsConfig', 'getLastCheck', 'runGitopsCheck'] as const) {
  for (const closeOwner of [false, true]) {
    it(`${closeOwner ? 'closed' : 'live control'} owner after gated ${stage}`, async () => {
      const app = await boot(); const entered = gate(); const blocked = gate();
      seam[stage].mockImplementationOnce(async () => { entered.release(); await blocked.promise; return values[stage]; });
      try {
        await vi.advanceTimersByTimeAsync(60_000); await entered.promise;
        if (closeOwner) await app.close();
        blocked.release(); await checkpoint();
        if (closeOwner) { const actual = { runs: seam.runGitopsCheck.mock.calls.length, alerts: seam.audit.mock.calls.length }; const expected = { runs: stage === 'runGitopsCheck' ? 1 : 0, alerts: 0 }; console.log('EXPECTED:', expected, 'ACTUAL:', actual); console.log(JSON.stringify(actual) === JSON.stringify(expected) ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED'); } expect(seam.runGitopsCheck).toHaveBeenCalledTimes(closeOwner && stage !== 'runGitopsCheck' ? 0 : 1);
        expect(seam.audit).toHaveBeenCalledTimes(closeOwner ? 0 : 1);
        if (!closeOwner) expect(seam.audit).toHaveBeenCalledWith(app.getDecorator('db'), null, 'alert.gitops_drift', expect.stringContaining('changed service shop/api'), { commit: 'synthetic' });
      } finally { blocked.release(); await checkpoint(); await app.close(); }
    });
  }
}
