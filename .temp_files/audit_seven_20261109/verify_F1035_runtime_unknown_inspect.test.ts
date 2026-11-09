import { expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ capture: vi.fn(), audit: vi.fn(), agent: vi.fn() }));
vi.mock('../../apps/server/src/lib/exec.js', () => ({ capture: io.capture, run: vi.fn(), sleep: vi.fn() }));
vi.mock('../../apps/server/src/lib/audit.js', () => ({ audit: io.audit }));
vi.mock('../../apps/server/src/lib/agentClient.js', () => ({ agentOp: io.agent }));
vi.mock('../../apps/server/src/engine/builders/pm2.js', () => ({ pm2Status: vi.fn(), pm2Start: vi.fn(), pm2Resurrect: vi.fn() }));
import { createRuntimeStateReconciler } from '../../apps/server/src/plugins/runtimeState.js';
import { buildTestApp, createFakeDb, svcRow, trackStatusUpdates } from '../../apps/server/test/helpers.js';

it('retains unknown runtimes, still detects explicit absence and continues to the next service', async () => {
  for (const message of ['', 'permission denied', 'API 500: internal server error', 'Docker inspect timed out', 'Cannot connect to the Docker daemon', 'No such container: c1', 'No such object: c1']) {
    for (const target of [false, true]) {
      io.capture.mockReset().mockImplementation(async (_cmd: string, args: string[]) => {
        if (!target && args.at(-1) === 'c1' && message) throw new Error(message);
        return 'running';
      });
      io.agent.mockReset().mockResolvedValue({ exitCode: message ? 1 : 0, lines: [message || 'running'] });
      io.audit.mockClear();
      const row = svcRow({ id: 1, type: 'docker', status: 'running', runtimeId: 'c1', replicas: 1 });
      const next = svcRow({ id: 2, type: 'docker', status: 'running', runtimeId: 'c2', replicas: 1 });
      let targetReads = 0;
      const db = createFakeDb({ findMany: { services: [row, next] }, select: {
        services: [row, next], serviceTargets: () => target && targetReads++ === 0 ? [{ id: 5, serviceId: 1, serverId: 8, runtimeId: 'target-c1', status: 'running' }] : [],
      } });
      const { updates } = trackStatusUpdates(db);
      const app = await buildTestApp({ db }), patrol = createRuntimeStateReconciler(app);
      try {
        await patrol.reconcile();
        const missing = /no such (container|object)/i.test(message);
        expect(updates).toEqual(missing ? [{ status: 'error' }] : []);
        expect(io.audit).toHaveBeenCalledTimes(missing && !target ? 1 : 0);
        if (!/cannot connect/i.test(message) || target) expect(io.capture).toHaveBeenCalledWith('docker', ['inspect', '--format', '{{.State.Status}}', 'c2']);
        expect(io.capture).not.toHaveBeenCalledWith('docker', expect.arrayContaining(['start']));
        expect(io.agent.mock.calls.some(c => c[2] === 'docker.start')).toBe(false);
      } finally { await patrol.close(); await app.close(); }
    }
  }
  console.log('FIX VERIFIED');
});
