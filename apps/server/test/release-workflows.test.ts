import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

type Step = { name?: string; run?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Workflow = { jobs: Record<string, { steps: Step[] }> };
const readWorkflow = (name: string) => load(readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf8')) as Workflow;

describe('release delivery invariants', () => {
  it('never deletes historical registry versions during publication', () => {
    const workflow = readWorkflow('release-publish.yml');
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) expect(step.run ?? '').not.toMatch(/gh api --method DELETE/);
    }
  });

  it('runs real database integration checks before publishing a release image', () => {
    const steps = readWorkflow('release-publish.yml').jobs['publish-image']!.steps;
    const integration = steps.findIndex((step) => step.run?.includes('vitest.integration.config.ts'));
    const push = steps.findIndex((step) => step.with?.['push'] === true);
    expect(integration).toBeGreaterThan(-1);
    expect(steps[integration]!.env?.['RUN_INTEGRATION']).toBe('1');
    expect(push).toBeGreaterThan(integration);
  });

  it('builds the workspace before the release checks', () => {
    // Server tests resolve the built web dashboard layout; turbo has no edge
    // forcing web#build ahead of server#test, so the checks alone can run
    // them in either order (this raced a v0.10.3 release attempt).
    const steps = readWorkflow('release-publish.yml').jobs['publish-image']!.steps;
    const build = steps.findIndex((step) => step.run === 'pnpm build');
    const checks = steps.findIndex((step) => step.run === 'pnpm release:check');
    expect(build).toBeGreaterThan(-1);
    expect(checks).toBeGreaterThan(build);
  });

  it('uses lowercase OCI repository names on the main publishing path', () => {
    const steps = readWorkflow('ci.yml').jobs['publish-image']!.steps;
    const push = steps.find((step) => step.with?.['push'] === true)!;
    const tags = String(push.with?.['tags']);
    expect(tags).not.toContain('github.repository');
    expect(tags).toContain('ghcr.io/ninedeploy/ninedeploy:edge');
  });

  it('r475: verifies version provenance before anything is built or pushed', () => {
    // Tags are typed by hand; a stale or mistyped tag would pass every check
    // (it IS a green commit) and publish a mislabeled image that also
    // clobbers :latest. The provenance step must sit before install/build.
    const steps = readWorkflow('release-publish.yml').jobs['publish-image']!.steps;
    const provenance = steps.findIndex((step) => step.name?.includes('provenance'));
    expect(provenance).toBeGreaterThan(-1);
    const step = steps[provenance]!;
    expect(step.run).toContain("require('./package.json').version");
    expect(step.run).toContain('apps/server/src/version.ts');
    const install = steps.findIndex((step2) => step2.run === 'pnpm install --frozen-lockfile');
    expect(install).toBeGreaterThan(provenance);
  });

  it('r475: checks out the requested tag, not the dispatching branch', () => {
    // A manual workflow_dispatch run from a BRANCH must build the TAG; the
    // ref pin is the only thing standing between the two.
    const workflow = readWorkflow('release-publish.yml');
    const checkout = workflow.jobs['publish-image']!.steps.find((step) => String(step.uses ?? '').startsWith('actions/checkout'));
    expect(checkout?.with?.['ref']).toBe('${{ env.RELEASE_TAG }}');
  });

  it('r475: the local gate runs the phases in CI order (typecheck, lint, build, then tests)', () => {
    // A single `turbo run typecheck lint build test` is NOT phase-ordered —
    // turbo has no edges between those tasks, so local green could diverge
    // from CI's sequential invocations (the 0.10.30 escape class).
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts['release:check']).toBe('pnpm typecheck && pnpm lint && pnpm build && pnpm turbo run test --concurrency=1');
  });

  it('r475: the pnpm pins in the Dockerfile and installer track packageManager', () => {
    // Three hardcoded copies must not drift from package.json — a pnpm major
    // bump without touching them fails only inside a full CI round trip.
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
    const expected = /^pnpm@([\d.]+)/.exec(pkg.packageManager)?.[1];
    expect(expected).toBeDefined();
    const dockerfile = readFileSync(new URL('../../../Dockerfile', import.meta.url), 'utf8');
    const args = dockerfile.match(/ARG PNPM_VERSION=([\d.]+)/g) ?? [];
    expect(args.length).toBe(2); // builder + runner stage
    for (const arg of args) expect(arg).toBe(`ARG PNPM_VERSION=${expected}`);
    const installer = readFileSync(new URL('../../../install.sh', import.meta.url), 'utf8');
    expect(installer).toContain(`PNPM_VERSION="${expected}"`);
  });

  it('r476: no documented createClient example uses the nonexistent token option', () => {
    // The r472 audit found AI_MCP_CLI.md teaching an unauthenticated client;
    // r476 found the SAME bug family copied in README.md and website docs.
    // The SDK takes getToken (a provider); a static token: key is silently
    // ignored at runtime and every call 401s. Sweep every doc-bearing
    // surface so a new copy cannot ship.
    const surfaces = ['../../../README.md', '../../../docs', '../../../website/src', '../../../apps/web/src', '../../../packages/mcp', '../../../packages/plugin-sdk'];
    const offenders: string[] = [];
    for (const surface of surfaces) {
      const url = new URL(surface, import.meta.url);
      if (!existsSync(url)) continue;
      const files = statSync(url).isFile()
        ? [url]
        : readdirSync(url, { recursive: true }).map((f) => new URL(`${surface}/${f}`, import.meta.url));
      for (const file of files) {
        const fp = file.pathname.replace(/^\/([A-Za-z]:)/, '$1');
        if (!/\.(md|ts|tsx|js|mjs)$/.test(fp) || /node_modules|dist/.test(fp)) continue;
        if (/createClient\(\{[^}]*token\s*:/s.test(readFileSync(file, 'utf8'))) offenders.push(fp);
      }
    }
    expect(offenders, `docs teaching the nonexistent token: option: ${offenders.join(', ')}`).toEqual([]);
  });

  it('r477: the release scripts shared package list covers every workspace package.json', () => {
    // bump-version and tag-release rewrite/verify this list; an 11th package
    // missing from it would ship at a stale version with every gate green.
    // The list lives in scripts/lib/package-list.mjs (one home, imported by
    // both scripts); this test pins it against the real workspace globs.
    const listUrl = new URL('../../../scripts/lib/package-list.mjs', import.meta.url);
    const list = readFileSync(listUrl, 'utf8');
    const listed = [...list.matchAll(/'([^']*package\.json)'/g)].map((m) => m[1]);
    expect(listed.length).toBeGreaterThanOrEqual(10);
    const workspaces = ['.', 'apps/cli', 'apps/server', 'apps/web', 'packages/db', 'packages/mcp', 'packages/plugin-sdk', 'packages/schemas', 'packages/sdk', 'website'];
    const expected = workspaces.map((w) => (w === '.' ? 'package.json' : `${w}/package.json`));
    for (const rel of expected) expect(listed, `missing ${rel}`).toContain(rel);
    // And both scripts import the shared module instead of a private copy.
    const bump = readFileSync(new URL('../../../scripts/bump-version.js', import.meta.url), 'utf8');
    const tag = readFileSync(new URL('../../../scripts/tag-release.js', import.meta.url), 'utf8');
    expect(bump).toContain("from './lib/package-list.mjs'");
    expect(tag).toContain("from './lib/package-list.mjs'");
  });
});
