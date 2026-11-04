import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ calls: [] as string[][], fail: '', custom: false, copied: '', name: '', image: `sha256:${'a'.repeat(64)}`, oom: '', helpers: [] as Array<{ id: string; created: string; name: string }> }));
vi.mock('../../src/lib/fileCommandInput.js', () => ({
  streamFileToCommand: async (_cmd: string, args: string[], file: string) => {
    state.calls.push(args); state.copied = file;
    expect(await readFile(file, 'utf8')).toContain(state.custom ? 'PGDMP' : 'CREATE TABLE');
    if (state.fail === 'copy') throw new Error('copy error');
  },
}));
vi.mock('../../src/lib/exec.js', () => {
  class ExecTimeoutError extends Error {}
  class ExecOutputTooLargeError extends Error {}
  return {
    ExecTimeoutError, ExecOutputTooLargeError, sleep: async () => undefined,
    capture: vi.fn(async (_cmd: string, args: string[], options: { timeoutMs: number }) => {
      state.calls.push(args);
      expect(options.timeoutMs).toBeGreaterThan(0);
      if (args[0] === 'image') {
        if (state.fail === 'image') throw new Error('private daemon error');
        return state.image;
      }
      if (args[0] === 'create') {
        state.name = args[args.indexOf('--name') + 1]!;
        if (state.fail === 'create') throw new Error('lost create reply');
        return `${'b'.repeat(64)}\n`;
      }
      if (args[0] === 'cp') {
        state.copied = args[1]!;
        expect(await readFile(args[1]!, 'utf8')).toContain(state.custom ? 'PGDMP' : 'CREATE TABLE');
        if (state.fail === 'copy') throw new Error('copy error');
      }
      if (args.includes('pg_isready') && state.fail === 'ready') throw new Error('not ready');
      if (args[0] === 'exec' && (args.includes('-f') || args.includes('pg_restore'))) {
        if (state.fail === 'restore') throw new Error('SECRET_SQL_DUMP_CONTENT');
        if (state.fail === 'enospc') throw new Error('`docker` exited 1: ERROR:  could not extend file "base/16384/16390": No space left on device');
        if (state.fail === 'timeout') throw new ExecTimeoutError('secret');
      }
      if (args.includes('-c')) {
        if (state.fail === 'query') throw new Error('SECRET_QUERY_RESULT');
        if (state.fail === 'output') throw new ExecOutputTooLargeError('secret');
        return state.fail === 'mismatch' ? 'wrong private value\n' : 'known-row\n';
      }
      if (args[0] === 'inspect' && args.includes('{{.State.OOMKilled}}')) {
        if (state.oom === 'unreadable') throw new Error('daemon hiccup');
        return `${state.oom === 'killed'}\n`;
      }
      if (args[0] === 'inspect' && args.includes('{{.Created}} {{.Name}}')) {
        const helper = state.helpers.find(h => h.id === args.at(-1));
        if (!helper || helper.name === 'VANISHED') throw new Error('No such object');
        return `${helper.created} ${helper.name}\n`;
      }
      if (args[0] === 'ps' && args.includes('label=ninedeploy.role=restore-verification')) return state.helpers.map(h => h.id).join('\n');
      if (args[0] === 'rm' && state.fail === 'cleanup') throw new Error('offline');
      if (args[0] === 'ps') return state.fail === 'retained' ? `${'b'.repeat(64)}\n` : '';
      return '';
    }),
  };
});
import { pruneRestoreVerificationHelpers, RESTORE_VERIFICATION_MAX_DUMP_BYTES, verifyPostgresRestore } from '../../src/lib/backupRestoreVerification.js';

let directory: string;
let file: string;
beforeEach(async () => {
  state.calls = []; state.fail = ''; state.custom = false; state.copied = ''; state.name = '';
  state.image = `sha256:${'a'.repeat(64)}`; state.oom = ''; state.helpers = [];
  directory = await mkdtemp(join(tmpdir(), 'nd-restore-test-'));
  file = join(directory, 'source.sql');
  await writeFile(file, 'CREATE TABLE known(id text);');
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const verify = () => verifyPostgresRestore({ file, image: 'postgres:18', query: 'SELECT id FROM known', expected: 'known-row' });

describe('isolated real PostgreSQL restore verifier orchestration', () => {
  it('restores plain SQL, queries known data, confirms removal and never changes the source', async () => {
    const result = await verify();
    expect(result).toMatchObject({ status: 'passed', cleanupConfirmed: true, format: 'plain', queryMatched: true });
    expect(await readFile(file, 'utf8')).toBe('CREATE TABLE known(id text);');
    const create = state.calls.find(args => args[0] === 'create')!;
    for (const flag of ['--read-only', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', 'postgres', '--pids-limit', '--memory', '--cpus']) expect(create).toContain(flag);
    expect(create).toContain(state.image);
    expect(state.calls.some(args => args[0] === 'cp')).toBe(false);
    expect(state.calls.find(args => args.includes('restore-copy'))).toEqual(expect.arrayContaining(['exec', '-i', 'sh', '-c', 'umask 077; cat > "$1"']));
    expect(create).not.toContain('postgres:18');
    expect(create.some(arg => ['--mount', '-v', '--volume', '-p', '--publish', '--privileged'].includes(arg))).toBe(false);
    expect(create.filter(arg => arg.startsWith('PGDATA='))).toEqual(['PGDATA=/tmp/nd-restore/data']);
    expect(state.calls.find(args => args.includes('-f'))).toEqual(expect.arrayContaining(['-X', 'ON_ERROR_STOP=1', '--single-transaction']));
    expect(state.calls.find(args => args[0] === 'rm')).toEqual(['rm', '-f', '-v', state.name]);
    expect(state.calls.at(-1)?.[0]).toBe('ps');
    // The caller's private staged file is streamed as-is: no second plaintext
    // copy on the panel's disk for a crash to leave behind.
    expect(state.copied).toBe(file);
  });
  it('uses the archive restore tool for custom dumps with strict error handling', async () => {
    state.custom = true; await writeFile(file, 'PGDMP custom fixture');
    expect((await verify()).format).toBe('custom');
    expect(state.calls.find(args => args.includes('pg_restore'))).toEqual(expect.arrayContaining(['--exit-on-error', '--single-transaction']));
  });
  it.each(['image', 'create', 'copy', 'ready', 'timeout', 'output', 'cleanup', 'retained'])('refuses to certify unavailable or incomplete %s execution', async failure => {
    state.fail = failure;
    expect((await verify()).status).toBe('unverifiable');
  });
  it.each(['restore', 'query', 'mismatch'])('fails %s without exposing restored content', async failure => {
    state.fail = failure;
    const result = await verify();
    expect(result.status).toBe('failed');
    expect(result.cleanupConfirmed).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|wrong private value|SELECT id/);
    expect(state.calls.some(args => args[0] === 'rm')).toBe(true);
  });
  it('attempts owned cleanup even after a lost create response', async () => {
    state.fail = 'create'; await verify();
    expect(state.calls.find(args => args[0] === 'rm')?.at(-1)).toBe(state.name);
  });
  it('rejects invalid probes before any Docker work', async () => {
    await expect(verifyPostgresRestore({ file, image: 'postgres:18', query: '', expected: '' })).rejects.toThrow();
    expect(state.calls).toEqual([]);
  });
  it('refuses malformed image identity before creating a helper', async () => {
    state.image = 'not-an-immutable-image';
    expect((await verify()).status).toBe('unverifiable');
    expect(state.calls.some(args => args[0] === 'create')).toBe(false);
  });
});

describe('bounded helper capacity is never reported as a broken backup', () => {
  const capacity = 'Backup exceeds the bounded restore verification capacity';
  it('refuses a dump too large for the scratch before any helper or copy exists', async () => {
    const handle = await open(file, 'r+');
    try { await handle.truncate(RESTORE_VERIFICATION_MAX_DUMP_BYTES + 1); } finally { await handle.close(); }
    const result = await verify();
    expect(result).toMatchObject({ status: 'unverifiable', error: capacity, cleanupConfirmed: true });
    expect(state.calls.some(args => args[0] === 'create')).toBe(false);
    expect(state.copied).toBe('');
  });
  it('reports an out-of-space restore as unverifiable, without keeping the engine message', async () => {
    state.fail = 'enospc';
    const result = await verify();
    expect(result).toMatchObject({ status: 'unverifiable', error: capacity, cleanupConfirmed: true });
    expect(JSON.stringify(result)).not.toMatch(/base\/16384|No space/);
  });
  it('reports a cgroup OOM kill during restore as unverifiable', async () => {
    state.fail = 'restore'; state.oom = 'killed';
    const result = await verify();
    expect(result).toMatchObject({ status: 'unverifiable', error: capacity });
    expect(JSON.stringify(result)).not.toMatch(/SECRET/);
  });
  it('does not blame the backup when the helper state cannot be read', async () => {
    state.fail = 'restore'; state.oom = 'unreadable';
    expect((await verify()).status).toBe('unverifiable');
  });
  it('still fails a genuine restore error on a healthy helper', async () => {
    state.fail = 'restore'; state.oom = 'healthy';
    expect(await verify()).toMatchObject({ status: 'failed', error: 'Restore verification failed during restore' });
  });
});

describe('crashed restore helpers are swept', () => {
  const uuid = '0f1e2d3c-4b5a-4968-8776-655443322110';
  const now = Date.parse('2026-11-04T12:00:00Z');
  it('removes only labelled helpers with the generated name that outlived the age floor', async () => {
    state.helpers = [
      { id: 'a'.repeat(64), created: '2026-11-04T10:00:00.123456789Z', name: `/ninedeploy-restore-check-${uuid}` },
      { id: 'b'.repeat(64), created: '2026-11-04T11:55:00Z', name: `/ninedeploy-restore-check-${uuid}` },
      { id: 'c'.repeat(64), created: '2026-11-04T09:00:00Z', name: '/someone-elses-container' },
      { id: 'd'.repeat(64), created: 'not-a-date', name: `/ninedeploy-restore-check-${uuid}` },
    ];
    expect(await pruneRestoreVerificationHelpers(60 * 60 * 1000, now)).toBe(1);
    const removed = state.calls.filter(args => args[0] === 'rm');
    expect(removed).toEqual([['rm', '-f', '-v', 'a'.repeat(64)]]);
  });
  it('keeps sweeping after one container vanishes mid-scan, and ignores non-id lines', async () => {
    state.helpers = [
      { id: 'f'.repeat(64), created: '', name: 'VANISHED' },
      { id: 'not-a-container-id', created: '2026-11-04T08:00:00Z', name: `/ninedeploy-restore-check-${uuid}` },
      { id: 'e'.repeat(64), created: '2026-11-04T08:00:00Z', name: `/ninedeploy-restore-check-${uuid}` },
    ];
    expect(await pruneRestoreVerificationHelpers(60 * 60 * 1000, now)).toBe(1);
    expect(state.calls.filter(args => args[0] === 'rm')).toEqual([['rm', '-f', '-v', 'e'.repeat(64)]]);
    expect(state.calls.some(args => args.includes('not-a-container-id'))).toBe(false);
  });
});
