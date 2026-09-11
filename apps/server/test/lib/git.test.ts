import { existsSync, mkdirSync, rmSync, } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const gitState = vi.hoisted(() => ({
  simpleGit: vi.fn(),
}));

vi.mock('simple-git', () => ({ simpleGit: gitState.simpleGit }));

const { checkoutCommit } = await import('../../src/lib/git.js');

/** Every simple-git instance carries the redirect hardening (r099). */
const HARDENED = { config: ['http.followRedirects=false'] };

const tmpRoot = path.join(os.tmpdir(), `ninedeploy-git-${process.pid}-${Date.now()}`);

function makeGit() {
  return {
    addConfig: vi.fn(async () => undefined),
    remote: vi.fn(async () => undefined),
    fetch: vi.fn(async () => undefined),
    checkout: vi.fn(async () => undefined),
    pull: vi.fn(async () => undefined),
    raw: vi.fn(async () => '0123456789abcdef\n'),
    clone: vi.fn(async () => undefined),
  };
}

function gitDir(name: string): string {
  return path.join(tmpRoot, name);
}

function existingCheckout(name: string): string {
  const dir = gitDir(name);
  mkdirSync(path.join(dir, '.git'), { recursive: true });
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
  it('fetches, checks out, pulls, and reuses the working tree', async () => {
    const dir = existingCheckout('existing-public');
    const git = makeGit();
    gitState.simpleGit.mockImplementation(() => git);

    const sink = vi.fn();
    const resolved = await checkoutCommit('https://github.com/ada/repo.git', 'main', undefined, dir, sink);

    expect(gitState.simpleGit).toHaveBeenCalledWith(dir, HARDENED);
    expect(git.fetch).toHaveBeenCalledWith(['--all']);
    expect(git.checkout).toHaveBeenCalledWith('main');
    expect(git.pull).toHaveBeenCalledWith('origin', 'main');
    expect(git.raw).toHaveBeenCalledWith(['log', '-1', '--format=%H']);
    expect(sink).toHaveBeenCalledWith('Fetching latest…');
    expect(resolved).toBe('0123456789abcdef');
  });

  it('refreshes the remote url when a token is provided', async () => {
    const dir = existingCheckout('existing-token');
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
    const dir = existingCheckout('existing-key');
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
    const dir = existingCheckout('existing-addconfig-fail');
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
    const dir = existingCheckout('existing-remote-fail');
    const git = makeGit();
    git.remote = vi.fn(async () => {
      throw new Error('remote failed');
    });
    gitState.simpleGit.mockImplementation(() => git);

    await expect(
      checkoutCommit('https://github.com/org/repo.git', 'main', undefined, dir, vi.fn(), { token: 't' }),
    ).rejects.toThrow('remote failed');
  });
});

describe('checkoutCommit — edge cases', () => {
  it('continues when pull fails (detached/empty remote)', async () => {
    const dir = existingCheckout('existing-pull-fail');
    const git = makeGit();
    git.pull = vi.fn(async () => {
      throw new Error('no upstream');
    });
    gitState.simpleGit.mockImplementation(() => git);

    await expect(
      checkoutCommit('https://github.com/ada/repo.git', 'main', undefined, dir, vi.fn()),
    ).resolves.toBe('0123456789abcdef');
  });

  it('checks out the pinned sha and falls back to it when the log is empty', async () => {
    const dir = existingCheckout('existing-sha');
    const git = makeGit();
    git.raw = vi.fn(async () => '');
    gitState.simpleGit.mockImplementation(() => git);

    const resolved = await checkoutCommit('https://github.com/ada/repo.git', 'main', 'deadbeef', dir, vi.fn());
    expect(git.checkout).toHaveBeenCalledWith('deadbeef');
    expect(resolved).toBe('deadbeef');
  });

  it('returns an empty string when no sha and the log is empty', async () => {
    const dir = existingCheckout('existing-no-sha');
    const git = makeGit();
    git.raw = vi.fn(async () => '');
    gitState.simpleGit.mockImplementation(() => git);

    const resolved = await checkoutCommit('https://github.com/ada/repo.git', 'main', undefined, dir, vi.fn());
    expect(resolved).toBe('');
  });
});
