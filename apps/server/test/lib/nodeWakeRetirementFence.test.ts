import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { orderedNodeProxyWrite, retireNodeProxyBackend } from '../../src/lib/nodeProxyJournal.js';
import { withRoutingAck } from '../../src/lib/proxyRoutingAck.js';
import { withNodeServiceJournal } from '../../src/lib/nodeLifecycle.js';
import { retiredWakeBackends, assertNoWakeBackendReference, parseWakeRouting } from '../../src/lib/nodeWakeRetirementFence.js';

let root: string, effects: string[];
const old = { name: 'ninedeploy-wake', id: 'a'.repeat(64) };
const routes = (host = `ninedeploy-wake-g-${'b'.repeat(32)}`) => `http:\n  services:\n    wake:\n      loadBalancer:\n        servers:\n          - url: "http://${host}:8080"\n`;
const request = (revision: number, content = routes()) => ({ revision, requestId: revision.toString(16).padStart(32, '0'), timeoutMs: 5000, content });
const write = async (content: string) => { effects.push(content); return true; };
const seed = () => orderedNodeProxyWrite(root, request(1, withRoutingAck(routes())), write);
const fenced = () => withNodeServiceJournal(root, 1, 5000, async journal => retiredWakeBackends(journal.database));
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'nd-wake-retirement-')); effects = []; });
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('commits a backend fence before removal and rejects later higher-revision routes to the retired name', async () => {
  await seed(); let confirms = 0;
  expect(await retireNodeProxyBackend(root, request(1), old, async () => { confirms++; }, async () => {
    // A separate journal access here would deadlock the write lock: inspect the
    // persisted fence after the bounded removal callback returns instead.
    effects.push('remove'); return true;
  })).toBe(true);
  expect(confirms).toBe(1); expect((await fenced()).get(old.name)).toBe(old.id);
  await orderedNodeProxyWrite(root, request(2, withRoutingAck(routes())), write);
  await expect(orderedNodeProxyWrite(root, request(3, withRoutingAck(routes(old.name))), write)).rejects.toThrow(/retired/);
  expect(effects).toHaveLength(3);
});
it('retains the committed fence across a lost removal reply and retries the same immutable identity', async () => {
  await seed();
  await expect(retireNodeProxyBackend(root, request(1), old, async () => {}, async () => { throw new Error('Docker reply lost'); })).rejects.toThrow('Docker reply lost');
  expect((await fenced()).get(old.name)).toBe(old.id);
  expect(await retireNodeProxyBackend(root, request(1), old, async () => {}, async () => false)).toBe(false);
  await expect(orderedNodeProxyWrite(root, request(2, withRoutingAck(routes(old.name))), write)).rejects.toThrow(/retired/);
});
it('fences old writer connections after retirement while allowing current validated writes', async () => {
  await seed(); await retireNodeProxyBackend(root, request(1), old, async () => {}, async () => true);
  await expect(withNodeServiceJournal(root, 1, 5000, journal => journal.write(async () => {
    journal.database.prepare('UPDATE proxy_write_head SET revision=2 WHERE id=1').run();
  }))).rejects.toThrow(/ninedeploy_wake_proxy_writer/);
  expect((await orderedNodeProxyWrite(root, request(2, withRoutingAck(routes())), write)).complete).toBe(true);
});
it('never removes or fences while the requested routing still references the old catcher', async () => {
  const input = request(1, routes(old.name));
  await orderedNodeProxyWrite(root, { ...input, content: withRoutingAck(input.content) }, write);
  let removed = false, confirmed = false;
  await expect(retireNodeProxyBackend(root, input, old, async () => { confirmed = true; }, async () => { removed = true; return true; })).rejects.toThrow(/retired/);
  expect(removed || confirmed).toBe(false); expect((await fenced()).size).toBe(0);
});
it('refuses stale revisions, mismatched digests, missing receipts and unconfirmed live routing before removal', async () => {
  await seed(); let removes = 0;
  const remove = async () => { removes++; return true; };
  await expect(retireNodeProxyBackend(root, request(2), old, async () => {}, remove)).rejects.toThrow(/superseded|unconfirmed/);
  await expect(retireNodeProxyBackend(root, request(1, routes('other')), old, async () => {}, remove)).rejects.toThrow(/superseded|unconfirmed/);
  await expect(retireNodeProxyBackend(root, request(1), old, async () => { throw new Error('live routing unavailable'); }, remove)).rejects.toThrow('live routing unavailable');
  expect(removes).toBe(0); expect((await fenced()).size).toBe(0);
});
it('refuses a reused backend name instead of fencing or deleting a different container', async () => {
  await seed(); await retireNodeProxyBackend(root, request(1), old, async () => {}, async () => true);
  let removed = false;
  await expect(retireNodeProxyBackend(root, request(1), { ...old, id: 'c'.repeat(64) }, async () => {}, async () => { removed = true; return true; })).rejects.toThrow(/reused/);
  expect(removed).toBe(false);
});
it.each(['http://ninedeploy-wake:8080', 'http://NINEDEPLOY-WAKE.:8080', 'http://%6einedeploy-wake:8080', 'ninedeploy-wake:8080'])('detects retired URL/address host %s without leaking configuration', address => {
  expect(() => assertNoWakeBackendReference({ http: { service: { address } } }, new Set([old.name]))).toThrow(/retired/);
  expect(() => assertNoWakeBackendReference({ url: 'http://ninedeploy-wake.example:8080' }, new Set([old.name]))).not.toThrow();
});
it('handles aliases with cycles and sanitizes invalid YAML errors', () => {
  const value: Record<string, unknown> = {}; value.self = value;
  expect(() => assertNoWakeBackendReference(value, new Set([old.name]))).not.toThrow();
  expect(() => parseWakeRouting('private-secret: [invalid')).toThrow('Node proxy configuration could not be parsed for safe retirement');
});
