import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DB } from '@ninedeploy/db';

// Never reach the real docker CLI or a real agent from this file.
const execMock = vi.hoisted(() => ({ capture: vi.fn(async () => { throw new Error('docker must not run in tests'); }) }));
vi.mock('../../src/lib/exec.js', () => execMock);
const agentMock = vi.hoisted(() => ({
  agentPing: vi.fn(async () => { throw new Error('agentPing must be injected'); }),
  agentOp: vi.fn(async () => { throw new Error('agentOp must be injected'); }),
}));
vi.mock('../../src/lib/agentClient.js', () => agentMock);
vi.mock('../../src/lib/crypto.js', () => ({ decrypt: (v: string) => `plain:${v}` }));

const {
  createNodeHealthWatch,
  dfLinePercent,
  diskSnapshot,
  dockerDataRoot,
  offlineSnapshot,
  panelDiskReadings,
  resetDockerRootCache,
  usedPercent,
  REMOTE_DISK_EVERY_MS,
  REMOTE_DISK_MAX_AGE_MS,
} = await import('../../src/lib/nodeHealth.js');

interface Node {
  id: number;
  name: string;
  host: string;
  port: number;
  status: string;
  tokenEncrypted: string;
  lastSeenAt: Date | null;
}

function fakeDb(nodes: Node[]) {
  const stamped: Array<Record<string, unknown>> = [];
  const db = {
    query: { servers: { findMany: async () => nodes.map((n) => ({ ...n })) } },
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          stamped.push(patch);
          return [];
        },
      }),
    }),
  } as unknown as DB;
  return { db, stamped };
}

const T0 = new Date('2026-10-08T10:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const node = (over: Partial<Node> = {}): Node => ({
  id: 1,
  name: 'node-a',
  host: '10.0.0.5',
  port: 4600,
  status: 'online',
  tokenEncrypted: 'enc',
  lastSeenAt: T0,
  ...over,
});

afterEach(() => {
  vi.clearAllMocks();
  resetDockerRootCache();
});

describe('disk percent parsing', () => {
  it('uses df Use% semantics (reserved blocks excluded, rounded up)', () => {
    // 100 blocks, 20 free, 10 available to users: used 80 / (80 + 10) = 88.9 → 89
    expect(usedPercent(100, 20, 10)).toBe(89);
    expect(usedPercent(0, 0, 0)).toBeNull();
    expect(usedPercent(100, 100, 100)).toBe(0);
  });

  it('reads an agent ND-DF (df -kP) row', () => {
    expect(dfLinePercent('/dev/sda1 1000 850 150 85% /')).toBe(85);
    expect(dfLinePercent('/dev/sda1 1000')).toBeNull();
    expect(dfLinePercent('garbage x y z')).toBeNull();
  });
});

describe('dockerDataRoot', () => {
  it('asks docker once with a bounded timeout and caches the answer', async () => {
    execMock.capture.mockResolvedValueOnce('/var/lib/docker\n' as never);
    expect(await dockerDataRoot(1000)).toBe('/var/lib/docker');
    expect(await dockerDataRoot(2000)).toBe('/var/lib/docker');
    expect(execMock.capture).toHaveBeenCalledTimes(1);
    const [, args, opts] = execMock.capture.mock.calls[0] as unknown as [string, string[], { timeoutMs: number }];
    expect(args).toEqual(['info', '--format', '{{.DockerRootDir}}']);
    expect(opts.timeoutMs).toBeGreaterThan(0);
    expect(opts.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  it('returns null when docker is unavailable', async () => {
    expect(await dockerDataRoot(1000)).toBeNull();
  });
});

describe('panelDiskReadings', () => {
  it('measures the data dir, plus a distinct, locally visible docker data root', async () => {
    const { tmpdir } = await import('node:os');
    const { dirname } = await import('node:path');
    const dataDir = tmpdir();
    const root = dirname(dataDir);
    execMock.capture.mockResolvedValueOnce(`${root}\n` as never);
    const readings = await panelDiskReadings(dataDir);
    expect(readings.map((r) => r.where)).toEqual([`panel ${dataDir}`, `panel ${root}`]);
    for (const r of readings) expect(r.pct).toBeGreaterThanOrEqual(0);
  });

  it('skips a docker data root this process cannot see (the container install)', async () => {
    const { tmpdir } = await import('node:os');
    execMock.capture.mockResolvedValueOnce('/definitely/not/here/docker\n' as never);
    const readings = await panelDiskReadings(tmpdir());
    expect(readings).toHaveLength(1);
  });
});

describe('snapshots', () => {
  it('disk: worst reading wins and every host is named', () => {
    expect(diskSnapshot([])).toBeNull();
    expect(diskSnapshot([{ where: 'panel /data', pct: 40 }, { where: 'node-a', pct: 91 }])).toEqual({
      serviceId: null,
      kind: 'disk',
      value: 91,
      detail: 'node-a 91%, panel /data 40%',
    });
  });

  it('server_offline: minutes rounded up, counted from watchSince at the earliest', () => {
    const nodes = [
      { id: 1, name: 'a', lastSeenAt: at(-120) }, // down long before this panel started watching
      { id: 2, name: 'b', lastSeenAt: at(1) },
      { id: 3, name: 'never', lastSeenAt: null }, // never connected: not watched
    ];
    const s = offlineSnapshot(nodes, at(5.5), T0);
    expect(s).toEqual({ serviceId: null, kind: 'server_offline', value: 6, detail: 'a unseen 6 min, b unseen 5 min' });
    // No nodes at all still yields a sample (value 0) so a firing rule recovers.
    expect(offlineSnapshot([], at(5), T0)).toEqual({ serviceId: null, kind: 'server_offline', value: 0 });
  });
});

describe('createNodeHealthWatch', () => {
  const panelDisk = async () => [{ where: 'panel /data', pct: 50 }];

  it('pings non-pending nodes, stamps last_seen_at on success, and starts the clock at the first cycle', async () => {
    const ping = vi.fn(async (host: string) => {
      if (host === 'down') throw new Error('unreachable');
    });
    const stats = vi.fn(async () => [] as string[]);
    const { db, stamped } = fakeDb([
      node({ id: 1, name: 'up' }),
      // Last seen two hours ago (the panel itself was down): must not fire at boot.
      node({ id: 2, name: 'down', host: 'down', lastSeenAt: at(-120) }),
      node({ id: 3, name: 'pending', host: 'p', status: 'pending' }),
    ]);
    const watch = createNodeHealthWatch({ ping, stats, panelDisk });

    const first = await watch.cycle(db, T0);
    expect(ping).toHaveBeenCalledTimes(2);
    expect(ping).toHaveBeenCalledWith('10.0.0.5', 4600, 'plain:enc');
    expect(stamped).toEqual([{ lastSeenAt: T0 }]);
    expect(first.find((s) => s.kind === 'server_offline')).toMatchObject({ value: 0 });

    const later = await watch.cycle(db, at(6));
    expect(later.find((s) => s.kind === 'server_offline')).toMatchObject({ value: 6, detail: 'down unseen 6 min' });
  });

  it('emits no server_offline sample when the node list cannot be read', async () => {
    const db = { query: { servers: { findMany: async () => { throw new Error('no such table'); } } } } as unknown as DB;
    const watch = createNodeHealthWatch({ ping: vi.fn(), stats: vi.fn(), panelDisk });
    const out = await watch.cycle(db, T0);
    expect(out.map((s) => s.kind)).toEqual(['disk']);
  });

  it('a deleted node stops counting, so a firing offline rule can recover', async () => {
    const nodes = [node({ id: 2, name: 'down', host: 'down' })];
    const ping = vi.fn(async () => { throw new Error('unreachable'); });
    const watch = createNodeHealthWatch({ ping, stats: vi.fn(), panelDisk });
    const { db } = fakeDb(nodes);
    await watch.cycle(db, T0);
    expect((await watch.cycle(db, at(10))).find((s) => s.kind === 'server_offline')?.value).toBe(10);
    nodes.length = 0; // DELETE /servers/2
    expect((await watch.cycle(db, at(11))).find((s) => s.kind === 'server_offline')?.value).toBe(0);
  });

  it('samples remote disk every 5 minutes from agent.stats and forgets deleted or silent nodes', async () => {
    const nodes = [node({ id: 1, name: 'node-a' })];
    let reachable = true;
    const ping = vi.fn(async () => {
      if (!reachable) throw new Error('unreachable');
    });
    const stats = vi.fn(async () => ['nd-web|1%|1MiB / 2MiB', 'ND-DF /dev/sda1 1000 930 70 93% /']);
    const watch = createNodeHealthWatch({ ping, stats, panelDisk });
    const { db } = fakeDb(nodes);

    const first = await watch.cycle(db, T0);
    expect(first.find((s) => s.kind === 'disk')).toMatchObject({ value: 93, detail: 'node-a 93%, panel /data 50%' });
    await watch.cycle(db, at(1));
    expect(stats).toHaveBeenCalledTimes(1); // not every tick
    await watch.cycle(db, new Date(T0.getTime() + REMOTE_DISK_EVERY_MS));
    expect(stats).toHaveBeenCalledTimes(2);

    // The node stops answering: its last reading ages out instead of pinning the value.
    reachable = false;
    const stale = await watch.cycle(db, new Date(T0.getTime() + REMOTE_DISK_EVERY_MS + REMOTE_DISK_MAX_AGE_MS + 1));
    expect(stale.find((s) => s.kind === 'disk')).toMatchObject({ value: 50 });

    // A deleted node's reading is dropped at once.
    reachable = true;
    await watch.cycle(db, at(60));
    nodes.length = 0;
    const gone = await watch.cycle(db, at(61));
    expect(gone.find((s) => s.kind === 'disk')).toMatchObject({ value: 50, detail: 'panel /data 50%' });
  });

  it('a failing stats probe does not break the cycle', async () => {
    const watch = createNodeHealthWatch({
      ping: vi.fn(async () => undefined),
      stats: vi.fn(async () => { throw new Error('old agent'); }),
      panelDisk: async () => { throw new Error('statfs broke'); },
    });
    const { db } = fakeDb([node()]);
    const out = await watch.cycle(db, T0);
    expect(out).toEqual([{ serviceId: null, kind: 'server_offline', value: 0 }]);
  });
});
