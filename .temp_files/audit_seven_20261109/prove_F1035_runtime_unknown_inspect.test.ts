import { expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ capture: vi.fn(), audit: vi.fn(), agent: vi.fn() }));
vi.mock('../../apps/server/src/lib/exec.js', () => ({ capture: io.capture, run: vi.fn(), sleep: vi.fn() }));
vi.mock('../../apps/server/src/lib/audit.js', () => ({ audit: io.audit }));
vi.mock('../../apps/server/src/lib/agentClient.js', () => ({ agentOp: io.agent }));
vi.mock('../../apps/server/src/engine/builders/pm2.js', () => ({ pm2Status: vi.fn(), pm2Start: vi.fn(), pm2Resurrect: vi.fn() }));
import { createRuntimeStateReconciler } from '../../apps/server/src/plugins/runtimeState.js';
import { buildTestApp, createFakeDb, svcRow, trackStatusUpdates } from '../../apps/server/test/helpers.js';
async function inspect(error?: Error) {
  io.capture.mockReset().mockImplementation(async () => { if (error) throw error; return 'running'; });
  io.audit.mockClear();
  const row = svcRow({ id: 1, type: 'docker', status: 'running', runtimeId: 'c1', replicas: 1 });
  const db = createFakeDb({ findMany: { services: [row] }, select: { services: [row] } });
  const { updates } = trackStatusUpdates(db);
  const app = await buildTestApp({ db });
  const patrol = createRuntimeStateReconciler(app);
  try { await patrol.reconcile(); return { updates, alerts: io.audit.mock.calls.length }; }
  finally { await patrol.close(); await app.close(); }
}
it('does not turn an unreadable Docker response into a service outage', async () => {
  const control = await inspect();
  expect(control).toEqual({ updates: [], alerts: 0 });
  console.log('CONTROL EXPECTED: updates=[] alerts=0 | ACTUAL:', JSON.stringify(control));
  const actual = await inspect(new Error('permission denied while trying to connect to the Docker daemon socket'));
  console.log('EXPECTED: updates=[] alerts=0 | ACTUAL:', JSON.stringify(actual));
  console.log(actual.updates.length || actual.alerts ? 'PROBLEM CONFIRMED' : 'PROBLEM NOT REPRODUCED');
  expect(actual).toEqual({ updates: [], alerts: 0 });
});
it('does not mark a fan-out target gone for an unknown inspect failure', async () => {
  io.capture.mockReset().mockResolvedValue('running');
  io.agent.mockReset().mockResolvedValue({ exitCode: 1, lines: ['permission denied while trying to connect to the Docker daemon socket'] });
  const row = svcRow({ id: 1, type: 'docker', status: 'running', runtimeId: 'c1', replicas: 1 });
  const db = createFakeDb({ findMany: { services: [row] }, select: { services: [row], serviceTargets: [{ id: 5, serviceId: 1, serverId: 8, runtimeId: 'target-c1', status: 'running' }] } });
  const { updates } = trackStatusUpdates(db);
  const app = await buildTestApp({ db });
  const patrol = createRuntimeStateReconciler(app);
  try {
    await patrol.reconcile();
    console.log('EXPECTED: fan-out updates=[] | ACTUAL:', JSON.stringify(updates));
    console.log(updates.length ? 'PROBLEM CONFIRMED' : 'PROBLEM NOT REPRODUCED');
    expect(updates).toEqual([]);
  } finally { await patrol.close(); await app.close(); }
});
