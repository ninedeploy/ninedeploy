import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
const paths = vi.hoisted(() => ({ dataDir: '', dbFile: '', masterKeyFile: '' }));
vi.mock('../../apps/server/src/config.js', () => ({ config: { paths } }));
vi.mock('../../apps/server/src/lib/audit.js', () => ({ audit: vi.fn() }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, copyFileSync: (...args: Parameters<typeof fs.copyFileSync>) => {
    if (path.basename(String(args[0])).startsWith('_env')) throw new Error('fixture env write failed');
    return fs.copyFileSync(...args);
  } };
});
import { importSystemArchive } from '../../apps/server/src/lib/systemArchive.js';
it('restores absence as well as original files after a later swap fails', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nd-archive-rollback-'));
  const previous = process.cwd();
  try {
    const input = path.join(root, 'input'); mkdirSync(input);
    writeFileSync(path.join(input, '_meta.json'), '{}');
    writeFileSync(path.join(input, '_db-fixture.db'), 'NEW-DB');
    writeFileSync(path.join(input, 'master.key'), 'NEW-KEY');
    mkdirSync(path.join(input, 'traefik')); writeFileSync(path.join(input, 'traefik', 'config'), 'NEW-ROUTES');
    writeFileSync(path.join(input, '_env-fixture'), 'NEW-ENV');
    const tar = spawnSync('tar', ['-czf', 'input.tar.gz', '_meta.json', '_db-fixture.db', 'master.key', 'traefik', '_env-fixture'], { cwd: input });
    expect(tar.status, tar.stderr.toString()).toBe(0);
    const archive = readFileSync(path.join(input, 'input.tar.gz'));
    for (const existing of [true, false]) {
      paths.dataDir = path.join(root, String(existing)); mkdirSync(paths.dataDir);
      paths.dbFile = path.join(paths.dataDir, 'ninedeploy.db'); paths.masterKeyFile = path.join(paths.dataDir, 'master.key');
      const cwd = path.join(root, `cwd-${existing}`); mkdirSync(cwd); process.chdir(cwd);
      writeFileSync(paths.dbFile, 'OLD-DB');
      if (existing) {
        writeFileSync(paths.masterKeyFile, 'OLD-KEY');
        mkdirSync(path.join(paths.dataDir, 'traefik')); writeFileSync(path.join(paths.dataDir, 'traefik', 'config'), 'OLD-ROUTES');
      }
      await expect(importSystemArchive({ db: {} } as never, archive, null)).rejects.toThrow('fixture env write failed');
      expect(readFileSync(paths.dbFile, 'utf8')).toBe('OLD-DB');
      if (existing) {
        expect(readFileSync(paths.masterKeyFile, 'utf8')).toBe('OLD-KEY');
        expect(readFileSync(path.join(paths.dataDir, 'traefik', 'config'), 'utf8')).toBe('OLD-ROUTES');
        console.log('CONTROL EXPECTED: original DB/key/routes restored | ACTUAL: passed');
      } else {
        const leftovers = { key: existsSync(paths.masterKeyFile), traefik: existsSync(path.join(paths.dataDir, 'traefik')) };
        console.log('EXPECTED: originally absent key/routes remain absent | ACTUAL:', leftovers);
        console.log(leftovers.key || leftovers.traefik ? 'PROBLEM CONFIRMED' : 'PROBLEM NOT REPRODUCED');
        expect(leftovers).toEqual({ key: false, traefik: false });
      }
    }
  } finally { process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
});
