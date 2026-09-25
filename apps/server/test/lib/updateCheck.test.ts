import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeError, isNewer } from '../../src/lib/updateCheck.js';

// curl / git fallbacks go through execFile; never let a test reach the network.
type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;
const exec = vi.hoisted(() => ({
  impl: null as null | ((cmd: string, args: string[]) => { stdout?: string; error?: string }),
  calls: [] as Array<{ cmd: string; args: string[] }>,
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: (cmd: string, args: string[], _opts: unknown, cb: ExecCb) => {
    exec.calls.push({ cmd, args });
    const out = exec.impl?.(cmd, args) ?? { error: `spawn ${cmd} ENOENT` };
    queueMicrotask(() => (out.error ? cb(new Error(out.error), '', '') : cb(null, out.stdout ?? '', '')));
  },
}));

const feed = (body: unknown, ok = true) =>
  vi.fn(async () => (ok ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 500 }));

/** fetch that fails like undici does: a bare "fetch failed" with the reason in `cause`. */
const unreachable = () =>
  vi.fn(async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' }) });
  });

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'nd-update-check-'));
  vi.stubEnv('NINEDEPLOY_DATA_DIR', dataDir);
  exec.impl = null;
  exec.calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  // Reset the module cache between tests so cached results don't leak.
  vi.resetModules();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('isNewer', () => {
  it('compares major, minor and patch (v-prefix optional)', () => {
    expect(isNewer('v0.2.0', '0.1.9')).toBe(true);
    expect(isNewer('0.1.10', 'v0.1.9')).toBe(true);
    expect(isNewer('v0.1.9', '0.1.9')).toBe(false);
    expect(isNewer('v0.1.8', '0.1.9')).toBe(false);
    expect(isNewer('v1.0.0', '0.9.9')).toBe(true);
  });
});

describe('describeError', () => {
  it('surfaces the cause undici hides behind "fetch failed"', () => {
    const err = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' }) });
    expect(describeError(err)).toBe('fetch failed ← getaddrinfo ENOTFOUND api.github.com');
  });

  it('lists every address of a happy-eyeballs AggregateError', () => {
    const agg = Object.assign(new AggregateError([new Error('connect ETIMEDOUT 140.82.121.6:443'), new Error('connect ENETUNREACH 2606:50c0::1:443')], ''), { code: 'ETIMEDOUT' });
    expect(describeError(new TypeError('fetch failed', { cause: agg }))).toBe(
      'fetch failed ← connect ETIMEDOUT 140.82.121.6:443, connect ENETUNREACH 2606:50c0::1:443',
    );
  });

  it('prefixes a code the message does not already carry', () => {
    expect(describeError(Object.assign(new Error('unable to get local issuer certificate'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }))).toBe(
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY: unable to get local issuer certificate',
    );
  });
});

describe('checkForUpdate', () => {
  it('reports an available update when the feed tag is newer', async () => {
    vi.stubGlobal('fetch', feed({ tag_name: 'v99.0.0', html_url: 'https://x/y' }));
    const { checkForUpdate } = await import('../../src/lib/updateCheck.js');
    const res = await checkForUpdate(true);
    expect(res).toMatchObject({ latest: 'v99.0.0', updateAvailable: true, notesUrl: 'https://x/y', source: 'github-api' });
    expect(res.stale).toBeUndefined();
    expect(res.current).toBeTruthy();
  });

  it('reports up-to-date when the feed tag is not newer', async () => {
    vi.stubGlobal('fetch', feed({ tag_name: 'v0.0.1' }));
    const { checkForUpdate } = await import('../../src/lib/updateCheck.js');
    expect((await checkForUpdate(true)).updateAvailable).toBe(false);
  });

  it('returns unknown when every source fails and nothing was ever seen', async () => {
    vi.stubGlobal('fetch', feed({}, false));
    const { checkForUpdate } = await import('../../src/lib/updateCheck.js');
    const res = await checkForUpdate(true);
    expect(res.updateAvailable).toBeNull();
    expect(res.latest).toBeNull();
    expect(res.reason).toBe('unreachable');
  });

  it('returns unknown when the feed returns no tag_name', async () => {
    vi.stubGlobal('fetch', feed({}));
    const { checkForUpdate } = await import('../../src/lib/updateCheck.js');
    const res = await checkForUpdate(true);
    expect(res.updateAvailable).toBeNull();
    expect(res.detail).toContain('github-api: update feed returned no release tag');
  });

  it('caches results within the TTL', async () => {
    const f = feed({ tag_name: 'v99.0.0' });
    vi.stubGlobal('fetch', f);
    const { checkForUpdate } = await import('../../src/lib/updateCheck.js');
    await checkForUpdate(true);
    await checkForUpdate();
    await checkForUpdate();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('shares one probe between concurrent callers', async () => {
    const f = feed({ tag_name: 'v99.0.0' });
    vi.stubGlobal('fetch', f);
    const { checkForUpdate } = await import('../../src/lib/updateCheck.js');
    await Promise.all([checkForUpdate(true), checkForUpdate(true), checkForUpdate()]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('returns unknown without fetching when checks are disabled', async () => {
    vi.stubEnv('NINEDEPLOY_UPDATE_CHECK_URL', 'disabled');
    const f = feed({ tag_name: 'v99.0.0' });
    vi.stubGlobal('fetch', f);
    const { checkForUpdate } = await import('../../src/lib/updateCheck.js');
    const res = await checkForUpdate(true);
    expect(res.updateAvailable).toBeNull();
    expect(res.reason).toBe('disabled');
    expect(f).not.toHaveBeenCalled();
    expect(exec.calls).toHaveLength(0);
  });

  it('names the real cause of every failed source instead of a bare "fetch failed"', async () => {
    vi.stubGlobal('fetch', unreachable());
    const { checkForUpdate } = await import('../../src/lib/updateCheck.js');
    const res = await checkForUpdate(true);
    expect(res.reason).toBe('unreachable');
    expect(res.detail).toContain('github-api: fetch failed ← getaddrinfo ENOTFOUND api.github.com');
    expect(res.detail).toContain('release-page: fetch failed');
    expect(res.detail).toContain('github-api via curl: curl:');
    expect(res.detail).toContain('git: git:');
  });

  it('flags a GitHub API rate limit in the detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, headers: new Headers({ 'x-ratelimit-remaining': '0' }) })));
    const { checkForUpdate } = await import('../../src/lib/updateCheck.js');
    expect((await checkForUpdate(true)).detail).toContain('update feed 403 (GitHub API rate limit reached)');
  });

  // ── r370: "curl reaches GitHub, the panel says fetch failed" ─────────────

  it('falls back to the release page redirect when the API is rate-limited', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.startsWith('https://api.github.com/')
          ? { ok: false, status: 403, headers: new Headers() }
          : { ok: false, status: 302, headers: new Headers({ location: 'https://github.com/NineDeploy/NineDeploy/releases/tag/v99.1.0' }) },
      ),
    );
    const { checkForUpdate } = await import('../../src/lib/updateCheck.js');
    const res = await checkForUpdate(true);
    expect(res).toMatchObject({
      latest: 'v99.1.0',
      updateAvailable: true,
      source: 'release-page',
      notesUrl: 'https://github.com/NineDeploy/NineDeploy/releases/tag/v99.1.0',
    });
  });

  it('falls back to curl when Node fetch cannot reach GitHub but the host curl can', async () => {
    vi.stubGlobal('fetch', unreachable());
    exec.impl = (cmd, args) =>
      cmd === 'curl' && args.includes('https://api.github.com/repos/NineDeploy/NineDeploy/releases/latest')
        ? { stdout: JSON.stringify({ tag_name: 'v99.2.0', html_url: 'https://notes' }) }
        : { error: 'nope' };
    const { checkForUpdate } = await import('../../src/lib/updateCheck.js');
    const res = await checkForUpdate(true);
    expect(res).toMatchObject({ latest: 'v99.2.0', updateAvailable: true, source: 'github-api via curl', notesUrl: 'https://notes' });
  });

  it('falls back to the release page via curl', async () => {
    vi.stubGlobal('fetch', unreachable());
    exec.impl = (cmd, args) =>
      cmd === 'curl' && args.includes('%{redirect_url}')
        ? { stdout: 'https://github.com/NineDeploy/NineDeploy/releases/tag/v99.3.0' }
        : { error: 'curl: (22) The requested URL returned error: 403' };
    const { checkForUpdate } = await import('../../src/lib/updateCheck.js');
    expect(await checkForUpdate(true)).toMatchObject({ latest: 'v99.3.0', source: 'release-page via curl' });
  });

  it('falls back to git ls-remote (the installer\'s own source) and picks the highest release tag', async () => {
    vi.stubGlobal('fetch', unreachable());
    exec.impl = (cmd) =>
      cmd === 'git'
        ? {
            stdout: [
              'a1\trefs/tags/v99.4.0',
              'b2\trefs/tags/v99.10.1',
              'c3\trefs/tags/v99.10.0',
              'd4\trefs/tags/v100.0.0-rc1', // not a release tag
              'e5\trefs/tags/nightly',
            ].join('\n'),
          }
        : { error: 'nope' };
    const { checkForUpdate } = await import('../../src/lib/updateCheck.js');
    expect(await checkForUpdate(true)).toMatchObject({ latest: 'v99.10.1', source: 'git' });
  });

  it('keeps a custom (non-GitHub) feed to the feed itself: no release page or git fallback', async () => {
    vi.stubEnv('NINEDEPLOY_UPDATE_CHECK_URL', 'https://updates.example.com/latest.json');
    const f = unreachable();
    vi.stubGlobal('fetch', f);
    const { checkForUpdate } = await import('../../src/lib/updateCheck.js');
    const res = await checkForUpdate(true);
    expect(f).toHaveBeenCalledTimes(1);
    expect(exec.calls.map((c) => c.cmd)).toEqual(['curl']);
    expect(res.detail).toMatch(/^feed: fetch failed/);
  });

  it('serves the last successful answer (stale) when every source fails, and persists it across restarts', async () => {
    vi.stubGlobal('fetch', feed({ tag_name: 'v99.0.0', html_url: 'https://notes' }));
    let mod = await import('../../src/lib/updateCheck.js');
    const good = await mod.checkForUpdate(true);
    expect(JSON.parse(readFileSync(path.join(dataDir, 'update-check.json'), 'utf8'))).toMatchObject({ latest: 'v99.0.0' });

    // Simulated restart + GitHub unreachable.
    vi.resetModules();
    vi.stubGlobal('fetch', unreachable());
    mod = await import('../../src/lib/updateCheck.js');
    const res = await mod.checkForUpdate(true);
    expect(res).toMatchObject({ latest: 'v99.0.0', updateAvailable: true, notesUrl: 'https://notes', stale: true, checkedAt: good.checkedAt });
    expect(res.detail).toContain('ENOTFOUND');
    expect(res.reason).toBeUndefined();
  });

  it('answers a fresh process from the persisted result without waiting on GitHub', async () => {
    writeFileSync(
      path.join(dataDir, 'update-check.json'),
      JSON.stringify({ latest: 'v99.5.0', notesUrl: null, checkedAt: '2026-09-01T00:00:00.000Z', source: 'github-api' }),
    );
    const f = vi.fn(() => new Promise(() => {})); // GitHub hangs forever
    vi.stubGlobal('fetch', f);
    const { checkForUpdate } = await import('../../src/lib/updateCheck.js');
    expect(await checkForUpdate()).toMatchObject({ latest: 'v99.5.0', updateAvailable: true });
    expect(f).toHaveBeenCalledTimes(1); // background refresh started
  });

  it('never offers a persisted release that is not newer than the running one', async () => {
    writeFileSync(
      path.join(dataDir, 'update-check.json'),
      JSON.stringify({ latest: 'v0.0.1', notesUrl: null, checkedAt: '2026-09-01T00:00:00.000Z', source: 'git' }),
    );
    vi.stubGlobal('fetch', unreachable());
    const { checkForUpdate } = await import('../../src/lib/updateCheck.js');
    expect(await checkForUpdate(true)).toMatchObject({ latest: 'v0.0.1', updateAvailable: false, stale: true });
  });

  it('re-probes failures after 10 minutes; an expired success is served while it refreshes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const start = Date.now();
      const failing = feed({}, false);
      vi.stubGlobal('fetch', failing);
      const { checkForUpdate } = await import('../../src/lib/updateCheck.js');

      await checkForUpdate(true); // failure cached at `start` (two fetch sources)
      const perProbe = failing.mock.calls.length;
      await checkForUpdate(); // within the 10-minute failure TTL → served from cache
      expect(failing).toHaveBeenCalledTimes(perProbe);

      vi.setSystemTime(start + 11 * 60 * 1000); // failure TTL passed → re-probe
      await checkForUpdate();
      expect(failing).toHaveBeenCalledTimes(2 * perProbe);

      const success = feed({ tag_name: 'v99.0.0' });
      vi.stubGlobal('fetch', success);
      vi.setSystemTime(start + 12 * 60 * 1000);
      await checkForUpdate(true); // success cached at start+12m
      vi.setSystemTime(start + 40 * 60 * 1000); // 28 min later — still inside 1h
      await checkForUpdate();
      expect(success).toHaveBeenCalledTimes(1);

      const newer = feed({ tag_name: 'v99.1.0' });
      vi.stubGlobal('fetch', newer);
      vi.setSystemTime(start + 80 * 60 * 1000); // past 1h → old answer now, refresh behind it
      expect((await checkForUpdate()).latest).toBe('v99.0.0');
      await vi.waitFor(async () => expect((await checkForUpdate()).latest).toBe('v99.1.0'));
      expect(newer).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
