import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  // The node probe's exit code (and, F332, its output), switchable per test.
  // A non-zero exit answers docker's "No such volume" unless a test says otherwise.
  const node = { exitCode: 0, lines: null as string[] | null };
  // r470: the mock mirrors the REAL agentOp contract — non-zero exit codes
  // THROW unless the caller passes { tolerateExit: true }. A mock that
  // happily resolved { exitCode: 1 } is exactly how r466 shipped a probe
  // that threw on the very case it was probing for.
  const agentOpImpl = async (
    _db: unknown,
    _id: unknown,
    op: unknown,
    _p: unknown,
    sink?: (l: string) => void,
    opts?: { tolerateExit?: boolean },
  ) => {
    sink?.('probe'); // exercise the module's sink arrow (coverage)
    if (node.exitCode !== 0 && !opts?.tolerateExit) {
      throw new Error(`agent ${String(op)} exited with ${node.exitCode}`);
    }
    return { exitCode: node.exitCode, lines: node.lines ?? (node.exitCode !== 0 ? ['[]', 'Error: No such volume: nd-svc-web-data'] : []) };
  };
  return {
    node,
    agentOpImpl,
    listManagedVolumeNames: vi.fn(async () => [] as string[]),
    agentOp: vi.fn(agentOpImpl),
  };
});
vi.mock('../../src/lib/inventory.js', () => ({
  listManagedVolumeNames: mocks.listManagedVolumeNames,
}));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: mocks.agentOp }));
const execMocks = vi.hoisted(() => ({ capture: vi.fn(async () => '') }));
vi.mock('../../src/lib/exec.js', () => execMocks);

import { assertSlugVolumeNotRetained } from '../../src/lib/retainedSlugVolume.js';

/** r466: the retention guard must probe the NODE for remote services. */
describe('assertSlugVolumeNotRetained (r351/r466)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks clears CALLS, not implementations — a previous test's
    // mockRejectedValue would otherwise leak into the next one. Re-bind the
    // contract-faithful implementation every time.
    mocks.agentOp.mockImplementation(mocks.agentOpImpl);
    mocks.listManagedVolumeNames.mockResolvedValue([]);
    mocks.node.exitCode = 0;
    mocks.node.lines = null;
  });

  it('local path: a retained local volume blocks the slug', async () => {
    mocks.listManagedVolumeNames.mockResolvedValue(['nd-svc-web-data']);
    await expect(assertSlugVolumeNotRetained('web', 'docker')).rejects.toMatchObject({
      statusCode: 409,
      code: 'slug_volume_retained',
    });
  });

  it('local path: unreachable docker fails closed except for pm2', async () => {
    mocks.listManagedVolumeNames.mockRejectedValue(new Error('docker down'));
    await expect(assertSlugVolumeNotRetained('web', 'docker')).rejects.toMatchObject({ code: 'slug_volume_retained' });
    await expect(assertSlugVolumeNotRetained('web', 'pm2')).resolves.toBeUndefined();
  });

  it('node path: probes the node agent with tolerateExit — exit 1 means MISSING, not failure', async () => {
    mocks.listManagedVolumeNames.mockResolvedValue(['nd-svc-web-data']); // local volume is IRRELEVANT
    mocks.node.exitCode = 1; // node says: no such volume
    await expect(
      assertSlugVolumeNotRetained('web', 'docker', { db: {} as never, serverId: 7 }),
    ).resolves.toBeUndefined();
    // The whole r470 fix is this 6th argument: without it the real agentOp
    // throws on exit 1, the catch fails closed, and EVERY fresh slug 409s.
    expect(mocks.agentOp).toHaveBeenCalledWith(
      {} as never,
      7,
      'docker.volumeInspect',
      { name: 'nd-svc-web-data' },
      expect.any(Function),
      { tolerateExit: true },
    );
    expect(mocks.listManagedVolumeNames).not.toHaveBeenCalled();
  });

  it('node path: a retained NODE volume blocks with a node-naming 409', async () => {
    mocks.node.exitCode = 0; // volume exists on the node
    const err = await assertSlugVolumeNotRetained('web', 'docker', { db: {} as never, serverId: 7 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 409, code: 'slug_volume_retained' });
    expect(String((err as Error).message)).toContain('ON NODE #7');
    expect(String((err as Error).message)).toContain('serverId=7');
  });

  it('node path: an unreachable agent fails closed (treated as retained), pm2 exempt', async () => {
    // BOTH calls see the offline agent (mockRejectedValue, not ...Once): the
    // docker create fails closed, and the pm2 create is exempted by the
    // unreachable-only carve-out (a pm2 service never mounts a docker volume
    // and must stay creatable while the node is down).
    mocks.agentOp.mockRejectedValue(new Error('node offline'));
    await expect(
      assertSlugVolumeNotRetained('web', 'docker', { db: {} as never, serverId: 7 }),
    ).rejects.toMatchObject({ code: 'slug_volume_retained' });
    await expect(
      assertSlugVolumeNotRetained('web', 'pm2', { db: {} as never, serverId: 7 }),
    ).resolves.toBeUndefined();
  });

  it('node path: a pm2 service is NOT exempt when the node definitively says the volume exists', async () => {
    mocks.node.exitCode = 0;
    await expect(
      assertSlugVolumeNotRetained('web', 'pm2', { db: {} as never, serverId: 7 }),
    ).rejects.toMatchObject({ code: 'slug_volume_retained' });
  });

  // F332: `docker volume inspect` exits 1 for "no such volume" AND for a
  // daemon the CLI cannot reach (124: agent timeout, 127: unspawnable). Only
  // docker's own "No such volume" is a definitive MISSING — the rest used to
  // read as missing too, so a node with a sick daemon let a freed slug
  // re-mount a deleted service's node data once the daemon came back.
  it('node path: a non-zero exit WITHOUT "No such volume" is unanswered — fails closed, pm2 exempt', async () => {
    for (const [exitCode, lines] of [
      [1, ['Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?']],
      [124, ['Operation timed out after 595000ms — killed']],
      [127, []],
    ] as Array<[number, string[]]>) {
      mocks.node.exitCode = exitCode;
      mocks.node.lines = lines;
      const err = await assertSlugVolumeNotRetained('web', 'docker', { db: {} as never, serverId: 7 }).catch((e: unknown) => e);
      expect(err).toMatchObject({ statusCode: 409, code: 'slug_volume_retained' });
      expect(String((err as Error).message)).toContain(`docker volume inspect exited ${exitCode}`);
      await expect(assertSlugVolumeNotRetained('web', 'pm2', { db: {} as never, serverId: 7 })).resolves.toBeUndefined();
    }
    // Both CLI spellings of the definitive answer still free the slug.
    mocks.node.exitCode = 1;
    mocks.node.lines = ['[]', 'Error response from daemon: get nd-svc-web-data: no such volume'];
    await expect(assertSlugVolumeNotRetained('web', 'docker', { db: {} as never, serverId: 7 })).resolves.toBeUndefined();
  });
});

describe('assertSlugVolumeNotRetained — argument contract (r466)', () => {
  it('refuses a node probe without the db instead of failing mysteriously', async () => {
    await expect(assertSlugVolumeNotRetained('web', 'docker', { serverId: 7 })).rejects.toThrow(
      /needs the db/i,
    );
  });

  it('exports the volume-name convention it guards', async () => {
    const mod = await import('../../src/lib/retainedSlugVolume.js');
    expect(mod.primaryServiceVolumeName('web')).toBe('nd-svc-web-data');
  });
});

/**
 * r662: an EXISTING service moving between hosts may meet its own volume
 * from an earlier placement there. Slugs are unique among live rows, so a
 * volume Docker created after the row existed is the service's own; one
 * created before it is a deleted service's.
 */
describe('r662: own-volume exemption for a moving service', () => {
  const row = new Date('2026-06-01T00:00:00Z');
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listManagedVolumeNames.mockResolvedValue(['nd-svc-web-data']);
  });

  it('local: a volume created after the service row is its own — allowed', async () => {
    execMocks.capture.mockResolvedValueOnce('2026-07-01T10:00:00Z\n');
    await expect(assertSlugVolumeNotRetained('web', 'docker', { ownerCreatedAt: row })).resolves.toBeUndefined();
    expect(execMocks.capture).toHaveBeenCalledWith('docker', ['volume', 'inspect', '--format', '{{.CreatedAt}}', 'nd-svc-web-data']);
  });

  it('local: a volume older than the row is a deleted service — refused', async () => {
    execMocks.capture.mockResolvedValueOnce('2025-01-01T10:00:00Z\n');
    await expect(assertSlugVolumeNotRetained('web', 'docker', { ownerCreatedAt: row })).rejects.toMatchObject({ code: 'slug_volume_retained' });
  });

  it('local: an unreadable stamp stays refused (fail closed)', async () => {
    execMocks.capture.mockRejectedValueOnce(new Error('docker down'));
    await expect(assertSlugVolumeNotRetained('web', 'docker', { ownerCreatedAt: row })).rejects.toMatchObject({ code: 'slug_volume_retained' });
  });

  it('create (no owner yet) never consults the stamp', async () => {
    await expect(assertSlugVolumeNotRetained('web', 'docker')).rejects.toMatchObject({ code: 'slug_volume_retained' });
    expect(execMocks.capture).not.toHaveBeenCalled();
  });
});
