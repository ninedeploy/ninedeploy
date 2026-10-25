import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNodeLifecycle, runLegacyNodeLifecycle } from '../../src/lib/nodeLifecycle.js';

const io = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../../src/lib/spawnValidated.js', () => ({ spawnValidated: io.spawn }));
const target = { id: 'a'.repeat(64), name: 'web-9' };
let root: string, running: boolean, effects: string[][];
const fence = (revision = 2, deploymentId = 9) => ({ requestId: String(revision).padStart(32, '0'), serviceId: 7, deploymentId,
  revision, action: 'stop', targets: [], timeoutMs: 5000 });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nd-legacy-lifecycle-')); running = false; effects = [];
  io.spawn.mockReset().mockImplementation(async (_bin: string, args: string[], sink: (line: string) => void) => {
    if (args[0] === 'inspect') sink(JSON.stringify({ ...target, name: `/${target.name}`, managed: 'service', serviceId: '7', deploymentId: '9', status: running ? 'running' : 'exited', running }));
    else { effects.push(args); running = args[0] === 'start'; }
    return 0;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (dirname(root) !== tmpdir() || !basename(root).startsWith('nd-legacy-lifecycle-')) throw Error('Unexpected fixture cleanup path');
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe('legacy node lifecycle compatibility barrier', () => {
  it('accepts full immutable ID references used by deployment recovery', async () => {
    expect(await runLegacyNodeLifecycle(root, 'start', target.id, 5, () => undefined)).toBe(0);
    expect(await runLegacyNodeLifecycle(root, 'stop', target.id, 17, () => undefined)).toBe(0);
    expect(effects).toEqual([['start', target.id], ['stop', '-t', '17', target.id]]);
  });

  it('allows old-generation retirement by immutable ID without allowing its resurrection', async () => {
    await createNodeLifecycle(root).apply(fence(4, 10));
    expect(await runLegacyNodeLifecycle(root, 'stop', target.id, 5, () => undefined)).toBe(0);
    await expect(runLegacyNodeLifecycle(root, 'start', target.id, 5, () => undefined)).rejects.toThrow(/legacy.*fenced|ordered lifecycle/i);
    expect(effects).toEqual([['stop', '-t', '5', target.id]]);
  });

  it('does not let an immutable ID bypass the ordered generation fence', async () => {
    await createNodeLifecycle(root).apply(fence());
    await expect(runLegacyNodeLifecycle(root, 'start', target.id, 5, () => undefined)).rejects.toThrow(/legacy.*fenced|ordered lifecycle/i);
    expect(effects).toEqual([]);
  });

  it('refuses an ID whose inspect answer belongs to another container', async () => {
    await expect(runLegacyNodeLifecycle(root, 'stop', 'b'.repeat(64), 5, () => undefined)).rejects.toThrow(/identity changed/);
    expect(effects).toEqual([]);
  });

  it('does not stop a container renamed after its immutable ID was inspected', async () => {
    const original = io.spawn.getMockImplementation()!; let inspected = 0;
    io.spawn.mockImplementation(async (...args) => {
      if (args[1][0] !== 'inspect') return original(...args);
      inspected++;
      return original(args[0], args[1], line => args[2](JSON.stringify({ ...JSON.parse(line), ...(inspected > 1 ? { name: '/renamed' } : {}) })), args[3]);
    });
    await expect(runLegacyNodeLifecycle(root, 'stop', target.id, 5, () => undefined)).rejects.toThrow(/identity changed/);
    expect(effects).toEqual([]);
  });

  it('retains legacy control before adoption while sending immutable IDs to Docker', async () => {
    expect(await runLegacyNodeLifecycle(root, 'start', target.name, 5, () => undefined)).toBe(0);
    expect(await runLegacyNodeLifecycle(root, 'stop', target.name, 17, () => undefined)).toBe(0);
    expect(effects).toEqual([['start', target.id], ['stop', '-t', '17', target.id]]);
  });

  it('refuses a delayed legacy Start after a durable Stop fence', async () => {
    await createNodeLifecycle(root).apply(fence());
    await expect(runLegacyNodeLifecycle(root, 'start', target.name, 5, () => undefined)).rejects.toThrow(/legacy.*fenced|ordered lifecycle/i);
    expect(effects).toEqual([]); expect(running).toBe(false);
  });

  it('refuses legacy Stop of the ordered generation after Start', async () => {
    await createNodeLifecycle(root).apply({ ...fence(), action: 'start', targets: [target] });
    effects = [];
    await expect(runLegacyNodeLifecycle(root, 'stop', target.name, 5, () => undefined)).rejects.toThrow(/legacy.*fenced|ordered lifecycle/i);
    expect(effects).toEqual([]); expect(running).toBe(true);
  });

  it('allows immutable retirement of an older generation without allowing its resurrection', async () => {
    await createNodeLifecycle(root).apply(fence(4, 10));
    expect(await runLegacyNodeLifecycle(root, 'stop', target.name, 5, () => undefined)).toBe(0);
    await expect(runLegacyNodeLifecycle(root, 'start', target.name, 5, () => undefined)).rejects.toThrow(/legacy.*fenced|ordered lifecycle/i);
    expect(effects).toEqual([['stop', '-t', '5', target.id]]);
  });

  it('does not let the first fence acknowledge while an older legacy effect is undrained', async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const original = io.spawn.getMockImplementation()!;
    io.spawn.mockImplementation(async (...args) => {
      if (args[1][0] === 'start') { entered(); await released; }
      return original(...args);
    });
    const legacy = runLegacyNodeLifecycle(root, 'start', target.name, 5, () => undefined);
    await started;
    let acknowledged = false;
    const stopped = createNodeLifecycle(root).apply(fence()).then(reply => { acknowledged = true; return reply; });
    try {
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(acknowledged).toBe(false);
    } finally { release(); await legacy; await stopped; }
    await expect(runLegacyNodeLifecycle(root, 'start', target.name, 5, () => undefined)).rejects.toThrow(/legacy.*fenced|ordered lifecycle/i);
  });
  it('retains a managed Compose project compatibility path after the same service changed orchestrator', async () => {
    await createNodeLifecycle(root).apply(fence());
    const original = io.spawn.getMockImplementation()!;
    io.spawn.mockImplementation(async (...args) => {
      if (args[1][0] !== 'inspect') return original(...args);
      return original(args[0], args[1], line => args[2](JSON.stringify({ ...JSON.parse(line), composeProject: 'ndcmp-web' })), args[3]);
    });
    expect(await runLegacyNodeLifecycle(root, 'start', target.name, 5, () => undefined)).toBe(0);
    expect(effects).toEqual([['start', target.id]]);
  });
});


it('fences every adopted generation from legacy Stop, including a target outside the root generation', async () => {
  // The captured container is generation 9, while the batch root identifies generation 10.
  await createNodeLifecycle(root).apply({ ...fence(4, 10), targets: [{ ...target, deploymentId: 9 }] });
  effects = [];
  await expect(runLegacyNodeLifecycle(root, 'stop', target.id, 5, () => undefined)).rejects.toThrow(/legacy.*fenced|ordered lifecycle/i);
  expect(effects).toEqual([]);
});
