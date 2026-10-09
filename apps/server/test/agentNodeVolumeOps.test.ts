import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Multi-node T5: the two read-only agent ops the node Volumes page and the
 * node restore guard use (agentOps/volumes.ts, `docker.volumeUsage` and
 * `docker.volumeSize`, on `volume.manage`), registered in the T5 block of
 * the op registry. argv is captured at the `spawnValidated` seam; nothing
 * reaches Docker.
 */

const spawnMock = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => 0));
vi.mock('../src/lib/spawnValidated.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/spawnValidated.js')>()),
  spawnValidated: spawnMock,
}));

const registry = await import('../src/agentOps/index.js');
const { nodeVolumeOps, VOLUME_MISSING_EXIT, VOLUME_USAGE_FORMAT } = await import('../src/agentOps/volumes.js');
const { HELPER_IMAGE } = await import('../src/lib/inventory.js');

const run = (op: string, params: Record<string, unknown>, sealed = false) => {
  const lines: string[] = [];
  return registry.runRegisteredOp(op, params, (l) => lines.push(l), { sealed }, {}).then((code) => ({ code, lines }));
};
const argvs = () => spawnMock.mock.calls.map((c) => c[1] as string[]);

beforeEach(() => {
  spawnMock.mockReset().mockResolvedValue(0);
});

describe('T5 agent ops (registered, on volume.manage)', () => {
  it('are in the registry, in the T5 block, gated on volume.manage, unsealed allowed', () => {
    expect(registry.AGENT_OP_MODULES).toContain(nodeVolumeOps);
    for (const op of ['docker.volumeUsage', 'docker.volumeSize']) {
      expect(registry.AGENT_OPS.get(op)).toMatchObject({ cap: 'volume.manage', sealedOnly: false });
    }
    // No new capability: volume.manage is advertised once, where T2 put it.
    expect(registry.registeredCapabilities().filter((c) => c === 'volume.manage')).toHaveLength(1);
  });

  it('docker.volumeUsage runs a literal format only, whatever the params say', async () => {
    expect((await run('docker.volumeUsage', { format: '{{.Config.Env}}' })).code).toBe(0);
    expect(argvs()).toEqual([['ps', '-a', '--no-trunc', '--format', VOLUME_USAGE_FORMAT]]);
  });

  it('docker.volumeSize: managed names only, never creates a missing volume, du read-only without a network', async () => {
    await expect(run('docker.volumeSize', { name: '/etc' })).rejects.toThrow(/volume name/);
    await expect(run('docker.volumeSize', { name: 'nd-svc-a;rm' })).rejects.toThrow(/volume name/);
    expect(spawnMock).not.toHaveBeenCalled();

    // `docker volume inspect` exits 1: missing → no `docker run` (it would create the volume).
    spawnMock.mockResolvedValueOnce(1);
    const missing = await run('docker.volumeSize', { name: 'nd-svc-a-data' });
    expect(missing).toEqual({ code: VOLUME_MISSING_EXIT, lines: ['ND-VOLUME-MISSING nd-svc-a-data'] });
    expect(argvs()).toEqual([['volume', 'inspect', 'nd-svc-a-data']]);

    spawnMock.mockClear();
    expect((await run('docker.volumeSize', { name: 'nd-svc-a-data' })).code).toBe(0);
    expect(argvs()).toEqual([
      ['volume', 'inspect', 'nd-svc-a-data'],
      ['run', '--rm', '--network', 'none', '-v', 'nd-svc-a-data:/v:ro', HELPER_IMAGE, 'du', '-sb', '/v'],
    ]);
  });
});
