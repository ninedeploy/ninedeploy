import { execFile } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { VERSION } from '../version.js';
import { createLogger } from './log.js';

const log = createLogger('update-check');

export interface UpdateCheckResult {
  current: string;
  latest: string | null;
  updateAvailable: boolean | null; // null = unknown (offline / disabled)
  notesUrl: string | null;
  checkedAt: string;
  /** Present only when updateAvailable is null: why no verdict exists. */
  reason?: 'disabled' | 'unreachable';
  /** Short feed-side detail (why the live check failed) for the UI. */
  detail?: string;
  /** Which source answered: 'github-api', 'release-page', 'git', … (+ ' via curl'). */
  source?: string;
  /**
   * r370: true when the live check failed and this is the last release seen
   * by a successful check (checkedAt is that check's time, detail says why
   * the fresh one failed). A verdict from an hour ago beats "unavailable".
   */
  stale?: boolean;
  /** A6: the channel this answer is for. */
  channel?: UpdateChannel;
}

/** A6: `release` follows every release (as before); `stable` follows the `stable` tag. */
export type UpdateChannel = 'release' | 'stable';

/** Successful answers are reused for an hour (GitHub's anonymous API budget is 60 req/h per IP). */
const CACHE_TTL_MS = 60 * 60 * 1000;
/** Failures are remembered far more briefly than successes: one boot-time
 *  blip (network not up yet, a single API rate-limit 403) must not pin
 *  "update check unavailable" on the dashboard. */
const FAILURE_CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
const EXEC_TIMEOUT_MS = 15_000;
const DETAIL_MAX = 500;
const RELEASE_TAG = /^v?\d+\.\d+\.\d+$/;
const GITHUB_API_LATEST = /^https:\/\/api\.github\.com\/repos\/([\w.-]+)\/([\w.-]+)\/releases\/latest\/?$/;
const USER_AGENT = `NineDeploy/${VERSION} (update-check)`;

interface Found {
  latest: string;
  notesUrl: string | null;
}

interface LastGood extends Found {
  checkedAt: string;
  source: string;
}

// A6: one cache, probe and last answer per channel, so switching channels never shows the other one's verdict.
const cachedBy = new Map<UpdateChannel, { result: UpdateCheckResult; at: number; isFailure: boolean }>();
const inflightBy = new Map<UpdateChannel, Promise<UpdateCheckResult>>();
const lastGoodBy = new Map<UpdateChannel, LastGood | null>(); // absent = not loaded from disk yet

/** Compare two semver strings ("v" prefix optional). Returns true when a > b. */
export function isNewer(a: string, b: string): boolean {
  // Preserve leading-decimal parsing without rounding large release components.
  const parse = (v: string) => v.replace(/^v/, '').split('.').map((n) => BigInt(n.trimStart().match(/^[+-]?\d+/)?.[0] ?? '0'));
  const [aMaj = 0n, aMin = 0n, aPatch = 0n] = parse(a);
  const [bMaj = 0n, bMin = 0n, bPatch = 0n] = parse(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPatch > bPatch;
}

/**
 * r370: undici reports every transport failure as a bare "fetch failed" and
 * hides the reason in `cause` (ENOTFOUND, ECONNRESET, a TLS CA error, an
 * AggregateError of per-address ETIMEDOUTs from happy eyeballs). The bare
 * message is what operators saw — useless for telling DNS from IPv6 from a
 * TLS-inspecting proxy. Walk the cause chain instead.
 */
export function describeError(err: unknown): string {
  const one = (e: unknown): string => {
    if (!(e instanceof Error)) return String(e);
    const code = (e as { code?: unknown }).code;
    const msg = e.message || e.name;
    return typeof code === 'string' && !msg.includes(code) ? `${code}: ${msg}` : msg;
  };
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 4; depth++) {
    const nested = (cur as { errors?: unknown }).errors;
    if (Array.isArray(nested) && nested.length > 0) {
      parts.push(nested.map(one).join(', '));
      break;
    }
    parts.push(one(cur));
    cur = cur instanceof Error ? (cur as { cause?: unknown }).cause : null;
  }
  return parts.filter((p, i) => p && parts.indexOf(p) === i).join(' ← ');
}

function stateFile(channel: UpdateChannel): string {
  return path.join(config.paths.dataDir, channel === 'stable' ? 'update-check-stable.json' : 'update-check.json');
}

function loadLastGood(channel: UpdateChannel): LastGood | null {
  if (lastGoodBy.has(channel)) return lastGoodBy.get(channel)!;
  let lastGood: LastGood | null = null;
  try {
    const raw = JSON.parse(readFileSync(stateFile(channel), 'utf8')) as Partial<LastGood>;
    if (typeof raw.latest === 'string' && RELEASE_TAG.test(raw.latest) && typeof raw.checkedAt === 'string') {
      lastGood = {
        latest: raw.latest,
        notesUrl: typeof raw.notesUrl === 'string' ? raw.notesUrl : null,
        checkedAt: raw.checkedAt,
        source: typeof raw.source === 'string' ? raw.source : 'unknown',
      };
    }
  } catch {
    /* first check on this install, or an unreadable file — nothing to fall back on */
  }
  lastGoodBy.set(channel, lastGood);
  return lastGood;
}

function saveLastGood(channel: UpdateChannel, value: LastGood): void {
  lastGoodBy.set(channel, value);
  try {
    const file = stateFile(channel);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, file);
  } catch {
    /* read-only data dir: the in-memory copy still covers this process */
  }
}

function verdict(channel: UpdateChannel, found: LastGood, extra: Partial<UpdateCheckResult> = {}): UpdateCheckResult {
  // Recomputed against the RUNNING version on every read, so a persisted
  // answer from before a self-update never offers the release we are on.
  return {
    current: VERSION,
    latest: found.latest,
    updateAvailable: isNewer(found.latest, VERSION),
    notesUrl: found.notesUrl,
    checkedAt: found.checkedAt,
    source: found.source,
    channel,
    ...extra,
  };
}

function unknownResult(channel: UpdateChannel, reason: 'disabled' | 'unreachable', detail?: string): UpdateCheckResult {
  return {
    current: VERSION,
    latest: null,
    updateAvailable: null,
    notesUrl: null,
    checkedAt: new Date().toISOString(),
    reason,
    channel,
    ...(detail !== undefined ? { detail: detail.slice(0, DETAIL_MAX) } : {}),
  };
}

function requireTag(tag: unknown, what: string): string {
  if (typeof tag !== 'string' || !RELEASE_TAG.test(tag.trim())) {
    throw new Error(`${what} returned no release tag${typeof tag === 'string' && tag ? ` (got "${tag.slice(0, 40)}")` : ''}`);
  }
  const t = tag.trim();
  return t.startsWith('v') ? t : `v${t}`;
}

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true, ...(env ? { env } : {}) },
      (err, stdout, stderr) => {
        if (err) {
          const tail = String(stderr ?? '').trim().split('\n').pop();
          reject(new Error(tail ? `${cmd}: ${tail}` : `${cmd}: ${describeError(err)}`));
        } else resolve(String(stdout));
      },
    );
  });
}

// ── Sources ────────────────────────────────────────────────────────────────
// Node's fetch and the host's curl fail differently: curl honours
// HTTPS_PROXY and the system CA store (TLS-inspecting middleboxes), and its
// happy-eyeballs keeps the slow IPv4 attempt alive where Node's 250 ms
// per-address budget gives up. "curl reaches GitHub but the panel says fetch
// failed" was exactly that split, so every HTTP source is tried with both.

function parseFeed(body: unknown, what: string): Found {
  const b = (body ?? {}) as { tag_name?: unknown; html_url?: unknown };
  return { latest: requireTag(b.tag_name, what), notesUrl: typeof b.html_url === 'string' ? b.html_url : null };
}

async function feedViaFetch(url: string): Promise<Found> {
  const res = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const remaining = res.headers?.get?.('x-ratelimit-remaining');
    throw new Error(`update feed ${res.status}${remaining === '0' ? ' (GitHub API rate limit reached)' : ''}`);
  }
  return parseFeed(await res.json(), 'update feed');
}

async function feedViaCurl(url: string): Promise<Found> {
  const out = await run('curl', ['-fsSL', '-m', '12', '-H', 'Accept: application/vnd.github+json', '-A', USER_AGENT, url]);
  let body: unknown;
  try {
    body = JSON.parse(out);
  } catch {
    throw new Error('update feed (curl) returned non-JSON');
  }
  return parseFeed(body, 'update feed (curl)');
}

/** github.com/<repo>/releases/latest 302s to …/releases/tag/<tag>: no API, no rate limit. */
function tagFromReleaseRedirect(location: string | null | undefined, what: string): string {
  const m = /\/releases\/tag\/([^/?#]+)\/?(?:[?#].*)?$/.exec(location ?? '');
  if (!m?.[1]) throw new Error(`${what} did not redirect to a release${location ? ` (→ ${location.slice(0, 80)})` : ''}`);
  return requireTag(decodeURIComponent(m[1]), what);
}

async function releasePageViaFetch(repo: string): Promise<Found> {
  const res = await fetch(`https://github.com/${repo}/releases/latest`, {
    method: 'HEAD',
    redirect: 'manual',
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const latest = tagFromReleaseRedirect(res.headers.get('location'), `release page ${res.status}`);
  return { latest, notesUrl: `https://github.com/${repo}/releases/tag/${latest}` };
}

async function releasePageViaCurl(repo: string): Promise<Found> {
  const devNull = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const location = await run('curl', ['-sS', '-I', '-m', '12', '-A', USER_AGENT, '-o', devNull, '-w', '%{redirect_url}', `https://github.com/${repo}/releases/latest`]);
  const latest = tagFromReleaseRedirect(location.trim(), 'release page (curl)');
  return { latest, notesUrl: `https://github.com/${repo}/releases/tag/${latest}` };
}

/** The installer's own first source (install.sh latest_tag): works behind git-only proxies. */
async function gitLsRemote(repo: string): Promise<Found> {
  const out = await run('git', ['ls-remote', '--tags', '--refs', `https://github.com/${repo}.git`], {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
  });
  let best: string | null = null;
  for (const line of out.split('\n')) {
    const tag = line.split('refs/tags/')[1]?.trim();
    if (tag && RELEASE_TAG.test(tag) && (!best || isNewer(tag, best))) best = tag;
  }
  const latest = requireTag(best, 'git ls-remote');
  return { latest, notesUrl: `https://github.com/${repo}/releases/tag/${latest}` };
}

/**
 * A6: the release the `stable` tag points at, from `git ls-remote --tags`
 * output (annotated tags peeled through their ^{} line); the highest when
 * several release tags share its commit. Throws when there is none.
 */
export function stableTagFromLsRemote(out: string): string {
  const direct = new Map<string, string>();
  const peeled = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref?.startsWith('refs/tags/')) continue;
    const name = ref.slice('refs/tags/'.length);
    if (name.endsWith('^{}')) peeled.set(name.slice(0, -3), sha);
    else if (!direct.has(name)) direct.set(name, sha);
  }
  const commitOf = (name: string) => peeled.get(name) ?? direct.get(name);
  const stable = commitOf('stable');
  if (!stable) throw new Error('no stable tag yet (the stable channel has no release)');
  let best: string | null = null;
  for (const name of new Set([...direct.keys(), ...peeled.keys()])) {
    if (RELEASE_TAG.test(name) && commitOf(name) === stable && (!best || isNewer(name, best))) best = name;
  }
  return requireTag(best, 'stable tag');
}

async function stableViaGit(repo: string): Promise<Found> {
  const out = await run('git', ['ls-remote', '--tags', `https://github.com/${repo}.git`], { ...process.env, GIT_TERMINAL_PROMPT: '0' });
  const latest = stableTagFromLsRemote(out);
  return { latest, notesUrl: `https://github.com/${repo}/releases/tag/${latest}` };
}

async function stableViaApi(repo: string): Promise<Found> {
  const get = async (url: string) => {
    const res = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 404) throw new Error('no stable tag yet (the stable channel has no release)');
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    return res.json() as Promise<unknown>;
  };
  const ref = (await get(`https://api.github.com/repos/${repo}/git/ref/tags/stable`)) as { object?: { sha?: unknown } };
  const sha = typeof ref.object?.sha === 'string' ? ref.object.sha : null;
  if (!sha) throw new Error('the stable tag has no commit');
  const tags = (await get(`https://api.github.com/repos/${repo}/tags?per_page=100`)) as Array<{ name?: unknown; commit?: { sha?: unknown } }>;
  let best: string | null = null;
  for (const t of Array.isArray(tags) ? tags : []) {
    if (typeof t.name === 'string' && RELEASE_TAG.test(t.name) && t.commit?.sha === sha && (!best || isNewer(t.name, best))) best = t.name;
  }
  const latest = requireTag(best, 'stable tag');
  return { latest, notesUrl: `https://github.com/${repo}/releases/tag/${latest}` };
}

function sources(url: string, channel: UpdateChannel): Array<{ name: string; run: () => Promise<Found> }> {
  const gh = GITHUB_API_LATEST.exec(url);
  const repo = gh ? `${gh[1]}/${gh[2]}` : null;
  if (channel === 'stable') {
    // A custom feed names one release; the stable tag lives on GitHub only.
    if (!repo) return [{ name: 'stable', run: async () => Promise.reject(new Error('the stable channel needs the GitHub release feed (NINEDEPLOY_UPDATE_CHECK_URL is a custom feed)')) }];
    return [
      { name: 'git', run: () => stableViaGit(repo) },
      { name: 'github-api', run: () => stableViaApi(repo) },
    ];
  }
  // A custom (non-GitHub) feed has no release page or git remote to fall back on.
  const list: Array<{ name: string; run: () => Promise<Found> }> = [
    { name: repo ? 'github-api' : 'feed', run: () => feedViaFetch(url) },
  ];
  if (repo) list.push({ name: 'release-page', run: () => releasePageViaFetch(repo) });
  list.push({ name: repo ? 'github-api via curl' : 'feed via curl', run: () => feedViaCurl(url) });
  if (repo) {
    list.push({ name: 'release-page via curl', run: () => releasePageViaCurl(repo) });
    list.push({ name: 'git', run: () => gitLsRemote(repo) });
  }
  return list;
}

async function probe(channel: UpdateChannel): Promise<UpdateCheckResult> {
  const failures: string[] = [];
  for (const source of sources(config.updateCheckUrl, channel)) {
    try {
      const found = await source.run();
      const good: LastGood = { ...found, checkedAt: new Date().toISOString(), source: source.name };
      saveLastGood(channel, good);
      const result = verdict(channel, good);
      cachedBy.set(channel, { result, at: Date.now(), isFailure: false });
      return result;
    } catch (err) {
      failures.push(`${source.name}: ${describeError(err)}`);
    }
  }
  const detail = failures.join(' | ').slice(0, DETAIL_MAX);
  log.warn(`every release source failed — ${detail}`);
  const previous = loadLastGood(channel);
  const result = previous ? verdict(channel, previous, { stale: true, detail }) : unknownResult(channel, 'unreachable', detail);
  cachedBy.set(channel, { result, at: Date.now(), isFailure: true });
  return result;
}

function refresh(channel: UpdateChannel): Promise<UpdateCheckResult> {
  let running = inflightBy.get(channel);
  if (!running) {
    running = probe(channel).finally(() => inflightBy.delete(channel));
    inflightBy.set(channel, running);
  }
  return running;
}

/**
 * Latest published release vs the running version. Never throws — the
 * dashboard must not break on an air-gapped host.
 *
 * r370 hardening, because one host showed "fetch failed" while `curl`
 * reached GitHub fine:
 *  - five sources, first answer wins: the API via fetch, the release page's
 *    redirect (no rate limit), both again via curl, then `git ls-remote` —
 *    the same sources install.sh itself resolves "latest" from;
 *  - the failure detail names the real cause (errno / TLS / rate limit);
 *  - the last successful answer is persisted under the data dir and served
 *    (stale: true) when every source fails, so the banner and the
 *    Update & Restart button survive a blip or a restart;
 *  - an expired success is served immediately while a background refresh
 *    runs; concurrent callers share one probe.
 */
export async function checkForUpdate(force = false, channel: UpdateChannel = 'release'): Promise<UpdateCheckResult> {
  if (config.updateCheckUrl === 'disabled') {
    const result = unknownResult(channel, 'disabled', 'NINEDEPLOY_UPDATE_CHECK_URL=disabled');
    cachedBy.set(channel, { result, at: Date.now(), isFailure: false });
    return result;
  }
  if (force) return refresh(channel);
  const cached = cachedBy.get(channel);
  if (!cached) {
    // Fresh process: answer from the persisted last success right away and
    // refresh behind it, instead of making the first dashboard load wait on
    // GitHub.
    const previous = loadLastGood(channel);
    if (!previous) return refresh(channel);
    void refresh(channel);
    return verdict(channel, previous);
  }

  const ttl = cached.isFailure ? FAILURE_CACHE_TTL_MS : CACHE_TTL_MS;
  if (Date.now() - cached.at < ttl) return cached.result;
  if (cached.isFailure) return refresh(channel);
  void refresh(channel);
  return cached.result;
}
