import { expect, it, vi } from 'vitest';
import { svcRow } from '../helpers.js';
import { applyLocalLimits } from '../../src/lib/localLimitUpdate.js';

const io = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('../../src/lib/exec.js', () => ({ capture: io.capture }));
const service = () => svcRow({ id: 1, status: 'running', runtimeId: 'web-3', replicas: 2, runtimeReplicas: 2, memLimitMb: 64 });
const rows = () => ['a'.repeat(64), 'b'.repeat(64)].map((id, index) => ({ id, name: index ? '/web-3-r2' : '/web-3', managed: 'service', serviceId: '1', deploymentId: '3', status: 'running', restarts: 0, cpuShares: 0, nanoCpus: 0, cpuQuota: 0, memory: 64 * 1_048_576, memorySwap: 64 * 1_048_576 }));
const output = () => rows().map(row => JSON.stringify(row)).join('\n');

it('does not mutate containers when the service owner changes after inspection', async () => {
  io.capture.mockReset().mockResolvedValueOnce(output());
  expect(await applyLocalLimits(service(), async () => false)).toBe(false);
  expect(io.capture).toHaveBeenCalledTimes(1);
});

it('does not report success when the owner changes after the Docker update', async () => {
  io.capture.mockReset().mockResolvedValueOnce(output()).mockResolvedValueOnce('').mockResolvedValueOnce(output());
  const current = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  expect(await applyLocalLimits(service(), current)).toBe(false);
  expect(io.capture.mock.calls[1]![1]).toEqual(expect.arrayContaining(['update', 'a'.repeat(64), 'b'.repeat(64)]));
});

it.each([{ serverId: 4 }, { orchestrator: 'swarm' as const }, { type: 'compose' as const }])('does not inspect an unsupported placement: %j', async change => {
  io.capture.mockReset();
  expect(await applyLocalLimits({ ...service(), ...change }, async () => true)).toBe(false);
  expect(io.capture).not.toHaveBeenCalled();
});
