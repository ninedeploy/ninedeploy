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
  it('empties the volume before extracting, then cleans up', async () => {
    const log = vi.fn();
    await restoreVolume('nd-svc-web-data', '/backups/web.tar.gz', log);

    // Read-write mount plus an rm-then-extract command: extracting over the
    // existing contents would merge them and keep files the snapshot lacks.
    const created = execMocks.capture.mock.calls[0]![1] as unknown as string[];
    expect(created).toContain('nd-svc-web-data:/v');
    expect(created.join(' ')).toContain('rm -rf');
    expect(created.join(' ')).toContain('tar -xzf');

    const args = runArgs();
    expect(args[0]).toEqual(['cp', '/backups/web.tar.gz', 'sidecar-id:/tmp/ninedeploy-volume.tar.gz']);
    expect(args[1]).toEqual(['start', '-a', 'sidecar-id']);
    expect(args[2]).toEqual(['rm', '-f', 'sidecar-id']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('restored'));
  });

  it('removes the sidecar even when the restore fails', async () => {
    execMocks.run.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'start') throw new Error('bad archive');
    });
    await expect(restoreVolume('nd-svc-web-data', '/backups/web.tar.gz', vi.fn())).rejects.toThrow('bad archive');
    expect(runArgs()).toContainEqual(['rm', '-f', 'sidecar-id']);
  });
});
