/**
 * G3.1 compose stack volumes (`lib/composeVolumes.ts`): parsing the listing,
 * listing on the panel host (docker argv) or a node (agent op, capability
 * gate), and creating a volume with compose's labels. Docker, the agent and
 * the capability check are stand-ins; nothing reaches a real daemon.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@ninedeploy/db';

const m = vi.hoisted(() => ({
  capture: vi.fn<(cmd: string, args: string[], opts?: unknown) => Promise<string>>(),
  agentOp: vi.fn<(...a: unknown[]) => Promise<{ exitCode: number; lines: string[] }>>(),
  capability: vi.fn<(...a: unknown[]) => Promise<void>>(),
}));
vi.mock('../../src/lib/exec.js', async (orig) => ({ ...(await orig<object>()), capture: m.capture }));
vi.mock('../../src/lib/agentClient.js', async (orig) => ({ ...(await orig<object>()), agentOp: m.agentOp }));
vi.mock('../../src/lib/agentCapabilities.js', async (orig) => ({ ...(await orig<object>()), assertNodeCapability: m.capability }));

const lib = await import('../../src/lib/composeVolumes.js');

const db = {} as DB;

beforeEach(() => {
  m.capture.mockReset();
  m.agentOp.mockReset();
  m.capability.mockReset().mockResolvedValue(undefined);
});

describe('parseComposeVolumes', () => {
  it('skips blank lines, marks names not of the project as fixed, and sorts by name', () => {
    const long = `ndcmp-shop_${'a'.repeat(130)}`;
    const out = lib.parseComposeVolumes(
      ['ndcmp-shop_uploads\tuploads', '', '   ', 'pgdata\tdb', 'ndcmp-shop_db\tdb', 'ndcmp-other_x\tx', `${long}\tbig`, 'ndcmp-shop_cache'],
      'ndcmp-shop',
    );
    expect(out).toEqual([
      { name: 'ndcmp-other_x', key: 'x', fixed: true },
      { name: long, key: 'big', fixed: true },
      { name: 'ndcmp-shop_cache', key: '', fixed: false },
      { name: 'ndcmp-shop_db', key: 'db', fixed: false },
      { name: 'ndcmp-shop_uploads', key: 'uploads', fixed: false },
      { name: 'pgdata', key: 'db', fixed: true },
    ]);
  });

  it('treats a project-prefixed name with characters compose never uses as fixed', () => {
    expect(lib.parseComposeVolumes(['ndcmp-shop_bad name\tk'], 'ndcmp-shop')).toEqual([{ name: 'ndcmp-shop_bad name', key: 'k', fixed: true }]);
    // Equal names keep their order (the comparator answers 0).
    expect(lib.parseComposeVolumes(['ndcmp-shop_a\t1', 'ndcmp-shop_a\t2'], 'ndcmp-shop').map((v) => v.key)).toEqual(['1', '2']);
  });

  it('names the project after the slug', () => {
    expect(lib.composeProject('shop')).toBe('ndcmp-shop');
  });
});

describe('composeVolumes', () => {
  it('lists the panel host by the project label with a literal format', async () => {
    m.capture.mockResolvedValue('ndcmp-shop_db\tdb\nndcmp-shop_app\tapp\n');
    const out = await lib.composeVolumes(db, null, 'shop');
    expect(m.capture).toHaveBeenCalledWith(
      'docker',
      ['volume', 'ls', '--filter', 'label=com.docker.compose.project=ndcmp-shop', '--format', '{{.Name}}\t{{.Label "com.docker.compose.volume"}}'],
      { timeoutMs: 30_000 },
    );
    expect(out.map((v) => v.name)).toEqual(['ndcmp-shop_app', 'ndcmp-shop_db']);
    expect(m.capability).not.toHaveBeenCalled();
    expect(m.agentOp).not.toHaveBeenCalled();
  });

  it('lists a node through the agent after checking its capability', async () => {
    m.agentOp.mockResolvedValue({ exitCode: 0, lines: ['ndcmp-shop_db\tdb', 'fixed-name\tdata'] });
    const out = await lib.composeVolumes(db, 4, 'shop');
    expect(m.capability).toHaveBeenCalledWith(db, 4, { cap: 'volume.compose', feature: 'move a compose stack with its volumes', sealedRequired: true });
    expect(m.agentOp).toHaveBeenCalledWith(db, 4, 'docker.composeVolumes', { project: 'ndcmp-shop' }, expect.any(Function));
    expect((m.agentOp.mock.calls[0]![4] as () => unknown)()).toBeUndefined();
    expect(out).toEqual([
      { name: 'fixed-name', key: 'data', fixed: true },
      { name: 'ndcmp-shop_db', key: 'db', fixed: false },
    ]);
    expect(m.capture).not.toHaveBeenCalled();
  });

  it('refuses a node without the capability before asking its agent', async () => {
    m.capability.mockRejectedValue(Object.assign(new Error('agent too old'), { statusCode: 422 }));
    await expect(lib.composeVolumes(db, 4, 'shop')).rejects.toThrow('agent too old');
    await expect(lib.assertComposeVolumesOnNode(db, 4)).rejects.toThrow('agent too old');
    expect(m.agentOp).not.toHaveBeenCalled();
  });
});

describe('createComposeVolume', () => {
  it('refuses a name that is not a compose stack volume', async () => {
    for (const name of ['pgdata', 'nd-svc-api-data', 'ndcmp-shop', `ndcmp-shop_${'a'.repeat(130)}`]) {
      const err = await lib.createComposeVolume(db, null, name).catch((e: unknown) => e);
      expect(err).toMatchObject({ statusCode: 400, code: 'move_fixed_volume_names' });
      expect(String((err as Error).message)).toContain('is not a compose stack volume');
    }
    expect(m.capture).not.toHaveBeenCalled();
    expect(m.agentOp).not.toHaveBeenCalled();
  });

  it('creates on a node through the agent after the capability check', async () => {
    m.agentOp.mockResolvedValue({ exitCode: 0, lines: [] });
    await lib.createComposeVolume(db, 9, 'ndcmp-shop_db-data');
    expect(m.capability).toHaveBeenCalledTimes(1);
    expect(m.agentOp).toHaveBeenCalledWith(db, 9, 'docker.composeVolumeCreate', { name: 'ndcmp-shop_db-data' }, expect.any(Function));
    expect((m.agentOp.mock.calls[0]![4] as () => unknown)()).toBeUndefined();
    expect(m.capture).not.toHaveBeenCalled();
  });

  it('creates a missing volume on the panel host with compose labels', async () => {
    m.capture.mockRejectedValueOnce(new Error('No such volume')).mockResolvedValueOnce('');
    await lib.createComposeVolume(db, null, 'ndcmp-shop_db-data');
    expect(m.capture.mock.calls.map((c) => c[1])).toEqual([
      ['volume', 'inspect', '--format', '{{index .Labels "com.docker.compose.project"}}', 'ndcmp-shop_db-data'],
      ['volume', 'create', '--label', 'com.docker.compose.project=ndcmp-shop', '--label', 'com.docker.compose.volume=db-data', 'ndcmp-shop_db-data'],
    ]);
    expect(m.capture.mock.calls[1]![2]).toEqual({ timeoutMs: 60_000 });
  });

  it('reuses a volume compose made for the same project', async () => {
    m.capture.mockResolvedValueOnce('ndcmp-shop\n');
    await lib.createComposeVolume(db, null, 'ndcmp-shop_db');
    expect(m.capture).toHaveBeenCalledTimes(1);
  });

  it('refuses a volume of that name that compose did not make for the project', async () => {
    m.capture.mockResolvedValueOnce('\n');
    await expect(lib.createComposeVolume(db, null, 'ndcmp-shop_db')).rejects.toThrow(
      'Volume ndcmp-shop_db exists on the panel host and was not created by compose for ndcmp-shop',
    );
    m.capture.mockResolvedValueOnce('ndcmp-other');
    await expect(lib.createComposeVolume(db, null, 'ndcmp-shop_db')).rejects.toThrow(/not created by compose/);
    expect(m.capture.mock.calls.every((c) => c[1][1] === 'inspect')).toBe(true);
  });

  it('surfaces a failed create', async () => {
    m.capture.mockRejectedValueOnce(new Error('missing')).mockRejectedValueOnce(new Error('daemon down'));
    await expect(lib.createComposeVolume(db, null, 'ndcmp-shop_db')).rejects.toThrow('daemon down');
  });
});
