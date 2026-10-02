import { readFileSync, existsSync, statSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { afterAll, describe, expect, it } from 'vitest';

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

// ── r573: release tooling must never leave a half-done release behind ──
describe('r573: release publishing and version bumping', () => {
  it('moves :latest only when the tag is the highest release, one run per tag at a time', () => {
    const raw = readFileSync(new URL('../../../.github/workflows/release-publish.yml', import.meta.url), 'utf8');
    const workflow = load(raw) as Workflow & { concurrency?: { group?: string; 'cancel-in-progress'?: boolean } };
    // Serialized per tag (a push and a manual re-run of the same tag), never cancelled mid-push.
    expect(workflow.concurrency?.group).toContain('inputs.tag || github.ref_name');
    expect(workflow.concurrency?.['cancel-in-progress']).toBe(false);
    // r581: the decision lives in the promotion job, made after the smokes.
    const steps = workflow.jobs['promote-release']!.steps;
    const decide = steps.findIndex((s) => s.name?.includes('moves :latest'));
    expect(decide).toBeGreaterThan(-1);
    const decideStep = steps[decide] as Step & { id?: string };
    expect(decideStep.id).toBe('latest');
    expect(decideStep.run).toContain('git ls-remote --tags --refs origin');
    expect(decideStep.run).toContain('"$highest" = "$RELEASE_TAG"');
    // The retag is gated on that decision and comes after it.
    const retag = steps.findIndex((s) => s.run?.includes('imagetools create'));
    expect(retag).toBeGreaterThan(decide);
    expect((steps[retag] as Step & { if?: string }).if).toBe("steps.latest.outputs.move == 'true'");
    // The dispatch hint names the real workflow file.
    expect(raw).not.toContain('gh workflow run release.yml');
    expect(raw).toContain('gh workflow run release-publish.yml');
  });

  describe('bump-version.js validates every rewrite before writing any', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const dirs: string[] = [];
    afterAll(() => {
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    });

    const PACKAGES = [
      'package.json', 'apps/cli/package.json', 'apps/server/package.json', 'apps/web/package.json',
      'packages/db/package.json', 'packages/mcp/package.json', 'packages/plugin-sdk/package.json',
      'packages/schemas/package.json', 'packages/sdk/package.json', 'website/package.json',
    ];

    /** A miniature repo carrying every file the script rewrites, at 0.0.1. */
    function fixtureRepo(opts: { versionLiteral: boolean }): string {
      const root = mkdtempSync(join(tmpdir(), 'nd-bump-'));
      dirs.push(root);
      const put = (rel: string, body: string) => {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), body);
      };
      mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
      copyFileSync(join(repoRoot, 'scripts', 'bump-version.js'), join(root, 'scripts', 'bump-version.js'));
      copyFileSync(join(repoRoot, 'scripts', 'lib', 'package-list.mjs'), join(root, 'scripts', 'lib', 'package-list.mjs'));
      for (const rel of PACKAGES) put(rel, `${JSON.stringify({ name: rel, version: '0.0.1' }, null, 2)}\n`);
      put(
        'apps/server/src/version.ts',
        `${opts.versionLiteral ? "export const VERSION = '0.0.1';\n" : '// VERSION literal missing\n'}` +
          "export const CHANGELOG = [\n  {\n    version: '0.0.1',\n    date: '2026-01-01',\n    title: 'x',\n    changes: [\n      'y',\n    ],\n  },\n];\n",
      );
      put('apps/web/src/routes/About.tsx', 'install.sh --version v0.0.1\n');
      put('docs/QUICKSTART.md', 'install.sh --version v0.0.1\n');
      put('website/src/pages/Home.tsx', '<span className="tag font-bold">v0.0.1</span>\n');
      put('website/src/components/Layout.tsx', 'v0.0.1 GA\n');
      put('README.md', 'Release-0.0.1-blue --version v0.0.1 newest release tag (**0.0.1**)\n');
      return root;
    }
    const versions = (root: string) => PACKAGES.map((rel) => JSON.parse(readFileSync(join(root, rel), 'utf8')).version as string);
    const bump = (root: string) =>
      spawnSync(process.execPath, [join(root, 'scripts', 'bump-version.js'), '0.10.99'], { cwd: root, encoding: 'utf8' });

    it('a critical pattern miss exits 1 and leaves EVERY file untouched (no half-bumped tree)', () => {
      const root = fixtureRepo({ versionLiteral: false });
      const res = bump(root);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('nothing was written');
      expect(versions(root)).toEqual(PACKAGES.map(() => '0.0.1'));
      expect(readFileSync(join(root, 'docs/QUICKSTART.md'), 'utf8')).toContain('--version v0.0.1');
    });

    it('a clean tree is bumped everywhere (including /g patterns checked twice)', () => {
      const root = fixtureRepo({ versionLiteral: true });
      const res = bump(root);
      expect(res.status, res.stderr).toBe(0);
      expect(versions(root)).toEqual(PACKAGES.map(() => '0.10.99'));
      const ts = readFileSync(join(root, 'apps/server/src/version.ts'), 'utf8');
      expect(ts).toContain("export const VERSION = '0.10.99';");
      expect(ts.indexOf("version: '0.10.99'")).toBeLessThan(ts.indexOf("version: '0.0.1'"));
      expect(readFileSync(join(root, 'apps/web/src/routes/About.tsx'), 'utf8')).toContain('--version v0.10.99');
      expect(readFileSync(join(root, 'docs/QUICKSTART.md'), 'utf8')).toContain('--version v0.10.99');
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('Release-0.10.99-blue --version v0.10.99 newest release tag (**0.10.99**)\n');
    });
  });
});

// ── r581: installed servers are only offered a release that upgraded green ──
describe('r581: publication is gated on the end-to-end smokes', () => {
  type Job = {
    needs?: string | string[];
    permissions?: Record<string, string>;
    steps: Array<Step & { id?: string; if?: string; 'timeout-minutes'?: number }>;
  };
  const jobs = () => readWorkflow('release-publish.yml').jobs as unknown as Record<string, Job>;
  const needsOf = (job: Job) => [job.needs ?? []].flat();
  const uses = (step: Step, action: string) => String(step.uses ?? '').startsWith(`${action}@`);

  it('the build job pushes ONLY :vX.Y.Z and verifies its manifest — no :latest, no Release', () => {
    const build = jobs()['publish-image']!;
    expect(build.permissions).toEqual({ contents: 'read', packages: 'write' });
    const meta = build.steps.find((s) => uses(s, 'docker/metadata-action'))!;
    const tags = String(meta.with?.['tags']).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    expect(tags).toEqual(['type=raw,value=${{ env.RELEASE_TAG }}']);
    expect(String(meta.with?.['flavor'])).toContain('latest=false');
    const push = build.steps.findIndex((s) => s.with?.['push'] === true);
    const manifest = build.steps.findIndex((s) => s.name?.includes('multi-arch manifest'));
    expect(push).toBeGreaterThan(-1);
    expect(manifest).toBeGreaterThan(push);
    expect(build.steps.some((s) => uses(s, 'softprops/action-gh-release'))).toBe(false);
    expect(build.steps.some((s) => s.run?.includes('imagetools create'))).toBe(false);
  });

  it('the smoke job needs the build and runs both smokes on the pushed tag', () => {
    const smoke = jobs()['smoke-published-image']!;
    expect(needsOf(smoke)).toEqual(['publish-image']);
    expect(smoke.permissions).toEqual({ contents: 'read', packages: 'read' });
    const steps = smoke.steps;
    expect(steps.find((s) => uses(s, 'actions/checkout'))?.with?.['ref']).toBe('${{ env.RELEASE_TAG }}');
    // smoke-upgrade loads @libsql/client from packages/db.
    const install = steps.findIndex((s) => s.run === 'pnpm install --frozen-lockfile');
    expect(install).toBeGreaterThan(-1);

    // The FROM side is the previous PUBLISHED release (releases API), never a bare tag.
    const previous = steps.findIndex((s) => s.id === 'previous');
    expect(steps[previous]!.run).toContain('/releases');
    expect(steps[previous]!.run).toContain('select(.draft == false and .prerelease == false)');
    expect(steps[previous]!.run).not.toContain('ls-remote');
    expect(steps[previous]!.run).toContain('skipping the upgrade smoke');

    const upgrade = steps.findIndex((s) => s.run?.includes('scripts/smoke-upgrade.mjs'));
    expect(upgrade).toBeGreaterThan(Math.max(install, previous));
    expect(steps[upgrade]!.run).toBe('node scripts/smoke-upgrade.mjs --from="$FROM_TAG" --to="$RELEASE_TAG"');
    expect(steps[upgrade]!.env?.['FROM_TAG']).toBe('${{ steps.previous.outputs.from }}');
    expect(steps[upgrade]!.if).toBe("steps.previous.outputs.from != ''");
    expect(steps[upgrade]!['timeout-minutes']).toBeGreaterThan(0);

    const journey = steps.findIndex((s) => s.run?.includes('scripts/smoke-user-journey.mjs'));
    expect(journey).toBeGreaterThan(install);
    expect(steps[journey]!.run).toBe('node scripts/smoke-user-journey.mjs --image="ghcr.io/ninedeploy/ninedeploy:${RELEASE_TAG}"');
    expect(steps[journey]!.if).toBeUndefined();
    expect(steps[journey]!['timeout-minutes']).toBeGreaterThan(0);
  });

  it(':latest and the GitHub Release come only after the smokes, as a retag of the smoked manifest', () => {
    const all = jobs();
    const promote = all['promote-release']!;
    expect(needsOf(promote)).toEqual(expect.arrayContaining(['publish-image', 'smoke-published-image']));
    expect(promote.permissions).toEqual({ contents: 'write', packages: 'write' });
    const steps = promote.steps;
    // No rebuild on the way to :latest.
    expect(steps.some((s) => uses(s, 'docker/build-push-action'))).toBe(false);
    const retag = steps.findIndex((s) => s.run?.includes('imagetools create'));
    expect(steps[retag]!.run).toContain('imagetools create --tag "${repo}:latest" "${repo}:${RELEASE_TAG}"');
    expect(steps[retag]!.run).toContain('"$want" != "$got"');
    // The Release is what servers discover — it is the last step.
    const release = steps.findIndex((s) => uses(s, 'softprops/action-gh-release'));
    expect(release).toBe(steps.length - 1);
    expect(release).toBeGreaterThan(retag);
    expect(steps[release]!.with?.['tag_name']).toBe('${{ env.RELEASE_TAG }}');

    // Nowhere else: only promote-release may write contents or create the Release.
    for (const [name, job] of Object.entries(all)) {
      if (name === 'promote-release') continue;
      expect(job.permissions?.['contents'], name).toBe('read');
      expect(job.steps.some((s) => uses(s, 'softprops/action-gh-release')), name).toBe(false);
      expect(job.steps.some((s) => s.run?.includes('imagetools create')), name).toBe(false);
    }
  });

  it('every action stays pinned to a full commit SHA', () => {
    for (const job of Object.values(jobs())) {
      for (const step of job.steps) {
        if (step.uses) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });

  it('the upgrade smoke pulls both images up front and fails loudly on a missing FROM release', () => {
    const script = readFileSync(new URL('../../../scripts/smoke-upgrade.mjs', import.meta.url), 'utf8');
    const pulls = script.indexOf("pullOrFail(FROM, 'from')");
    expect(pulls).toBeGreaterThan(-1);
    expect(script.indexOf("pullOrFail(TO, 'to')")).toBeGreaterThan(pulls);
    // Before anything is created.
    expect(pulls).toBeLessThan(script.indexOf("docker(['network', 'create', NET])"));
    expect(script).toContain('is a published release, so installed servers pin this image');
    // A FROM that already carries r541 cannot orphan a secret; the precondition
    // applies only to older releases, the post-upgrade check to all.
    expect(script).toContain('if (olderThan(FROM, R541_FIXED_IN))');
    expect(script).toContain('post.orphanProjectEnv !== 0');
  });
});
