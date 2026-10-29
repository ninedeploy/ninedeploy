import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { runRegisteredOp } from '../../src/agentOps/index.js';

const io = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../../src/lib/spawnValidated.js', () => ({ spawnValidated: io.spawn }));
const old = { id: 'a'.repeat(64), name: 'web-9', deploymentId: 9 };
const candidate = { id: 'b'.repeat(64), name: 'web-10', deploymentId: 10 };
const stop = { requestId: 'c'.repeat(32), serviceId: 7, deploymentId: 10, revision: 4, action: 'stop', targets: [old, candidate], timeoutMs: 5000 };
let root: string, rows: Map<string, { id: string; name: string; deploymentId: number; running: boolean }>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nd-stop-retire-')); vi.spyOn(process, 'cwd').mockReturnValue(root);
  rows = new Map([old, candidate].map(target => [target.id, { ...target, running: false }]));
  io.spawn.mockReset().mockImplementation(async (_bin, args: string[], sink: (line: string) => void) => {
    if (args[0] === 'inspect') {
      for (const ref of args.slice(args.indexOf('--format') + 2)) {
        const row = rows.get(ref);
        if (!row) { sink(`Error: No such container: ${ref}`); return 1; }
        sink(JSON.stringify({ ...row, name: '/' + row.name, managed: 'service', serviceId: '7', deploymentId: String(row.deploymentId), status: row.running ? 'running' : 'exited' }));
      }
    } else if (args[0] === 'rm') rows.delete(args.at(-1)!);
    return 0;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (dirname(root) !== tmpdir() || !basename(root).startsWith('nd-stop-retire-')) throw Error('Invalid fixture cleanup');
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});
const invoke = (op: string, params: object, lines: string[] = []) => runRegisteredOp(op, params as Record<string, unknown>, line => lines.push(line), { sealed: true }, {});
const retire = { requestId: stop.requestId, serviceId: 7, revision: 4, targets: [candidate], timeoutMs: 5000 };

it('retires only a candidate in the acknowledged Stop and permits an exact retry', async () => {
  expect(await invoke('docker.lifecycle', stop)).toBe(0);
  const lines: string[] = [];
  expect(await invoke('docker.lifecycleRetire', retire, lines)).toBe(0);
  expect(rows.has(candidate.id)).toBe(false); expect(rows.has(old.id)).toBe(true);
  expect(JSON.parse(lines[0]!.slice('ND-LIFECYCLE-RETIRED '.length))).toMatchObject({ complete: true, items: [{ ...candidate, removed: true }] });
  expect(await invoke('docker.lifecycleRetire', retire)).toBe(0);
});

it('rejects retirement after a newer command took the agent journal', async () => {
  expect(await invoke('docker.lifecycle', stop)).toBe(0);
  expect(await invoke('docker.lifecycle', { ...stop, requestId: 'd'.repeat(32), revision: 5, targets: [] })).toBe(0);
  await expect(invoke('docker.lifecycleRetire', retire)).rejects.toThrow(/stale|superseded|ownership/i);
  expect(rows.has(candidate.id)).toBe(true);
});

it('refuses unsealed and owner-disabled retirement before Docker effects', async () => {
  await expect(runRegisteredOp('docker.lifecycleRetire', retire, () => {}, { sealed: false }, {})).rejects.toThrow(/sealed/i);
  await expect(runRegisteredOp('docker.lifecycleRetire', retire, () => {}, { sealed: true }, { NINEDEPLOY_AGENT_CONTAINER_LIFECYCLE: 'off' })).rejects.toThrow(/disabled/i);
  expect(io.spawn).not.toHaveBeenCalled();
});

it('rejects a target outside the acknowledged Stop before deleting anything', async () => {
  expect(await invoke('docker.lifecycle', stop)).toBe(0);
  await expect(invoke('docker.lifecycleRetire', { ...retire, targets: [{ ...candidate, name: 'replacement' }] })).rejects.toThrow(/coverage|ownership/i);
  expect(rows.has(candidate.id)).toBe(true); expect(rows.has(old.id)).toBe(true);
});

it('retains a stopped candidate that has started again before retirement', async () => {
  expect(await invoke('docker.lifecycle', stop)).toBe(0);
  rows.get(candidate.id)!.running = true;
  await expect(invoke('docker.lifecycleRetire', retire)).rejects.toThrow(/identity|state/i);
  expect(rows.has(candidate.id)).toBe(true);
});

it('does not reuse an acknowledged retirement request for a different target set', async () => {
  expect(await invoke('docker.lifecycle', stop)).toBe(0);
  expect(await invoke('docker.lifecycleRetire', retire)).toBe(0);
  await expect(invoke('docker.lifecycleRetire', { ...retire, targets: [old] })).rejects.toThrow(/conflicts/i);
  expect(rows.has(old.id)).toBe(true);
});

it('retries safely after the container was removed but post-removal inspection failed', async () => {
  expect(await invoke('docker.lifecycle', stop)).toBe(0);
  const normal = io.spawn.getMockImplementation()!; let removed = false;
  io.spawn.mockImplementation(async (...args) => {
    if (args[1][0] === 'inspect' && removed) throw Error('Controlled inspection failure');
    const result = await normal(...args);
    if (args[1][0] === 'rm') removed = true;
    return result;
  });
  await expect(invoke('docker.lifecycleRetire', retire)).rejects.toThrow(/inspection failure/i);
  expect(rows.has(candidate.id)).toBe(false);
  io.spawn.mockImplementation(normal);
  expect(await invoke('docker.lifecycleRetire', retire)).toBe(0);
  expect(rows.has(old.id)).toBe(true);
});

it('does not let a newer lifecycle command overtake a retirement already in progress', async () => {
  expect(await invoke('docker.lifecycle', stop)).toBe(0);
  const normal = io.spawn.getMockImplementation()!; let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  io.spawn.mockImplementation(async (...args) => {
    if (args[1][0] === 'rm') { entered(); await gate; }
    return normal(...args);
  });
  const retiring = invoke('docker.lifecycleRetire', retire);
  await waiting;
  const newer = invoke('docker.lifecycle', { ...stop, requestId: 'd'.repeat(32), revision: 5, targets: [] });
  try {
    expect(await Promise.race([newer.then(() => 'completed'), new Promise(resolve => setTimeout(() => resolve('waiting'), 100))])).toBe('waiting');
  } finally { release(); }
  expect(await retiring).toBe(0); expect(await newer).toBe(0);
  expect(rows.has(candidate.id)).toBe(false); expect(rows.has(old.id)).toBe(true);
});
