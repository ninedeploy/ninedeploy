import type { CloneCreds } from './git.js';
import { HttpError } from './errors.js';
import { EgressBlockedError } from './egressGuard.js';

/**
 * F1012: the clone-failure classifier, shared by the analysis routes
 * (modules/insights.ts, F1006/F1009) and the deploy pipeline. It lives apart
 * from lib/git.ts on purpose: tests that mock git.ts wholesale would
 * otherwise lose it.
 */

/** A repository URL safe to repeat to the client: userinfo removed. */
export function displayRepoUrl(repoUrl: string): string {
  try {
    const url = new URL(repoUrl);
    url.username = '';
    url.password = '';
    return url.toString().slice(0, 200);
  } catch {
    return repoUrl.replace(/\/\/[^/@]+@/, '//').slice(0, 200);
  }
}

/** git's stderr for a log, with any credential this checkout used removed. */
export function redactGitOutput(text: string, creds: CloneCreds | undefined): string {
  let out = text.replace(/\/\/[^/@\s'"]+@/g, '//***@');
  const token = creds?.token;
  if (token) {
    for (const piece of [encodeURIComponent(token), token]) out = out.split(piece).join('[redacted]');
  }
  return out.slice(0, 2000);
}

export interface ClassifiedCloneFailure {
  code: 'branch_not_found' | 'repo_unreachable';
  /** A fixed reason class — never git's own text. */
  reason: string;
  /** What to do. Built from constants and the branch name only. */
  advice: string;
  /** The failing clone was a submodule of the repository. */
  submodule: boolean;
}

/** Classes the analysis message has always printed without a "(reason: …)" part. */
export const UNNAMED_IN_ANALYSIS = new Set(['branch not found', 'HTTP redirect']);

/**
 * F1006/F1009: classify a failed clone from git's own stderr (simple-git puts
 * it in the error message) into a reason class and advice. Nothing git printed
 * is repeated. Anything unrecognised is returned as null and keeps its
 * previous handling.
 */
export function classifyCloneFailure(err: unknown, branch: string, creds: CloneCreds | undefined, repoUrl: string): ClassifiedCloneFailure | null {
  if (!(err instanceof Error) || err instanceof HttpError || err instanceof EgressBlockedError) return null;
  const text = err.message;
  const submodule = /into submodule path/i.test(text);
  // F1012: a deploy (no --branch clone) fails on the checkout instead: "pathspec '<branch>' did not match".
  if (/Remote branch .+ not found in upstream|Could not find remote branch/i.test(text) || text.includes(`pathspec '${branch}' did not match`)) {
    return {
      code: 'branch_not_found',
      reason: 'branch not found',
      advice: `branch "${branch}" does not exist in the repository. Pick an existing branch.`,
      submodule,
    };
  }
  if (/returned error: 30[1278]\b/i.test(text)) {
    return {
      code: 'repo_unreachable',
      reason: 'HTTP redirect',
      advice: 'the Git host answered with a redirect, which NineDeploy does not follow. If the repository was renamed or moved, use its current URL.',
      submodule,
    };
  }
  if (
    /repository '[^']*' not found|Repository not found|Authentication failed|could not read (Username|Password)|terminal prompts disabled|Invalid username or (password|token)|HTTP Basic: Access denied|returned error: 40[134]\b|Permission denied \(publickey|Could not read from remote repository|could not be found or you don't have permission/i.test(
      text,
    )
  ) {
    // F1009: a fixed reason class (never git's own text) so the user can tell
    // "the credential was refused" from "the repository is invisible to it".
    const reason = /returned error: 403\b/i.test(text)
      ? 'HTTP 403 (permission denied)'
      : /Authentication failed|could not read (Username|Password)|terminal prompts disabled|Invalid username or (password|token)|HTTP Basic: Access denied|returned error: 401\b|Permission denied \(publickey/i.test(text)
        ? 'authentication failed'
        : 'repository not found or no access';
    if (!creds?.token && !creds?.deployKey) {
      return {
        code: 'repo_unreachable',
        reason,
        advice: 'the repository was not found, or it is private — select a Git credential that has access to it.',
        submodule,
      };
    }
    const detail =
      reason === 'authentication failed'
        ? 'the Git host refused the selected credential (an expired, revoked or mistyped token, or a deploy key it does not accept).'
        : reason === 'HTTP 403 (permission denied)'
          ? 'the selected credential was accepted but denied access to this repository.'
          : 'the repository was not found or the selected credential has no access to it.';
    const github =
      !!creds.token && reason !== 'authentication failed' && (creds.type === 'github' || /^https?:\/\/(www\.)?github\.com\//i.test(displayRepoUrl(repoUrl)));
    return {
      code: 'repo_unreachable',
      reason,
      advice: `${detail}${
        github
          ? " For a fine-grained GitHub token, add this repository to the token's repository access; fine-grained tokens also need Contents: Read-only (organization repositories may also need the token approved or SSO-authorized). A classic token needs the repo scope."
          : ''
      }`,
      submodule,
    };
  }
  // Not a bare "unable to access": git also says that for an HTTP 5xx, where the host WAS reached.
  if (/Could not resolve host|Failed to connect|Could not connect to server|Connection (timed out|refused|reset)|SSL certificate problem|certificate verif|\bSSL\b.*(connect|handshake)|schannel|Host key verification failed|Could not resolve hostname|Network is unreachable/i.test(text)) {
    const reason = /SSL certificate problem|certificate verif|\bSSL\b.*(connect|handshake)|schannel|Host key verification failed/i.test(text)
      ? 'TLS or host-key verification failed'
      : 'could not resolve/connect';
    return { code: 'repo_unreachable', reason, advice: 'the Git host could not be reached from the panel (DNS, network or TLS failure).', submodule };
  }
  return null;
}
