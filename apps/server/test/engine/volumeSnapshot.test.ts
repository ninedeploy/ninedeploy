import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The three managed-volume helpers all work through a throwaway sidecar
 * container, so the assertions here are about the exact docker invocations:
 * that is the whole contract, and getting the mount flags or the cleanup wrong
 * is what would silently corrupt a volume. The at-rest encryption runs for
 * real against a stubbed master key — the cipher path itself is under test.
 */
vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'a'.repeat(64));

// The volume operations take a cross-process lock file under the configured
// data dir — point it at a throwaway directory instead of the real one. The
// directory itself is created lazily by the lock; vi.hoisted may only touch
// globals, hence the primitive string building.
const lockDir = vi.hoisted(() => ({
  dataDir: `${process.env.TEMP ?? process.env.TMPDIR ?? '/tmp'}/nd-volsnap-${process.pid}`,
}));
vi.mock('../../src/config.js', () => ({ config: { paths: lockDir } }));

const execMocks = vi.hoisted(() => ({
  run: vi.fn(async () => undefined),
  capture: vi.fn(async () => 'sidecar-id\n'),
  sleep: vi.fn(async () => undefined),
}));
vi.mock('../../src/lib/exec.js', () => execMocks);

const pullMocks = vi.hoisted(() => ({
  ensureDockerImage: vi.fn(async () => undefined),
  pullDockerImage: vi.fn(async () => undefined),
}));
vi.mock('../../src/lib/dockerPull.js', () => pullMocks);

const { backupVolume, createDockerVolume, restoreVolume } = await import('../../src/engine/database.js');

/** The docker argv of each `run` call, for order-sensitive assertions. */
const runArgs = () => execMocks.run.mock.calls.map((c) => (c as unknown as [string, string[]])[1]);

/** Make the mocked `docker cp` out of the sidecar materialize the archive on
 * disk, so the engine's encrypt-in-place step has a real file to work on. */
function fakeArchiveCp(content: string, dest: string) {
  execMocks.run.mockImplementation(async (_cmd: string, args: string[]) => {
    if (args[0] === 'cp' && args[2] === dest) writeFileSync(dest, content);
    return undefined;
  });
}

afterEach(() => {
  for (const file of [SNAP, LEGACY]) {
    if (!existsSync(file)) continue;
    rmSync(file, { force: true });
    // stageForRestore names its temp siblings <file>.<uuid>.dec — sweep them.
    for (const entry of readdirSync(path.dirname(file))) {
      if (entry.startsWith(`${path.basename(file)}.`) && entry.endsWith('.dec')) {
        rmSync(path.join(path.dirname(file), entry), { force: true });
      }
    }
  }
});

const SNAP = path.join(os.tmpdir(), `nd-unit-snap-${process.pid}.tar.gz`);
const LEGACY = path.join(os.tmpdir(), `nd-unit-legacy-${process.pid}.tar.gz`);

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations, so a failure case from an earlier
  // test would otherwise leak into the next one.
  execMocks.run.mockImplementation(async () => undefined);
  execMocks.capture.mockResolvedValue('sidecar-id\n');
});

describe('createDockerVolume', () => {
  it('creates the named volume', async () => {
    await createDockerVolume('nd-svc-web-data');
    expect(runArgs()[0]).toEqual(['volume', 'create', 'nd-svc-web-data']);
  });

  it('forwards its log sink when one is given', async () => {
    const log = vi.fn();
    await createDockerVolume('nd-svc-web-data', log);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('nd-svc-web-data'));
  });
});

describe('backupVolume', () => {
  it('tars the volume read-only in a sidecar and encrypts the archive at rest', async () => {
    const log = vi.fn();
    fakeArchiveCp('tarball-bytes', SNAP);
    await backupVolume('nd-svc-web-data', SNAP, log);

    expect(pullMocks.ensureDockerImage).toHaveBeenCalledWith('alpine:3.21', log);
    // The source volume is mounted read-only: a snapshot must never be able to
    // modify what it is reading.
    const created = execMocks.capture.mock.calls[0]![1] as unknown as string[];
    expect(created).toContain('-v');
    expect(created).toContain('nd-svc-web-data:/v:ro');

    const args = runArgs();
    expect(args[0]).toEqual(['start', '-a', 'sidecar-id']);
    expect(args[1]).toEqual(['cp', 'sidecar-id:/tmp/ninedeploy-volume.tar.gz', SNAP]);
    expect(args[2]).toEqual(['rm', '-f', 'sidecar-id']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(SNAP));
    // Same at-rest posture as database dumps: the written file carries the
    // master-key stream envelope and leaks none of the volume bytes.
    const atRest = readFileSync(SNAP, 'utf8');
    expect(atRest.startsWith('NDBK1:')).toBe(true);
    expect(atRest).not.toContain('tarball-bytes');
  });

  it('removes the sidecar even when the snapshot fails', async () => {
    execMocks.run.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'start') throw new Error('tar exploded');
    });
    await expect(backupVolume('nd-svc-web-data', SNAP, vi.fn())).rejects.toThrow('tar exploded');
    expect(runArgs()).toContainEqual(['rm', '-f', 'sidecar-id']);
  });
});

describe('restoreVolume', () => {
  it('extracts into staging first and only then swaps the volume contents', async () => {
    const log = vi.fn();
    writeFileSync(LEGACY, 'plain-tarball');
    await restoreVolume('nd-svc-web-data', LEGACY, log);

    // Read-write mount; the script does the whole job inside the sidecar.
    const created = execMocks.capture.mock.calls[0]![1] as unknown as string[];
    expect(created).toContain('nd-svc-web-data:/v');
    const script = created.at(-1)!;
    expect(script.startsWith('set -e')).toBe(true);
    // Preflight rejects unreadable archives before any work.
    expect(script).toMatch(/^set -e\ntar -tzf \S+ >\/dev\/null$/m);
    // Extraction targets a hidden staging directory inside the volume, not
    // the volume root — a corrupt member or a full disk aborts with the
    // current contents untouched.
    expect(script).toMatch(/mkdir \/v\/\.nd-restore-[0-9a-f]{8}\ntar -xzf \S+ -C \/v\/\.nd-restore-[0-9a-f]{8}/);
    // The destructive phase (moving current data aside) may only run AFTER
    // extraction has completed, and cleanup never removes volume contents.
    const extractAt = script.indexOf('tar -xzf');
    const asideAt = script.indexOf('for f in /v/..?* /v/.[!.]* /v/*; do');
    expect(asideAt).toBeGreaterThan(extractAt);
    expect(script).not.toMatch(/rm -rf \/v\/\.\.\?\* /);
    // A rename failure rolls the aside-move back instead of leaving a mix.
    expect(script).toContain('rollback; exit 1');

    // A legacy plaintext archive stages as itself — no decryption sibling.
    const cp = runArgs().find((a) => a[0] === 'cp' && a[2]?.includes('ninedeploy-volume.tar.gz'))!;
    expect(cp[1]).toBe(LEGACY);
    const args = runArgs();
    expect(args).toContainEqual(['start', '-a', 'sidecar-id']);
    expect(args).toContainEqual(['rm', '-f', 'sidecar-id']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('restored'));
  });

  it('decrypts an encrypted snapshot to a temp sibling and cleans it up', async () => {
    fakeArchiveCp('secret-tarball', SNAP);
    await backupVolume('nd-svc-web-data', SNAP, vi.fn());

    // Capture the staged plaintext at the moment of the copy — restoreVolume
    // unlinks the sibling in its finally block before returning.
    let stagedPath: string | undefined;
    let stagedContent: string | undefined;
    execMocks.run.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'cp' && String(args[1]).endsWith('.dec')) {
        stagedPath = String(args[1]);
        stagedContent = readFileSync(stagedPath, 'utf8');
      }
      return undefined;
    });

    await restoreVolume('nd-svc-web-data', SNAP, vi.fn());

    // The sidecar received a decrypted sibling, not the encrypted file —
    // holding exactly the original archive — and it is gone afterwards.
    expect(stagedPath).toMatch(/nd-unit-snap-.+\.dec$/);
    expect(stagedPath).not.toBe(SNAP);
    expect(stagedContent).toBe('secret-tarball');
    expect(stagedPath && existsSync(stagedPath)).toBe(false);
  });

  it('uses a fresh staging suffix per restore so leftovers cannot collide', async () => {
    writeFileSync(LEGACY, 'plain-tarball');
    await restoreVolume('nd-svc-web-data', LEGACY, vi.fn());
    await restoreVolume('nd-svc-web-data', LEGACY, vi.fn());
    const first = (execMocks.capture.mock.calls[0]![1] as unknown as string[]).at(-1)!;
    const second = (execMocks.capture.mock.calls[1]![1] as unknown as string[]).at(-1)!;
    expect(first).not.toBe(second);
  });

  it('removes the sidecar even when the restore fails', async () => {
    writeFileSync(LEGACY, 'plain-tarball');
    execMocks.run.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'start') throw new Error('bad archive');
    });
    await expect(restoreVolume('nd-svc-web-data', LEGACY, vi.fn())).rejects.toThrow('bad archive');
    expect(runArgs()).toContainEqual(['rm', '-f', 'sidecar-id']);
  });
});

afterAll(() => {
  rmSync(lockDir.dataDir, { recursive: true, force: true });
});

describe('cross-process operation lock', () => {
  it('refuses with 409 while another process holds the volume lock', async () => {
    const lockFile = path.join(lockDir.dataDir, 'op-locks', 'volume-nd-svc-web-data.lock');
    mkdirSync(path.dirname(lockFile), { recursive: true });
    writeFileSync(lockFile, `different-process ${Date.now()}`);
    try {
      await expect(backupVolume('nd-svc-web-data', SNAP, vi.fn())).rejects.toMatchObject({ statusCode: 409 });
    } finally {
      rmSync(lockFile, { force: true });
    }
  });
});
