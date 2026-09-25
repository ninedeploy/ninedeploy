import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// r362: drizzle-kit runs with cwd=packages/db (`pnpm --filter … db:migrate`),
// so a relative NINEDEPLOY_DB_PATH from .env must resolve against the repo
// root — where the server (cwd = install dir) reads it — not packages/db.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const original = process.env['NINEDEPLOY_DB_PATH'];

async function configUrl(): Promise<string> {
  vi.resetModules();
  const mod = await import('../drizzle.config.ts');
  return (mod.default as { dbCredentials: { url: string } }).dbCredentials.url;
}

afterEach(() => {
  if (original === undefined) delete process.env['NINEDEPLOY_DB_PATH'];
  else process.env['NINEDEPLOY_DB_PATH'] = original;
});

describe('drizzle.config database path', () => {
  it('anchors a relative NINEDEPLOY_DB_PATH at the repo root', async () => {
    process.env['NINEDEPLOY_DB_PATH'] = './.data/ninedeploy.db';
    expect(await configUrl()).toBe(`file:${path.join(repoRoot, '.data', 'ninedeploy.db')}`);
  });

  it('keeps an absolute path (with or without file:) as given', async () => {
    const abs = path.join(repoRoot, '.data', 'abs.db');
    process.env['NINEDEPLOY_DB_PATH'] = `file:${abs}`;
    expect(await configUrl()).toBe(`file:${abs}`);
    process.env['NINEDEPLOY_DB_PATH'] = abs;
    expect(await configUrl()).toBe(`file:${abs}`);
  });

  it('defaults to <repo>/.data/ninedeploy.db', async () => {
    delete process.env['NINEDEPLOY_DB_PATH'];
    expect(await configUrl()).toBe(`file:${path.join(repoRoot, '.data', 'ninedeploy.db')}`);
  });
});
