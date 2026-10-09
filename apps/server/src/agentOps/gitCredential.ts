import { isRepoUrl, type Params, str, validated } from './operands.js';

/**
 * The node agent's per-job Git credential (0.13, T5), moved out of agent.ts
 * unchanged by the multi-node transport work (design §9 M8) so private-clone
 * credentials grow here, not in the agent's hot spot. agent.ts re-exports
 * {@link gitCredentialEnv}; behaviour is byte-identical to 0.15.
 */

/**
 * 0.13 (T5): the ops that accept a per-job Git credential — the three that
 * reach the repository's remote. Any other op carrying one is refused, so a
 * credential is never silently dropped (or applied where nobody looked).
 */
const GIT_CREDENTIAL_OPS: ReadonlySet<string> = new Set(['git.ensure', 'git.fetch', 'git.reset']);
/** `x-access-token` for a GitHub App token; a basic-auth user name never holds `:`. */
const RE_CRED_USER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Printable ASCII without space: no CR/LF/NUL can reach a header, even before base64. */
const RE_CRED_SECRET = /^[\x21-\x7e]{1,4096}$/;

/** What a validated credential becomes: child-process env, plus the redactor for its output. */
export interface GitCredentialEnv {
  env: Record<string, string>;
  redact: (line: string) => string;
}

/**
 * 0.13 (T5): a per-job Git credential, applied ONLY through the child's
 * environment (`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`,
 * git ≥ 2.31). It never becomes an argv element (the node's process list),
 * a `.git/config` line (the workspace outlives the job) or an output line.
 *
 * The header is scoped with `http.<scheme>://<host>/.extraheader`, so git
 * sends it to the repository's own origin and nowhere else — and every
 * network git op already runs with `http.followRedirects=false`.
 *
 * Refused unless the request arrived SEALED: on the legacy plaintext path the
 * token would have crossed the network in clear. Null when the op carries no
 * credential (today's behaviour, and what every older panel sends).
 */
export function gitCredentialEnv(
  op: string,
  params: Params,
  sealed: boolean,
  baseEnv: NodeJS.ProcessEnv = process.env,
): GitCredentialEnv | null {
  const raw = params['credential'];
  if (raw === undefined) return null;
  if (!GIT_CREDENTIAL_OPS.has(op)) throw new Error(`Invalid params: ${op} takes no Git credential`);
  if (!sealed) {
    throw new Error('Refusing a Git credential sent over the unencrypted transport: it is accepted only inside a sealed request');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) {
    throw new Error('Invalid git credential');
  }
  const keys = Object.keys(raw);
  if (keys.length !== 2 || !keys.includes('username') || !keys.includes('password')) throw new Error('Invalid git credential');
  const { username, password } = raw as Record<string, unknown>;
  if (typeof username !== 'string' || !RE_CRED_USER.test(username) || typeof password !== 'string' || !RE_CRED_SECRET.test(password)) {
    throw new Error('Invalid git credential');
  }
  // The header's scope comes from the repository URL the op names (git.fetch
  // and git.reset carry it only for this). HTTP(S) only, with no userinfo of
  // its own — a basic-auth header means nothing to an SSH remote.
  const url = validated(str(params, 'url'), isRepoUrl, 'repo url');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid repo url');
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password || !parsed.host) {
    throw new Error('Invalid repo url: a Git credential needs a plain http(s) repository URL');
  }
  const encoded = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  // Append after any GIT_CONFIG_* entries the node's own environment sets.
  const prior = Number(baseEnv['GIT_CONFIG_COUNT'] ?? '0');
  const index = Number.isInteger(prior) && prior >= 0 && prior < 1000 ? prior : 0;
  const secrets = [...new Set([`basic ${encoded}`, encoded, password, encodeURIComponent(password)])].sort((a, b) => b.length - a.length);
  return {
    env: {
      GIT_CONFIG_COUNT: String(index + 1),
      [`GIT_CONFIG_KEY_${index}`]: `http.${parsed.protocol}//${parsed.host}/.extraheader`,
      [`GIT_CONFIG_VALUE_${index}`]: `AUTHORIZATION: basic ${encoded}`,
    },
    redact: (line) => {
      let out = line;
      for (const secret of secrets) out = out.split(secret).join('[redacted]');
      return out;
    },
  };
}
