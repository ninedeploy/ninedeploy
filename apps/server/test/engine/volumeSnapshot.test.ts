import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The three managed-volume helpers all work through a throwaway sidecar
 * container, so the assertions here are about the exact docker invocations:
 * that is the whole contract, and getting the mount flags or the cleanup wrong
 * is what would silently corrupt a volume.
 */
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
  it('tars the volume read-only in a sidecar and copies the archive out', async () => {
    const log = vi.fn();
    await backupVolume('nd-svc-web-data', '/backups/web.tar.gz', log);

    expect(pullMocks.ensureDockerImage).toHaveBeenCalledWith('alpine:3.21', log);
    // The source volume is mounted read-only: a snapshot must never be able to
    // modify what it is reading.
    const created = execMocks.capture.mock.calls[0]![1] as unknown as string[];
    expect(created).toContain('-v');
    expect(created).toContain('nd-svc-web-data:/v:ro');

    const args = runArgs();
    expect(args[0]).toEqual(['start', '-a', 'sidecar-id']);
    expect(args[1]).toEqual(['cp', 'sidecar-id:/tmp/ninedeploy-volume.tar.gz', '/backups/web.tar.gz']);
    expect(args[2]).toEqual(['rm', '-f', 'sidecar-id']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('/backups/web.tar.gz'));
  });

  it('removes the sidecar even when the snapshot fails', async () => {
    execMocks.run.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'start') throw new Error('tar exploded');
    });
    await expect(backupVolume('nd-svc-web-data', '/backups/web.tar.gz', vi.fn())).rejects.toThrow('tar exploded');
    expect(runArgs()).toContainEqual(['rm', '-f', 'sidecar-id']);
  });
});

describe('restoreVolume', () => {
  it('extracts into staging first and only then swaps the volume contents', async () => {
    const log = vi.fn();
    await restoreVolume('nd-svc-web-data', '/backups/web.tar.gz', log);

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

    const args = runArgs();
    expect(args[0]).toEqual(['cp', '/backups/web.tar.gz', 'sidecar-id:/tmp/ninedeploy-volume.tar.gz']);
    expect(args[1]).toEqual(['start', '-a', 'sidecar-id']);
    expect(args[2]).toEqual(['rm', '-f', 'sidecar-id']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('restored'));
  });

  it('uses a fresh staging suffix per restore so leftovers cannot collide', async () => {
    await restoreVolume('nd-svc-web-data', '/backups/web.tar.gz', vi.fn());
    await restoreVolume('nd-svc-web-data', '/backups/web.tar.gz', vi.fn());
    const first = (execMocks.capture.mock.calls[0]![1] as unknown as string[]).at(-1)!;
    const second = (execMocks.capture.mock.calls[1]![1] as unknown as string[]).at(-1)!;
    expect(first).not.toBe(second);
  });

  it('removes the sidecar even when the restore fails', async () => {
    execMocks.run.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'start') throw new Error('bad archive');
    });
    await expect(restoreVolume('nd-svc-web-data', '/backups/web.tar.gz', vi.fn())).rejects.toThrow('bad archive');
    expect(runArgs()).toContainEqual(['rm', '-f', 'sidecar-id']);
  });
});
