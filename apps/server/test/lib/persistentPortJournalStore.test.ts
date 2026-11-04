import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { PersistentPortNftSpec } from '../../src/lib/persistentPortNft.js';
import type { PersistentPortJournal } from '../../src/lib/persistentPortPublication.js';
import { withPersistentPortJournalStore, type PersistentPortJournalStore } from '../../src/lib/persistentPortJournalStore.js';

const spec: PersistentPortNftSpec = { serviceId: 1, owner: 'a'.repeat(32), revision: 1, mark: 0x4e440001,
  target: { id: 'b'.repeat(64), ipv4: '172.29.0.2' }, bindings: [{ hostIp: '10.6.6.9', hostPort: 5060, protocol: 'udp', containerPort: 5060 }] };
const committed = (): PersistentPortJournal => ({ version: 3, committed: structuredClone(spec), pending: null, source: null, retiring: null, retained: [structuredClone(spec.target)] });
const pending = (): PersistentPortJournal => { const next = { ...structuredClone(spec), revision: 2, target: { id: 'c'.repeat(64), ipv4: '172.29.0.3' } }; return { ...committed(), pending: next, source: structuredClone(spec), retained: [structuredClone(spec.target), structuredClone(next.target)] }; };

describe('durable persistent port journal store', () => {
  if (process.platform !== 'linux') {
    it('refuses unsupported hosts without creating state or invoking the callback', async () => {
      let called = false;
      await expect(withPersistentPortJournalStore('must-not-be-created', spec, async () => { called = true; })).rejects.toThrow('requires Linux');
      expect(called).toBe(false);
    });
  } else {
    const directories: string[] = [];
    const directory = () => { const path = mkdtempSync(join(tmpdir(), 'nd-port-journal-')); directories.push(path); return path; };
    const dataPath = (path: string) => join(path, 'service-1.json');
    const put = (path: string, bytes: string | Buffer) => writeFileSync(dataPath(path), bytes, { mode: 0o600 });
    const child = (path: string, mode: string) => {
      writeFileSync(join(path, 'input.json'), JSON.stringify({ spec, journal: pending() }), { mode: 0o600 });
      const require = createRequire(import.meta.url);
      return spawnSync(process.execPath, ['--import', pathToFileURL(require.resolve('tsx')).href,
        fileURLToPath(new URL('../../../../scripts/fixtures/persistent-port-journal.mjs', import.meta.url)), path, mode], {
        encoding: 'utf8', timeout: 5000, maxBuffer: 1 << 20, windowsHide: true,
      });
    };
    afterEach(() => {
      for (const path of directories.splice(0)) {
        if (!resolve(path).startsWith(`${resolve(tmpdir())}/nd-port-journal-`)) throw new Error('Unsafe journal fixture cleanup');
        rmSync(path, { recursive: true, force: true });
      }
    });
    it('persists a private snapshot, reads it from a new lock scope and protects the service namespace', async () => {
      const path = directory(), snapshot = committed();
      await withPersistentPortJournalStore(path, spec, async store => { expect(store.read()).toBeNull(); store.save(snapshot); });
      expect(lstatSync(dataPath(path)).mode & 0o777).toBe(0o600);
      await withPersistentPortJournalStore(path, spec, async store => { expect(store.read()).toEqual(snapshot); });
      await withPersistentPortJournalStore(path, { ...spec, serviceId: 2 }, async store => { expect(store.read()).toBeNull(); });
      await expect(withPersistentPortJournalStore(path, { ...spec, owner: 'f'.repeat(32) }, async store => store.read())).rejects.toThrow('Invalid');
    });
    it('syncs file data before rename and directory metadata before acknowledgement', async () => {
      const path = directory(), result = child(path, 'normal');
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(path, 'events.json'), 'utf8')).events).toEqual(['file-sync', 'rename', 'directory-sync']);
      await withPersistentPortJournalStore(path, spec, async store => { expect(store.read()).toEqual(pending()); });
      expect(readdirSync(path).filter(name => name.endsWith('.tmp'))).toEqual([]);
    });
    it('recovers the previous intent when the writer dies after file sync and before rename', async () => {
      const path = directory(); await withPersistentPortJournalStore(path, spec, async store => store.save(committed()));
      const result = child(path, 'kill-before-rename'); expect(result.status).not.toBe(0); expect(result.error).toBeUndefined();
      await withPersistentPortJournalStore(path, spec, async store => { expect(store.read()).toEqual(committed()); });
      expect(readdirSync(path).filter(name => name.endsWith('.tmp'))).toHaveLength(1);
    });
    it('reconstructs a complete renamed intent after writer death without claiming power-loss durability', async () => {
      const path = directory(); await withPersistentPortJournalStore(path, spec, async store => store.save(committed()));
      const result = child(path, 'kill-after-rename'); expect(result.status).not.toBe(0); expect(result.error).toBeUndefined();
      await withPersistentPortJournalStore(path, spec, async store => { expect(store.read()).toEqual(pending()); });
    });
    it('keeps the committed intent recoverable when the final durable acknowledgement is lost', async () => {
      const path = directory(); await withPersistentPortJournalStore(path, spec, async store => store.save(committed()));
      const result = child(path, 'lost-durable-ack'); expect(result.status, result.stderr).toBe(0);
      await withPersistentPortJournalStore(path, spec, async store => { expect(store.read()).toEqual(pending()); });
    });
    it('refuses escaped storage operations and kernel commands after host authority ends', async () => {
      const path = directory(); let escaped!: PersistentPortJournalStore;
      await withPersistentPortJournalStore(path, spec, async store => { escaped = store; });
      expect(() => escaped.read()).toThrow('scope has ended'); expect(() => escaped.save(committed())).toThrow('scope has ended');
      expect(() => escaped.context.run('true', [])).toThrow('has ended'); expect(existsSync(dataPath(path))).toBe(false);
    });
    it('captures immutable service ownership before waiting for host authority', async () => {
      const path = directory(), input = structuredClone(spec);
      const operation = withPersistentPortJournalStore(path, input, async store => { await Promise.resolve(); store.save(committed()); });
      input.serviceId = 2; input.owner = 'f'.repeat(32); await operation;
      expect(existsSync(dataPath(path))).toBe(true); expect(existsSync(join(path, 'service-2.json'))).toBe(false);
    });
    it.each(['symlink', 'hardlink', 'directory', 'world-readable'] as const)('preserves unsafe %s journal entries and their targets', async kind => {
      const path = directory(), sentinel = join(path, 'sentinel'); writeFileSync(sentinel, 'untouched', { mode: 0o600 });
      if (kind === 'symlink') symlinkSync(sentinel, dataPath(path));
      if (kind === 'hardlink') linkSync(sentinel, dataPath(path));
      if (kind === 'directory') mkdirSync(dataPath(path));
      if (kind === 'world-readable') { put(path, JSON.stringify(committed())); chmodSync(dataPath(path), 0o644); }
      await withPersistentPortJournalStore(path, spec, async store => {
        expect(() => store.read()).toThrow(); expect(() => store.save(pending())).toThrow();
      });
      expect(readFileSync(sentinel, 'utf8')).toBe('untouched');
    });
    it('refuses a FIFO without blocking the worker', () => {
      const path = directory(); const fifo = spawnSync('mkfifo', ['-m', '600', dataPath(path)], { encoding: 'utf8' }); expect(fifo.status, fifo.stderr).toBe(0);
      const result = child(path, 'probe-read'); expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    });
    it.each([['malformed JSON', '{broken'], ['null state', 'null'], ['unsupported version', JSON.stringify({ ...committed(), version: 2 })], ['invalid UTF-8', Buffer.from([0xff])], ['oversized bytes', Buffer.alloc(256 * 1024 + 1, 0x20)]] as const)('refuses %s without overwriting it', async (_label, bytes) => {
      const path = directory(); put(path, bytes); const before = readFileSync(dataPath(path));
      await withPersistentPortJournalStore(path, spec, async store => { expect(() => store.read()).toThrow(); expect(() => store.save(pending())).toThrow(); });
      expect(readFileSync(dataPath(path))).toEqual(before);
    });
    it('refuses foreign or invalid outgoing journals before touching a serving snapshot', async () => {
      const path = directory(); await withPersistentPortJournalStore(path, spec, async store => store.save(committed()));
      const before = readFileSync(dataPath(path));
      await withPersistentPortJournalStore(path, spec, async store => { const bad = pending(); bad.pending!.serviceId = 2; expect(() => store.save(bad)).toThrow(); });
      expect(readFileSync(dataPath(path))).toEqual(before);
    });
    it('refuses a replaced authority directory while preserving both namespaces', async () => {
      const path = directory(), moved = `${path}-moved`; directories.push(moved);
      await withPersistentPortJournalStore(path, spec, async store => {
        store.save(committed()); renameSync(path, moved); mkdirSync(path, { mode: 0o700 });
        expect(() => store.read()).toThrow('identity changed'); expect(() => store.save(pending())).toThrow('identity changed');
      });
      expect(JSON.parse(readFileSync(dataPath(moved), 'utf8'))).toEqual(committed()); expect(existsSync(dataPath(path))).toBe(false);
    });
  }
});
