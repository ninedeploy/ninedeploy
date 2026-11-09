import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ paths: { dataDir: '' }, fail: false }));
vi.mock('../../apps/server/src/config.js', () => ({ config: { paths: state.paths } }));
vi.mock('../../apps/server/src/lib/exec.js', () => ({ capture: async () => '' }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, renameSync: (...args: Parameters<typeof fs.renameSync>) => {
    if (state.fail && path.basename(String(args[0])).startsWith('.pending-')) throw Object.assign(new Error('fixture publication denied'), { code: 'EACCES' });
    return fs.renameSync(...args);
  } };
});
import { storeSourceUpload } from '../../apps/server/src/lib/sourceUpload.js';
it('removes the owned pending file when publication fails and keeps the previous archive', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nd-upload-publish-')); state.paths.dataDir = root;
  try {
    const archive = gzipSync(Buffer.alloc(1024));
    const stored = await storeSourceUpload(1, archive);
    const dir = path.join(root, 'uploads', '1'), final = `${stored.sha}.tar.gz`;
    expect(readdirSync(dir)).toEqual([final]); expect(readFileSync(path.join(dir, final))).toEqual(archive);
    console.log('CONTROL EXPECTED: valid archive published, no pending file | ACTUAL: passed');
    state.fail = true;
    await expect(storeSourceUpload(1, archive)).rejects.toMatchObject({ code: 'EACCES' });
    expect(readFileSync(path.join(dir, final))).toEqual(archive);
    const pending = readdirSync(dir).filter(file => file.startsWith('.pending-'));
    console.log('EXPECTED: zero pending files after failed publication | ACTUAL:', pending.length);
    console.log(pending.length ? 'PROBLEM CONFIRMED' : 'PROBLEM NOT REPRODUCED');
    expect(pending).toEqual([]);
  } finally { state.fail = false; rmSync(root, { recursive: true, force: true }); }
});
