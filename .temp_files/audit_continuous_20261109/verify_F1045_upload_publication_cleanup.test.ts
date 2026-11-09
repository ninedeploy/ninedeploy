import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ paths: { dataDir: '' }, fault: '' }));
vi.mock('../../apps/server/src/config.js', () => ({ config: { paths: state.paths } }));
vi.mock('../../apps/server/src/lib/exec.js', () => ({ capture: async () => { if (state.fault === 'validation') throw new Error('fixture validation failure'); return ''; } }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (state.fault === 'write' && path.basename(String(args[0])).startsWith('.pending-')) { fs.writeFileSync(args[0], 'PARTIAL'); throw new Error('fixture partial write'); }
      return fs.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (state.fault === 'rename') throw new Error('fixture publication failure');
      return fs.renameSync(...args);
    },
  };
});
import { listSourceUploads, storeSourceUpload } from '../../apps/server/src/lib/sourceUpload.js';
it('verifies failed first uploads/reuploads and preserves another pending owner', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nd-verify-publication-')); state.paths.dataDir = root;
  try {
    const archive = gzipSync(Buffer.alloc(1024));
    let serviceId = 0;
    for (const existing of [false, true]) {
      for (const fault of ['write', 'rename', 'validation']) {
        serviceId++; state.fault = '';
        const dir = path.join(root, 'uploads', String(serviceId)); mkdirSync(dir, { recursive: true });
        if (existing) await storeSourceUpload(serviceId, archive);
        writeFileSync(path.join(dir, '.pending-other-owner.tar.gz'), 'OTHER-OWNER');
        const before = readdirSync(dir).sort(), records = listSourceUploads(serviceId);
        state.fault = fault;
        for (let attempt = 0; attempt < 4; attempt++) {
          await expect(storeSourceUpload(serviceId, archive)).rejects.toThrow();
          expect(readdirSync(dir).sort()).toEqual(before);
          expect(listSourceUploads(serviceId)).toEqual(records);
          expect(readFileSync(path.join(dir, '.pending-other-owner.tar.gz'), 'utf8')).toBe('OTHER-OWNER');
        }
        state.fault = ''; await storeSourceUpload(serviceId, archive);
        expect(listSourceUploads(serviceId)).toHaveLength(1);
      }
    }
    console.log('EXPECTED: 24 failed writes/moves/validations leave no owned file, preserve sibling/history, retry succeeds | ACTUAL: all passed');
    console.log('FIX VERIFIED');
  } finally { state.fault = ''; rmSync(root, { recursive: true, force: true }); }
});
