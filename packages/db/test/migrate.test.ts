import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from 'drizzle-orm/libsql/migrator';

vi.mock('drizzle-orm/libsql/migrator', () => ({ migrate: vi.fn(async () => undefined) }));

import { pickMigrationsFolder, resolveMigrationsFolder, runMigrations } from '../src/migrate.js';

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'nd-migrate-test-'));

function makeFolder(name: string, withJournal: boolean): string {
  const dir = path.join(tmpRoot, name);
  mkdirSync(path.join(dir, 'meta'), { recursive: true });
  if (withJournal) writeFileSync(path.join(dir, 'meta', '_journal.json'), '{}');
  return dir;
}

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env['NINEDEPLOY_MIGRATIONS_DIR'];
});

describe('pickMigrationsFolder', () => {
  it('returns the first candidate that carries the drizzle journal', () => {
    const withJournal = makeFolder('a', true);
    const without = makeFolder('b', false);
    expect(pickMigrationsFolder([withJournal, without])).toBe(withJournal);
    expect(pickMigrationsFolder([undefined, without, withJournal])).toBe(withJournal);
  });

  it('returns null when no candidate has a journal', () => {
    const without = makeFolder('c', false);
    expect(pickMigrationsFolder([undefined, without])).toBeNull();
    expect(pickMigrationsFolder([])).toBeNull();
  });
});

describe('resolveMigrationsFolder', () => {
  it('honours the NINEDEPLOY_MIGRATIONS_DIR override', () => {
    const dir = makeFolder('env-dir', true);
    vi.stubEnv('NINEDEPLOY_MIGRATIONS_DIR', dir);
    expect(resolveMigrationsFolder()).toBe(dir);
  });

  it('skips an override without a journal and falls back to a known layout', () => {
    const dir = makeFolder('env-empty', false);
    vi.stubEnv('NINEDEPLOY_MIGRATIONS_DIR', dir);
    const resolved = resolveMigrationsFolder();
    expect(resolved).not.toBeNull();
    expect(resolved!.endsWith('migrations')).toBe(true);
  });

  it('resolves a real migrations folder from the package layout when unset', () => {
    const resolved = resolveMigrationsFolder();
    expect(resolved).not.toBeNull();
    expect(resolved!.endsWith('migrations')).toBe(true);
  });
});

describe('runMigrations', () => {
  it('applies migrations from the override folder and returns it', async () => {
    const dir = makeFolder('run-override', true);
    const result = await runMigrations({} as never, dir);
    expect(result).toBe(dir);
    expect(migrate).toHaveBeenCalledWith({}, { migrationsFolder: dir });
  });

  it('resolves the folder when no override is given', async () => {
    const dir = makeFolder('run-resolved', true);
    vi.stubEnv('NINEDEPLOY_MIGRATIONS_DIR', dir);
    const result = await runMigrations({} as never);
    expect(result).toBe(dir);
    expect(migrate).toHaveBeenCalledWith({}, { migrationsFolder: dir });
  });
});
