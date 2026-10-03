import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const base = mkdtempSync(path.join(os.tmpdir(), 'nd-compose-ws-'));
const reposDir = path.join(base, 'repos');
vi.mock('../../src/config.js', () => ({ config: { paths: { reposDir } } }));

const { INLINE_COMPOSE_FILE, materialiseComposeFile, stackWorkspace } = await import(
  '../../src/lib/composeWorkspace.js'
);

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('stackWorkspace', () => {
  it('resolves a per-service directory under the repos root', () => {
    expect(stackWorkspace(42)).toBe(path.join(reposDir, '42'));
  });

  it('refuses an id that would climb out of the repos root', () => {
    // The id reaches this helper from a route parameter and becomes a path
    // segment — a non-integer must never be joined in.
    expect(() => stackWorkspace(Number.NaN)).toThrow(/invalid workspace id/);
    expect(() => stackWorkspace(1.5)).toThrow(/invalid workspace id/);
    expect(() => stackWorkspace('../etc' as unknown as number)).toThrow(/invalid workspace id/);
  });
});

describe('materialiseComposeFile', () => {
  const yaml = 'services:\n  app:\n    image: nginx:alpine\n';

  it('creates the workspace and writes the file the builder deploys', () => {
    const file = materialiseComposeFile(7, yaml);

    expect(file).toBe(path.join(reposDir, '7', INLINE_COMPOSE_FILE));
    expect(readFileSync(file, 'utf8')).toBe(yaml);
  });

  it('overwrites a previous revision in place', () => {
    materialiseComposeFile(8, yaml);
    const next = 'services:\n  app:\n    image: nginx:1.27\n';
    const file = materialiseComposeFile(8, next);

    expect(readFileSync(file, 'utf8')).toBe(next);
  });

  it('writes the file 0600 — a compose file routinely carries credentials', () => {
    const file = materialiseComposeFile(9, yaml);
    // Windows does not implement POSIX permission bits; assert where it means
    // something rather than skipping the guarantee entirely.
    if (process.platform === 'win32') return;
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
