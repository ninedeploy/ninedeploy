import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Multi-node T3 (design §3.2, O5): static Git credentials on a node — the
 * agent side.
 *
 * A deploy key reaches the node only inside a sealed `git.withKey`, lives in
 * a fresh /dev/shm directory (0700, key 0600) for exactly that call, reaches
 * git only as `GIT_SSH_COMMAND` in the network children's environment, and is
 * removed in `finally` — on success, failure and a throw alike. A PAT keeps
 * the 0.13 env-only path with a `static: true` marker the node's owner can
 * refuse. Spawning is recorded, never real.
 */

const spawnMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => 0));
vi.mock('../src/lib/spawnValidated.js', () => ({ spawnValidated: spawnMock }));

const { runOp, gitCredentialEnv, agentCapabilities } = await import('../src/agent.js');
const registry = await import('../src/agentOps/index.js');
const cred = await import('../src/agentOps/gitCredential.js');

type SpawnCall = [string, string[], (l: string) => void, { cwd?: string; env?: Record<string, string> } | undefined];
const calls = () => spawnMock.mock.calls as unknown as SpawnCall[];

const KEY_BODY = 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW';
const KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\n${KEY_BODY}\nQyNTUxOQAAACBhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NQ==\n-----END OPENSSH PRIVATE KEY-----`;
const SSH_URL = 'git@github.com:acme/web.git';
const SEALED = { sealed: true };

const tmp = mkdtempSync(join(tmpdir(), 'nd-agent-sshkey-'));
const shm = join(tmp, 'shm');
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockResolvedValue(0);
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmp);
  rmSync(shm, { recursive: true, force: true });
  mkdirSync(shm, { recursive: true });
  cred._setKeyDirRootForTests(shm);
});
afterEach(() => {
  cwdSpy.mockRestore();
  cred._setKeyDirRootForTests(null);
});

const keyed = (op: string, params: Record<string, unknown>, key: Record<string, unknown> = { privateKey: KEY }) => ({ op, params, key });

/** What the git child saw of the key while it ran. */
function captureKeyDuringSpawn() {
  const seen: Array<{ argv: string[]; env?: Record<string, string>; keyText?: string; keyMode?: number; dirs: string[] }> = [];
  spawnMock.mockImplementation(async (...args: unknown[]) => {
    const [, argv, , opts] = args as SpawnCall;
    const command = opts?.env?.['GIT_SSH_COMMAND'];
    const keyPath = command ? /-i '([^']+)'/.exec(command)?.[1] : undefined;
    seen.push({
      argv,
      env: opts?.env,
      keyText: keyPath ? readFileSync(keyPath, 'utf8') : undefined,
      keyMode: keyPath ? statSync(keyPath).mode & 0o777 : undefined,
      dirs: readdirSync(shm),
    });
    return 0;
  });
  return seen;
}

describe('git.withKey: the deploy key exists only for the call', () => {
  it('clones with GIT_SSH_COMMAND in the clone child only; the key never reaches argv; the directory is gone afterwards', async () => {
    const seen = captureKeyDuringSpawn();
    expect(await runOp('git.withKey', keyed('git.ensure', { workspace: 'web', url: SSH_URL, depth: '1' }), () => undefined, SEALED)).toBe(0);
    const clone = seen.find((s) => s.argv.includes('clone'))!;
    // Default host-key policy on a node: accept-new against the job's own
    // known_hosts in the session directory — never `StrictHostKeyChecking=no`.
    const command = clone.env?.['GIT_SSH_COMMAND'] ?? '';
    const keyPath = /^ssh -i '([^']+)'/.exec(command)?.[1] ?? '';
    const sessionDir = join(keyPath, '..');
    expect(sessionDir).toMatch(/nd-git-/);
    expect(keyPath).toBe(join(sessionDir, 'key'));
    expect(command).toBe(
      `ssh -i '${keyPath}' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile='${join(sessionDir, 'known_hosts')}'`,
    );
    expect(clone.keyText).toBe(`${KEY}\n`); // LF line ends and the final newline ssh insists on
    if (process.platform !== 'win32') expect(clone.keyMode).toBe(0o600);
    expect(clone.dirs.filter((d) => d.startsWith('nd-git-'))).toHaveLength(1);
    for (const [, argv] of calls()) expect(argv.join(' ')).not.toContain(KEY_BODY);
    expect(readdirSync(shm)).toEqual([]);
    expect(cred._liveKeySessions()).toEqual([]);
  });

  it('an existing checkout: set-url runs without the key, the fetch with it', async () => {
    mkdirSync(join(tmp, '.agent-work', 'old', '.git'), { recursive: true });
    const seen = captureKeyDuringSpawn();
    await runOp('git.withKey', keyed('git.ensure', { workspace: 'old', url: SSH_URL }), () => undefined, SEALED);
    expect(seen.find((s) => s.argv.includes('set-url'))!.env).toBeUndefined();
    expect(seen.find((s) => s.argv.includes('fetch'))!.env?.['GIT_SSH_COMMAND']).toMatch(/^ssh -i /);
  });

  it('removes the key when git fails and when the op throws', async () => {
    spawnMock.mockResolvedValue(128);
    expect(await runOp('git.withKey', keyed('git.fetch', { workspace: 'web', url: SSH_URL }), () => undefined, SEALED)).toBe(128);
    expect(readdirSync(shm)).toEqual([]);
    spawnMock.mockRejectedValue(new Error('killed'));
    await expect(runOp('git.withKey', keyed('git.reset', { workspace: 'web', url: SSH_URL, sha: 'abcdef1' }), () => undefined, SEALED)).rejects.toThrow('killed');
    expect(readdirSync(shm)).toEqual([]);
    expect(cred._liveKeySessions()).toEqual([]);
  });

  it('accept-new, explicit or by default; `insecure` (StrictHostKeyChecking=no) is refused on a node', async () => {
    const seen = captureKeyDuringSpawn();
    await runOp('git.withKey', keyed('git.fetch', { workspace: 'web', url: SSH_URL }, { privateKey: KEY, hostKeyPolicy: 'accept-new' }), () => undefined, SEALED);
    expect(seen[0]!.env?.['GIT_SSH_COMMAND']).toMatch(/-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile='.+nd-git-[^']+[\\/]known_hosts'$/);
    await expect(
      runOp('git.withKey', keyed('git.fetch', { workspace: 'web', url: SSH_URL }, { privateKey: KEY, hostKeyPolicy: 'insecure' }), () => undefined, SEALED),
    ).rejects.toThrow(/Invalid hostKeyPolicy: a node accepts only accept-new/);
    expect(readdirSync(shm)).toEqual([]);
  });

  it('redacts the key from every line', async () => {
    spawnMock.mockImplementation(async (...args: unknown[]) => {
      (args[2] as (l: string) => void)(`Load key: ${KEY_BODY}: invalid format`);
      return 1;
    });
    const lines: string[] = [];
    await runOp('git.withKey', keyed('git.fetch', { workspace: 'web', url: SSH_URL }), (l) => lines.push(l), SEALED);
    expect(lines).toEqual(['Load key: [redacted]: invalid format']);
  });

  it('refuses before writing anything: unsealed, an http URL, a wrapped op that is not a network git op, a bad key, no /dev/shm', async () => {
    const refused: Array<[Record<string, unknown>, Record<string, unknown>, RegExp]> = [
      [keyed('git.ensure', { workspace: 'web', url: SSH_URL }), {}, /over the unencrypted transport/],
      [keyed('git.ensure', { workspace: 'web', url: 'https://github.com/acme/web.git' }), SEALED, /needs an ssh:\/\/ or git@host:path/],
      [keyed('git.checkout', { workspace: 'web', ref: 'main', url: SSH_URL }), SEALED, /wraps git.ensure, git.fetch or git.reset/],
      [keyed('docker.build', { url: SSH_URL }), SEALED, /wraps git.ensure/],
      [keyed('git.ensure', { workspace: 'web', url: SSH_URL, credential: { username: 'a', password: 'b' } }), SEALED, /Invalid params for the wrapped git op/],
      [keyed('git.ensure', { workspace: 'web', url: SSH_URL }, { privateKey: 'not a key' }), SEALED, /Invalid deploy key/],
      [keyed('git.ensure', { workspace: 'web', url: SSH_URL }, { privateKey: KEY, extra: 1 }), SEALED, /Invalid deploy key/],
      [keyed('git.ensure', { workspace: 'web', url: SSH_URL }, { privateKey: KEY, hostKeyPolicy: 'yes' }), SEALED, /Invalid hostKeyPolicy/],
    ];
    for (const [params, ctx, re] of refused) await expect(runOp('git.withKey', params, () => undefined, ctx), String(re)).rejects.toThrow(re);
    cred._setKeyDirRootForTests(join(tmp, 'no-such-shm'));
    await expect(runOp('git.withKey', keyed('git.ensure', { workspace: 'web', url: SSH_URL }), () => undefined, SEALED)).rejects.toThrow(
      /no in-memory filesystem for it/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
    expect(readdirSync(shm)).toEqual([]);
  });

  it('a session id from the wire is unknown: `credential: {kind: "ssh"}` on git.ensure is refused', async () => {
    await expect(
      runOp('git.ensure', { workspace: 'web', url: SSH_URL, credential: { kind: 'ssh', session: 'f'.repeat(64) } }, () => undefined, SEALED),
    ).rejects.toThrow(/no such deploy-key session/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('sweeps key directories a crashed agent left behind (and never a live one)', async () => {
    mkdirSync(join(shm, 'nd-git-stale1'));
    mkdirSync(join(shm, 'other-file'));
    const seen = captureKeyDuringSpawn();
    await runOp('git.withKey', keyed('git.fetch', { workspace: 'web', url: SSH_URL }), () => undefined, SEALED);
    // During the call only the live session's directory was there.
    expect(seen[0]!.dirs.filter((d) => d.startsWith('nd-git-'))).toHaveLength(1);
    expect(seen[0]!.dirs).not.toContain('nd-git-stale1');
    expect(readdirSync(shm)).toEqual(['other-file']);
  });

  it('the node owner’s switch refuses it and removes git.sshkey from the ping', async () => {
    expect(agentCapabilities({})).toContain('git.sshkey');
    expect(agentCapabilities({ NINEDEPLOY_AGENT_STATIC_CREDENTIALS: 'off' })).not.toContain('git.sshkey');
    await expect(
      registry.runRegisteredOp('git.withKey', keyed('git.fetch', { workspace: 'web', url: SSH_URL }), () => undefined, SEALED, {
        NINEDEPLOY_AGENT_STATIC_CREDENTIALS: 'off',
      }),
    ).rejects.toThrow(/NINEDEPLOY_AGENT_STATIC_CREDENTIALS=off/);
    expect(existsSync(shm) && readdirSync(shm)).toEqual([]);
    expect(registry.AGENT_OPS.get('git.withKey')?.cap).toBe('git.sshkey');
  });
});

describe('a PAT on a node: the 0.13 env-only path with a `static` marker', () => {
  const URL_ = 'https://github.com/acme/web.git';
  const PAT = 'ghp_staticPersonalAccessToken123';

  it('applies exactly like the 0.13 shape, and the 0.13 shape is unchanged', () => {
    const plain = gitCredentialEnv('git.ensure', { url: URL_, credential: { username: 'x-access-token', password: PAT } }, true, {});
    const marked = gitCredentialEnv('git.ensure', { url: URL_, credential: { username: 'x-access-token', password: PAT, static: true } }, true, {});
    expect(marked!.env).toEqual(plain!.env);
    expect(plain!.env).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${PAT}`).toString('base64')}`,
    });
    expect(marked!.redact(`x ${PAT} y`)).toBe('x [redacted] y');
  });

  it('is refused when the node’s owner switched static credentials off (an App token is not)', () => {
    const off = { NINEDEPLOY_AGENT_STATIC_CREDENTIALS: 'off' };
    expect(() => gitCredentialEnv('git.ensure', { url: URL_, credential: { username: 'oauth2', password: PAT, static: true } }, true, off)).toThrow(
      /turned them off \(NINEDEPLOY_AGENT_STATIC_CREDENTIALS=off/,
    );
    expect(gitCredentialEnv('git.ensure', { url: URL_, credential: { username: 'x-access-token', password: PAT } }, true, off)).not.toBeNull();
  });

  it('only that exact third key is accepted', () => {
    for (const credential of [
      { username: 'u', password: PAT, static: false },
      { username: 'u', password: PAT, other: true },
      { username: 'u', password: PAT, static: true, x: 1 },
      { kind: 'ssh', session: 'x', extra: 1 },
    ]) {
      expect(() => gitCredentialEnv('git.ensure', { url: URL_, credential }, true, {}), JSON.stringify(credential)).toThrow(/Invalid git credential/);
    }
  });
});
