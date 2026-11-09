import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ fail: false, paths: { dataDir: '', dbFile: '', masterKeyFile: '' } }));
vi.mock('../../apps/server/src/config.js', () => ({ config: { paths: state.paths } }));
vi.mock('../../apps/server/src/lib/audit.js', () => ({ audit: vi.fn() }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, copyFileSync: (...args: Parameters<typeof fs.copyFileSync>) => {
    if (state.fail && path.basename(String(args[0])).startsWith('_env')) {
      fs.writeFileSync(args[1], 'PARTIAL'); throw new Error('fixture late failure');
    }
    return fs.copyFileSync(...args);
  } };
});
import { importSystemArchive, systemImportInFlight } from '../../apps/server/src/lib/systemArchive.js';
it('verifies absent-path rollback, untouched omitted members, success and malformed archive cleanup', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nd-verify-rollback-'));
  const previous = process.cwd();
  try {
    for (const mode of ['rollback', 'omitted', 'success', 'invalid']) {
      const base = path.join(root, mode); mkdirSync(base);
      const input = path.join(base, 'input'); mkdirSync(input);
      const cwd = path.join(base, 'cwd'); mkdirSync(cwd); process.chdir(cwd);
      state.paths.dataDir = path.join(base, 'data'); mkdirSync(state.paths.dataDir);
      state.paths.dbFile = path.join(state.paths.dataDir, 'ninedeploy.db');
      state.paths.masterKeyFile = path.join(state.paths.dataDir, 'master.key');
      const traefik = path.join(state.paths.dataDir, 'traefik');
      if (mode === 'omitted') {
        writeFileSync(state.paths.masterKeyFile, 'UNTOUCHED'); mkdirSync(traefik);
        writeFileSync(path.join(traefik, 'sentinel'), 'UNTOUCHED');
      }
      writeFileSync(path.join(input, '_meta.json'), '{}');
      writeFileSync(path.join(input, '_db-fixture.db'), 'NEW-DB');
      writeFileSync(path.join(input, '_env-fixture'), 'NEW-ENV');
      const members = ['_meta.json', '_db-fixture.db', '_env-fixture'];
      if (mode !== 'omitted') {
        writeFileSync(path.join(input, 'master.key'), 'NEW-KEY'); mkdirSync(path.join(input, 'traefik'));
        writeFileSync(path.join(input, 'traefik', 'route'), 'NEW-ROUTE'); members.push('master.key', 'traefik');
      }
      const tar = spawnSync('tar', ['-czf', 'input.tar.gz', ...members], { cwd: input });
      expect(tar.status, tar.stderr.toString()).toBe(0);
      state.fail = mode === 'rollback' || mode === 'omitted';
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const worker = { stop: vi.fn(() => { enter(); return gate; }), start: vi.fn() };
      const importing = importSystemArchive({ db: {}, worker } as never, mode === 'invalid' ? Buffer.from('not tar') : readFileSync(path.join(input, 'input.tar.gz')), null);
      const result = importing.then(value => ({ value, error: null }), error => ({ value: null, error }));
      await Promise.race([entered, result]);
      if (mode !== 'invalid') { expect(systemImportInFlight()).toBe(true); expect(existsSync(state.paths.dbFile)).toBe(false); }
      release();
      const outcome = await result;
      if (mode === 'success') {
        expect(outcome.value?.status).toBe(200); expect(readFileSync(state.paths.dbFile, 'utf8')).toBe('NEW-DB');
        expect(readFileSync(state.paths.masterKeyFile, 'utf8')).toBe('NEW-KEY'); expect(readFileSync(path.join(cwd, '.env'), 'utf8')).toBe('NEW-ENV');
        expect(worker.start).not.toHaveBeenCalled();
      } else {
        expect(outcome.error).toBeInstanceOf(Error); expect(existsSync(state.paths.dbFile)).toBe(false);
        expect(existsSync(path.join(cwd, '.env'))).toBe(false);
        if (mode === 'omitted') { expect(readFileSync(state.paths.masterKeyFile, 'utf8')).toBe('UNTOUCHED'); expect(readFileSync(path.join(traefik, 'sentinel'), 'utf8')).toBe('UNTOUCHED'); }
        else { expect(existsSync(state.paths.masterKeyFile)).toBe(false); expect(existsSync(traefik)).toBe(false); }
        expect(worker.start).toHaveBeenCalledTimes(mode === 'invalid' ? 0 : 1);
      }
      expect(existsSync(path.join(state.paths.dataDir, '_import'))).toBe(false); expect(systemImportInFlight()).toBe(false);
    }
    console.log('EXPECTED: rollback restores absence, omitted originals survive, success keeps files, malformed input cleans | ACTUAL: 4 gated cases passed');
    console.log('FIX VERIFIED');
  } finally { process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
});
