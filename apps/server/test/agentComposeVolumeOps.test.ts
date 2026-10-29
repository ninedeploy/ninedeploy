import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G3.1 compose stack volumes on a node (agentOps/volumes.ts, `volume.compose`):
 * listing by compose's project label, creating with compose's labels, and the
 * volume transfer kinds taking `ndcmp-<slug>_<key>` only when compose made
 * that volume for that project. argv is captured at the `spawnValidated`
 * seam; nothing reaches Docker.
 */

const spawnMock = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => 0));
vi.mock('../src/lib/spawnValidated.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/spawnValidated.js')>()),
  spawnValidated: spawnMock,
}));

const registry = await import('../src/agentOps/index.js');
const { volumeExportKind, volumeImportKind, COMPOSE_VOLUME_FORMAT } = await import('../src/agentOps/volumes.js');

const run = (op: string, params: Record<string, unknown>, sealed = true) => {
  const lines: string[] = [];
  return registry.runRegisteredOp(op, params, (l) => lines.push(l), { sealed }, {}).then((code) => ({ code, lines }));
};
const argvs = () => spawnMock.mock.calls.map((c) => c[1] as string[]);

/** A docker whose volume inspect answers `label` (null = no such volume). */
function dockerWithLabel(label: string | null) {
  spawnMock.mockImplementation(async (_bin: unknown, args: string[], onLine?: unknown) => {
    if (args[0] === 'volume' && args[1] === 'inspect') {
      if (label === null) return 1;
      if (args.includes('--format')) (onLine as (l: string) => void)(label);
      return 0;
    }
    return 0;
  });
}

beforeEach(() => {
  spawnMock.mockReset().mockResolvedValue(0);
});
afterEach(() => {
  delete process.env['NINEDEPLOY_AGENT_VOLUME_COMPOSE'];
});

describe('volume.compose ops', () => {
  it('are registered on volume.compose, sealed only, and switched off by the node owner', () => {
    expect(registry.AGENT_OPS.get('docker.composeVolumes')).toMatchObject({ cap: 'volume.compose', sealedOnly: true });
    expect(registry.AGENT_OPS.get('docker.composeVolumeCreate')).toMatchObject({ cap: 'volume.compose', sealedOnly: true });
    expect(registry.capabilityKillSwitch('volume.compose', { NINEDEPLOY_AGENT_VOLUME_COMPOSE: 'off' })).toBe('NINEDEPLOY_AGENT_VOLUME_COMPOSE');
  });

  it('lists the volumes of one compose project, with a literal format', async () => {
    await run('docker.composeVolumes', { project: 'ndcmp-shop' });
    expect(argvs()[0]).toEqual(['volume', 'ls', '--filter', 'label=com.docker.compose.project=ndcmp-shop', '--format', COMPOSE_VOLUME_FORMAT]);
    await expect(run('docker.composeVolumes', { project: 'shop' })).rejects.toThrow(/compose project/);
    await expect(run('docker.composeVolumes', { project: 'ndcmp-shop,label=x' })).rejects.toThrow(/compose project/);
  });

  it('creates a missing volume with compose labels, keeps its own, refuses a foreign one', async () => {
    dockerWithLabel(null);
    await run('docker.composeVolumeCreate', { name: 'ndcmp-shop_db-data' });
    expect(argvs().at(-1)).toEqual([
      'volume', 'create', '--label', 'com.docker.compose.project=ndcmp-shop', '--label', 'com.docker.compose.volume=db-data', 'ndcmp-shop_db-data',
    ]);
    spawnMock.mockClear();
    dockerWithLabel('ndcmp-shop');
    expect((await run('docker.composeVolumeCreate', { name: 'ndcmp-shop_db-data' })).code).toBe(0);
    expect(argvs().some((a) => a[1] === 'create')).toBe(false);
    dockerWithLabel('');
    await expect(run('docker.composeVolumeCreate', { name: 'ndcmp-shop_db-data' })).rejects.toThrow(/not created by compose/);
    await expect(run('docker.composeVolumeCreate', { name: 'pgdata' })).rejects.toThrow(/compose volume name/);
    await expect(run('docker.composeVolumeCreate', { name: 'nd-svc-api-data' })).rejects.toThrow(/compose volume name/);
  });
});

describe('volume transfer kinds and compose volumes', () => {
  it('export a compose volume only when compose made it for that project', async () => {
    dockerWithLabel('ndcmp-shop');
    const prepared = await volumeExportKind.prepare({ volume: 'ndcmp-shop_data' }, { maxBytes: 1 });
    expect(prepared.direction).toBe('agent-to-panel');
    dockerWithLabel('ndcmp-other');
    await expect(volumeExportKind.prepare({ volume: 'ndcmp-shop_data' }, { maxBytes: 1 })).rejects.toThrow(/not created by compose for ndcmp-shop/);
    dockerWithLabel('');
    await expect(volumeImportKind.prepare({ volume: 'ndcmp-shop_data' }, { maxBytes: 1 })).rejects.toThrow(/not created by compose/);
    dockerWithLabel(null);
    await expect(volumeExportKind.prepare({ volume: 'ndcmp-shop_data' }, { maxBytes: 1 })).rejects.toThrow(/does not exist/);
    // Anything else is still refused by name.
    await expect(volumeExportKind.prepare({ volume: 'pgdata' }, { maxBytes: 1 })).rejects.toThrow(/nd-svc-\* or nd-db-\*/);
  });

  it('refuse compose volumes when the node owner switched them off', async () => {
    process.env['NINEDEPLOY_AGENT_VOLUME_COMPOSE'] = 'off';
    dockerWithLabel('ndcmp-shop');
    await expect(volumeImportKind.prepare({ volume: 'ndcmp-shop_data' }, { maxBytes: 1 })).rejects.toThrow(/switched off/);
  });
});

describe('parseComposeVolumes (panel side)', () => {
  it('keeps the project volumes and flags a fixed name', async () => {
    const { parseComposeVolumes } = await import('../src/lib/composeVolumes.js');
    expect(parseComposeVolumes(['ndcmp-shop_uploads\tuploads', 'pgdata\tdb', '', 'ndcmp-shop-x_data\tdata'], 'ndcmp-shop')).toEqual([
      { name: 'ndcmp-shop-x_data', key: 'data', fixed: true },
      { name: 'ndcmp-shop_uploads', key: 'uploads', fixed: false },
      { name: 'pgdata', key: 'db', fixed: true },
    ]);
  });
});
