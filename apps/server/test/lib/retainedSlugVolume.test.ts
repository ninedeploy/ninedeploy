import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  listManagedVolumeNames: vi.fn(async () => [] as string[]),
  agentOp: vi.fn(async (_db: unknown, _id: unknown, _op: unknown, _p: unknown, sink?: (l: string) => void) => {
    sink?.('probe'); // exercise the module's sink arrow (coverage)
    return { exitCode: 0, lines: [] };
  }),
}));
vi.mock('../../src/lib/inventory.js', () => ({
  listManagedVolumeNames: mocks.listManagedVolumeNames,
}));
vi.mock('../../src/lib/agentClient.js', () => ({ agentOp: mocks.agentOp }));

import { assertSlugVolumeNotRetained } from '../../src/lib/retainedSlugVolume.js';

/** r466: the retention guard must probe the NODE for remote services. */
describe('assertSlugVolumeNotRetained (r351/r466)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listManagedVolumeNames.mockResolvedValue([]);
    mocks.agentOp.mockResolvedValue({ exitCode: 1, lines: [] });
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

  it('node path: probes the node agent, not the local daemon', async () => {
    mocks.listManagedVolumeNames.mockResolvedValue(['nd-svc-web-data']); // local volume is IRRELEVANT
    mocks.agentOp.mockResolvedValue({ exitCode: 1, lines: [] }); // node: missing
    await expect(
      assertSlugVolumeNotRetained('web', 'docker', { db: {} as never, serverId: 7 }),
    ).resolves.toBeUndefined();
    expect(mocks.agentOp).toHaveBeenCalledWith(
      {} as never,
      7,
      'docker.volumeInspect',
      { name: 'nd-svc-web-data' },
      expect.any(Function),
    );
    expect(mocks.listManagedVolumeNames).not.toHaveBeenCalled();
  });

  it('node path: a retained NODE volume blocks with a node-naming 409', async () => {
    mocks.agentOp.mockResolvedValue({ exitCode: 0, lines: ['[]'] });
    const err = await assertSlugVolumeNotRetained('web', 'docker', { db: {} as never, serverId: 7 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 409, code: 'slug_volume_retained' });
    expect(String((err as Error).message)).toContain('ON NODE #7');
    expect(String((err as Error).message)).toContain('serverId=7');
  });

  it('node path: an unreachable agent fails closed (treated as retained), pm2 exempt', async () => {
    mocks.agentOp.mockRejectedValue(new Error('node offline'));
    await expect(
      assertSlugVolumeNotRetained('web', 'docker', { db: {} as never, serverId: 7 }),
    ).rejects.toMatchObject({ code: 'slug_volume_retained' });
    await expect(
      assertSlugVolumeNotRetained('web', 'pm2', { db: {} as never, serverId: 7 }),
    ).resolves.toBeUndefined();
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
