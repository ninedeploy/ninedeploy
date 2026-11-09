/**
 * S7 (docs/plans/COMPETITIVE_ROADMAP_2026-11.md): browser journeys in CI.
 *  - Playwright lives in e2e/ with its own lockfile, never in the panel's
 *    workspace: the bare-metal installer builds that workspace on every host.
 *  - The workflow runs only after a main CI push run (never a fork's code),
 *    with read-only permissions and SHA-pinned actions.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), 'utf8');

describe('e2e/ stays outside the panel workspace', () => {
  it('has its own package, lockfile and workspace file, with Playwright pinned exactly', () => {
    const pkg = JSON.parse(read('e2e/package.json')) as { devDependencies: Record<string, string> };
    expect(pkg.devDependencies['@playwright/test']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(existsSync(new URL('e2e/pnpm-lock.yaml', root))).toBe(true);
    expect(read('e2e/pnpm-workspace.yaml')).toMatch(/packages:\n\s+- "\."/);
  });

  it('no workspace package depends on Playwright, and the root workspace does not glob e2e/', () => {
    expect(read('pnpm-workspace.yaml')).not.toMatch(/e2e/);
    const manifests = ['package.json', ...['apps', 'packages'].flatMap((dir) =>
      readdirSync(new URL(`${dir}/`, root)).map((p) => `${dir}/${p}/package.json`))].filter((p) => existsSync(new URL(p, root)));
    for (const m of manifests) expect(read(m), m).not.toMatch(/playwright/i);
  });
});

describe('.github/workflows/browser-e2e.yml', () => {
  const wf = load(read('.github/workflows/browser-e2e.yml')) as {
    on: { workflow_run: { workflows: string[]; branches: string[] }; workflow_dispatch: unknown };
    permissions: Record<string, string>;
    jobs: { journeys: { if: string; steps: Array<{ uses?: string; run?: string; with?: Record<string, unknown> }> } };
  };
  const job = wf.jobs.journeys;

  it('follows main CI, and runs only for a push run (never a fork PR named main)', () => {
    expect(wf.on.workflow_run.workflows).toEqual(['CI']);
    expect(wf.on.workflow_run.branches).toEqual(['main']);
    expect(wf.on.workflow_dispatch).toBeTruthy();
    expect(job.if).toContain("github.event.workflow_run.event == 'push'");
    expect(job.if).toContain("github.event.workflow_run.conclusion == 'success'");
  });

  it('is read-only, pins every action by SHA, and does not keep the checkout token', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    for (const s of job.steps) if (s.uses) expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
    expect(job.steps.find((s) => s.uses?.startsWith('actions/checkout@'))?.with?.['persist-credentials']).toBe(false);
  });

  it('installs Playwright only inside e2e/ and drives the main-<sha> image', () => {
    const runs = job.steps.map((s) => s.run ?? '').join('\n');
    expect(runs).toContain('pnpm --dir e2e install --frozen-lockfile');
    expect(runs).toContain('node scripts/smoke-browser-e2e.mjs');
    expect(read('.github/workflows/browser-e2e.yml')).toContain("format('ghcr.io/ninedeploy/ninedeploy:main-{0}', github.event.workflow_run.head_sha)");
  });
});

describe('scripts/smoke-browser-e2e.mjs', () => {
  const src = read('scripts/smoke-browser-e2e.mjs');
  it('sets the public URL to the browser origin, removes only what it created, and never prunes', () => {
    expect(src).toContain('`NINEDEPLOY_PUBLIC_URL=${ORIGIN}`');
    expect(src).not.toMatch(/\bprune\b/);
    expect(src).toMatch(/\['rm', '-f', c\]/);
    expect(src).toContain("['volume', 'rm', VOLUME]");
  });

  it("never registers a real Let's Encrypt account from the setup journey", () => {
    expect(read('e2e/tests/01-setup.spec.ts')).toMatch(/acme\.uncheck\(\)/);
  });
});
