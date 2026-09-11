import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { simpleGit, type SimpleGit, type SimpleGitOptions } from 'simple-git';
import { assertCloneTargetAllowed } from './gitEgress.js';

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

/** Inject a token into an HTTPS URL as basic-auth userinfo. */
function injectToken(url: string, token: string, type?: string): string {
  const m = /^(https?:\/\/)([^/]+)(\/.*)$/.exec(url);
  if (!m) return url;
  const user = type === 'gitlab' ? 'oauth2' : 'x-access-token';
  return `${m[1]}${user}:${encodeURIComponent(token)}@${m[2]}${m[3]}`;
}

/** Hide any embedded credentials before logging. */
function maskUrl(url: string): string {
  return url.replace(/\/\/[^/@]+@/, '//***@');
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
): Promise<string> {
  if (sha !== undefined && !COMMIT_SHA_RE.test(sha)) {
    throw new Error(`Refusing to check out an invalid commit sha: ${sha.slice(0, 40)}`);
  }
  // Egress gate (see lib/gitEgress.ts): refuse private-network remotes before
  // any git operation starts.
  await assertCloneTargetAllowed(repoUrl);
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
  const gitOptions: Partial<SimpleGitOptions> = {
    config: ['http.followRedirects=false'],
    ...(useKey ? { unsafe: { allowUnsafeSshCommand: true } } : {}),
  };
  const keyFile = path.join(path.dirname(dir), `${path.basename(dir)}.sshkey`);

  const writeKey = () => {
    mkdirSync(path.dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, creds!.deployKey!, { mode: 0o600 });
  };
  const sshCommand = `ssh -i "${keyFile}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;

  let git: SimpleGit | undefined;
  try {
    if (existsSync(path.join(dir, '.git'))) {
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
      await git.fetch(['--all']);
    } else {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });

      let cloneUrl = repoUrl;
      const opts: string[] = [];
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

    await git.checkout(branch);
    try {
      await git.pull('origin', branch);
    } catch {
      /* detached/empty remote is fine */
    }
    if (sha) await git.checkout(sha);

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
    }
    if (creds?.deployKey) {
      rmSync(keyFile, { force: true });
    }
  }
}
