import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureDockerImage,
  pullDockerImage,
  recoverImageDirectlyFromRegistry,
  recoverImageWithNativeSnapshotter,
} from '../../src/lib/dockerPull.js';

const h = vi.hoisted(() => ({
  run: vi.fn(),
  capture: vi.fn(),
  sleep: vi.fn(async () => undefined),
}));

vi.mock('../../src/lib/exec.js', () => ({ capture: h.capture, run: h.run, sleep: h.sleep }));

// Same pin as dockerPull.test.ts: no containerd socket, so ctr args carry no --address.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: (p: string) => !String(p).endsWith('containerd.sock') && actual.existsSync(p) };
});

const ARCH = process.arch === 'x64' ? 'amd64' : process.arch;
const STALE = 'unable to prepare extraction snapshot: target snapshot "sha256:abc" already exists';

/** Every temp dir the module created (crane staging, recovery staging), removed after each test. */
const created = new Set<string>();
afterEach(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
  created.clear();
});

/** Fake `tar -xzf … -C <staging> crane`: create the binary so the cache sees it. */
function fakeCraneExtraction(cmd: string, args: string[]): boolean {
  if (cmd !== 'tar' || args[0] !== '-xzf') return false;
  created.add(args[3]!);
  writeFileSync(path.join(args[3]!, 'crane'), '');
  return true;
}

/** The --change values handed to `docker image import`. */
const importChanges = () => {
  const call = h.run.mock.calls.find(([cmd, args]) => cmd === 'docker' && args[0] === 'image' && args[1] === 'import');
  const args = (call?.[1] ?? []) as string[];
  return args.flatMap((a, i) => (args[i - 1] === '--change' ? [a] : []));
};

describe('dockerPull — uncovered recovery paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.run.mockReset();
    h.capture.mockReset();
  });

  it('translates every OCI config field into an import --change, including shell and NONE healthchecks', async () => {
    h.run.mockImplementation(async (cmd: string, args: string[]) => { fakeCraneExtraction(cmd, args); });
    h.capture
      .mockResolvedValueOnce(JSON.stringify({
        config: {
          Env: ['NOVALUE', 'A=b=c'],
          StopSignal: 'SIGQUIT',
          Labels: { maintainer: 'me' },
          OnBuild: ['RUN echo hi'],
          Healthcheck: { Test: ['CMD-SHELL', 'curl -f http://localhost/ || exit 1'], Interval: 1, Timeout: 2, StartPeriod: 3, StartInterval: 4, Retries: 5 },
        },
      }))
      .mockResolvedValueOnce('sha256:one')
      .mockResolvedValueOnce(JSON.stringify({ config: { Healthcheck: { Test: ['NONE'] } } }))
      .mockResolvedValueOnce('sha256:two')
      .mockResolvedValueOnce(JSON.stringify({ config: { Healthcheck: { Test: [] , Interval: 0 } } }))
      .mockResolvedValueOnce('sha256:three')
      .mockResolvedValueOnce(JSON.stringify({}))
      .mockResolvedValueOnce('sha256:four');

    await recoverImageDirectlyFromRegistry('a:1', vi.fn(), 'a:recovered');
    expect(importChanges()).toEqual([
      'ENV NOVALUE',
      'ENV A="b=c"',
      'STOPSIGNAL SIGQUIT',
      'LABEL maintainer="me"',
      'ONBUILD RUN echo hi',
      'HEALTHCHECK --interval=1ns --timeout=2ns --start-period=3ns --start-interval=4ns --retries=5 CMD curl -f http://localhost/ || exit 1',
    ]);
    expect(h.run.mock.calls.at(-1)![1]).toContain('a:recovered');

    h.run.mockClear();
    await recoverImageDirectlyFromRegistry('b:1', vi.fn());
    expect(importChanges()).toEqual(['HEALTHCHECK NONE']);
    // The crane binary was cached: only one download across both recoveries.
    expect(h.run.mock.calls.filter(([cmd]) => cmd === 'curl')).toHaveLength(0);

    h.run.mockClear();
    await recoverImageDirectlyFromRegistry('c:1', vi.fn());
    expect(importChanges()).toEqual([]);
    h.run.mockClear();
    await recoverImageDirectlyFromRegistry('d:1', vi.fn());
    expect(importChanges()).toEqual([]);
  });

  it('selects the host platform from a manifest list (lower- and upper-case platform fields)', async () => {
    let mountedRootfs = '';
    h.run.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'ctr' && args.includes('mount')) mountedRootfs = args.at(-1)!;
    });
    h.capture
      .mockResolvedValueOnce(JSON.stringify({ target: { digest: 'sha256:index' } }))
      .mockResolvedValueOnce(JSON.stringify({
        manifests: [
          { digest: 'sha256:win', platform: { os: 'windows', architecture: ARCH } },
          {},
          { Digest: 'sha256:host', Platform: { OS: 'linux', Architecture: ARCH } },
        ],
      }))
      .mockResolvedValueOnce(JSON.stringify({ config: { Digest: 'sha256:cfg' } }))
      .mockResolvedValueOnce(JSON.stringify({ config: { User: 'app' } }))
      .mockResolvedValueOnce('sha256:imported');
    const log = vi.fn();

    await recoverImageWithNativeSnapshotter('localhost/app:1', log);

    const gets = h.capture.mock.calls.filter(([, args]) => (args as string[]).includes('get')).map(([, args]) => (args as string[]).at(-1));
    expect(gets).toEqual(['sha256:index', 'sha256:host', 'sha256:cfg']);
    expect(importChanges()).toEqual(['USER app']);
    expect(h.run).toHaveBeenCalledWith('ctr', ['--namespace', 'moby', 'images', 'unmount', mountedRootfs], {}, expect.any(Function));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('existing Docker state was preserved'));
  });

  it.each([
    ['no target digest', [{}], 'containerd image has no target digest'],
    ['no manifest for the host', [{ Target: { Digest: 'sha256:i' } }, { manifests: [{ digest: 'sha256:w', platform: { os: 'windows', architecture: ARCH } }] }], `containerd image has no linux/${ARCH} manifest`],
    ['no config digest', [{ target: { digest: 'sha256:m' } }, { config: {} }], 'containerd image manifest has no config digest'],
  ])('fails native recovery when the image has %s, and removes its staging', async (_name, replies, message) => {
    for (const reply of replies) h.capture.mockResolvedValueOnce(JSON.stringify(reply));
    h.run.mockResolvedValue(undefined);
    await expect(recoverImageWithNativeSnapshotter('app:1', vi.fn())).rejects.toThrow(message);
    expect(h.run.mock.calls.some(([cmd, args]) => cmd === 'ctr' && (args as string[]).includes('mount'))).toBe(false);
  });

  it('rethrows a native pull failure that is not the transfer-platform bug', async () => {
    h.run.mockImplementation(async (_cmd: string, _args: string[], _opts: unknown, sink: (l: string) => void) => {
      sink('ctr: failed to resolve reference: not found');
      throw new Error('ctr pull exited 1');
    });
    await expect(recoverImageWithNativeSnapshotter('app:1', vi.fn())).rejects.toThrow('ctr pull exited 1');
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it('leaves a rootfs it could not unmount in place, and says so', async () => {
    let rootfs = '';
    h.run.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'ctr' && args.includes('mount')) rootfs = args.at(-1)!;
      if (cmd === 'ctr' && args.includes('unmount')) throw new Error('device busy');
      if (cmd === 'tar') throw new Error('tar exited 2');
    });
    h.capture
      .mockResolvedValueOnce(JSON.stringify({ target: { digest: 'sha256:m' } }))
      .mockResolvedValueOnce(JSON.stringify({ config: { digest: 'sha256:c' } }))
      .mockResolvedValueOnce(JSON.stringify({ config: {} }));
    const log = vi.fn();

    await expect(recoverImageWithNativeSnapshotter('app:1', log)).rejects.toThrow('tar exited 2');
    created.add(path.dirname(rootfs));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Could not unmount recovery rootfs'));
    const { existsSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
    expect(existsSync(rootfs)).toBe(true);
  });

  it('refuses to remove a non-committed stale snapshot, then reports every recovery failure', async () => {
    const key = `sha256:${'b'.repeat(64)}`;
    h.run.mockImplementation(async (cmd: string, args: string[], _opts: unknown, sink: (l: string) => void) => {
      if (cmd === 'docker' && args[0] === 'pull') {
        sink(`unable to prepare extraction snapshot: target snapshot "${key}" already exists`);
        throw new Error('docker pull exited 1');
      }
      if (cmd === 'ctr') throw 'native string failure';
      if (cmd === 'curl') throw 'registry string failure';
    });
    h.capture.mockResolvedValueOnce(JSON.stringify({ kind: 1 }));
    const log = vi.fn();

    await expect(pullDockerImage('app:1', log, 3)).rejects.toThrow(
      'docker pull exited 1; native snapshot recovery failed: native string failure; direct registry recovery failed: registry string failure',
    );
    // The stale-target error is persistent: no retries.
    expect(h.sleep).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(`Refusing to remove stale snapshot ${key}: containerd reports non-committed kind 1`);
    expect(h.run.mock.calls.some(([cmd, args]) => cmd === 'ctr' && (args as string[]).includes('remove'))).toBe(false);
  });

  it('treats a snapshot info failure as "repair not applicable" and recovers natively', async () => {
    const key = `sha256:${'c'.repeat(64)}`;
    h.run.mockImplementation(async (cmd: string, args: string[], _opts: unknown, sink: (l: string) => void) => {
      if (cmd === 'docker' && args[0] === 'pull') {
        sink(`target snapshot ${key} already exists`);
        throw 'pull failed as a string';
      }
    });
    h.capture
      .mockRejectedValueOnce('snapshot info string failure')
      .mockResolvedValueOnce(JSON.stringify({ target: { digest: 'sha256:m' } }))
      .mockResolvedValueOnce(JSON.stringify({ config: { digest: 'sha256:c' } }))
      .mockResolvedValueOnce(JSON.stringify({ config: {} }))
      .mockResolvedValueOnce('sha256:imported');
    const log = vi.fn();

    await pullDockerImage('app:1', log, 1);
    expect(log).toHaveBeenCalledWith('Targeted stale snapshot repair was not applicable: snapshot info string failure');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('recovering app:1 through containerd'));
  });

  it('combines Error messages when every recovery fails after a snapshot race without a stale key', async () => {
    h.run.mockImplementation(async (cmd: string, args: string[], _opts: unknown, sink: (l: string) => void) => {
      if (cmd === 'docker' && args[0] === 'pull') {
        sink('failed to prepare extraction snapshot: parent snapshot sha256:x does not exist');
        throw 'string pull failure';
      }
      throw new Error(`${cmd} failed`);
    });
    await expect(pullDockerImage('app:1', vi.fn(), 1)).rejects.toThrow(
      'string pull failure; native snapshot recovery failed: ctr failed; direct registry recovery failed: curl failed',
    );
  });

  it('re-downloads crane after a failed download instead of caching the failure', async () => {
    let curls = 0;
    h.run.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'curl' && curls++ === 0) throw new Error('curl: (6) could not resolve host');
      fakeCraneExtraction(cmd, args);
    });
    h.capture.mockImplementation(async (cmd: string) => (cmd.endsWith('crane') ? JSON.stringify({ config: {} }) : 'sha256:x'));

    await expect(recoverImageDirectlyFromRegistry('e:1', vi.fn())).rejects.toThrow('could not resolve host');
    await recoverImageDirectlyFromRegistry('e:1', vi.fn());
    expect(curls).toBe(2);
  });
});

describe('dockerPull — host architecture and ensureDockerImage', () => {
  const realArch = process.arch;
  const setArch = (arch: string) => Object.defineProperty(process, 'arch', { value: arch, configurable: true });
  afterEach(() => setArch(realArch));
  beforeEach(() => {
    h.run.mockReset();
    h.capture.mockReset();
  });

  it('maps arm64 and passes other architectures through (direct recovery refuses them)', async () => {
    h.run.mockImplementation(async (cmd: string, args: string[], _opts: unknown, sink: (l: string) => void) => {
      if (cmd === 'ctr') { sink('boom'); throw new Error('ctr unavailable'); }
    });
    setArch('arm64');
    await expect(recoverImageWithNativeSnapshotter('app:1', vi.fn())).rejects.toThrow('ctr unavailable');
    expect(h.run.mock.calls[0]![1]).toContain('linux/arm64');

    setArch('s390x');
    await expect(recoverImageWithNativeSnapshotter('app:1', vi.fn())).rejects.toThrow('ctr unavailable');
    expect(h.run.mock.calls.at(-1)![1]).toContain('linux/s390x');
    // No pinned crane release exists for it. Any crane cached by an earlier test
    // was removed by its afterEach, so the preparation always runs again here.
    await expect(recoverImageDirectlyFromRegistry('app:1', vi.fn())).rejects.toThrow('direct registry recovery does not support linux/s390x');
    expect(h.run.mock.calls.some(([cmd]) => cmd === 'curl')).toBe(false);
  });

  it('fails a timed-out inspect instead of pulling against a wedged daemon (F975)', async () => {
    const timeout = Object.assign(new Error('docker image inspect timed out'), { name: 'ExecTimeoutError' });
    h.capture.mockRejectedValueOnce(timeout);
    await expect(ensureDockerImage('busybox:1', vi.fn())).rejects.toBe(timeout);
    expect(h.run).not.toHaveBeenCalled();
  });

  it('shares one pull between concurrent callers and evicts it afterwards', async () => {
    h.capture.mockRejectedValue('No such image');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    h.run.mockImplementation(async () => { await gate; });

    const a = ensureDockerImage('shared:1', vi.fn());
    const b = ensureDockerImage('shared:1', vi.fn());
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([a, b]);
    expect(h.run).toHaveBeenCalledTimes(1);

    await ensureDockerImage('shared:1', vi.fn());
    expect(h.run).toHaveBeenCalledTimes(2);
  });
});
