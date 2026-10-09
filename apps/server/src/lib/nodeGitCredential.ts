import { eq } from 'drizzle-orm';
import { type DB, sources } from '@ninedeploy/db';
import { agentTransportSealed } from './agentClient.js';
import { type AgentCaller, capabilityRefusal, gitCredentialRefusal } from './agentCapabilities.js';
import { redactGitOutput } from './cloneFailure.js';
import { providerErrorText, redactSecrets } from './redactSecret.js';
import { cloneCredentialKind, STATIC_CREDENTIAL_REFUSAL, staticClonePlan, staticCredentialFeature } from './remoteDeploy.js';
import { type CloneCredsTarget, resolveCloneCreds } from './sourceCreds.js';

/**
 * 0.13 (T5): a GitHub App repository checked out on a remote node.
 *
 * The node used to clone anonymously, so every credentialed repository was
 * refused there (r268). A GitHub App needs no long-lived secret on the node:
 * per job the panel mints a `contents: read` installation token scoped to the
 * one repository, hands it to the node's `git.ensure` / `git.fetch` /
 * `git.reset` inside the sealed envelope, and revokes it once the checkout is
 * done — whatever happened. The agent applies it only through git's
 * environment (see `gitCredentialEnv` in agent.ts).
 *
 * PAT and deploy-key sources stay on the panel: they are long-lived and not
 * scoped to one repository, so they keep the r268 refusal — unless the
 * operator allows that source on nodes (multi-node, `sources.allow_on_nodes`,
 * step-up gated; see `staticSession` below).
 */

/** The basic-auth user name GitHub expects with an installation token. */
export const GIT_CREDENTIAL_USERNAME = 'x-access-token';

/** The agent ops that reach the repository's remote, and so carry the credential. */
const CREDENTIAL_OPS: ReadonlySet<string> = new Set(['git.ensure', 'git.fetch', 'git.reset']);

/** One job's git access to a node: agent calls, plus the cleanup that must run. */
export interface NodeGitSession {
  /** Run one `git.*` agent op — with the job's credential on the ops that need it. */
  git: AgentCaller;
  /** Revoke the job's token (no-op for an anonymous session). Never throws; idempotent. */
  release: () => Promise<void>;
}

/** Opens the session for one job on one node. Bound to the service by {@link nodeGitCredentialSource}. */
export type NodeGitCredentialSource = (
  agent: AgentCaller,
  node: { label: string; serverId: number | null },
) => Promise<NodeGitSession>;

/** Today's behaviour: every call is exactly the agent call it always was. */
function anonymousSession(agent: AgentCaller): NodeGitSession {
  return { git: agent, release: async () => undefined };
}

/**
 * The credential source for one service's node jobs. Per job it:
 *
 *  1. decides which credential the panel would clone with — none (anonymous,
 *     unchanged), a static one (refused, r268, unless its source allows it
 *     on nodes), or a GitHub App;
 *  2. for an App, refuses unless the node's agent advertises `git.credential`
 *     and is reached over the sealed transport — BEFORE anything is minted;
 *  3. mints a fresh repository-scoped `contents: read` token (never cached,
 *     so revoking it cannot cut off another job sharing it);
 *  4. returns a session that adds `credential` (and the repository URL that
 *     scopes it on the node) to the network git ops, redacts the token from
 *     every output line and error, and revokes it on `release`.
 */
export function nodeGitCredentialSource(db: DB, target: CloneCredsTarget): NodeGitCredentialSource {
  return async (agent, node) => {
    const kind = await cloneCredentialKind(db, target);
    if (kind === 'none') return anonymousSession(agent);
    if (kind === 'static') return staticSession(db, target, agent, node);
    const sealed = node.serverId == null ? false : await agentTransportSealed(db, node.serverId);
    const refusal = await gitCredentialRefusal(agent, node.label, sealed);
    if (refusal) throw new Error(refusal);

    const creds = await resolveCloneCreds(db, target, { perJob: true });
    if (creds?.type !== 'github_app' || !creds.token) {
      // The link or source changed since step 1: re-apply the r268 rule to
      // what the panel would clone with NOW.
      if (creds && creds.type !== 'registry' && (creds.token || creds.deployKey)) {
        await creds.revoke?.();
        throw new Error(STATIC_CREDENTIAL_REFUSAL);
      }
      return anonymousSession(agent);
    }

    const token = creds.token;
    const basic = Buffer.from(`${GIT_CREDENTIAL_USERNAME}:${token}`, 'utf8').toString('base64');
    const redact = (text: string): string => redactGitOutput(redactSecrets(text, [basic]), creds);
    const credential = { username: GIT_CREDENTIAL_USERNAME, password: token };
    let released = false;
    return {
      git: async (op, params, sink) => {
        if (released) throw new Error(`agent ${op}: the job's GitHub App token was already revoked`);
        const sent = CREDENTIAL_OPS.has(op)
          ? { ...params, url: typeof params['url'] === 'string' ? params['url'] : (target.repoUrl ?? ''), credential }
          : params;
        try {
          return await agent(op, sent, (line) => sink(redact(line)));
        } catch (err) {
          throw new Error(redact(err instanceof Error ? err.message : String(err)));
        }
      },
      release: async () => {
        if (released) return;
        released = true;
        await creds.revoke?.().catch(() => false);
      },
    };
  };
}

// ── static credentials on nodes (multi-node, design §3.2, owner decision O5) ──

/** What the agent accepts as a basic-auth secret (agentOps/gitCredential.ts `RE_CRED_SECRET`). */
const RE_AGENT_SECRET = /^[\x21-\x7e]{1,4096}$/;

/** lib/git.ts `tokenUserinfo`: the user name the panel itself clones with, so a node clones exactly as the panel does. */
export function staticTokenUsername(sourceType: string | undefined): string {
  return sourceType === 'gitlab' ? 'oauth2' : GIT_CREDENTIAL_USERNAME;
}

/**
 * A PAT or deploy key for one job on one node — only for a source with
 * `allow_on_nodes` on, after the same checks as queue time (host check, the
 * agent's `git.sshkey` over the sealed transport, the node's kill switch):
 *   - a PAT travels like an App token, `{username, password, static: true}`
 *     on git.ensure / git.fetch / git.reset (the agent applies it through
 *     git's environment and refuses it when its owner switched static
 *     credentials off). Nothing to revoke: `release` only closes the session.
 *   - a deploy key wraps those three ops in `git.withKey`: the agent keeps the
 *     key in `/dev/shm` for that one call only.
 * The secret is redacted from every line and error the session returns.
 */
async function staticSession(
  db: DB,
  target: CloneCredsTarget,
  agent: AgentCaller,
  node: { label: string; serverId: number | null },
): Promise<NodeGitSession> {
  const src = target.sourceId == null ? undefined : await db.query.sources.findFirst({ where: eq(sources.id, target.sourceId) });
  if (!src?.allowOnNodes) throw new Error(STATIC_CREDENTIAL_REFUSAL);
  const plan = staticClonePlan(src, target.repoUrl ?? '');
  if ('refusal' in plan) throw new Error(plan.refusal);
  const sealed = node.serverId == null ? false : await agentTransportSealed(db, node.serverId);
  const refusal = await capabilityRefusal(agent, node.label, sealed, {
    cap: 'git.sshkey',
    feature: staticCredentialFeature(plan.mode),
    sealedRequired: true,
  });
  if (refusal) throw new Error(refusal.message);

  const creds = await resolveCloneCreds(db, target, { perJob: true });
  const secret = plan.mode === 'key' ? creds?.deployKey : creds?.token;
  if (!creds || creds.type === 'github_app' || !secret) {
    // The source changed since the check above: never guess.
    await creds?.revoke?.().catch(() => false);
    throw new Error("The repository's Git credential changed while the deployment was starting; deploy again.");
  }

  let released = false;
  const guard = (op: string) => {
    if (released) throw new Error(`agent ${op}: the job's Git credential session is already closed`);
  };
  if (plan.mode === 'token') {
    if (!RE_AGENT_SECRET.test(secret)) {
      throw new Error('The access token holds characters a node cannot send in an HTTP header (spaces or control characters); build on the panel instead.');
    }
    const username = staticTokenUsername(creds.type);
    const basic = Buffer.from(`${username}:${secret}`, 'utf8').toString('base64');
    const redact = (text: string): string => redactGitOutput(redactSecrets(text, [basic, secret]), creds);
    const credential = { username, password: secret, static: true };
    return {
      git: async (op, params, sink) => {
        guard(op);
        const sent = CREDENTIAL_OPS.has(op) ? { ...params, url: plan.url, credential } : params;
        try {
          return await agent(op, sent, (line) => sink(redact(line)));
        } catch (err) {
          throw new Error(redact(err instanceof Error ? err.message : String(err)));
        }
      },
      release: async () => {
        released = true;
      },
    };
  }

  const redact = (text: string): string => providerErrorText(text, secret);
  // accept-new against the job's own known_hosts (never `StrictHostKeyChecking=no`
  // on a node, unlike the panel's own lib/git.ts path).
  const key = { privateKey: secret, hostKeyPolicy: 'accept-new' as const };
  return {
    git: async (op, params, sink) => {
      guard(op);
      const out = (line: string) => sink(redact(line));
      try {
        if (!CREDENTIAL_OPS.has(op)) return await agent(op, params, out);
        return await agent('git.withKey', { op, params: { ...params, url: plan.url }, key }, out);
      } catch (err) {
        throw new Error(redact(err instanceof Error ? err.message : String(err)));
      }
    },
    release: async () => {
      released = true;
    },
  };
}
