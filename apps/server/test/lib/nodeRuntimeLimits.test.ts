import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createNodeRuntimeMutation } from '../../src/lib/nodeRuntimeMutation.js';

const io = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../../src/lib/spawnValidated.js', () => ({ spawnValidated: io.spawn }));
let root: string;
let rows: Array<Record<string, unknown>>;
let ignoreUpdate: boolean;
const request = () => ({ requestId: '1'.repeat(32), serviceId: 7, revision: 8, timeoutMs: 5000, memLimitMb: 64,
  targets: rows.map(row => ({ id: row.id, name: String(row.name).slice(1), deploymentId: 10 })) });
const runtime = () => createNodeRuntimeMutation(root);
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nd-runtime-limits-')); ignoreUpdate = false;
  rows = ['a', 'b'].map((value, index) => ({ id: value.repeat(64), name: index ? '/web-10-r2' : '/web-10', managed: 'service',
    serviceId: '7', deploymentId: '10', status: 'running', running: true, restarts: 0, cpuShares: 0, nanoCpus: 0, cpuQuota: 0, memory: 0, memorySwap: 0 }));
  io.spawn.mockReset().mockImplementation(async (_bin, args: string[], sink: (line: string) => void) => {
    if (args[0] === 'inspect') { const row = rows.find(item => item.id === args.at(-1)); if (!row) return 1; sink(JSON.stringify(row)); return 0; }
    if (args[0] === 'update') { if (!ignoreUpdate) for (const row of rows) { row.memory = 64 * 1_048_576; row.memorySwap = row.memory; } return 0; }
    throw new Error('Unexpected Docker operation');
  });
});
afterEach(async () => {
  if (dirname(root) !== tmpdir() || !basename(root).startsWith('nd-runtime-limits-')) throw new Error('Invalid fixture cleanup');
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});
it('updates every owned immutable replica and replays its receipt without another effect', async () => {
  const input = request(), first = await runtime().limits(input);
  expect(first).toMatchObject({ complete: true, items: input.targets });
  expect(io.spawn.mock.calls.filter(call => call[1][0] === 'update').map(call => call[1])).toEqual([
    ['update', '--memory', '64m', '--memory-swap', '64m', ...input.targets.map(target => target.id)],
  ]);
  io.spawn.mockClear(); expect(await runtime().limits(input)).toEqual(first); expect(io.spawn).not.toHaveBeenCalled();
});
it('rejects a foreign replica before changing any container', async () => {
  const input = request(); rows[1]!.serviceId = '8';
  await expect(runtime().limits(input)).rejects.toThrow(/ownership/);
  expect(io.spawn.mock.calls.some(call => call[1][0] === 'update')).toBe(false);
});
it('refuses to confirm limits the daemon did not actually apply', async () => {
  ignoreUpdate = true;
  await expect(runtime().limits(request())).rejects.toThrow(/unconfirmed/);
});
it('checks unlimited fields before updating another resource', async () => {
  rows[1]!.cpuQuota = 50_000;
  await expect(runtime().limits({ ...request(), cpuLimitMilli: 0, cpuShares: 0 })).rejects.toThrow(/requires a deploy/);
  expect(io.spawn.mock.calls.some(call => call[1][0] === 'update')).toBe(false);
});
it('rejects a delayed update after a newer service fence without Docker effects', async () => {
  await runtime().fence({ requestId: '2'.repeat(32), serviceId: 7, revision: 9, timeoutMs: 5000 });
  await expect(runtime().limits(request())).rejects.toThrow(/stale/);
  expect(io.spawn).not.toHaveBeenCalled();
});
it('refuses duplicate targets and unsupported limit resets before acquiring authority', async () => {
  const input = request();
  await expect(runtime().limits({ ...input, targets: [input.targets[0], input.targets[0]] })).rejects.toThrow();
  await expect(runtime().limits({ ...input, memLimitMb: 0 })).rejects.toThrow();
  expect(io.spawn).not.toHaveBeenCalled();
  await expect(runtime().fence({ requestId: '2'.repeat(32), serviceId: 7, revision: 1, timeoutMs: 5000 })).resolves.toMatchObject({ complete: true });
});
it('rejects changed ownership at the same revision', async () => {
  await runtime().limits(request()); io.spawn.mockClear();
  await expect(runtime().limits({ ...request(), requestId: '3'.repeat(32) })).rejects.toThrow(/conflict/);
  expect(io.spawn).not.toHaveBeenCalled();
});
