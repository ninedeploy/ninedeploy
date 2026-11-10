import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename, sep } from 'node:path';
const state = vi.hoisted(() => ({
  fail: '', nextId: 0, containers: new Map<string, string>(), volumes: new Set<string>(), calls: [] as string[][],
  committed: undefined as (() => void) | undefined, gate: undefined as Promise<void> | undefined,
}));
vi.mock('../../src/lib/exec.js', () => {
  class ExecTimeoutError extends Error {}
  return {
    ExecTimeoutError,
    capture: async (_cmd: string, args: string[]) => {
      state.calls.push(args);
      if (args[0] === 'image') { if (state.fail === 'image') throw new Error('image unavailable'); return `sha256:${'1'.repeat(64)}`; }
      if (args[0] !== 'create') throw new Error('Unexpected capture');
      const id = `owned-cid-${++state.nextId}`;
      const name = args.includes('--name') ? args[args.indexOf('--name') + 1]! : id;
      state.containers.set(id, name); state.volumes.add(id);
      const gate = state.gate;
      if (gate) { state.gate = undefined; state.committed?.(); await gate; throw new Error('committed create reply lost'); }
      if (state.fail === 'create') throw new Error('committed create reply lost');
      if (state.fail === 'create-timeout') throw new ExecTimeoutError('create deadline');
      return `${id}\n`;
    },
    run: async (_cmd: string, args: string[]) => {
      state.calls.push(args);
      if (args[0] === 'rm') {
        if (state.fail === 'cleanup') throw new Error('cleanup unavailable');
        for (const [id, name] of state.containers) if (args.includes(id) || args.includes(name)) {
          state.containers.delete(id); if (args.includes('-v')) state.volumes.delete(id);
        }
      } else if (args[0] === 'cp') {
        expect(await readFile(args[1]!, 'utf8')).toBe('owned fixture bytes');
        if (state.fail === 'copy') throw new Error('copy unavailable');
      } else if (args[0] === 'start') {
        if (state.fail === 'start') throw new Error('checker rejected fixture');
        if (state.fail === 'timeout') throw new ExecTimeoutError('checker deadline');
      } else throw new Error('Unexpected run');
    },
  };
});
const { validateDumpFile } = await import('../../src/lib/backupDrill.js');
let root: string | undefined;
afterEach(async () => {
  if (root) {
    const absolute = resolve(root);
    if (!absolute.startsWith(resolve(tmpdir()) + sep) || !basename(absolute).startsWith('nd-drill-lifecycle-')) throw new Error('Unowned cleanup');
    await rm(absolute, { recursive: true, force: true });
  }
  root = undefined; state.fail = ''; state.nextId = 0; state.containers.clear(); state.volumes.clear(); state.calls = []; state.gate = undefined; state.committed = undefined;
});
async function file() { root = await mkdtemp(join(tmpdir(), 'nd-drill-lifecycle-')); const path = join(root, 'source.rdb'); await writeFile(path, 'owned fixture bytes'); return path; }
async function check(failure = '') { state.fail = failure; const path = await file(); const result = await validateDumpFile('redis', path, 'redis:fixture'); expect(await readFile(path, 'utf8')).toBe('owned fixture bytes'); return result; }
it('control: normal checker removes its owned helper and volume', async () => { expect((await check()).outcome).toBe('passed'); expect(state.containers.size).toBe(0); expect(state.volumes.size).toBe(0); });
for (const failure of ['create', 'create-timeout', 'copy', 'start', 'timeout']) it(`cleans helper and volume after ${failure}`, async () => {
  const result = await check(failure); expect(result.outcome).toBe(failure === 'start' ? 'failed' : 'unverifiable'); expect(state.containers.size).toBe(0); expect(state.volumes.size).toBe(0);
});
it('does not attempt helper cleanup if image inspection failed before create', async () => { expect((await check('image')).outcome).toBe('unverifiable'); expect(state.calls.some(args => args[0] === 'create' || args[0] === 'rm')).toBe(false); });
it('cleanup errors preserve the structural best-effort verdict policy', async () => { expect((await check('cleanup')).outcome).toBe('passed'); expect(state.containers.size).toBe(1); });
it('removes no unrelated container, volume or named-volume fixture', async () => {
  state.containers.set('unrelated', 'foreign-container'); state.volumes.add('unrelated'); state.volumes.add('named-operator-volume');
  expect((await check()).outcome).toBe('passed'); expect([...state.containers]).toEqual([['unrelated', 'foreign-container']]); expect([...state.volumes].sort()).toEqual(['named-operator-volume', 'unrelated']);
});
it('lost create cleanup remains scoped while another checker completes', async () => {
  const path = await file(); let release!: () => void, committed!: () => void;
  state.gate = new Promise<void>(done => release = done); const reached = new Promise<void>(done => committed = done); state.committed = committed;
  const first = validateDumpFile('redis', path, 'redis:fixture');
  try {
    await reached; expect(state.containers.size).toBe(1);
    expect((await validateDumpFile('redis', path, 'redis:fixture')).outcome).toBe('passed');
    expect(state.containers.size).toBe(1); expect(state.volumes.size).toBe(1);
  } finally { release(); await first; }
  expect(state.containers.size).toBe(0); expect(state.volumes.size).toBe(0);
  const names = state.calls.filter(args => args[0] === 'create').map(args => args[args.indexOf('--name') + 1]);
  expect(names.every(name => /^ninedeploy-drill-check-[0-9a-f-]{36}$/.test(name ?? ''))).toBe(true); expect(new Set(names).size).toBe(2);
});
