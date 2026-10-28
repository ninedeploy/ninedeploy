import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ reposDir: '', credential: vi.fn() }));
vi.mock('../src/config.js', async original => {
  const actual = await original<typeof import('../src/config.js')>();
  return { ...actual, config: { ...actual.config, paths: { ...actual.config.paths, reposDir: state.reposDir } } };
});
vi.mock('../src/lib/sourceCreds.js', () => ({ resolveCloneCreds: state.credential }));
const parent = mkdtempSync(path.join(os.tmpdir(), 'nd-gitops-cleanup-'));
state.reposDir = parent;
const { readSpecFromRepo } = await import('../src/lib/instanceGitops.js');
afterAll(() => rmSync(parent, { recursive: true, force: true }));

it('removes the temporary directory when credentials cannot be resolved and still accepts a later checkout', async () => {
  state.credential.mockRejectedValueOnce(new Error('credentials unavailable'));
  const cfg = { enabled: true, repoUrl: 'https://github.com/acme/instance', branch: 'main', path: 'instance.yaml', sourceId: 7, intervalMinutes: 15 };
  const checkout = vi.fn(async (_url: string, _branch: string, _sha: string | undefined, dir: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'instance.yaml'), 'version: "1"\nprojects: []\n');
    return 'abcdef';
  });
  await expect(readSpecFromRepo({} as never, cfg, { checkout } as never)).rejects.toThrow('credentials unavailable');
  expect(checkout).not.toHaveBeenCalled();
  expect(readdirSync(parent)).toEqual([]);
  await expect(readSpecFromRepo({} as never, { ...cfg, sourceId: null }, { checkout } as never)).resolves.toMatchObject({ commit: 'abcdef' });
  expect(readdirSync(parent)).toEqual([]);
});
