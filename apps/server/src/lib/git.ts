import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { simpleGit, type SimpleGit, type SimpleGitOptions } from 'simple-git';
import { type CloneTargetPin, curlResolveEntry, vetCloneTarget } from './gitEgress.js';

export interface CloneCreds {
  type?: string; // github | gitlab | gitea | custom
  token?: string; // PAT for HTTPS
  deployKey?: string; // SSH private key
}

/**
 * A commit-ish we are willing to hand to `git checkout` as an argv element.
 *
 * The value originates in a provider webhook payload, and git reads a
 * leading-dash operand as an option. The schema layer constrains the branch
 * (see `gitBranch`) but nothing validated the SHA, so the sink defends itself
 * — same pattern as `lib/probeUrl.ts`.
 */
const COMMIT_SHA_RE = /^[0-9a-fA-F]{7,64}$/;

function isSshUrl(url: string): boolean {
  return url.startsWith('git@') || url.startsWith('ssh://') || url.startsWith('ssh+git://');
}

/** Convert an HTTPS URL to its SSH form (git@host:path.git). */
function toSshUrl(url: string): string {
  const m = /^https?:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
  return m ? `git@${m[1]}:${m[2]}.git` : url;
}

/** The basic-auth userinfo `injectToken` puts in front of the host. */
function tokenUserinfo(token: string, type?: string): string {
  const user = type === 'gitlab' ? 'oauth2' : 'x-access-token';
  return `${user}:${encodeURIComponent(token)}@`;
}

/** Inject a token into an HTTPS URL as basic-auth userinfo. */
function injectToken(url: string, token: string, type?: string): string {
  const m = /^(https?:\/\/)([^/]+)(\/.*)$/.exec(url);
  if (!m) return url;
  return `${m[1]}${tokenUserinfo(token, type)}${m[2]}${m[3]}`;
}

/**
 * F576: `git submodule init` resolves a relative submodule URL against the
 * (tokenized) origin and persists the result in `.git/config` and in the
 * submodule's own `.git/modules/<name>/config` — copies the origin reset never
 * touches. Remove exactly the userinfo this checkout injected from every
 * config of the superproject and its (nested) submodule git dirs.
 */
function scrubInjectedUserinfo(dir: string, userinfo: string): void {
  const scrub = (file: string) => {
    if (!existsSync(file)) return;
    const text = readFileSync(file, 'utf8');
    if (text.includes(userinfo)) writeFileSync(file, text.split(`//${userinfo}`).join('//'));
  };
  const walk = (modulesDir: string) => {
    if (!existsSync(modulesDir)) return;
    for (const e of readdirSync(modulesDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const sub = path.join(modulesDir, e.name);
      // A submodule git dir has HEAD + config; a name with `/` is a plain
      // directory level above it.
      if (existsSync(path.join(sub, 'HEAD'))) {
        scrub(path.join(sub, 'config'));
        walk(path.join(sub, 'modules'));
      } else {
        walk(sub);
      }
    }
  };
  scrub(path.join(dir, '.git', 'config'));
  walk(path.join(dir, '.git', 'modules'));
}

/** Hide any embedded credentials before logging. */
function maskUrl(url: string): string {
  return url.replace(/\/\/[^/@]+@/, '//***@');
}

/** A remote URL with any userinfo removed and a trailing `.git`/slash dropped. */
function canonicalRemote(url: string): string {
  return url.trim().replace(/\/\/[^/@]+@/, '//').replace(/\/+$/, '').replace(/\.git$/, '');
}

/** Whether the checkout's current origin is (either form of) `repoUrl`. */
function sameRemote(current: string, repoUrl: string): boolean {
  const c = canonicalRemote(current);
  return c === canonicalRemote(repoUrl) || c === canonicalRemote(toSshUrl(repoUrl));
}

const MAX_SUBMODULE_DEPTH = 5;

/** Redirect hardening (r099) — on every git invocation. */
const NO_REDIRECTS = 'http.followRedirects=false';

/**
 * r622: never run a hook from a checkout. Clones do not copy hooks, but a
 * crafted submodule path (the CVE-2025-48384 class on an unpatched host git)
 * can write one; with hooksPath pointed at nothing, git never looks there.
 */
const NO_HOOKS = 'core.hooksPath=/dev/null';
/** simple-git refuses a core.hooksPath override unless told it is intended. */
const HOOKS_OPT_IN = { allowUnsafeHooksPath: true } as const;

/**
 * r355: `-c http.curloptResolve=<host>:<port>:<ip>` for a vetted remote, so
 * libcurl connects to the address the egress gate approved instead of
 * resolving the name again (DNS rebinding). One entry per host; git accepts
 * the key multiple times. Unknown to git < 2.37, which ignores it.
 */
function pinConfig(pin: CloneTargetPin | null): string[] {
  return pin ? [`http.curloptResolve=${curlResolveEntry(pin)}`] : [];
}

/**
 * r173: submodule URLs come from the repository's own `.gitmodules`, so they
 * are as attacker-controlled as the repo — and `git submodule update
 * --recursive` dialled them with no egress check (`url =
 * http://169.254.169.254/…` or `ssh://git@10.0.0.5/…` made the panel reach
 * internal hosts during checkout). Initialise one level at a time, gating
 * every URL first: relative URLs resolve against the already-vetted origin;
 * anything else must be a network form the egress gate understands.
 */
async function initSubmodules(
  git: SimpleGit,
  repoDir: string,
  sink: (line: string) => void,
  config: string[],
  depth = 0,
): Promise<void> {
  if (depth >= MAX_SUBMODULE_DEPTH || !existsSync(path.join(repoDir, '.gitmodules'))) return;
  let raw = '';
  try {
    // F577: `-z` (`<key>\n<value>\0`). The plain `<key> <value>` form is
    // ambiguous — names and values may both contain spaces, so a URL holding
    // ".path " parsed as a path entry and skipped the egress gate below.
    raw = await git.raw(['config', '-z', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.(url|path)$']);
  } catch {
    return; // no url/path entries at all
  }
  const paths: string[] = [];
  // r355: the pins of every level so far — relative submodule URLs resolve
  // against an already-pinned parent, absolute https ones add their own.
  const levelConfig = [...config];
  for (const entry of raw.split('\0')) {
    const nl = entry.indexOf('\n');
    const m = nl < 0 ? null : /\.(url|path)$/.exec(entry.slice(0, nl));
    if (!m) continue;
    const value = entry.slice(nl + 1).trim();
    if (m[1] === 'path') {
      paths.push(value);
      continue;
    }
    if (value.startsWith('./') || value.startsWith('../')) continue;
    if (!/^(https?:\/\/|ssh:\/\/|git:\/\/|[\w.-]+@[\w.-]+:)/i.test(value)) {
      throw new Error(`Refusing submodule URL with an unsupported transport: ${maskUrl(value).slice(0, 120)}`);
    }
    for (const entry of pinConfig(await vetCloneTarget(value))) {
      if (!levelConfig.includes(entry)) levelConfig.push(entry);
    }
  }
  if (depth === 0) sink('Initialising git submodules …');
  // `-c` settings reach the child clones `submodule update` spawns (git keeps
  // GIT_CONFIG_PARAMETERS for submodule processes), so the pins apply there.
  const updater = levelConfig.length === config.length ? git : simpleGit(repoDir, { config: levelConfig, unsafe: HOOKS_OPT_IN });
  // F576: the stored submodule URLs are scrubbed after every checkout; re-derive
  // them from the (vetted) `.gitmodules` and this run's origin before fetching.
  await updater.raw(['submodule', 'sync', '--quiet']);
  await updater.submoduleUpdate(['--init']);
  for (const rel of paths) {
    const subDir = path.resolve(repoDir, rel);
    if (!subDir.startsWith(path.resolve(repoDir) + path.sep)) continue;
    if (!existsSync(path.join(subDir, '.gitmodules'))) continue;
    await initSubmodules(simpleGit(subDir, { config: levelConfig, unsafe: HOOKS_OPT_IN }), subDir, sink, levelConfig, depth + 1);
  }
}

/**
 * r657: bounds for a checkout made only to INSPECT a repository (the Deploy
 * wizard's analysis, insights refresh). A deploy needs the full history and
 * submodules; an inspection reads a handful of files at the branch tip.
 */
export interface CheckoutLimits {
  /** Fresh clone at depth 1 of `branch` only, no tags, no submodules. */
  shallow?: boolean;
  /** Aborts every git process of this checkout (timeout / size watcher). */
  signal?: AbortSignal;
}

/**
 * Ensure `dir` is a checkout of `repoUrl` at `branch` (optionally pinned to
 * `sha`). Supports private repos via an HTTPS PAT or an SSH deploy key.
 */
export async function checkoutCommit(
  repoUrl: string,
  branch: string,
  sha: string | undefined,
  dir: string,
  sink: (line: string) => void,
  creds?: CloneCreds,
  limits?: CheckoutLimits,
): Promise<string> {
  if (sha !== undefined && !COMMIT_SHA_RE.test(sha)) {
    throw new Error(`Refusing to check out an invalid commit sha: ${sha.slice(0, 40)}`);
  }
  // Egress gate (see lib/gitEgress.ts): refuse private-network remotes before
  // any git operation starts. For http(s) it also returns the addresses it
  // vetted, which every git invocation below is pinned to (r355).
  const pin = await vetCloneTarget(repoUrl);
  const useKey = !!creds?.deployKey && (isSshUrl(repoUrl) || !creds?.token);
  // simple-git refuses `core.sshCommand` unless the caller opts in, because the
  // value is normally attacker-reachable. Here it is not: `keyFile` is derived
  // from the numeric service id under the server's own repos dir, and the rest
  // of the string is a literal. Scoping the opt-in to deploy-key checkouts
  // keeps every other git invocation under the default protections.
  //
  // Without this the feature is dead code — the config call throws, and the
  // checkout silently proceeds with no credentials.
  // `http.followRedirects=false` on EVERY git command (r099): the egress gate
  // above validates the URL's host once, but git follows the first HTTP
  // redirect by default — a public repo host answering `/info/refs` with
  // `302 → http://169.254.169.254/…` turned a checkout into a request from the
  // panel's network position. Cost: a renamed GitHub repo (301) must be
  // updated to its new URL instead of being followed.
  //
  // r355: `http.curloptResolve` pins the remote's hostname to the vetted
  // addresses for this checkout's clone/fetch/submodule runs — git no longer
  // resolves the name itself, so a rebinding DNS answer between the gate and
  // git's connect cannot redirect it. TLS still validates the hostname.
  const gitConfig = [NO_REDIRECTS, NO_HOOKS, ...pinConfig(pin)];
  const gitOptions: Partial<SimpleGitOptions> = {
    config: gitConfig,
    unsafe: { ...HOOKS_OPT_IN, ...(useKey ? { allowUnsafeSshCommand: true } : {}) },
    ...(limits?.signal ? { abort: limits.signal } : {}),
  };
  const keyFile = path.join(path.dirname(dir), `${path.basename(dir)}.sshkey`);

  const writeKey = () => {
    mkdirSync(path.dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, creds!.deployKey!, { mode: 0o600 });
  };
  // Host keys: accept-new against this checkout's own known_hosts, removed
  // with the key below — the same policy as node clones
  // (agentOps/gitCredential.ts). It used to be `StrictHostKeyChecking=no` +
  // `/dev/null`, which accepted any key on every connection; now a key that
  // changes between the clone and its submodule fetches is refused. The file
  // does not outlive the job, so a legitimately rotated host key never blocks
  // the next deploy (there is no operator surface to reset a pinned key).
  const knownHostsFile = `${keyFile}.known_hosts`;
  const sshCommand = `ssh -i "${keyFile}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="${knownHostsFile}"`;

  let git: SimpleGit | undefined;
  try {
    // r172: reuse the checkout only while it still points at `repoUrl`. With
    // no credential (or a deploy key) the origin was never reset, so after a
    // repoUrl change every deploy kept fetching and building the OLD
    // repository — the one the egress gate above did not just validate.
    let reuse = existsSync(path.join(dir, '.git'));
    if (reuse) {
      const current = await simpleGit(dir, gitOptions)
        .remote(['get-url', 'origin'])
        .catch(() => undefined);
      if (typeof current !== 'string' || !sameRemote(current, repoUrl)) {
        sink('Repository URL changed — re-cloning …');
        reuse = false;
      }
    }
    if (reuse) {
      git = simpleGit(dir, gitOptions);
      // Refresh auth so rotated credentials take effect.
      if (useKey) {
        writeKey();
        // NOT swallowed: a failure here means the deploy key never took effect
        // and the fetch below would run unauthenticated, which surfaces later
        // as a confusing "repository not found".
        await git.addConfig('core.sshCommand', sshCommand);
      } else if (creds?.token) {
        // NOT swallowed (same rule as core.sshCommand above): if the origin
        // URL never updates, the fetch below runs with the STALE stored
        // credential and fails far from the real cause.
        await git.remote(['set-url', 'origin', injectToken(repoUrl, creds.token, creds.type)]);
      }
      sink('Fetching latest…');
      // F576: submodules are fetched by initSubmodules after their URLs are
      // re-synced; an on-demand recursion here would use the scrubbed ones.
      await git.fetch(['--all', '--no-recurse-submodules']);
    } else {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });

      let cloneUrl = repoUrl;
      // r657: `branch` is schema-validated (no leading dash) before it gets here.
      const opts: string[] = limits?.shallow ? ['--depth', '1', '--single-branch', '--no-tags', '--branch', branch] : [];
      if (useKey) {
        writeKey();
        cloneUrl = toSshUrl(repoUrl);
        opts.push('--config', `core.sshCommand=${sshCommand}`);
        sink(`Cloning ${maskUrl(cloneUrl)} (SSH deploy key) …`);
      } else if (creds?.token) {
        cloneUrl = injectToken(repoUrl, creds.token, creds.type);
        sink(`Cloning ${maskUrl(repoUrl)} (access token) …`);
      } else {
        sink(`Cloning ${maskUrl(repoUrl)} …`);
      }
      await simpleGit(gitOptions).clone(cloneUrl, dir, opts);
      git = simpleGit(dir, gitOptions);
    }

    // r273: move to the fetched remote tip deterministically. This used to be
    // `checkout <branch>` + `pull origin <branch>` with the pull's failure
    // swallowed as "detached/empty remote" — so after a force-push (divergent
    // history) or a merge conflict, every deploy without a pinned sha built
    // the OLD local HEAD and reported success. Only a genuinely missing
    // remote ref falls back to the local branch; any other failure throws.
    const remoteRef = `refs/remotes/origin/${branch}`;
    const hasRemoteRef = await git
      .raw(['rev-parse', '--verify', '--quiet', `${remoteRef}^{commit}`])
      .then(
        (out) => out.trim() !== '',
        () => false,
      );
    if (hasRemoteRef) {
      // `-f` discards leftovers of earlier builds in this reused working
      // tree, so they can neither block nor survive the switch.
      await git.raw(['checkout', '-f', '-B', branch, remoteRef, '--']);
    } else {
      sink(`origin has no branch ${branch} — using the local checkout`);
      await git.checkout(branch);
    }
    if (sha) await git.checkout(sha);

    // Submodules: if the repo ships a `.gitmodules`, init + fetch them so
    // builds that reference submodule paths don't fail on empty directories.
    // r657: an inspection never recurses into submodules (each is another clone).
    if (!limits?.shallow) await initSubmodules(git, dir, sink, gitConfig);

    const resolved = (await git.raw(['log', '-1', '--format=%H'])).trim() || sha || '';
    sink(`Checked out ${resolved.slice(0, 7)} on ${branch}`);
    return resolved;
  } finally {
    // Security cleanup — never leave credentials on disk or in .git/config
    // after the checkout completes (or throws). Re-open the working copy
    // directly (git may be unset if the clone itself failed midway and left a
    // partially-initialized repo with the tokenized origin URL on disk).
    if (creds?.token) {
      const cleaner = git ?? (existsSync(path.join(dir, '.git')) ? simpleGit(dir) : null);
      if (cleaner) {
        // Reset origin to the tokenless URL so the access token does not persist
        // in .git/config (nor leak into later git error output).
        await cleaner.remote(['set-url', 'origin', repoUrl]).catch(() => undefined);
      }
      scrubInjectedUserinfo(dir, tokenUserinfo(creds.token, creds.type));
    }
    if (creds?.deployKey) {
      rmSync(keyFile, { force: true });
      rmSync(knownHostsFile, { force: true });
    }
  }
}
