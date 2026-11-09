import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ paths: { dataDir: '' }, fault: '' }));
vi.mock('../src/config.js', () => ({ config: { paths: state.paths } }));
vi.mock('../src/lib/exec.js', () => ({ capture: async () => '' }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (state.fault === 'rename' && path.basename(String(args[0])).startsWith('.pending-')) throw Object.assign(new Error('fixture publication denied'), { code: 'EACCES' });
      return fs.renameSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (state.fault === 'write' && path.basename(String(args[0])).startsWith('.pending-')) {
        fs.writeFileSync(args[0], 'PARTIAL');
        throw Object.assign(new Error('fixture partial write'), { code: 'ENOSPC' });
      }
      return fs.writeFileSync(...args);
    },
  };
});
import { listSourceUploads, storeSourceUpload } from '../src/lib/sourceUpload.js';

it.each(['rename', 'write'])('F1045: cleans pending %s failures and preserves the published archive', async fault => {
  const root = mkdtempSync(path.join(tmpdir(), 'nd-upload-publication-'));
  state.paths.dataDir = root; state.fault = '';
  try {
    const archive = gzipSync(Buffer.alloc(1024));
    const stored = await storeSourceUpload(1, archive);
    const dir = path.join(root, 'uploads', '1'), final = `${stored.sha}.tar.gz`;
    const before = listSourceUploads(1);
    state.fault = fault;
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(storeSourceUpload(1, archive)).rejects.toMatchObject({ code: fault === 'rename' ? 'EACCES' : 'ENOSPC' });
      expect(readdirSync(dir)).toEqual([final]);
      expect(readFileSync(path.join(dir, final))).toEqual(archive);
      expect(listSourceUploads(1)).toEqual(before);
    }
    state.fault = '';
    await expect(storeSourceUpload(1, archive)).resolves.toMatchObject({ sha: stored.sha });
    expect(readdirSync(dir)).toEqual([final]);
  } finally { state.fault = ''; rmSync(root, { recursive: true, force: true }); }
});
