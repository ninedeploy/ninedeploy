import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type Provider = 'github' | 'gitlab' | 'gitea' | 'bitbucket';

export interface PushEvent {
  branch: string;
  sha: string;
  message: string;
  author: string;
  repoUrl?: string;
  /** Paths added/modified/removed across the push (drives watch-path filtering). */
  changedFiles: string[];
  /** How many commits the payload listed. GitHub caps this at ~20 for big
   *  pushes, so `>= COMMIT_LIST_CAP` means the file list may be INCOMPLETE —
   *  watch-path filtering must fail open rather than silently skip. */
  commitsListed: number;
}

/** Constant-time comparison of two hex/base64 strings. */
function safeEqual(a: string, b: string): boolean {
  // Hash both sides first so even raw-token providers (GitLab) always compare
  // equal-length buffers. Returning early on length exposed the secret's
  // length through a measurable timing difference.
  const ab = createHash('sha256').update(a).digest();
  const bb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ab, bb);
}

function hmac(secret: string, body: string, digest: 'hex' | 'base64'): string {
  return createHmac('sha256', secret).update(body).digest(digest);
}

/**
 * Detect the provider from request headers and verify the signature/token.
 * Returns the provider when valid, otherwise null.
 */
export function verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string, secret: string): Provider | null {
  const h = (k: string) => {
    const v = headers[k];
    return typeof v === 'string' ? v : undefined;
  };

  // GitHub
  if (h('x-github-event')) {
    const sig = h('x-hub-signature-256');
    if (!sig?.startsWith('sha256=')) return null;
    const expected = `sha256=${hmac(secret, rawBody, 'hex')}`;
    return safeEqual(sig, expected) ? 'github' : null;
  }

  // Gitea (GitHub-compatible payload, hex HMAC)
  if (h('x-gitea-event') || h('x-gitea-signature')) {
    const sig = h('x-gitea-signature');
    if (!sig) return null;
    return safeEqual(sig, hmac(secret, rawBody, 'hex')) ? 'gitea' : null;
  }

  // GitLab (token sent directly in a header)
  if (h('x-gitlab-event') || h('x-gitlab-token')) {
    const token = h('x-gitlab-token');
    if (!token) return null;
    return safeEqual(token, secret) ? 'gitlab' : null;
  }

  // Bitbucket Cloud (X-Event-Key + X-Hub-Signature: sha256=<hex hmac>)
  if (h('x-event-key')) {
    const sig = h('x-hub-signature');
    if (!sig?.startsWith('sha256=')) return null;
    const expected = `sha256=${hmac(secret, rawBody, 'hex')}`;
    return safeEqual(sig, expected) ? 'bitbucket' : null;
  }

  return null;
}

/** Whether this request is a provider "ping" (no deploy action needed). */
export function isPing(headers: Record<string, string | string[] | undefined>, provider: Provider): boolean {
  const h = (k: string) => {
    const v = headers[k];
    return typeof v === 'string' ? v : undefined;
  };
  if (provider === 'github' || provider === 'gitea') return h('x-github-event') === 'ping' || h('x-gitea-event') === 'ping';
  if (provider === 'bitbucket') return h('x-event-key') === 'diagnostics:ping';
  return h('x-gitlab-event') === 'Ping Hook';
}

// ── Delivery replay window ─────────────────────────────────────────────────
// The HMAC covers only the body — providers sign no timestamp, so a captured
// (still-valid) payload can be replayed much later to redeploy an old commit;
// the deployment-status dedup only covers SHAs currently queued/building.
// Providers stamp every delivery with a unique id; remembering those ids for
// a window closes most of the replay surface. In-memory is a deliberate
// mitigation rather than a guarantee: a panel restart clears it.
const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const REPLAY_MAP_SOFT_CAP = 10_000;
const seenDeliveries = new Map<string, number>();

function deliveryId(headers: Record<string, string | string[] | undefined>, provider: Provider): string | null {
  const h = (k: string) => {
    const v = headers[k];
    return typeof v === 'string' ? v : undefined;
  };
  if (provider === 'github') return h('x-github-delivery') ?? null;
  if (provider === 'gitea') return h('x-gitea-delivery') ?? null;
  if (provider === 'bitbucket') return h('x-request-uuid') ?? null;
  return h('x-gitlab-uuid') ?? null;
}

/**
 * True when this delivery id was already accepted inside the replay window.
 * Absent ids (older providers, hand-rolled senders) fail OPEN — the HMAC
 * remains the primary authentication.
 */
export function isReplayedDelivery(headers: Record<string, string | string[] | undefined>, provider: Provider): boolean {
  const id = deliveryId(headers, provider);
  if (!id) return false;
  const now = Date.now();
  if (seenDeliveries.size > REPLAY_MAP_SOFT_CAP) {
    for (const [k, at] of seenDeliveries) {
      if (now - at > REPLAY_WINDOW_MS) seenDeliveries.delete(k);
    }
    // Still oversized (a flood of unique ids): evict oldest-first. Map
    // iteration is insertion order, so this bounds memory deterministically.
    let excess = seenDeliveries.size - REPLAY_MAP_SOFT_CAP;
    if (excess > 0) {
      for (const k of seenDeliveries.keys()) {
        if (excess-- <= 0) break;
        seenDeliveries.delete(k);
      }
    }
  }
  const seenAt = seenDeliveries.get(id);
  seenDeliveries.set(id, now);
  return seenAt !== undefined;
}

/** Collect added/modified/removed paths from a commits array. */
function changedFilesFrom(commits: Array<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const c of commits) {
    for (const key of ['added', 'modified', 'removed'] as const) {
      const list = c[key];
      if (Array.isArray(list)) {
        for (const f of list) if (typeof f === 'string') out.push(f);
      }
    }
  }
  return out;
}

/** Parse a push payload into the fields the deploy pipeline needs. */
export function parsePush(body: unknown, provider: Provider): PushEvent | null {
  const b = body as Record<string, unknown>;
  // A JSON body of literal `null` arrives here from the public receiver
  // (Fastify parses it to null); same contract as parsePullRequest below.
  if (!b) return null;

  // Bitbucket FIRST: its repo:push payload has NO `ref`/`after` at all — the
  // common GitHub-shape checks below would null it out before its own branch.
  if (provider === 'bitbucket') {
    // Bitbucket's repo:push payload has NO `ref` and NO per-commit file
    // lists — branch/hash live under push.changes[].new.target. An empty
    // changedFiles list is the documented contract for watch-path filtering
    // to FAIL OPEN (the pipeline deploys unfiltered).
    const pushBb = b['push'] as Record<string, unknown> | undefined;
    const changes = (pushBb?.['changes'] as Array<Record<string, unknown>> | undefined) ?? [];
    const change = changes.find((c) => {
      const created = c['new'] as Record<string, unknown> | undefined;
      return created && typeof created === 'object' && created['type'] === 'branch';
    });
    const created = change?.['new'] as Record<string, unknown> | undefined;
    const target = created?.['target'] as Record<string, unknown> | undefined;
    const bbBranch = String(created?.['name'] ?? '');
    const sha = String(target?.['hash'] ?? '');
    if (!bbBranch || !sha) return null;
    const repo = b['repository'] as Record<string, unknown> | undefined;
    const fullName = String(repo?.['full_name'] ?? '');
    return {
      branch: bbBranch,
      sha,
      message: String(target?.['message'] ?? '').trim(),
      author: String((target?.['author'] as Record<string, unknown> | undefined)?.['raw'] ?? ''),
      repoUrl: fullName ? `https://bitbucket.org/${fullName}.git` : undefined,
      changedFiles: [],
      commitsListed: 0,
    };
  }

  // Branch/tag DELETION pushes are not deployable: GitHub/Gitea send
  // `deleted: true` with an all-zero `after` and a null head_commit; GitLab
  // sends the all-zero `after` with no commits (already filtered below).
  // Unguarded, the event parsed into a deploy with a NULL commitSha, which
  // engine/pipeline.ts resolves to checkoutCommit(service.branch) — a ref
  // that no longer exists — so deleting the tracked branch always produced
  // a spurious failing deployment. A real commit SHA is never all zeros.
  const after = typeof b['after'] === 'string' ? b['after'] : '';
  if (b['deleted'] === true || /^0+$/.test(after)) return null;
  const ref = typeof b['ref'] === 'string' ? (b['ref'] as string) : '';
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
  if (!branch) return null;

  if (provider === 'gitlab') {
    const commits = (b['commits'] as Array<Record<string, unknown>> | undefined) ?? [];
    const last = commits[commits.length - 1];
    if (!last) return null;
    const author = (last['author'] as Record<string, unknown> | undefined)?.['name'];
    const project = b['project'] as Record<string, unknown> | undefined;
    return {
      branch,
      sha: String(last['id'] ?? ''),
      message: String(last['message'] ?? ''),
      author: String(author ?? ''),
      repoUrl: typeof project?.['git_http_url'] === 'string' ? (project['git_http_url'] as string) : undefined,
      changedFiles: changedFilesFrom(commits),
      commitsListed: commits.length,
    };
  }

  // GitHub & Gitea share the same shape.
  const head = (b['head_commit'] as Record<string, unknown> | undefined) ?? {};
  const author = (head['author'] as Record<string, unknown> | undefined);
  const repo = (b['repository'] as Record<string, unknown> | undefined);
  const commits = (b['commits'] as Array<Record<string, unknown>> | undefined) ?? [];
  const withHead = [...commits, ...(Object.keys(head).length > 0 ? [head] : [])];
  return {
    branch,
    sha: String(head['id'] ?? ''),
    message: String(head['message'] ?? ''),
    author: String(author?.['username'] ?? ''),
    repoUrl: typeof repo?.['clone_url'] === 'string' ? (repo['clone_url'] as string) : undefined,
    changedFiles: changedFilesFrom(withHead),
    commitsListed: withHead.length,
  };
}

export interface PullRequestEvent {
  action: 'opened' | 'synchronize' | 'reopened' | 'closed';
  prNumber: number;
  branch: string;
  sha: string;
  title: string;
  author: string;
  repoUrl?: string;
  merged?: boolean;
}

/** Whether this request is a pull request / merge request event. */
export function isPullRequest(headers: Record<string, string | string[] | undefined>, provider: Provider): boolean {
  const h = (k: string) => (typeof headers[k] === 'string' ? headers[k] : undefined);
  if (provider === 'github' || provider === 'gitea') {
    return h('x-github-event') === 'pull_request' || h('x-gitea-event') === 'pull_request';
  }
  if (provider === 'bitbucket') return (h('x-event-key') ?? '').startsWith('pullrequest:');
  return h('x-gitlab-event') === 'Merge Request Hook';
}

/** Parse a pull request / merge request payload into structured fields. */
export function parsePullRequest(body: unknown, provider: Provider): PullRequestEvent | null {
  const b = body as Record<string, unknown>;
  if (!b) return null;

  if (provider === 'bitbucket') {
    const pr = b['pullrequest'] as Record<string, unknown> | undefined;
    if (!pr) return null;
    const key = String(b['event_key'] ?? '');
    const action: PullRequestEvent['action'] =
      key === 'pullrequest:fulfilled' || key === 'pullrequest:rejected'
        ? 'closed'
        : key === 'pullrequest:updated'
          ? 'synchronize'
          : 'opened';
    const source = pr['source'] as Record<string, unknown> | undefined;
    const sourceBranch = source?.['branch'] as Record<string, unknown> | undefined;
    const sourceCommit = source?.['commit'] as Record<string, unknown> | undefined;
    const author = pr['author'] as Record<string, unknown> | undefined;
    const repo = b['repository'] as Record<string, unknown> | undefined;
    const fullName = String(repo?.['full_name'] ?? '');
    const prNumber = Number(pr['id']) || 0;
    const branch = String(sourceBranch?.['name'] ?? '');
    if (!prNumber || !branch) return null;
    return {
      action,
      prNumber,
      branch,
      sha: String(sourceCommit?.['hash'] ?? ''),
      title: String(pr['title'] ?? ''),
      author: String(author?.['display_name'] ?? ''),
      repoUrl: fullName ? `https://bitbucket.org/${fullName}.git` : undefined,
      merged: key === 'pullrequest:fulfilled',
    };
  }

  if (provider === 'gitlab') {
    const attrs = b['object_attributes'] as Record<string, unknown> | undefined;
    if (!attrs) return null;
    const rawAction = String(attrs['action'] ?? '');
    let action: PullRequestEvent['action'] = 'opened';
    if (rawAction === 'close' || rawAction === 'merge') action = 'closed';
    else if (rawAction === 'update') action = 'synchronize';
    else if (rawAction === 'reopen') action = 'reopened';
    else if (rawAction === 'open') action = 'opened';
    else return null;

    const prNumber = Number(attrs['iid']) || 0;
    const branch = String(attrs['source_branch'] ?? '');
    const lastCommit = attrs['last_commit'] as Record<string, unknown> | undefined;
    const sha = String(lastCommit?.['id'] ?? attrs['last_commit_id'] ?? '');
    const title = String(attrs['title'] ?? '');
    const author = String((attrs['author'] as Record<string, unknown> | undefined)?.['name'] ?? (lastCommit?.['author'] as Record<string, unknown> | undefined)?.['name'] ?? '');
    const project = b['project'] as Record<string, unknown> | undefined;
    const repoUrl = typeof project?.['git_http_url'] === 'string' ? (project['git_http_url'] as string) : undefined;
    if (!prNumber || !branch) return null;
    return {
      action,
      prNumber,
      branch,
      sha,
      title,
      author,
      repoUrl,
      merged: rawAction === 'merge',
    };
  }

  // GitHub & Gitea
  const rawAction = String(b['action'] ?? '');
  let action: PullRequestEvent['action'] = 'opened';
  if (rawAction === 'closed') action = 'closed';
  else if (rawAction === 'synchronize') action = 'synchronize';
  else if (rawAction === 'reopened') action = 'reopened';
  else if (rawAction === 'opened') action = 'opened';
  else return null;

  const pr = b['pull_request'] as Record<string, unknown> | undefined;
  if (!pr) return null;
  const prNumber = Number(b['number'] || pr['number']) || 0;
  const head = pr['head'] as Record<string, unknown> | undefined;
  const branch = String(head?.['ref'] ?? '');
  const sha = String(head?.['sha'] ?? '');
  const title = String(pr['title'] ?? '');
  const user = pr['user'] as Record<string, unknown> | undefined;
  const author = String(user?.['login'] ?? '');
  const headRepo = head?.['repo'] as Record<string, unknown> | undefined;
  const repoUrl = typeof headRepo?.['clone_url'] === 'string' ? (headRepo['clone_url'] as string) : undefined;
  const merged = Boolean(pr['merged']);
  if (!prNumber || !branch) return null;

  return {
    action,
    prNumber,
    branch,
    sha,
    title,
    author,
    repoUrl,
    merged,
  };
}
