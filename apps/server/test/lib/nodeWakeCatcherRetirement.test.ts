import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { orderedNodeProxyWrite } from '../../src/lib/nodeProxyJournal.js';
import { withRoutingAck } from '../../src/lib/proxyRoutingAck.js';
import { retireWakeCatcher } from '../../src/lib/nodeWakeCatcherRetirement.js';

const io = vi.hoisted(() => ({ root: '', capture: vi.fn(), spawn: vi.fn() }));
vi.mock('../../src/lib/nodeProxyFiles.js', () => ({ nodeProxyJournalDirectory: () => io.root }));
vi.mock('../../src/lib/exec.js', async original => ({ ...await original<object>(), capture: io.capture }));
vi.mock('../../src/lib/spawnValidated.js', () => ({ spawnValidated: io.spawn }));
const target = { id: 'a'.repeat(64), name: 'ninedeploy-wake' };
const content = `http:\n  services:\n    new:\n      loadBalancer:\n        servers:\n          - url: "http://ninedeploy-wake-g-${'b'.repeat(32)}:8080"\n`;
const input = () => ({ revision: 1, requestId: 'c'.repeat(32), timeoutMs: 30_000, content, target });
let present: boolean, foreign: boolean, daemonError: boolean, lostRemove: boolean, extraOldRoute: boolean;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  io.root = mkdtempSync(join(tmpdir(), 'nd-catcher-retire-')); present = true; foreign = false; daemonError = false; lostRemove = false; extraOldRoute = false;
  await orderedNodeProxyWrite(io.root, { ...input(), content: withRoutingAck(content) }, async () => true);
  io.spawn.mockReset().mockImplementation(async (_command, args, sink) => {
    if (args[0] === 'inspect') {
      if (daemonError) { sink('Cannot connect to the Docker daemon'); return 1; }
      const reference = args.at(-1);
      if (!present) { sink(`Error: No such object: ${reference}`); return 1; }
      sink(JSON.stringify({ ...target, name: `/${target.name}`, managed: foreign ? 'service' : 'wake' })); return 0;
    }
    if (args[0] === 'rm') { present = false; if (lostRemove) throw new Error('reply lost'); return 0; }
    throw new Error('Unexpected Docker boundary');
  });
  io.capture.mockReset().mockImplementation(async () => {
    const parsed = load(withRoutingAck(content)) as { http: Record<string, Record<string, unknown>> };
    const observed = Object.fromEntries(['routers', 'services', 'middlewares'].map(kind => [kind,
      Object.fromEntries(Object.entries(parsed.http[kind] ?? {}).map(([name, value]) => [`${name}@file`, { ...(value as object), status: 'enabled' }]))]));
    if (extraOldRoute) observed.services!['unexpected@file'] = { loadBalancer: { servers: [{ url: 'http://ninedeploy-wake:8080' }] }, status: 'enabled' };
    return `X-NineDeploy-Generation: ${createHash('sha256').update(content).digest('hex')}\r\n\r\n${JSON.stringify(observed)}`;
  });
});
afterEach(() => { vi.useRealTimers(); rmSync(io.root, { recursive: true, force: true }); });
async function finish<T>(pending: Promise<T>): Promise<T> {
  let done = false; void pending.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 100 && !done; i++) await vi.advanceTimersByTimeAsync(250);
  expect(done).toBe(true); return pending;
}

it('confirms both live entrypoints before and after drain, then removes only the inspected immutable ID', async () => {
  const receipt = await finish(retireWakeCatcher(input()));
  expect(receipt).toMatchObject({ ...target, removed: true, fenced: true, revision: 1, requestId: input().requestId });
  expect(receipt.contentHash).toBe(createHash('sha256').update(withRoutingAck(content)).digest('hex'));
  expect(io.capture).toHaveBeenCalledTimes(4);
  expect(io.spawn.mock.calls.filter(call => call[1][0] === 'rm').map(call => call[1])).toEqual([['rm', '-fv', target.id]]);
  await expect(orderedNodeProxyWrite(io.root, { ...input(), revision: 2, content: withRoutingAck(content.replace(/ninedeploy-wake-g-[b]{32}/, target.name)) }, async () => true)).rejects.toThrow(/retired/);
});
it('rejects foreign identity and daemon errors before any removal or live routing probe', async () => {
  foreign = true; await expect(finish(retireWakeCatcher(input()))).rejects.toThrow(/foreign/);
  foreign = false; daemonError = true; await expect(finish(retireWakeCatcher(input()))).rejects.toThrow(/unavailable/);
  expect(io.capture).not.toHaveBeenCalled(); expect(io.spawn.mock.calls.some(call => call[1][0] === 'rm')).toBe(false);
});
it('refuses extra old backend definitions in live proxy state, even when the requested generation matches', async () => {
  extraOldRoute = true;
  await expect(finish(retireWakeCatcher(input()))).rejects.toThrow(/confirm/);
  expect(present).toBe(true); expect(io.spawn.mock.calls.some(call => call[1][0] === 'rm')).toBe(false);
});
it('keeps the persistent fence after a lost removal response and confirms absence on retry', async () => {
  lostRemove = true;
  await expect(finish(retireWakeCatcher(input()))).rejects.toThrow('reply lost');
  lostRemove = false; expect(await finish(retireWakeCatcher(input()))).toMatchObject({ removed: false, fenced: true });
  expect(io.spawn.mock.calls.filter(call => call[1][0] === 'rm')).toHaveLength(1);
});
it('validates identities and configuration without touching Docker or leaking malformed content', async () => {
  for (const params of [{ ...input(), target: { ...target, id: 'bad' } }, { ...input(), target: { ...target, name: 'foreign' } }, { ...input(), content: 'secret-key: [invalid' }]) {
    await expect(retireWakeCatcher(params)).rejects.toThrow();
  }
  expect(io.spawn).not.toHaveBeenCalled(); expect(io.capture).not.toHaveBeenCalled();
});
