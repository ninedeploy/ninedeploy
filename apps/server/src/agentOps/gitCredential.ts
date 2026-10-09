import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentOpModule } from './index.js';
import { isRepoUrl, type Params, str, switchedOff, validated } from './operands.js';

/**
 * The node agent's per-job Git credential (0.13, T5), moved out of agent.ts
 * unchanged by the multi-node transport work (design §9 M8) so private-clone
 * credentials grow here, not in the agent's hot spot. agent.ts re-exports
 * {@link gitCredentialEnv}; the 0.13 shape behaves byte-identically to 0.15.
 *
 * Multi-node (design §3, owner decision O5) adds two static credentials, both
 * opt-in per source on the panel and refusable by the node's owner with
 * `NINEDEPLOY_AGENT_STATIC_CREDENTIALS=off` (which also removes `git.sshkey`
 * from the ping):
 *   - a PAT: the 0.13 `{username, password}` shape plus `static: true`, applied
 *     exactly like an App token (an env-only `http.extraheader`);
 *   - a deploy key: op `git.withKey` (capability `git.sshkey`, sealed only)
 *     writes the key into a fresh `/dev/shm` directory (0700, key 0600), runs
 *     the wrapped `git.ensure` / `git.fetch` / `git.reset` with
 *     `GIT_SSH_COMMAND` in the network children's environment, and removes the
 *     directory in `finally` — success, failure or timeout alike. The key is
 *     never on argv, in `.agent-work`, in `.git/config` or in an output line.
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

/** The node owner's switch for every static credential (PATs and deploy keys). */
export const STATIC_CREDENTIALS_SWITCH = 'NINEDEPLOY_AGENT_STATIC_CREDENTIALS';
const staticCredentialsOff = (env: NodeJS.ProcessEnv): boolean => switchedOff(env[STATIC_CREDENTIALS_SWITCH]);
const STATIC_OFF_MESSAGE = `Refusing a static Git credential: this node's owner turned them off (${STATIC_CREDENTIALS_SWITCH}=off on the agent)`;

/** What a validated credential becomes: child-process env, plus the redactor for its output. */
export interface GitCredentialEnv {
  env: Record<string, string>;
  redact: (line: string) => string;
}

const isPlainObject = (raw: unknown): raw is Record<string, unknown> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw) && Object.getPrototypeOf(raw) === Object.prototype;

/** An SSH remote: `ssh://…` or scp-like `git@host:path` (an http(s) URL takes a token, never a key). */
const isSshRepoUrl = (url: string): boolean => isRepoUrl(url) && /^(?:ssh:\/\/|git@[A-Za-z0-9.-]+:)/.test(url);

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
 *
 * Multi-node: `{username, password, static: true}` is a PAT (refused when the
 * node's owner switched static credentials off), and `{kind: 'ssh', session}`
 * names a live deploy-key session opened by `git.withKey` in this process —
 * a session id from anywhere else is unknown and refused.
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
  if (!isPlainObject(raw)) throw new Error('Invalid git credential');
  if (raw['kind'] === 'ssh') return sshSessionEnv(raw, params);
  const keys = Object.keys(raw);
  const isStatic = keys.length === 3 && raw['static'] === true;
  if ((keys.length !== 2 && !isStatic) || !keys.includes('username') || !keys.includes('password')) throw new Error('Invalid git credential');
  if (isStatic && staticCredentialsOff(baseEnv)) throw new Error(STATIC_OFF_MESSAGE);
  const { username, password } = raw;
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

// ── deploy keys (multi-node, design §3.2) ──────────────────────────────────

/**
 * The only host-key policy a node accepts: `StrictHostKeyChecking=accept-new`
 * against a known_hosts file in the job's own key directory. A node is a new
 * trust boundary, so unlike the panel's own path (lib/git.ts,
 * `StrictHostKeyChecking=no`) a CHANGED key is never accepted within a job;
 * `insecure` is refused. Pinned provider keys and per-source known_hosts are
 * deferred (design §12).
 */
export type HostKeyPolicy = 'accept-new';

interface KeySession {
  dir: string;
  keyFile: string;
  hostKeyPolicy: HostKeyPolicy;
  /** The key and each of its lines, longest first, for the redactor. */
  pieces: string[];
}

/** Live sessions, by a random id only this process ever hands out. */
const keySessions = new Map<string, KeySession>();
/** Where key directories live: tmpfs inside the agent container. */
const KEY_DIR_ROOT = '/dev/shm';
const KEY_DIR_PREFIX = 'nd-git-';
let keyDirRoot = KEY_DIR_ROOT;
/** Test hook: point the key directories somewhere else (null restores `/dev/shm`). */
export function _setKeyDirRootForTests(dir: string | null): void {
  keyDirRoot = dir ?? KEY_DIR_ROOT;
}
/** Test hook: the live sessions (ids only). */
export function _liveKeySessions(): string[] {
  return [...keySessions.keys()];
}

const MAX_KEY = 16 * 1024;
const RE_PRIVATE_KEY =
  /^-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----\n(?:[A-Za-z0-9+/=:, -]*\n)+-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----\n$/;

/** A PEM/OpenSSH private key with LF line ends and one final newline (ssh insists on it), or a refusal. */
export function privateKeyOperand(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > MAX_KEY) throw new Error('Invalid deploy key');
  const key = `${raw.replace(/\r\n?/g, '\n').trim()}\n`;
  if (!RE_PRIVATE_KEY.test(key)) throw new Error('Invalid deploy key: expected a PEM or OpenSSH private key');
  return key;
}

/**
 * Remove key directories no live session owns: one a crashed agent left
 * behind. Creation and registration below are one synchronous step, so a
 * directory that is not in the table cannot belong to an op in flight.
 */
export function sweepStaleKeyDirs(): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(keyDirRoot);
  } catch {
    return 0;
  }
  const live = new Set([...keySessions.values()].map((s) => s.dir));
  for (const name of entries) {
    if (!name.startsWith(KEY_DIR_PREFIX)) continue;
    const dir = join(keyDirRoot, name);
    if (live.has(dir)) continue;
    rmSync(dir, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

let sweepTimer: NodeJS.Timeout | null = null;
/** The 10-minute backstop sweep, started with the first deploy-key op (never at import). */
function ensureKeySweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    try {
      sweepStaleKeyDirs();
    } catch {
      /* the next op's sweep retries */
    }
  }, 10 * 60 * 1000);
  sweepTimer.unref?.();
}

/** Single-quoted for the shell git runs `GIT_SSH_COMMAND` through; the paths come from mkdtemp. */
const shellQuote = (value: string): string => {
  if (value.includes("'")) throw new Error('Invalid key path');
  return `'${value}'`;
};

/** `{kind: 'ssh', session}` → `GIT_SSH_COMMAND` for the live session it names. */
function sshSessionEnv(raw: Record<string, unknown>, params: Params): GitCredentialEnv {
  const keys = Object.keys(raw);
  if (keys.length !== 2 || typeof raw['session'] !== 'string') throw new Error('Invalid git credential');
  const session = keySessions.get(raw['session']);
  if (!session) throw new Error('Invalid git credential: no such deploy-key session on this node');
  validated(str(params, 'url'), isSshRepoUrl, 'repo url: a deploy key needs an ssh:// or git@host:path repository URL');
  const hostKeys = ['-o StrictHostKeyChecking=accept-new', `-o UserKnownHostsFile=${shellQuote(join(session.dir, 'known_hosts'))}`];
  const command = ['ssh', '-i', shellQuote(session.keyFile), '-o IdentitiesOnly=yes', '-o BatchMode=yes', ...hostKeys].join(' ');
  return {
    env: { GIT_SSH_COMMAND: command },
    redact: (line) => {
      let out = line;
      for (const piece of session.pieces) out = out.split(piece).join('[redacted]');
      return out;
    },
  };
}

/** The ops a deploy key may wrap, and the only params each takes besides the URL. */
const KEYED_OPS: ReadonlySet<string> = GIT_CREDENTIAL_OPS;

/**
 * `git.withKey {op, params, key: {privateKey, hostKeyPolicy?}}` (sealed only,
 * capability `git.sshkey`): run `op` (`git.ensure` / `git.fetch` /
 * `git.reset`) with a deploy key that exists only for this call.
 */
export async function gitWithKeyOp(params: Params, onLine: (line: string) => void): Promise<number> {
  const inner = str(params, 'op');
  if (inner === undefined || !KEYED_OPS.has(inner)) throw new Error('Invalid op: git.withKey wraps git.ensure, git.fetch or git.reset');
  const innerParams = params['params'];
  if (!isPlainObject(innerParams) || 'credential' in innerParams) throw new Error('Invalid params for the wrapped git op');
  validated(str(innerParams, 'url'), isSshRepoUrl, 'repo url: a deploy key needs an ssh:// or git@host:path repository URL');
  const key = params['key'];
  if (!isPlainObject(key) || Object.keys(key).some((k) => k !== 'privateKey' && k !== 'hostKeyPolicy')) throw new Error('Invalid deploy key');
  const privateKey = privateKeyOperand(key['privateKey']);
  const policy = key['hostKeyPolicy'] ?? 'accept-new';
  if (policy !== 'accept-new') throw new Error('Invalid hostKeyPolicy: a node accepts only accept-new');

  sweepStaleKeyDirs();
  ensureKeySweep();
  let dir: string;
  try {
    dir = mkdtempSync(join(keyDirRoot, KEY_DIR_PREFIX)); // 0700
  } catch {
    // Never fall back to disk: the key would outlive a crash there.
    throw new Error(`Refusing the deploy key: this node has no in-memory filesystem for it (${keyDirRoot} is not writable)`);
  }
  const id = randomBytes(32).toString('hex');
  const keyFile = join(dir, 'key');
  try {
    writeFileSync(keyFile, privateKey, { mode: 0o600, flag: 'wx' });
    const pieces = [privateKey, privateKey.trim(), ...privateKey.split('\n').filter((l) => l.length >= 16 && !l.startsWith('-----'))].sort(
      (a, b) => b.length - a.length,
    );
    keySessions.set(id, { dir, keyFile, hostKeyPolicy: policy, pieces });
    const { runOp } = await import('../agent.js');
    return await runOp(inner, { ...innerParams, credential: { kind: 'ssh', session: id } }, onLine, { sealed: true });
  } finally {
    keySessions.delete(id);
    rmSync(dir, { recursive: true, force: true });
  }
}

export const gitKeyOps: AgentOpModule = {
  name: 'agentOps/gitCredential.ts',
  caps: ['git.sshkey'],
  ops: {
    'git.withKey': { cap: 'git.sshkey', sealedOnly: true, run: (p, onLine) => gitWithKeyOp(p, onLine) },
  },
};
