import type { DB } from '@ninedeploy/db';
import { agentTransportSealed } from './agentClient.js';
import { type AgentCaller, gitCredentialRefusal } from './agentCapabilities.js';
import { redactGitOutput } from './cloneFailure.js';
import { redactSecrets } from './redactSecret.js';
import { cloneCredentialKind, STATIC_CREDENTIAL_REFUSAL } from './remoteDeploy.js';
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
 * scoped to one repository, so they keep the r268 refusal.
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
 *     unchanged), a static one (refused, r268), or a GitHub App;
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
    if (kind === 'static') throw new Error(STATIC_CREDENTIAL_REFUSAL);
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
