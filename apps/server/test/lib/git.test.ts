import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const gitState = vi.hoisted(() => ({
  simpleGit: vi.fn(),
  /** What `git remote get-url origin` answers for an existing checkout. */
  origin: undefined as string | undefined,
  lastDir: undefined as string | undefined,
}));

vi.mock('simple-git', () => ({ simpleGit: gitState.simpleGit }));

// Deterministic DNS for the egress gate: every hostname answers one public
// address, which the checkout must then pin git to (r355).
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup, default: { lookup: dns.lookup } }));
const VETTED_IP = '140.82.121.4';

const { checkoutCommit } = await import('../../src/lib/git.js');

/** Every simple-git instance carries the redirect hardening (r099) and, for an
 *  https remote, the pin to the address the gate vetted (r355). */
const HARDENED = { config: ['http.followRedirects=false', `http.curloptResolve=github.com:443:${VETTED_IP}`] };

const tmpRoot = path.join(os.tmpdir(), `ninedeploy-git-${process.pid}-${Date.now()}`);

function makeGit() {
  return {
    addConfig: vi.fn(async () => undefined),
    remote: vi.fn(async (args: string[]) => (args[0] === 'get-url' ? gitState.origin : undefined)),
    fetch: vi.fn(async () => undefined),
    checkout: vi.fn(async () => undefined),
    pull: vi.fn(async () => undefined),
    raw: vi.fn(async (args: string[]) => {
      if (args[0] === 'config') {
        // `git config -f .gitmodules --get-regexp …` — read the fixture file.
        const file = path.join(gitState.lastDir ?? '', '.gitmodules');
        if (!existsSync(file)) throw new Error('no .gitmodules');
        const out: string[] = [];
        let name = '';
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          const sec = /^\[submodule "(.+)"\]/.exec(line.trim());
          if (sec) name = sec[1]!;
          const kv = /^(url|path)\s*=\s*(.+)$/.exec(line.trim());
          if (kv) out.push(`submodule.${name}.${kv[1]} ${kv[2]}`);
        }
        return `${out.join('\n')}\n`;
      }
      return '0123456789abcdef\n';
    }),
    clone: vi.fn(async () => undefined),
    submoduleUpdate: vi.fn(async () => undefined),
  };
}

function gitDir(name: string): string {
  return path.join(tmpRoot, name);
}

function existingCheckout(name: string, origin = 'https://github.com/org/repo.git'): string {
  const dir = gitDir(name);
  mkdirSync(path.join(dir, '.git'), { recursive: true });
  gitState.origin = origin;
  gitState.lastDir = dir;
  return dir;
}

/** A git whose bare `clone` fails, simulating an interrupted authenticated clone. */
function makeFailingCloneGit() {
  const g = makeGit();
  g.clone = vi.fn(async () => {
    // Half-written clone: repo dir exists with a .git skeleton before dying.
    throw new Error('connection reset mid-clone');
  });
  return g;
}

beforeEach(() => {
  dns.lookup.mockReset();
  dns.lookup.mockResolvedValue([{ address: VETTED_IP, family: 4 }]);
  gitState.origin = undefined;
  gitState.lastDir = undefined;
  gitState.simpleGit.mockReset();
  gitState.simpleGit.mockImplementation(() => makeGit());
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('checkoutCommit — fresh clone', () => {
  it('clones a public repo, checks out the branch, and returns the resolved sha', async () => {
    const dir = gitDir('fresh-public');
    const sink = vi.fn();
    const resolved = await checkoutCommit('https://github.com/ada/repo.git', 'main', undefined, dir, sink);

    expect(gitState.simpleGit.mock.calls[0]).toEqual([HARDENED]); // bare factory call for clone
    expect(gitState.simpleGit.mock.calls[1]).toEqual([dir, HARDENED]); // checkout instance
    const bare = gitState.simpleGit.mock.results[0]!.value;
    expect(bare.clone).toHaveBeenCalledWith('https://github.com/ada/repo.git', dir, []);
    expect(sink).toHaveBeenCalledWith('Cloning https://github.com/ada/repo.git …');
    expect(sink).toHaveBeenCalledWith('Checked out 0123456 on main');
    expect(resolved).toBe('0123456789abcdef');
  });

  it('injects a token into an HTTPS url and keeps the log message unmasked', async () => {
    const dir = gitDir('fresh-token');
    const sink = vi.fn();
    await checkoutCommit('https://github.com/org/private.git', 'main', undefined, dir, sink, {
      type: 'github',
      token: 'secret-pat',
    });

    const bare = gitState.simpleGit.mock.results[0]!.value;
    expect(bare.clone).toHaveBeenCalledWith(
      'https://x-access-token:secret-pat@github.com/org/private.git',
      dir,
      [],
    );
    expect(sink).toHaveBeenCalledWith('Cloning https://github.com/org/private.git (access token) …');
  });

  it('masks credentials already embedded in the repo url', async () => {
    const dir = gitDir('fresh-embedded-creds');
    const sink = vi.fn();
    await checkoutCommit('https://user:secret@example.com/org/repo.git', 'main', undefined, dir, sink);

    expect(sink).toHaveBeenCalledWith('Cloning https://***@example.com/org/repo.git …');
  });

  it('uses oauth2 as the user for gitlab tokens', async () => {
    const dir = gitDir('fresh-gitlab');
    await checkoutCommit('https://gitlab.com/group/repo.git', 'main', undefined, dir, vi.fn(), {
      type: 'gitlab',
      token: 'glpat',
    });
    const bare = gitState.simpleGit.mock.results[0]!.value;
    expect(bare.clone).toHaveBeenCalledWith(
      'https://oauth2:glpat@gitlab.com/group/repo.git',
      dir,
      [],
    );
  });

  it('keeps the original url when the token url has no http(s) prefix', async () => {
    const dir = gitDir('fresh-token-ssh');
    await checkoutCommit('git@github.com:org/repo.git', 'main', undefined, dir, vi.fn(), {
      token: 'pat',
    });
    const bare = gitState.simpleGit.mock.results[0]!.value;
    expect(bare.clone).toHaveBeenCalledWith('git@github.com:org/repo.git', dir, []);
  });

  it('writes an SSH deploy key and clones via the converted ssh url', async () => {
    const dir = gitDir('fresh-key');
    const sink = vi.fn();
    await checkoutCommit('https://github.com/org/repo.git', 'main', undefined, dir, sink, {
      deployKey: '-----BEGIN OPENSSH PRIVATE KEY-----',
    });

    const keyFile = path.join(path.dirname(dir), `${path.basename(dir)}.sshkey`);
    // The key is written for the clone, then scrubbed from disk afterwards
    // so private keys never accumulate in the repos directory.
    expect(existsSync(keyFile)).toBe(false);

    const bare = gitState.simpleGit.mock.results[0]!.value;
    expect(bare.clone).toHaveBeenCalledWith(
      'git@github.com:org/repo.git',
      dir,
      ['--config', expect.stringContaining('core.sshCommand=')],
    );
    expect(sink).toHaveBeenCalledWith('Cloning git@github.com:org/repo.git (SSH deploy key) …');
  });

  it('leaves a non-convertible url untouched when using a deploy key', async () => {
    const dir = gitDir('fresh-key-ftp');
    await checkoutCommit('ftp://example.com/repo', 'main', undefined, dir, vi.fn(), {
      deployKey: 'key-material',
    });
    const bare = gitState.simpleGit.mock.results[0]!.value;
    expect(bare.clone).toHaveBeenCalledWith('ftp://example.com/repo', dir, expect.any(Array));
  });

  it('still scrubs the tokenized remote when the clone itself fails midway', async () => {
    // First simpleGit() call: the bare instance whose clone dies mid-transfer.
    const bare = makeFailingCloneGit();
    // Later simpleGit(dir) calls (the finally-block re-open): a working handle.
    const reopened = makeGit();
    gitState.simpleGit.mockImplementationOnce(() => bare).mockImplementation(() => reopened);
    // Simulate the half-written clone leaving a .git skeleton on disk.
    const dir = gitDir('fresh-clone-fail');
    bare.clone.mockImplementationOnce(async () => {
      mkdirSync(path.join(dir, '.git'), { recursive: true });
      throw new Error('connection reset mid-clone');
    });

    await expect(
      checkoutCommit('https://github.com/org/private.git', 'main', undefined, dir, vi.fn(), {
        token: 'secret-tok',
      }),
    ).rejects.toThrow('mid-clone');

    // The finally block re-opened the partial repo and reset origin to the
    // tokenless URL, so the token is not left in .git/config.
    expect(reopened.remote).toHaveBeenCalledWith([
      'set-url', 'origin', 'https://github.com/org/private.git',
    ]);
  });

  it('skips the remote reset when a failed clone leaves no .git directory at all', async () => {
    const bare = makeFailingCloneGit();
    const reopened = makeGit();
    gitState.simpleGit.mockImplementationOnce(() => bare).mockImplementation(() => reopened);

    await expect(
      checkoutCommit('https://github.com/org/private.git', 'main', undefined, gitDir('fresh-clone-clean-fail'), vi.fn(), {
        token: 'secret-tok',
      }),
    ).rejects.toThrow('mid-clone');

    // Nothing on disk to clean → no set-url call on the reopened handle.
    expect(reopened.remote).not.toHaveBeenCalled();
  });
});

describe('checkoutCommit — existing checkout', () => {
  it('fetches, moves to the remote tip, and reuses the working tree', async () => {
    const dir = existingCheckout('existing-public', 'https://github.com/ada/repo.git');
    const git = makeGit();
    gitState.simpleGit.mockImplementation(() => git);

    const sink = vi.fn();
    const resolved = await checkoutCommit('https://github.com/ada/repo.git', 'main', undefined, dir, sink);

    expect(gitState.simpleGit).toHaveBeenCalledWith(dir, HARDENED);
    expect(git.fetch).toHaveBeenCalledWith(['--all']);
    // r273: no swallowed `pull` — the checkout is reset to origin's tip.
    expect(git.raw).toHaveBeenCalledWith(['checkout', '-f', '-B', 'main', 'refs/remotes/origin/main', '--']);
    expect(git.pull).not.toHaveBeenCalled();
    expect(git.raw).toHaveBeenCalledWith(['log', '-1', '--format=%H']);
    expect(sink).toHaveBeenCalledWith('Fetching latest…');
    expect(resolved).toBe('0123456789abcdef');
  });

  it('refreshes the remote url when a token is provided', async () => {
    const dir = existingCheckout('existing-token', 'https://github.com/org/repo.git');
    const git = makeGit();
    gitState.simpleGit.mockImplementation(() => git);

    await checkoutCommit('https://github.com/org/repo.git', 'main', undefined, dir, vi.fn(), {
      token: 'rotated',
    });
    expect(git.remote).toHaveBeenCalledWith(['set-url', 'origin', 'https://x-access-token:rotated@github.com/org/repo.git']);
    // After the fetch the token is scrubbed from .git/config (security cleanup).
    expect(git.remote).toHaveBeenCalledWith(['set-url', 'origin', 'https://github.com/org/repo.git']);
    expect(git.addConfig).not.toHaveBeenCalled();
  });

  it('writes a key and configures the ssh command when a deploy key is used', async () => {
    const dir = existingCheckout('existing-key', 'git@github.com:org/repo.git');
    const git = makeGit();
    gitState.simpleGit.mockImplementation(() => git);

    await checkoutCommit('git@github.com:org/repo.git', 'main', undefined, dir, vi.fn(), {
      deployKey: 'ssh-key',
    });
    expect(git.addConfig).toHaveBeenCalledWith('core.sshCommand', expect.stringContaining(`ssh -i "${path.join(path.dirname(dir), `${path.basename(dir)}.sshkey`)}"`));
    // The deploy key is removed from disk after checkout completes.
    expect(existsSync(path.join(path.dirname(dir), `${path.basename(dir)}.sshkey`))).toBe(false);
  });

  it('fails fast on addConfig failure', async () => {
    const dir = existingCheckout('existing-addconfig-fail', 'git@github.com:org/repo.git');
    const git = makeGit();
    git.addConfig = vi.fn(async () => {
      throw new Error('config failed');
    });
    gitState.simpleGit.mockImplementation(() => git);

    await expect(
      checkoutCommit('git@github.com:org/repo.git', 'main', undefined, dir, vi.fn(), { deployKey: 'k' }),
    ).rejects.toThrow('config failed');
  });

  it('surfaces a remote set-url failure (a rotated token must not silently miss)', async () => {
    // Same rule as core.sshCommand: if the origin URL never updates, the
    // fetch below runs with the STALE stored credential and fails far from
    // the real cause.
    const dir = existingCheckout('existing-remote-fail', 'https://github.com/org/repo.git');
    const git = makeGit();
    git.remote = vi.fn(async (args: string[]) => {
      if (args[0] === 'get-url') return gitState.origin;
      throw new Error('remote failed');
    });
    gitState.simpleGit.mockImplementation(() => git);

    await expect(
      checkoutCommit('https://github.com/org/repo.git', 'main', undefined, dir, vi.fn(), { token: 't' }),
    ).rejects.toThrow('remote failed');
  });
});

describe('checkoutCommit — edge cases', () => {
  it('r273: falls back to the local branch only when origin has no such ref', async () => {
    const dir = existingCheckout('existing-no-remote-ref', 'https://github.com/ada/repo.git');
    const git = makeGit();
    const baseRaw = git.raw;
    git.raw = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') throw new Error('exit 1');
      return baseRaw(args);
    });
    gitState.simpleGit.mockImplementation(() => git);
    const sink = vi.fn();

    await expect(checkoutCommit('https://github.com/ada/repo.git', 'main', undefined, dir, sink)).resolves.toBe(
      '0123456789abcdef',
    );
    expect(git.checkout).toHaveBeenCalledWith('main');
    expect(sink).toHaveBeenCalledWith('origin has no branch main — using the local checkout');
  });

  it('r273: fails the checkout when moving to the remote tip fails', async () => {
    const dir = existingCheckout('existing-reset-fail', 'https://github.com/ada/repo.git');
    const git = makeGit();
    const baseRaw = git.raw;
    git.raw = vi.fn(async (args: string[]) => {
      if (args[0] === 'checkout') throw new Error('unable to unlink old file');
      return baseRaw(args);
    });
    gitState.simpleGit.mockImplementation(() => git);

    await expect(checkoutCommit('https://github.com/ada/repo.git', 'main', undefined, dir, vi.fn())).rejects.toThrow(
      'unable to unlink old file',
    );
  });

  it('checks out the pinned sha and falls back to it when the log is empty', async () => {
    const dir = existingCheckout('existing-sha', 'https://github.com/ada/repo.git');
    const git = makeGit();
    git.raw = vi.fn(async () => '');
    gitState.simpleGit.mockImplementation(() => git);

    const resolved = await checkoutCommit('https://github.com/ada/repo.git', 'main', 'deadbeef', dir, vi.fn());
    expect(git.checkout).toHaveBeenCalledWith('deadbeef');
    expect(resolved).toBe('deadbeef');
  });

  it('returns an empty string when no sha and the log is empty', async () => {
    const dir = existingCheckout('existing-no-sha', 'https://github.com/ada/repo.git');
    const git = makeGit();
    git.raw = vi.fn(async () => '');
    gitState.simpleGit.mockImplementation(() => git);

    const resolved = await checkoutCommit('https://github.com/ada/repo.git', 'main', undefined, dir, vi.fn());
    expect(resolved).toBe('');
  });

  it('initialises submodules when the checkout ships a .gitmodules', async () => {
    const dir = existingCheckout('submodule-repo', 'https://github.com/ada/repo.git');
    writeFileSync(path.join(dir, '.gitmodules'), '[submodule "lib"]\n\tpath = lib\n\turl = https://github.com/acme/lib.git\n');
    const git = makeGit();
    const subUpdate = vi.fn(async () => undefined);
    git.submoduleUpdate = subUpdate;
    gitState.simpleGit.mockImplementation(() => git);

    await checkoutCommit('https://github.com/ada/repo.git', 'main', undefined, dir, vi.fn());
    // One level at a time (r173) — `--recursive` skipped the egress gate for
    // nested submodules.
    expect(subUpdate).toHaveBeenCalledWith(['--init']);
  });

  it('r173: refuses a submodule URL that points at a private address', async () => {
    const dir = existingCheckout('submodule-ssrf', 'https://github.com/ada/repo.git');
    writeFileSync(path.join(dir, '.gitmodules'), '[submodule "meta"]\n\tpath = meta\n\turl = http://169.254.169.254/latest/meta-data\n');
    const git = makeGit();
    gitState.simpleGit.mockImplementation(() => git);

    await expect(checkoutCommit('https://github.com/ada/repo.git', 'main', undefined, dir, vi.fn())).rejects.toThrow();
    expect(git.submoduleUpdate).not.toHaveBeenCalled();
  });

  it('r173: refuses a submodule with a non-network transport', async () => {
    const dir = existingCheckout('submodule-file', 'https://github.com/ada/repo.git');
    writeFileSync(path.join(dir, '.gitmodules'), '[submodule "x"]\n\tpath = x\n\turl = file:///etc\n');
    const git = makeGit();
    gitState.simpleGit.mockImplementation(() => git);

    await expect(checkoutCommit('https://github.com/ada/repo.git', 'main', undefined, dir, vi.fn())).rejects.toThrow(/unsupported transport/);
    expect(git.submoduleUpdate).not.toHaveBeenCalled();
  });

  it('r172: re-clones when the service now points at a different repository', async () => {
    const dir = existingCheckout('moved-repo', 'https://github.com/old/app.git');
    const sink = vi.fn();
    await checkoutCommit('https://github.com/new/app.git', 'main', undefined, dir, sink);
    expect(sink).toHaveBeenCalledWith('Repository URL changed — re-cloning …');
    const bare = gitState.simpleGit.mock.results.find((r) => (r.value as ReturnType<typeof makeGit>).clone.mock.calls.length > 0);
    expect((bare!.value as ReturnType<typeof makeGit>).clone).toHaveBeenCalledWith('https://github.com/new/app.git', dir, []);
  });

  it('skips submodule init when the checkout has no .gitmodules', async () => {
    const dir = existingCheckout('no-submodules', 'https://github.com/ada/repo.git');
    const git = makeGit();
    const subUpdate = vi.fn(async () => undefined);
    git.submoduleUpdate = subUpdate;
    gitState.simpleGit.mockImplementation(() => git);

    await checkoutCommit('https://github.com/ada/repo.git', 'main', undefined, dir, vi.fn());
    expect(subUpdate).not.toHaveBeenCalled();
  });
});

describe('checkoutCommit — r355 DNS-rebinding pin', () => {
  it('pins git to the address the gate vetted, even when the name re-resolves to a private one', async () => {
    // Rebinding DNS: the gate's lookup sees public addresses; any later
    // resolution (git/libcurl's own) would see the metadata service.
    dns.lookup.mockReset();
    dns.lookup
      .mockResolvedValueOnce([
        { address: '140.82.121.4', family: 4 },
        { address: '2606:50c0:8000::153', family: 6 },
      ])
      .mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    const dir = gitDir('pin-rebind');
    await checkoutCommit('https://github.com/ada/repo.git', 'main', undefined, dir, vi.fn());

    const pinned = 'http.curloptResolve=github.com:443:140.82.121.4,[2606:50c0:8000::153]';
    // The clone and the checkout instance both carry the pin…
    expect(gitState.simpleGit.mock.calls[0]).toEqual([{ config: ['http.followRedirects=false', pinned] }]);
    expect(gitState.simpleGit.mock.calls[1]).toEqual([dir, { config: ['http.followRedirects=false', pinned] }]);
    // …and the name was resolved exactly once — by the gate.
    expect(dns.lookup).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(gitState.simpleGit.mock.calls)).not.toContain('169.254.169.254');
  });

  it('pins the fetch of a reused checkout too, with the explicit port of the remote', async () => {
    const dir = existingCheckout('pin-reuse', 'https://git.example.com:8443/team/app.git');
    const git = makeGit();
    gitState.simpleGit.mockImplementation(() => git);
    await checkoutCommit('https://git.example.com:8443/team/app.git', 'main', undefined, dir, vi.fn());
    expect(gitState.simpleGit).toHaveBeenCalledWith(dir, {
      config: ['http.followRedirects=false', `http.curloptResolve=git.example.com:8443:${VETTED_IP}`],
    });
    expect(git.fetch).toHaveBeenCalledWith(['--all']);
  });

  it('adds the pin of an absolute https submodule to the submodule update', async () => {
    const dir = existingCheckout('pin-submodule', 'https://github.com/ada/repo.git');
    writeFileSync(path.join(dir, '.gitmodules'), '[submodule "lib"]\n\tpath = lib\n\turl = https://gitlab.com/acme/lib.git\n');
    const git = makeGit();
    gitState.simpleGit.mockImplementation(() => git);
    await checkoutCommit('https://github.com/ada/repo.git', 'main', undefined, dir, vi.fn());
    expect(gitState.simpleGit).toHaveBeenCalledWith(dir, {
      config: [
        'http.followRedirects=false',
        `http.curloptResolve=github.com:443:${VETTED_IP}`,
        `http.curloptResolve=gitlab.com:443:${VETTED_IP}`,
      ],
    });
    expect(git.submoduleUpdate).toHaveBeenCalledWith(['--init']);
  });

  it('adds no pin for an ssh remote (documented residual gap) or an IP-literal https remote', async () => {
    await checkoutCommit('git@github.com:org/repo.git', 'main', undefined, gitDir('pin-ssh'), vi.fn());
    expect(gitState.simpleGit.mock.calls[0]).toEqual([{ config: ['http.followRedirects=false'] }]);
    gitState.simpleGit.mockClear();
    await checkoutCommit('https://140.82.121.4/org/repo.git', 'main', undefined, gitDir('pin-literal'), vi.fn());
    expect(gitState.simpleGit.mock.calls[0]).toEqual([{ config: ['http.followRedirects=false'] }]);
  });
});
