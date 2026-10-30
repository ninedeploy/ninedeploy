import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { orderedNodeProxyWrite, legacyNodeProxyWrite } from '../../src/lib/nodeProxyJournal.js';

let root: string, content: string, effects: string[];
const request = (revision: number, text: string) => ({ revision, requestId: revision.toString(16).padStart(32, '0'), timeoutMs: 5_000, content: text });
const write = async (text: string) => { effects.push(text); const changed = content !== text; content = text; return changed; };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'nd-proxy-journal-')); content = ''; effects = []; });
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('fences delayed revisions and legacy writes after ordered adoption', async () => {
  await legacyNodeProxyWrite(root, 5_000, () => write('legacy'));
  await orderedNodeProxyWrite(root, request(2, 'new'), () => write('new'));
  await expect(orderedNodeProxyWrite(root, request(1, 'old'), () => write('old'))).rejects.toThrow(/stale/);
  await expect(legacyNodeProxyWrite(root, 5_000, () => write('late legacy'))).rejects.toThrow(/fenced/);
  expect(content).toBe('new'); expect(effects).toEqual(['legacy', 'new']);
});
it('replays one receipt and rejects a conflicting intent at the same revision', async () => {
  const first = await orderedNodeProxyWrite(root, request(5, 'new'), () => write('new'));
  expect(await orderedNodeProxyWrite(root, request(5, 'new'), () => write('new'))).toEqual(first);
  await expect(orderedNodeProxyWrite(root, request(5, 'other'), () => write('other'))).rejects.toThrow(/conflict/);
  expect(effects).toEqual(['new']);
});
it('retains the new fence if a file write lands but its receipt is lost', async () => {
  const next = request(7, 'new');
  await expect(orderedNodeProxyWrite(root, next, async () => { await write('new'); throw new Error('lost receipt'); })).rejects.toThrow('lost receipt');
  await expect(orderedNodeProxyWrite(root, request(6, 'old'), () => write('old'))).rejects.toThrow(/stale/);
  await expect(legacyNodeProxyWrite(root, 5_000, () => write('legacy'))).rejects.toThrow(/fenced/);
  await orderedNodeProxyWrite(root, next, () => write('new'));
  expect(content).toBe('new'); expect(effects).toEqual(['new', 'new']);
});
it('drains an already-admitted legacy write before acknowledging the ordered fence', async () => {
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const legacy = legacyNodeProxyWrite(root, 5_000, async () => { entered(); await blocked; return write('legacy'); });
  await started;
  const ordered = orderedNodeProxyWrite(root, request(2, 'new'), () => write('new'));
  expect(effects).toEqual([]);
  release(); await legacy; await ordered;
  expect(effects).toEqual(['legacy', 'new']);
  await expect(legacyNodeProxyWrite(root, 5_000, () => write('late'))).rejects.toThrow(/fenced/);
  expect(content).toBe('new');
});
