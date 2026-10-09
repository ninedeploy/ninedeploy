import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_CAPABILITIES, AGENT_CAPABILITIES_015, agentRoutes, gitCredentialEnv, resolveWorkspace, runOp } from '../src/agent.js';
import { open as openSealed, seal } from '../src/lib/agentSeal.js';
import { buildTestApp } from './helpers.js';

/**
 * 0.13 (T5): the node agent's per-job Git credential.
 *
 * The credential reaches git ONLY through the child's environment
 * (GIT_CONFIG_COUNT / KEY / VALUE): never argv (the node's process list), never
 * `.git/config` (the workspace outlives the job), never an output line. It is
 * accepted only from a sealed request, only on git.ensure / git.fetch /
 * git.reset, and only in its exact shape.
 */

const spawnMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => 0));
vi.mock('../src/lib/spawnValidated.js', () => ({ spawnValidated: spawnMock }));
const dockerPullMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../src/lib/dockerPull.js', () => ({ pullDockerImage: dockerPullMock }));

const TOKEN = 'ghs_perJobInstallationToken0123456789';
const CRED = { username: 'x-access-token', password: TOKEN };
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
const URL_ = 'https://github.com/acme/web.git';
const SEALED = { sealed: true };

type SpawnCall = [string, string[], (l: string) => void, { cwd?: string; env?: Record<string, string>; stdin?: string } | undefined];
const calls = () => spawnMock.mock.calls as unknown as SpawnCall[];

const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-agent-cred-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockResolvedValue(0);
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmp);
});
afterEach(() => cwdSpy.mockRestore());

/** Nothing the credential is made of may appear in any argv or stdin. */
function expectNoSecretOutsideEnv() {
  for (const [, argv, , opts] of calls()) {
    const visible = `${argv.join(' ')} ${opts?.stdin ?? ''}`;
    expect(visible).not.toContain(TOKEN);
    expect(visible).not.toContain(BASIC);
  }
}

describe('agent capability', () => {
  it('advertises git.credential next to the r660/r662 capabilities', () => {
    // 0.15 (T2b) appended `terminal`; the 0.13 entries keep their order.
    expect(AGENT_CAPABILITIES_015).toEqual(['build-path-guard', 'workspace.remove', 'git.credential', 'terminal']);
    // Multi-node capabilities are appended after the 0.15 list, never before it.
    expect(AGENT_CAPABILITIES.slice(0, 4)).toEqual([...AGENT_CAPABILITIES_015]);
  });
});

describe('gitCredentialEnv: env-only application', () => {
  it('scopes an AUTHORIZATION extraheader to the repository origin', () => {
    const cred = gitCredentialEnv('git.ensure', { url: URL_, credential: CRED }, true, {});
    expect(cred?.env).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${BASIC}`,
    });
    // A non-default port is part of the origin.
    expect(gitCredentialEnv('git.fetch', { url: 'https://ghe.example.com:8443/a/b.git', credential: CRED }, true, {})?.env['GIT_CONFIG_KEY_0']).toBe(
      'http.https://ghe.example.com:8443/.extraheader',
    );
  });

  it('appends after GIT_CONFIG_* entries the node environment already sets', () => {
    const cred = gitCredentialEnv('git.ensure', { url: URL_, credential: CRED }, true, { GIT_CONFIG_COUNT: '2' });
    expect(cred?.env).toEqual({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_2: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_2: `AUTHORIZATION: basic ${BASIC}`,
    });
  });

  it('is null without a credential operand (an older panel, an anonymous repository)', () => {
    expect(gitCredentialEnv('git.ensure', { url: URL_ }, false)).toBeNull();
    expect(gitCredentialEnv('docker.build', {}, false)).toBeNull();
  });

  it('git itself sends the header to the repository origin and to no other host', () => {
    const probe = spawnSync('git', ['--version'], { encoding: 'utf8' });
    if (probe.status !== 0) return; // no git on this machine: the env shape above is the contract
    const env = { ...process.env, ...gitCredentialEnv('git.ensure', { url: URL_, credential: CRED }, true, {})!.env };
    const match = (url: string) =>
      spawnSync('git', ['config', '--get-urlmatch', 'http.extraheader', url], { encoding: 'utf8', env, cwd: tmp });
    const same = match('https://github.com/acme/other.git');
    expect(same.status).toBe(0);
    expect(same.stdout.trim()).toBe(`AUTHORIZATION: basic ${BASIC}`);
    for (const other of ['https://evil.example.com/acme/web.git', 'http://github.com/acme/web.git', 'https://github.com.evil.io/x.git']) {
      const res = match(other);
      expect(res.stdout.trim()).toBe('');
      expect(res.status).not.toBe(0);
    }
  });
});

describe('runOp: the credential reaches only the network git children, through env', () => {
  it('git.ensure clone: env on the clone, nothing in argv', async () => {
    await expect(runOp('git.ensure', { workspace: 'cred-fresh', url: URL_, depth: '1', credential: CRED }, () => {}, SEALED)).resolves.toBe(0);
    const [exe, argv, , opts] = calls().at(-1)!;
    expect(exe).toBe('git');
    expect(argv).toContain('clone');
    expect(argv).toContain(URL_);
    expect(opts?.env?.['GIT_CONFIG_VALUE_0']).toBe(`AUTHORIZATION: basic ${BASIC}`);
    expect(opts?.env?.['GIT_CONFIG_KEY_0']).toBe('http.https://github.com/.extraheader');
    expectNoSecretOutsideEnv();
  });

  it('0.16: a server without shallow support (dumb HTTP) gets one full clone retry, with the same credential and egress flags', async () => {
    const EGRESS = ['-c', 'http.followRedirects=false', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never'];
    const dumb = 'http://192.168.176.4/dockerfile.git';
    spawnMock.mockImplementation((async (_e: string, argv: string[], onLine: (l: string) => void) => {
      if (!argv.includes('clone')) return 0;
      if (argv.includes('--depth')) {
        onLine("Cloning into '.'...");
        onLine(`fatal: dumb http transport does not support shallow capabilities (${TOKEN})`);
        return 128;
      }
      return 0;
    }) as never);
    const lines: string[] = [];
    await expect(runOp('git.ensure', { workspace: 'dumb-fresh', url: dumb, depth: '1', credential: CRED }, (l) => lines.push(l), SEALED)).resolves.toBe(0);
    const clones = calls().filter(([, argv]) => argv.includes('clone'));
    expect(clones.map(([, argv]) => argv)).toEqual([
      [...EGRESS, 'clone', '--depth', '1', '--no-single-branch', dumb, '.'],
      [...EGRESS, 'clone', dumb, '.'],
    ]);
    // The retry carries the same per-job credential, only through env.
    for (const [, , , opts] of clones) expect(opts?.env?.['GIT_CONFIG_VALUE_0']).toBe(`AUTHORIZATION: basic ${BASIC}`);
    expect(lines.some((l) => /does not support shallow clones .* retrying with a full clone/.test(l))).toBe(true);
    expect(lines.join('\n')).not.toContain(TOKEN);
    expectNoSecretOutsideEnv();

    // Control: any other clone failure is returned as is, with no retry.
    spawnMock.mockReset();
    spawnMock.mockImplementation((async (_e: string, argv: string[], onLine: (l: string) => void) => {
      if (!argv.includes('clone')) return 0;
      onLine('fatal: Authentication failed for the repository');
      return 128;
    }) as never);
    await expect(runOp('git.ensure', { workspace: 'auth-fail', url: URL_, depth: '1', credential: CRED }, () => {}, SEALED)).resolves.toBe(128);
    expect(calls().filter(([, argv]) => argv.includes('clone'))).toHaveLength(1);
  });

  it('0.16: git.reset of a missing commit on a dumb-HTTP server retries the fetch once without --depth', async () => {
    const EGRESS = ['-c', 'http.followRedirects=false', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never'];
    const dumb = 'http://192.168.176.4/dockerfile.git';
    spawnMock.mockImplementation((async (_e: string, argv: string[], onLine: (l: string) => void) => {
      if (argv[0] === 'cat-file') return 1; // the pinned commit is missing
      if (argv.includes('fetch') && argv.includes('--depth')) {
        onLine(`fatal: dumb http transport does not support shallow capabilities (${TOKEN})`);
        return 128;
      }
      return 0;
    }) as never);
    const lines: string[] = [];
    await expect(runOp('git.reset', { workspace: 'web', sha: 'abcdef1234', url: dumb, credential: CRED }, (l) => lines.push(l), SEALED)).resolves.toBe(0);
    expect(calls().map(([, argv]) => argv)).toEqual([
      ['cat-file', '-e', 'abcdef1234^{commit}'],
      [...EGRESS, 'fetch', '--depth', '1', 'origin', 'abcdef1234'],
      [...EGRESS, 'fetch', 'origin', 'abcdef1234'],
      ['reset', '--hard', 'abcdef1234'],
    ]);
    // Both fetches carry the credential through env; cat-file and reset never do.
    expect(calls().map(([, , , opts]) => opts?.env?.['GIT_CONFIG_VALUE_0'])).toEqual([undefined, `AUTHORIZATION: basic ${BASIC}`, `AUTHORIZATION: basic ${BASIC}`, undefined]);
    expect(lines.some((l) => /does not support shallow fetches .* retrying with a full fetch/.test(l))).toBe(true);
    expect(lines.join('\n')).not.toContain(TOKEN);
    expectNoSecretOutsideEnv();

    // Control: any other fetch failure is not retried.
    spawnMock.mockReset();
    spawnMock.mockImplementation((async (_e: string, argv: string[], onLine: (l: string) => void) => {
      if (argv[0] === 'cat-file') return 1;
      if (argv.includes('fetch')) {
        onLine('fatal: Authentication failed for the repository');
        return 128;
      }
      return 0;
    }) as never);
    await runOp('git.reset', { workspace: 'web', sha: 'abcdef1234', url: dumb, credential: CRED }, () => {}, SEALED);
    expect(calls().filter(([, argv]) => argv.includes('fetch'))).toHaveLength(1);
  });

  it('git.ensure on an existing checkout: only the fetch gets it — config and set-url never do', async () => {
    const dir = await resolveWorkspace('cred-existing');
    mkdirSync(path.join(dir, '.git'), { recursive: true });
    await runOp('git.ensure', { workspace: 'cred-existing', url: URL_, depth: '1', credential: CRED }, () => {}, SEALED);
    const byVerb = calls().map(([, argv, , opts]) => [argv.find((a) => ['config', 'remote', 'fetch'].includes(a)), opts?.env] as const);
    expect(byVerb.map(([v]) => v)).toEqual(['config', 'remote', 'fetch']);
    expect(byVerb[0]![1]).toBeUndefined();
    expect(byVerb[1]![1]).toBeUndefined();
    expect(byVerb[2]![1]?.['GIT_CONFIG_COUNT']).toBe('1');
    expectNoSecretOutsideEnv();
  });

  it('git.fetch and git.reset: the network child gets it, cat-file and reset do not', async () => {
    await runOp('git.fetch', { workspace: 'web', url: URL_, credential: CRED }, () => {}, SEALED);
    const fetch = calls().at(-1)!;
    expect(fetch[1]).toContain('fetch');
    expect(fetch[3]?.env?.['GIT_CONFIG_COUNT']).toBe('1');

    spawnMock.mockClear();
    spawnMock.mockResolvedValueOnce(1); // cat-file: the pinned commit is missing
    await runOp('git.reset', { workspace: 'web', sha: 'abcdef1234', url: URL_, credential: CRED }, () => {}, SEALED);
    const steps = calls().map(([, argv, , opts]) => ({ verb: argv.includes('fetch') ? 'fetch' : argv[0], env: opts?.env }));
    expect(steps.map((s) => s.verb)).toEqual(['cat-file', 'fetch', 'reset']);
    expect(steps[0]!.env).toBeUndefined();
    expect(steps[1]!.env?.['GIT_CONFIG_VALUE_0']).toBe(`AUTHORIZATION: basic ${BASIC}`);
    expect(steps[2]!.env).toBeUndefined();
    expectNoSecretOutsideEnv();
  });

  it('without a credential every op spawns exactly as before (no env option at all)', async () => {
    await runOp('git.ensure', { workspace: 'anon-fresh', url: URL_, depth: '1' }, () => {});
    await runOp('git.fetch', { workspace: 'web' }, () => {});
    expect(calls().map(([, , , opts]) => opts?.env)).toEqual([undefined, undefined]);
  });

  it('redacts the token, its basic-auth value and the header from every output line', async () => {
    spawnMock.mockImplementation((async (_e: string, _a: string[], onLine: (l: string) => void) => {
      onLine(`fatal: could not read from https://x-access-token:${TOKEN}@github.com/acme/web.git`);
      onLine(`> AUTHORIZATION: basic ${BASIC}`);
      onLine(`token=${encodeURIComponent(TOKEN)} done`);
      return 128;
    }) as never);
    const lines: string[] = [];
    await runOp('git.fetch', { workspace: 'web', url: URL_, credential: CRED }, (l) => lines.push(l), SEALED);
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      expect(l).not.toContain(TOKEN);
      expect(l).not.toContain(BASIC);
      expect(l).toContain('[redacted]');
    }
  });
});

describe('runOp: operand validation', () => {
  const bad: Array<[string, Record<string, unknown>, RegExp]> = [
    ['an array', { url: URL_, credential: ['x-access-token', TOKEN] }, /Invalid git credential/],
    ['a string', { url: URL_, credential: `x-access-token:${TOKEN}` }, /Invalid git credential/],
    ['null', { url: URL_, credential: null }, /Invalid git credential/],
    ['an extra key', { url: URL_, credential: { ...CRED, host: 'evil.example.com' } }, /Invalid git credential/],
    ['a missing password', { url: URL_, credential: { username: 'x-access-token' } }, /Invalid git credential/],
    ['a non-string password', { url: URL_, credential: { username: 'x-access-token', password: 42 } }, /Invalid git credential/],
    ['a colon in the user name', { url: URL_, credential: { username: 'a:b', password: TOKEN } }, /Invalid git credential/],
    ['a newline in the password', { url: URL_, credential: { username: 'x-access-token', password: `${TOKEN}\r\nX-Evil: 1` } }, /Invalid git credential/],
    ['a space in the password', { url: URL_, credential: { username: 'x-access-token', password: 'a b' } }, /Invalid git credential/],
    ['an empty password', { url: URL_, credential: { username: 'x-access-token', password: '' } }, /Invalid git credential/],
    ['no repository url to scope it', { credential: CRED }, /Invalid repo url/],
    ['an SSH remote', { url: 'git@github.com:acme/web.git', credential: CRED }, /Invalid repo url/],
    ['a URL with its own userinfo', { url: 'https://u:p@github.com/acme/web.git', credential: CRED }, /Invalid repo url/],
    ['a local path', { url: 'file:///etc', credential: CRED }, /Invalid repo url/],
  ];
  for (const [what, params, error] of bad) {
    it(`refuses ${what} before anything is spawned`, async () => {
      await expect(runOp('git.fetch', { workspace: 'web', ...params }, () => {}, SEALED)).rejects.toThrow(error);
      expect(spawnMock).not.toHaveBeenCalled();
    });
  }

  it('never echoes the secret in a validation error', async () => {
    const err = await runOp('git.fetch', { workspace: 'web', url: URL_, credential: { username: 'x-access-token', password: `${TOKEN} x` } }, () => {}, SEALED).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain(TOKEN);
  });

  it('refuses a credential on any op other than git.ensure / git.fetch / git.reset', async () => {
    for (const op of ['git.checkout', 'git.clone', 'docker.build', 'docker.pull', 'agent.ping']) {
      await expect(runOp(op, { url: URL_, ref: 'main', image: 'nginx', credential: CRED }, () => {}, SEALED)).rejects.toThrow(/takes no Git credential/);
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses a credential that did not arrive sealed', async () => {
    await expect(runOp('git.ensure', { workspace: 'web', url: URL_, credential: CRED }, () => {})).rejects.toThrow(/unencrypted transport/);
    await expect(runOp('git.fetch', { workspace: 'web', url: URL_, credential: CRED }, () => {}, { sealed: false })).rejects.toThrow(/unencrypted transport/);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('/agent/exec: the transport decides', () => {
  const TOKEN_AGENT = 'agent-shared-token';
  const HASH = createHash('sha256').update(TOKEN_AGENT).digest('hex');
  const appWith = async () => {
    const app = await buildTestApp();
    await app.register(agentRoutes, { tokenHash: HASH });
    return app;
  };

  it('refuses a credential on the legacy plaintext path with 400 and spawns nothing', async () => {
    const app = await appWith();
    const res = await app.inject({
      method: 'POST',
      url: '/agent/exec',
      headers: { 'x-agent-token': TOKEN_AGENT },
      payload: { op: 'git.fetch', params: { workspace: 'web', url: URL_, credential: CRED } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_params');
    expect(res.body).not.toContain(TOKEN);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('applies it from a sealed request, and the sealed answer carries no secret', async () => {
    spawnMock.mockImplementation((async (_e: string, _a: string[], onLine: (l: string) => void) => {
      onLine(`remote: Invalid username or password for x-access-token:${TOKEN}`);
      return 0;
    }) as never);
    const app = await appWith();
    const res = await app.inject({
      method: 'POST',
      url: '/agent/exec',
      payload: { sealed: seal(HASH, { op: 'git.fetch', params: { workspace: 'web', url: URL_, credential: CRED }, nonce: 'cred-1' }) },
    });
    expect(res.statusCode).toBe(200);
    const body = openSealed<{ lines: string[]; exitCode: number }>(HASH, res.json().sealed);
    expect(body.exitCode).toBe(0);
    expect(body.lines.join('\n')).not.toContain(TOKEN);
    expect(calls().at(-1)![3]?.env?.['GIT_CONFIG_COUNT']).toBe('1');
    expectNoSecretOutsideEnv();
  });

  it('an older panel (no credential operand) is served exactly as before on both transports', async () => {
    const app = await appWith();
    const plain = await app.inject({
      method: 'POST',
      url: '/agent/exec',
      headers: { 'x-agent-token': TOKEN_AGENT },
      payload: { op: 'git.fetch', params: { workspace: 'web' } },
    });
    expect(plain.statusCode).toBe(200);
    const sealed = await app.inject({
      method: 'POST',
      url: '/agent/exec',
      payload: { sealed: seal(HASH, { op: 'git.reset', params: { workspace: 'web', sha: 'HEAD' }, nonce: 'old-panel-1' }) },
    });
    expect(sealed.statusCode).toBe(200);
    expect(calls().every(([, , , opts]) => opts?.env === undefined)).toBe(true);
  });
});
