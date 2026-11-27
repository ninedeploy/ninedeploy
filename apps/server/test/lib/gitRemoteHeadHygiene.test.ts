/**
 * X2: what `remoteBranchHead` does around the git call itself (lib/git.ts): a host key the call
 * learnt is given back to a pinned source, and the directory of the call is removed after it,
 * the deploy key before all. The git call stands in here, and so does a removal that fails;
 * gitRemoteHead.test.ts runs the call for real.
 */
import { appendFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});

/** A removal that stands in for a file the system still holds, for as long as a test asks for it. */
const seam = vi.hoisted(() => ({
  capture: vi.fn(),
  removal: undefined as undefined | ((target: string) => void),
}));
vi.mock('../../src/lib/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/exec.js')>();
  return { ...actual, capture: seam.capture };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    rmSync: (target: string | Buffer | URL, options?: Parameters<typeof actual.rmSync>[1]) => {
      seam.removal?.(String(target));
      return actual.rmSync(target, options);
    },
  };
});

const { remoteBranchHead } = await import('../../src/lib/git.js');
const egress = await import('../../src/lib/gitEgress.js');

const URL_ = 'https://git.example.com/acme/web.git';
const SHA = 'a'.repeat(40);
const PINNED = 'git.example.com ssh-ed25519 AAAATEST';
const LEARNT = 'git.example.com ssh-rsa AAAANEW';
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nKEY\n-----END OPENSSH PRIVATE KEY-----\n';
const callDirectories = () => readdirSync(tmpdir()).filter((name) => name.startsWith('ninedeploy-ls-remote-'));

let before: string[];
beforeEach(() => {
  before = callDirectories();
  vi.spyOn(egress, 'vetCloneTarget').mockResolvedValue({ host: 'git.example.com', port: 443, addresses: ['203.0.113.7'] });
  seam.capture.mockReset();
  // The stand-in for the call answers with the head of `main`, and reports where it ran.
  seam.capture.mockImplementation(async (_cmd: string, _args: string[], opts: { cwd: string }) => {
    return `${SHA}\trefs/heads/main\n`;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  seam.removal = undefined;
  for (const name of callDirectories().filter((entry) => !before.includes(entry))) rmSync(path.join(tmpdir(), name), { recursive: true, force: true });
});

describe('a host key the call learnt', () => {
  /** A call that learnt the host's second key, as ssh writes it into the known_hosts of the call. */
  function learning() {
    seam.capture.mockImplementation(async (_cmd: string, _args: string[], opts: { cwd: string }) => {
      appendFileSync(path.join(opts.cwd, 'known_hosts'), `${LEARNT}\n`);
      return `${SHA}\trefs/heads/main\n`;
    });
  }
  const pinnedSource = (onHostKeys: (lines: string) => Promise<void>) => ({ deployKey: KEY, pinHostKeys: true, hostKeys: `${PINNED}\n`, onHostKeys });

  it('is given back to the pinned source with the keys it had', async () => {
    learning();
    const onHostKeys = vi.fn(async () => undefined);
    expect(await remoteBranchHead(URL_, 'main', pinnedSource(onHostKeys))).toBe(SHA);
    expect(onHostKeys).toHaveBeenCalledTimes(1);
    expect(onHostKeys).toHaveBeenCalledWith(`${PINNED}\n${LEARNT}\n`);
    expect(callDirectories().filter((entry) => !before.includes(entry))).toEqual([]);
  });

  it('is not reported when the call learnt none', async () => {
    const onHostKeys = vi.fn(async () => undefined);
    expect(await remoteBranchHead(URL_, 'main', pinnedSource(onHostKeys))).toBe(SHA);
    expect(onHostKeys).not.toHaveBeenCalled();
  });

  it('does not fail the call when the source cannot take it: it is learnt again next time', async () => {
    learning();
    const onHostKeys = vi.fn(async () => {
      throw new Error('database is locked');
    });
    expect(await remoteBranchHead(URL_, 'main', pinnedSource(onHostKeys))).toBe(SHA);
    expect(onHostKeys).toHaveBeenCalledTimes(1);
    expect(callDirectories().filter((entry) => !before.includes(entry))).toEqual([]);
  });
});

describe('the directory of the call', () => {
  const busy = (code: string) => Object.assign(new Error(`${code}: resource busy or locked`), { code });

  it('is removed, and a file still held is tried again', async () => {
    const removed: string[] = [];
    let held = true;
    seam.removal = (target) => {
      removed.push(target);
      if (held && target.endsWith('known_hosts')) {
        held = false;
        throw busy('EBUSY');
      }
    };
    expect(await remoteBranchHead(URL_, 'main', { type: 'custom', token: 'a-test-token' })).toBe(SHA);
    expect(removed.filter((target) => target.endsWith('known_hosts'))).toHaveLength(2);
    expect(callDirectories().filter((entry) => !before.includes(entry))).toEqual([]);
  });

  it('never keeps a deploy key: one that cannot be removed is thrown, after fifty more tries', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    seam.removal = (target) => {
      if (target.endsWith(`${path.sep}key`)) throw busy('EPERM');
    };
    const pending = remoteBranchHead(URL_, 'main', { deployKey: KEY });
    const outcome = pending.then(
      () => 'returned',
      (err: Error) => err.message,
    );
    const tries = vi.advanceTimersByTimeAsync(4_900);
    // Still trying: a deploy key is not given up on early.
    await expect(Promise.race([outcome, tries.then(() => 'trying')])).resolves.toBe('trying');
    await vi.advanceTimersByTimeAsync(200);
    expect(await outcome).toMatch(/the deploy key could not be removed after the call: .*ninedeploy-ls-remote-.*key/);
  });

  it('is given up after fifty more tries when it holds no key', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    seam.removal = (target) => {
      if (!target.endsWith('known_hosts')) throw busy('EBUSY');
    };
    const outcome = remoteBranchHead(URL_, 'main', { type: 'custom', token: 'a-test-token' }).then(
      (head) => `returned ${head === SHA}`,
      (err: Error) => `threw ${err.message}`,
    );
    await vi.advanceTimersByTimeAsync(5_100);
    expect(await outcome).toBe('returned true');
  });

  it('is gone after an ordinary call', async () => {
    expect(await remoteBranchHead(URL_, 'main', { deployKey: KEY })).toBe(SHA);
    const { cwd } = seam.capture.mock.calls[0]![2] as { cwd: string };
    expect(existsSync(cwd)).toBe(false);
  });
});
