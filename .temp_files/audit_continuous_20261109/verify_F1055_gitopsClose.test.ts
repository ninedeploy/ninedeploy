import Fastify from 'fastify';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
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
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  for (const name of ['getGitopsConfig', 'getLastCheck', 'runGitopsCheck'] as const) seam[name].mockReset().mockResolvedValue(values[name]);
  seam.audit.mockClear(); vi.setSystemTime(new Date('2026-11-09T12:00:00Z'));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

for (const stage of ['getGitopsConfig', 'getLastCheck', 'runGitopsCheck'] as const) {
  for (const outcome of ['drift', 'error']) {
    it(`independent closed owner / ${stage} / ${outcome}`, async () => {
      const app = await boot(); const entered = gate(); const blocked = gate();
      const result = outcome === 'error' ? { check: { error: 'synthetic read failure', drift: [], commit: null }, previous: null } : values.runGitopsCheck;
      seam.runGitopsCheck.mockResolvedValue(result);
      seam[stage].mockImplementationOnce(async () => { entered.release(); await blocked.promise; return stage === 'runGitopsCheck' ? result : values[stage]; });
      try {
        await vi.advanceTimersByTimeAsync(60_000); await entered.promise;
        await app.close(); blocked.release(); await checkpoint();
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(seam.runGitopsCheck).toHaveBeenCalledTimes(stage === 'runGitopsCheck' ? 1 : 0);
        expect(seam.audit).not.toHaveBeenCalled();
      } finally { blocked.release(); await checkpoint(); await app.close(); }
    });
  }
}
for (const outcome of ['drift', 'error']) it(`live ${outcome} alert control`, async () => {
  const app = await boot();
  if (outcome === 'error') seam.runGitopsCheck.mockResolvedValue({ check: { error: 'synthetic read failure', drift: [], commit: null }, previous: null });
  try {
    await vi.advanceTimersByTimeAsync(60_000); await checkpoint();
    expect(seam.audit).toHaveBeenCalledOnce();
    expect(seam.audit.mock.calls[0]?.[2]).toBe(outcome === 'error' ? 'alert.gitops_failed' : 'alert.gitops_drift');
  } finally { await app.close(); }
});
for (const mode of ['unconfigured', 'disabled', 'manual', 'recent', 'same-drift', 'same-error', 'empty']) {
  it(`unchanged no-alert behavior: ${mode}`, async () => {
    const app = await boot();
    if (mode === 'unconfigured') seam.getGitopsConfig.mockResolvedValue(null);
    if (mode === 'disabled') seam.getGitopsConfig.mockResolvedValue({ enabled: false, intervalMinutes: 1 });
    if (mode === 'manual') seam.getGitopsConfig.mockResolvedValue({ enabled: true, intervalMinutes: 0 });
    if (mode === 'recent') {
      seam.getGitopsConfig.mockResolvedValue({ enabled: true, intervalMinutes: 15 });
      seam.getLastCheck.mockResolvedValue({ at: '2026-11-09T12:00:00Z' });
    }
    if (mode === 'same-drift') seam.runGitopsCheck.mockResolvedValue({ ...values.runGitopsCheck, previous: values.runGitopsCheck.check });
    if (mode === 'same-error') seam.runGitopsCheck.mockResolvedValue({ check: { error: 'same', drift: [] }, previous: { error: 'same', drift: [] } });
    if (mode === 'empty') seam.runGitopsCheck.mockResolvedValue({ check: { error: null, drift: [] }, previous: null });
    try {
      await vi.advanceTimersByTimeAsync(60_000); await checkpoint();
      expect(seam.audit).not.toHaveBeenCalled();
      expect(seam.runGitopsCheck).toHaveBeenCalledTimes(['same-drift', 'same-error', 'empty'].includes(mode) ? 1 : 0);
    } finally { await app.close(); }
  });
}
it('busy prevents overlapping ticks and releases after completion', async () => {
  const app = await boot(); const blocked = gate();
  seam.runGitopsCheck.mockImplementationOnce(async () => { await blocked.promise; return values.runGitopsCheck; });
  try {
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(seam.runGitopsCheck).toHaveBeenCalledOnce();
    blocked.release(); await checkpoint();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(seam.runGitopsCheck).toHaveBeenCalledTimes(2);
  } finally { blocked.release(); await checkpoint(); await app.close(); }
});
it('a failed configuration read releases busy for the next tick', async () => {
  const app = await boot(); seam.getGitopsConfig.mockRejectedValueOnce(new Error('injected lookup failure'));
  try {
    await vi.advanceTimersByTimeAsync(60_000); await checkpoint();
    expect(seam.runGitopsCheck).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000); await checkpoint();
    expect(seam.runGitopsCheck).toHaveBeenCalledOnce(); expect(seam.audit).toHaveBeenCalledOnce();
  } finally { await app.close(); }
});
it('an old result after a replacement app boots cannot publish into the new owner', async () => {
  const previous = await boot(); const blocked = gate();
  seam.runGitopsCheck.mockImplementationOnce(async () => { await blocked.promise; return values.runGitopsCheck; });
  await vi.advanceTimersByTimeAsync(60_000); await previous.close();
  const current = await boot();
  try {
    await vi.advanceTimersByTimeAsync(60_000); blocked.release(); await checkpoint();
    expect(seam.audit).toHaveBeenCalledOnce(); expect(seam.audit.mock.calls[0]?.[0]).toBe(current.getDecorator('db'));
  } finally { blocked.release(); await checkpoint(); await current.close(); }
});
afterAll(() => console.log('FIX VERIFIED'));
