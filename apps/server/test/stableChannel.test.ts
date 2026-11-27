/**
 * A6 (docs/plans/COMPETITIVE_ROADMAP_2026-11.md): the stable release channel.
 *  - scripts/stable-channel.mjs decides which release the channel names;
 *  - the workflow runs it daily and writes two carriers: the STABLE file on
 *    the `stable` branch (with the built-in token) and the lightweight `stable`
 *    tag (with STABLE_TAG_TOKEN when it is set);
 *  - the panel resolves the channel per channel: the newer release the two name;
 *  - the installer accepts --channel stable and resolves it the same way.
 */
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the workflow's and the installer's text are what is under test here.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureBash, fixtureBashPath } from './bashFixture.js';

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;
const exec = vi.hoisted(() => ({ impl: null as null | ((cmd: string, args: string[]) => { stdout?: string; error?: string }) }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: (cmd: string, args: string[], _opts: unknown, cb: ExecCb) => {
    const out = exec.impl?.(cmd, args) ?? { error: `spawn ${cmd} ENOENT` };
    queueMicrotask(() => (out.error ? cb(new Error(out.error), '', '') : cb(null, out.stdout ?? '', '')));
  },
}));

const script = (await import(new URL('../../../scripts/stable-channel.mjs', import.meta.url).href)) as {
  pickStable: (r: unknown[], current: string | null, now: Date) => { tag: string | null; reason: string };
  isSecurity: (body: string) => boolean;
};
const root = new URL('../../../', import.meta.url);
/** The contents API's body for the STABLE file: base64, broken into lines. */
const pointerBody = (tag: string) => ({ content: Buffer.from(`${tag}\n`).toString('base64').match(/.{1,20}/g)!.join('\n'), encoding: 'base64' });
const day = 86_400_000;
const NOW = new Date('2026-11-20T12:00:00Z');
const rel = (tag: string, daysAgo: number, body = '', extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  published_at: new Date(NOW.getTime() - daysAgo * day).toISOString(),
  body,
  ...extra,
});

describe('scripts/stable-channel.mjs', () => {
  it('promotes the newest release that has soaked for seven days', () => {
    const releases = [rel('v0.18.25', 1), rel('v0.18.24', 8), rel('v0.18.23', 9), rel('v0.18.9', 30)];
    expect(script.pickStable(releases, 'v0.18.9', NOW)).toEqual({ tag: 'v0.18.24', reason: 'published 8 days ago' });
  });

  it('promotes a security release at once, and never a held one', () => {
    expect(script.pickStable([rel('v0.18.25', 0, 'fixed <!-- stable: security -->'), rel('v0.18.24', 8)], 'v0.18.20', NOW).tag).toBe('v0.18.25');
    // Only the marker counts: most CHANGELOG sections carry a Security heading.
    expect(script.isSecurity('### Security\n- fixed')).toBe(false);
    expect(script.pickStable([rel('v0.18.25', 0, 'text <!-- stable: security -->')], null, NOW).tag).toBe('v0.18.25');
    expect(script.pickStable([rel('v0.18.24', 8, '<!-- stable: hold -->'), rel('v0.18.23', 9)], null, NOW).tag).toBe('v0.18.23');
    expect(script.isSecurity('Mentions security in passing')).toBe(false);
  });

  it('never moves backwards, and ignores drafts, prereleases and odd tags', () => {
    expect(script.pickStable([rel('v0.18.24', 8)], 'v0.18.24', NOW)).toEqual({ tag: null, reason: 'stable is already v0.18.24' });
    expect(script.pickStable([rel('v0.18.20', 9)], 'v0.18.24', NOW).tag).toBeNull();
    const ignored = [rel('v0.19.0', 9, '', { draft: true }), rel('v0.19.1', 9, '', { prerelease: true }), rel('v0.19.2-rc1', 9), rel('stable', 9), rel('v0.19.3', 9, '', { published_at: null })];
    expect(script.pickStable(ignored, null, NOW)).toEqual({ tag: null, reason: 'no release qualifies yet' });
    // v0.18.10 is newer than v0.18.9 (numeric, not lexical).
    expect(script.pickStable([rel('v0.18.9', 9), rel('v0.18.10', 8)], null, NOW).tag).toBe('v0.18.10');
  });
});

describe('.github/workflows/stable-channel.yml', () => {
  type WfStep = { id?: string; if?: string; env?: Record<string, string>; run?: string; uses?: string };
  const wf = load(readFileSync(new URL('.github/workflows/stable-channel.yml', root), 'utf8')) as {
    on: { schedule: Array<{ cron: string }>; workflow_dispatch: unknown };
    permissions: Record<string, string>;
    jobs: { promote: { env: Record<string, string>; permissions: Record<string, string>; steps: WfStep[] } };
  };
  const steps = wf.jobs.promote.steps;
  const runs = steps.map((s) => s.run ?? '').join('\n');
  const step = (id: string) => {
    const found = steps.find((s) => s.id === id);
    expect(found, `no step with id ${id}`).toBeDefined();
    return found!;
  };

  it('runs daily and by hand, with write access only in its job', () => {
    expect(wf.on.schedule[0]!.cron).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(wf.on.workflow_dispatch).toBeTruthy();
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(wf.jobs.promote.permissions).toEqual({ contents: 'write' });
    for (const s of steps) if (s.uses) expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
  });

  it('decides where the channel is from both of its carriers, then with the script', () => {
    const decide = step('pick').run!;
    expect(decide).toContain('repos/$REPO/git/ref/tags/stable');
    expect(decide).toContain('repos/$REPO/contents/STABLE?ref=stable');
    expect(runs).toContain('node scripts/stable-channel.mjs');
    // A tag given by hand must be a published release.
    expect(runs).toContain('.draft == false and .prerelease == false');
  });

  it('names the release in the STABLE file on the stable branch, with a commit built on main, and never backwards', () => {
    // The built-in GITHUB_TOKEN may write this ref: the commit's .github/workflows is main's.
    const pointer = step('pointer');
    expect(pointer.if).toContain("steps.pick.outputs.target != ''");
    expect(pointer.if).toContain('inputs.dry_run != true');
    expect(pointer.env?.['GH_TOKEN']).toBeUndefined();
    expect(pointer.run).toContain('"base_tree":"%s"');
    expect(pointer.run).toContain('"path":"STABLE"');
    expect(pointer.run).toContain('repos/$REPO/git/ref/heads/main');
    expect(pointer.run).toContain('repos/$REPO/git/refs/heads/stable');
    expect(pointer.run).toContain('ref=refs/heads/stable');
    expect(pointer.run).toMatch(/Stable never moves backwards/);
    // A tag given by hand moves the file even backwards; the rules never do.
    expect(pointer.run).toContain('if [ -z "$FORCED_TAG" ] && [ -n "$have" ]');
    expect(pointer.run).toContain('echo "state=written" >> "$GITHUB_OUTPUT"');
  });

  it('moves only a lightweight tag on a release commit, and only refs/tags/stable', () => {
    const tag = step('tag').run!;
    expect(tag).toContain('[ "$type" = "commit" ]');
    expect(tag).toContain('repos/$REPO/git/refs/tags/stable');
    expect(tag).toContain('ref=refs/tags/stable');
    expect(runs).not.toMatch(/git push/);
  });

  it('without the tag secret the run stays green and says the tag did not move; with a failing secret it fails', () => {
    const tag = step('tag').run!;
    expect(step('tag').env?.['GH_TOKEN']).toBe('${{ secrets.STABLE_TAG_TOKEN || secrets.GITHUB_TOKEN }}');
    const warning = tag.indexOf('::warning::The stable tag was not moved');
    const error = tag.indexOf('::error::Could not move the stable tag with STABLE_TAG_TOKEN');
    expect(warning).toBeGreaterThan(0);
    expect(error).toBeGreaterThan(0);
    // The no-secret branch says so and ends the step well; the broken-secret branch, which comes
    // first in the function, fails.
    expect(tag.slice(warning)).toContain('echo "moved=false" >> "$GITHUB_OUTPUT"');
    expect(tag.slice(error, warning)).toMatch(/exit 1\n\s*fi/);
    expect(step('tag').env?.['HAS_TAG_TOKEN']).toBe("${{ secrets.STABLE_TAG_TOKEN != '' }}");
  });

  it('reports what stable names only after reading the carriers back, and skips that on a dry run', () => {
    const confirm = step('confirm');
    const pointerAt = steps.indexOf(step('pointer'));
    const tagAt = steps.indexOf(step('tag'));
    expect(pointerAt).toBeLessThan(tagAt);
    expect(steps.indexOf(confirm)).toBeGreaterThan(tagAt);
    expect(confirm.if).toContain("steps.pick.outputs.target != ''");
    expect(confirm.if).toContain('inputs.dry_run != true');
    expect(confirm.run).toContain('gh api "repos/$REPO/contents/STABLE?ref=stable" --jq .content');
    expect(confirm.run).toContain('echo "::error::the stable branch names $have, not $TARGET.');
    // The tag is confirmed only when its step moved it.
    expect(confirm.run).toContain('if [ "${{ steps.tag.outputs.moved }}" = "true" ]; then');
    expect(confirm.run).toContain('gh api "repos/$REPO/git/ref/tags/stable" --jq .object.sha');
  });
});

describe('panel: update check on the stable channel', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'nd-stable-'));
    vi.stubEnv('NINEDEPLOY_DATA_DIR', dataDir);
    exec.impl = null;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const LS_REMOTE = ['aaa\trefs/tags/v0.18.24', 'bbb\trefs/tags/v99.0.0', 'ccc\trefs/tags/stable', 'ccc\trefs/tags/v98.0.0', 'ddd\trefs/tags/v98.0.1', 'ccc\trefs/tags/v98.0.1^{}'].join('\n');

  it('reads the release on the stable tag (highest on its commit), annotated tags peeled', async () => {
    const { stableTagFromLsRemote } = await import('../src/lib/updateCheck.js');
    expect(stableTagFromLsRemote(LS_REMOTE)).toBe('v98.0.1');
    expect(() => stableTagFromLsRemote('aaa\trefs/tags/v1.0.0')).toThrow(/no stable tag yet/);
  });

  it('reads the release the stable branch names, as the text of its STABLE file', async () => {
    const { stableTagFromPointer } = await import('../src/lib/updateCheck.js');
    expect(stableTagFromPointer('v0.19.0\n')).toBe('v0.19.0');
    expect(stableTagFromPointer(' 0.19.0 ')).toBe('v0.19.0');
    expect(() => stableTagFromPointer('not a release')).toThrow(/returned no release tag/);
    expect(() => stableTagFromPointer('')).toThrow(/returned no release tag/);
  });

  it('serves the stable branch when the tag behind it is stuck, which is what a missing tag secret leaves', async () => {
    // The channel has two carriers; every source is asked and the newest release any names is the channel's.
    exec.impl = (cmd, args) => (cmd === 'git' && args[0] === 'ls-remote' ? { stdout: LS_REMOTE } : { error: 'no' });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('/contents/STABLE?ref=stable') ? { ok: true, status: 200, json: async () => pointerBody('v99.0.1') } : { ok: false, status: 404, json: async () => ({}) })));
    const { checkForUpdate } = await import('../src/lib/updateCheck.js');
    expect(await checkForUpdate(true, 'stable')).toMatchObject({ latest: 'v99.0.1', updateAvailable: true, channel: 'stable', source: 'github-api stable-file' });
  });

  it('serves the tag when the stable branch is the one behind', async () => {
    exec.impl = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'ls-remote') return { stdout: LS_REMOTE };
      if (cmd === 'curl' && args.some((a) => a.endsWith('/stable/STABLE'))) return { stdout: 'v97.0.0\n' };
      return { error: 'no' };
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    const { checkForUpdate } = await import('../src/lib/updateCheck.js');
    expect(await checkForUpdate(true, 'stable')).toMatchObject({ latest: 'v98.0.1', channel: 'stable', source: 'git' });
  });

  it('serves the raw STABLE file when git and the API are both unreachable', async () => {
    exec.impl = (cmd, args) => (cmd === 'curl' && args.some((a) => a.endsWith('/stable/STABLE')) ? { stdout: 'v99.0.2\n' } : { error: 'no' });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('fetch failed');
    }));
    const { checkForUpdate } = await import('../src/lib/updateCheck.js');
    expect(await checkForUpdate(true, 'stable')).toMatchObject({ latest: 'v99.0.2', channel: 'stable', source: 'stable-file' });
  });

  it('offers the stable release, keeps a separate answer per channel, and falls back to the API', async () => {
    exec.impl = (cmd, args) => (cmd === 'git' && args[0] === 'ls-remote' ? { stdout: LS_REMOTE } : { error: 'no' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'v99.0.0', html_url: 'https://x/v99' }) })));
    const { checkForUpdate } = await import('../src/lib/updateCheck.js');
    expect(await checkForUpdate(true, 'stable')).toMatchObject({ latest: 'v98.0.1', updateAvailable: true, channel: 'stable', source: 'git' });
    expect(await checkForUpdate(true, 'release')).toMatchObject({ latest: 'v99.0.0', channel: 'release' });
    // The cached stable answer is not the release channel's.
    expect((await checkForUpdate(false, 'stable')).latest).toBe('v98.0.1');
    expect(readFileSync(path.join(dataDir, 'update-check-stable.json'), 'utf8')).toContain('v98.0.1');

    vi.resetModules();
    exec.impl = () => ({ error: 'git: not found' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => (url.endsWith('/git/ref/tags/stable') ? { object: { sha: 'ccc', type: 'commit' } } : [{ name: 'v98.0.0', commit: { sha: 'ccc' } }, { name: 'v99.0.0', commit: { sha: 'bbb' } }]),
      })),
    );
    rmSync(path.join(dataDir, 'update-check-stable.json'));
    const fresh = await import('../src/lib/updateCheck.js');
    expect(await fresh.checkForUpdate(true, 'stable')).toMatchObject({ latest: 'v98.0.0', source: 'github-api' });
  });

  it('says why when there is no stable release yet, instead of offering one', async () => {
    exec.impl = () => ({ stdout: 'aaa\trefs/tags/v99.0.0' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    const { checkForUpdate } = await import('../src/lib/updateCheck.js');
    const res = await checkForUpdate(true, 'stable');
    expect(res).toMatchObject({ latest: null, updateAvailable: null, reason: 'unreachable', channel: 'stable' });
    expect(res.detail).toContain('no stable tag yet');
    expect(res.detail).toContain('the stable branch has no STABLE file yet');
  });
});

describe('install.sh --channel stable', () => {
  const sh = readFileSync(new URL('install.sh', root), 'utf8');
  // The installer's functions under its own bash, with curl and git replaced by shell functions.
  const bash = fixtureBash(spawnSync);
  const installer = fixtureBashPath(spawnSync, fileURLToPath(new URL('install.sh', root)), bash);
  const shrun = (script: string) =>
    spawnSync(bash, ['-c', `NINEDEPLOY_INSTALL_SOURCE_ONLY=1 . "$1"\n${script}`, 'stable-channel-test', installer], { encoding: 'utf8', timeout: 20_000 }).stdout.trim();

  it('reads the release the stable branch names, and serves the newer of the file and the tag', () => {
    expect(shrun(`printf 'v0.19.0\\n' | stable_tag_from_pointer_text`)).toBe('v0.19.0');
    expect(shrun(`printf 'not-a-release\\n' | stable_tag_from_pointer_text`)).toBe('');
    // The contents API's body: base64 broken into lines with \n.
    const body = JSON.stringify(pointerBody('v0.19.0'), null, 2);
    expect(shrun(`printf '%s' '${body}' | stable_tag_from_contents_json`)).toBe('v0.19.0');
    expect(shrun(`printf '%s' '{"encoding":"base64"}' | stable_tag_from_contents_json`)).toBe('');
    // A tag stuck behind the stable branch (what a missing tag secret leaves) …
    const stuck = [
      `curl() { case "$*" in *raw.githubusercontent.com*) printf 'v0.19.0\\n';; *) return 22;; esac; }`,
      `git() { printf 'aaa\\trefs/tags/stable\\naaa\\trefs/tags/v0.18.28\\n'; }`,
      'stable_tag',
    ].join('\n');
    expect(shrun(stuck)).toBe('v0.19.0');
    // … and the stable branch behind the tag.
    const behind = [`curl() { return 22; }`, `git() { printf 'aaa\\trefs/tags/stable\\naaa\\trefs/tags/v0.19.0\\n'; }`, 'stable_tag'].join('\n');
    expect(shrun(behind)).toBe('v0.19.0');
    // Neither carrier names a release: nothing, and the caller says so.
    const none = [`curl() { return 22; }`, `git() { printf 'aaa\\trefs/tags/v0.19.0\\n'; }`, 'stable_tag 2>/dev/null'].join('\n');
    expect(shrun(none)).toBe('');
  });

  it('accepts the channel, resolves it through stable_tag, and refuses when there is no stable release', () => {
    expect(sh).toContain('release|stable|main) ;;');
    expect(sh).toContain('REF=$(stable_tag)');
    expect(sh).toMatch(/\[ -n "\$REF" \] \|\| fail "The stable channel has no release yet/);
    // Defined before the source-only guard, so CI can exercise it.
    const guard = sh.indexOf('if [ "${NINEDEPLOY_INSTALL_SOURCE_ONLY:-}" = "1" ]');
    for (const fn of ['stable_tag_from_ls_remote', 'stable_tag_from_pointer_text', 'stable_tag_from_contents_json', 'stable_tag']) {
      expect(sh.indexOf(`\n${fn}() {`), fn).toBeGreaterThan(0);
      expect(sh.indexOf(`\n${fn}() {`), fn).toBeLessThan(guard);
    }
    // The STABLE file is asked where the workflow writes it.
    expect(sh).toContain('"https://raw.githubusercontent.com/${REPO_SLUG}/stable/STABLE"');
    expect(sh).toContain('"https://api.github.com/repos/${REPO_SLUG}/contents/STABLE?ref=stable"');
  });

  it('tells the panel about the channel, except on a pinned run (the self-update pins its target)', () => {
    const guarded = 'if [ "$CHANNEL" = "stable" ] && [ -z "$PINNED_VERSION" ]; then';
    // Once for the Docker .env, once for the bare-metal .env.
    expect(sh.split(guarded)).toHaveLength(3);
    expect(sh).toContain('upsert_env NINEDEPLOY_UPDATE_CHANNEL stable');
    expect(sh).toContain("printf 'NINEDEPLOY_UPDATE_CHANNEL=stable\\n' >> .env");
    const compose = readFileSync(new URL('docker-compose.prod.yml', root), 'utf8');
    expect(compose).toContain('NINEDEPLOY_UPDATE_CHANNEL: ${NINEDEPLOY_UPDATE_CHANNEL:-}');
  });

  it('fetches with --force everywhere, since the stable tag moves', () => {
    for (const line of sh.split('\n').filter((l) => /git fetch\b.*--tags/.test(l))) expect(line).toContain('--force');
  });
});

describe('panel: update channel routes', () => {
  it('stores the channel (operator, interactive) and checks the chosen channel', async () => {
    vi.resetModules();
    const check = vi.fn(async (_force: boolean, channel: string) => ({ current: '0.1.0', latest: null, updateAvailable: null, notesUrl: null, checkedAt: new Date().toISOString(), channel }));
    vi.doMock('../src/lib/updateCheck.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/lib/updateCheck.js')>()), checkForUpdate: check }));
    vi.doMock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
    const { systemRoutes } = await import('../src/modules/resources.js');
    const { asUser, buildTestApp } = await import('./helpers.js');
    const { closeMigratedDb, migratedDb } = await import('./lib/githubAppKit.js');
    const db = await migratedDb();
    const app = await buildTestApp({ db });
    await app.register(systemRoutes);
    expect((await app.inject({ method: 'GET', url: '/update-channel', headers: asUser() })).json()).toEqual({ channel: 'release' });
    const set = await app.inject({ method: 'PUT', url: '/update-channel', headers: asUser(), payload: { channel: 'stable' } });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toMatchObject({ channel: 'stable', check: { channel: 'stable' } });
    await app.inject({ method: 'GET', url: '/update-check', headers: asUser() });
    expect(check).toHaveBeenLastCalledWith(false, 'stable');
    expect((await app.inject({ method: 'PUT', url: '/update-channel', headers: asUser(), payload: { channel: 'nightly' } })).statusCode).toBe(400);
    const token = await app.inject({ method: 'PUT', url: '/update-channel', headers: { ...asUser(), 'x-test-token-scopes': 'operator' }, payload: { channel: 'release' } });
    expect(token.statusCode).toBe(403);
    await app.close();
    closeMigratedDb(db);

    // Without a saved choice, the installer's NINEDEPLOY_UPDATE_CHANNEL decides;
    // a saved choice wins over it.
    vi.stubEnv('NINEDEPLOY_UPDATE_CHANNEL', 'stable');
    const db2 = await migratedDb();
    const app2 = await buildTestApp({ db: db2 });
    await app2.register(systemRoutes);
    expect((await app2.inject({ method: 'GET', url: '/update-channel', headers: asUser() })).json()).toEqual({ channel: 'stable' });
    await app2.inject({ method: 'PUT', url: '/update-channel', headers: asUser(), payload: { channel: 'release' } });
    expect((await app2.inject({ method: 'GET', url: '/update-channel', headers: asUser() })).json()).toEqual({ channel: 'release' });
    await app2.close();
    closeMigratedDb(db2);
    vi.unstubAllEnvs();
    vi.doUnmock('../src/lib/updateCheck.js');
    vi.doUnmock('../src/lib/audit.js');
  });
});
