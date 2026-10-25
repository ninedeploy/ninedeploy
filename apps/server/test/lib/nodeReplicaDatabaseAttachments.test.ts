import { afterEach, expect, it, vi } from 'vitest';
import type { DB } from '@ninedeploy/db';
import { connectServiceToNodeDatabases, type NodeDatabaseAgent } from '../../src/lib/nodeDatabase.js';

const db = {} as DB;
const targets = [{ id: 'a'.repeat(64), name: 'web-7' }, { id: 'b'.repeat(64), name: 'web-7-r2' }];
const attached = [{ id: 1, slug: 'orders' }, { id: 2, slug: 'queue' }];
afterEach(() => vi.useRealTimers());

it('joins every immutable replica to every attached database between ownership checks', async () => {
  const events: string[] = [];
  const checkpoint = async () => { events.push('check'); };
  const agent = vi.fn<NodeDatabaseAgent>(async (_op, params) => { events.push(`${params.container}:${params.network}`); return { exitCode: 0, lines: [] }; });
  await connectServiceToNodeDatabases(db, 4, targets, attached, () => undefined, { agent, checkpoint });
  expect(events).toEqual(targets.flatMap(target => attached.flatMap(database => ['check', `${target.id}:nd-dbnet-${database.slug}`, 'check'])));
  expect(agent.mock.calls.every(call => call[0] === 'docker.networkConnect' && call[2]?.timeoutMs === 15_000)).toBe(true);
});

it('retains the existing single-container path and ignores an empty attachment list', async () => {
  const agent = vi.fn<NodeDatabaseAgent>(async () => ({ exitCode: 0, lines: [] }));
  await connectServiceToNodeDatabases(db, 4, 'web-7', [attached[0]!], () => undefined, { agent });
  expect(agent).toHaveBeenCalledExactlyOnceWith('docker.networkConnect', { network: 'nd-dbnet-orders', container: 'web-7' }, { tolerateExit: true, timeoutMs: 15_000 });
  agent.mockClear();
  await connectServiceToNodeDatabases(db, 4, targets, [], () => undefined, { agent });
  expect(agent).not.toHaveBeenCalled();
});

it.each([
  [], [{ id: 'reusable-name', name: 'web-7' }], [{ id: 'short', name: 'web-7' }],
  [targets[0]!, targets[0]!], Array.from({ length: 11 }, (_, i) => ({ id: String(i).padStart(64, 'a'), name: `web-7-r${i}` })),
].map(members => ({ members })))('refuses an incomplete, duplicate or oversized replica set before any node effect: %j', async ({ members }) => {
  const agent = vi.fn<NodeDatabaseAgent>();
  await expect(connectServiceToNodeDatabases(db, 4, members, attached, () => undefined, { agent })).rejects.toThrow(/complete immutable replica set/);
  expect(agent).not.toHaveBeenCalled();
});

it('fails the generation on a sibling join failure and does not continue to other bridges', async () => {
  const agent = vi.fn<NodeDatabaseAgent>(async (_op, params) => params.container === targets[1]!.id
    ? { exitCode: 1, lines: ['network unavailable'] } : { exitCode: 0, lines: [] });
  await expect(connectServiceToNodeDatabases(db, 4, targets, attached, () => undefined, { agent })).rejects.toThrow(/network unavailable/);
  expect(agent.mock.calls.map(call => call[1])).toEqual([
    { network: 'nd-dbnet-orders', container: targets[0]!.id }, { network: 'nd-dbnet-queue', container: targets[0]!.id },
    { network: 'nd-dbnet-orders', container: targets[1]!.id },
  ]);
});

it('keeps already attached database bridges idempotent', async () => {
  const agent = vi.fn<NodeDatabaseAgent>(async () => ({ exitCode: 1, lines: ['endpoint with name web-7 already exists'] }));
  await expect(connectServiceToNodeDatabases(db, 4, targets, attached, () => undefined, { agent })).resolves.toBeUndefined();
  expect(agent).toHaveBeenCalledTimes(4);
});

it('does not connect another replica after Stop supersedes an in-flight join', async () => {
  let cancelled = false;
  const agent = vi.fn<NodeDatabaseAgent>(async () => { cancelled = true; return { exitCode: 0, lines: [] }; });
  const checkpoint = async () => { if (cancelled) throw Error('Deployment cancelled'); };
  await expect(connectServiceToNodeDatabases(db, 4, targets, attached, () => undefined, { agent, checkpoint })).rejects.toThrow('Deployment cancelled');
  expect(agent).toHaveBeenCalledExactlyOnceWith('docker.networkConnect', { network: 'nd-dbnet-orders', container: targets[0]!.id }, { tolerateExit: true, timeoutMs: 15_000 });
});

it('uses the remaining stage budget and refuses a late successful reply', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const agent = vi.fn<NodeDatabaseAgent>(async () => { vi.setSystemTime(Date.now() + (agent.mock.calls.length === 1 ? 50_000 : 10_000)); return { exitCode: 0, lines: [] }; });
  await expect(connectServiceToNodeDatabases(db, 4, targets, attached, () => undefined, { agent })).rejects.toThrow(/attachment deadline exceeded/);
  expect(agent.mock.calls.map(call => call[2]?.timeoutMs)).toEqual([15_000, 10_000]);
});

it('does not start an effect if ownership checking has consumed the stage deadline', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const agent = vi.fn<NodeDatabaseAgent>();
  await expect(connectServiceToNodeDatabases(db, 4, targets, attached, () => undefined, { agent,
    checkpoint: async () => { vi.setSystemTime(Date.now() + 60_000); },
  })).rejects.toThrow(/attachment deadline exceeded/);
  expect(agent).not.toHaveBeenCalled();
});
