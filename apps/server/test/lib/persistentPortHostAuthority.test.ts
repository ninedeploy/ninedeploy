import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withPersistentPortHostAuthority, type PersistentPortHostContext } from '../../src/lib/persistentPortHostAuthority.js';

describe('persistent port host authority', () => {
  if (process.platform !== 'linux') {
    it('refuses an unsupported host before touching the filesystem or invoking commands', async () => {
      let called = false;
      await expect(withPersistentPortHostAuthority('not-created', async () => { called = true; })).rejects.toThrow('requires Linux');
      expect(called).toBe(false);
    });
  } else {
    const directories: string[] = [];
    const directory = () => {
      const path = mkdtempSync(join(tmpdir(), 'nd-port-authority-'));
      directories.push(path); return path;
    };
    afterEach(() => {
      for (const path of directories.splice(0)) {
        if (!resolve(path).startsWith(resolve(tmpdir()) + '/nd-port-authority-')) throw new Error('Unsafe fixture cleanup path');
        rmSync(path, { recursive: true, force: true });
      }
    });
    it('holds an actual OS lock throughout the operation and releases it afterward', async () => {
      const path = directory();
      await withPersistentPortHostAuthority(path, async context => {
        expect(context.run(process.execPath, ['-e', 'console.log("owned")']).trim()).toBe('owned');
        expect(() => context.run('flock', ['--nonblock', join(path, 'authority.lock'), 'true'])).toThrow('did not complete');
      });
      await expect(withPersistentPortHostAuthority(path, async () => 'released')).resolves.toBe('released');
    });
    it('does not steal authority from another operation whose heartbeat is irrelevant', async () => {
      const path = directory(); let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const holder = withPersistentPortHostAuthority(path, async () => { enter(); await gate; });
      await entered;
      try { await expect(withPersistentPortHostAuthority(path, async () => 'stolen', 1)).rejects.toThrow('unavailable'); }
      finally { release(); await holder; }
    });
    it('rejects a writable authority directory before creating the lock', async () => {
      const path = directory(); chmodSync(path, 0o777);
      await expect(withPersistentPortHostAuthority(path, async () => {})).rejects.toThrow('not private');
      expect(existsSync(join(path, 'authority.lock'))).toBe(false);
    });
    it('rejects a lock shared through a hard link and preserves the linked file', async () => {
      const path = directory(), target = join(path, 'sentinel'); writeFileSync(target, 'unchanged', { mode: 0o600 });
      linkSync(target, join(path, 'authority.lock'));
      await expect(withPersistentPortHostAuthority(path, async () => {})).rejects.toThrow('Unsafe');
      expect(readFileSync(target, 'utf8')).toBe('unchanged');
    });
    it('does not permit an escaped context to execute after releasing authority', async () => {
      const path = directory(), marker = join(path, 'must-not-exist'); let escaped!: PersistentPortHostContext;
      await withPersistentPortHostAuthority(path, async context => { escaped = context; });
      expect(() => escaped.run(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`])).toThrow('has ended');
      expect(existsSync(marker)).toBe(false);
    });
    it('keeps command output and arguments out of failure messages', async () => {
      await withPersistentPortHostAuthority(directory(), async context => {
        try { context.run(process.execPath, ['-e', 'process.stderr.write("sensitive-fixture-value");process.exit(7)']); }
        catch (error) { expect(String(error)).not.toContain('sensitive-fixture-value'); expect(String(error)).toContain('did not complete'); return; }
        throw new Error('Expected the failing command to reject');
      });
    });
    it('rejects invalid acquisition and command deadlines without running the callback or child', async () => {
      const path = directory(); let called = false;
      await expect(withPersistentPortHostAuthority(path, async () => { called = true; }, 0)).rejects.toThrow('timeout');
      expect(called).toBe(false);
      await withPersistentPortHostAuthority(path, async context => {
        expect(() => context.run(process.execPath, [], { timeoutMs: 0 })).toThrow('deadline');
      });
    });
  }
});
