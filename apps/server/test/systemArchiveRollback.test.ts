import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

const paths = vi.hoisted(() => ({ dataDir: '', dbFile: '', masterKeyFile: '' }));
vi.mock('../src/config.js', () => ({ config: { paths } }));
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn() }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, copyFileSync: (...args: Parameters<typeof fs.copyFileSync>) => {
    if (path.basename(String(args[0])).startsWith('_env')) {
      fs.writeFileSync(args[1], 'PARTIAL-ENV');
      throw new Error('fixture env write failed');
    }
    return fs.copyFileSync(...args);
  } };
});
import { importSystemArchive, systemImportInFlight } from '../src/lib/systemArchive.js';

it.each(['all', 'none', 'db-only', 'key-only'])('F1042: restores %s original state after a partial env failure', async state => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nd-import-rollback-'));
  const previous = process.cwd();
  let release!: () => void;
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
    paths.dataDir = path.join(root, 'data'); mkdirSync(paths.dataDir);
    paths.dbFile = path.join(paths.dataDir, 'ninedeploy.db'); paths.masterKeyFile = path.join(paths.dataDir, 'master.key');
    const cwd = path.join(root, 'cwd'); mkdirSync(cwd); process.chdir(cwd);
    const destinations = [paths.dbFile, paths.masterKeyFile, path.join(paths.dataDir, 'traefik'), path.join(cwd, '.env')];
    const present = [state === 'all' || state === 'db-only', state === 'all' || state === 'key-only', state === 'all', state === 'all'];
    for (const [index, destination] of destinations.entries()) {
      if (!present[index]) continue;
      if (index === 2) { mkdirSync(destination); writeFileSync(path.join(destination, 'config'), 'OLD-ROUTES'); }
      else writeFileSync(destination, ['OLD-DB', 'OLD-KEY', '', 'OLD-ENV'][index]!);
    }
    let entered!: () => void;
    const stopped = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const worker = { stop: vi.fn(() => { entered(); return gate; }), start: vi.fn() };
    const importing = importSystemArchive({ db: {}, worker } as never, archive, null);
    const rejection = expect(importing).rejects.toThrow('fixture env write failed');
    await Promise.race([stopped, importing]);
    expect(systemImportInFlight()).toBe(true);
    expect(destinations.map(destination => existsSync(destination))).toEqual(present);
    release();
    await rejection;
    expect(destinations.map(destination => existsSync(destination))).toEqual(present);
    for (const [index, destination] of destinations.entries()) {
      if (present[index]) expect(readFileSync(index === 2 ? path.join(destination, 'config') : destination, 'utf8')).toBe(['OLD-DB', 'OLD-KEY', 'OLD-ROUTES', 'OLD-ENV'][index]);
    }
    expect(existsSync(path.join(paths.dataDir, '_import'))).toBe(false);
    expect(systemImportInFlight()).toBe(false);
    expect(worker.start).toHaveBeenCalledOnce();
  } finally { release?.(); process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
});
