import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, asUser, createFakeDb } from './helpers.js';
import { doctorRoutes } from '../src/modules/doctor.js';
import { fixDoctorFinding, scanDoctor } from '../src/engine/doctor.js';

const ex = vi.hoisted(() => ({ capture: vi.fn(), run: vi.fn() }));
const ap = vi.hoisted(() => ({
  getDiskUsage: vi.fn(() => ({ diskUsedPercent: 45, diskTotalBytes: 100 * 1024 * 1024 * 1024, diskFreeBytes: 55 * 1024 * 1024 * 1024 })),
  executeAutoPrune: vi.fn(async () => ({ ok: true as const, freedBytes: 1234, diskUsedPercentAfter: 40, details: {} })),
}));

vi.mock('../src/lib/exec.js', () => ({ capture: ex.capture, run: ex.run, sleep: vi.fn() }));
vi.mock('../src/engine/autoPrune.js', () => ({
  getDiskUsage: ap.getDiskUsage,
  executeAutoPrune: ap.executeAutoPrune,
  DEFAULT_AUTOPRUNE_CONFIG: {},
  parseReclaimedBytes: () => 0,
}));
vi.mock('../src/lib/dockerPull.js', () => ({
  pullDockerImage: vi.fn(async () => undefined),
  ensureDockerImage: vi.fn(async () => undefined),
}));
vi.mock('../src/config.js', () => ({ config: { paths: { dataDir: '/tmp/nd-doctor-test' } } }));

/** The docker facade the scan reads. */
const host = {
  containers: [] as Array<{ Names: string; State: string; Image: string }>,
  volumeLs: '',
  networks: 'ninedeploy\n',
  networkMembers: {} as Record<string, string>,
  images: '',
  df: '',
};

beforeEach(() => {
  vi.clearAllMocks();
  host.containers = [];
  host.volumeLs = '';
  host.networks = 'ninedeploy\n';
  host.networkMembers = {};
  host.images = '';
  host.df = JSON.stringify({ Type: 'Images', Size: '2.207GB' });
  ex.run.mockResolvedValue(undefined);
  // clearAllMocks keeps implementations — re-arm the defaults per test so a
  // test-level override (disk pressure) cannot leak into the next one.
  ap.getDiskUsage.mockImplementation(() => ({ diskUsedPercent: 45, diskTotalBytes: 100 * 1024 * 1024 * 1024, diskFreeBytes: 55 * 1024 * 1024 * 1024 }));
  ap.executeAutoPrune.mockImplementation(async () => ({ ok: true as const, freedBytes: 1234, diskUsedPercentAfter: 40, details: {} }));
  ex.capture.mockImplementation(async (_cmd: string, args: string[]) => {
    const a = args as string[];
    if (a[0] === 'ps') {
      // `ps --filter name=^X$ -q` (containerRunning) answers bare ids for the
      // matching name only; the plain `ps -a --format` dump is JSON lines.
      if (a.includes('-q')) {
        const filter = (a.find((x) => x.startsWith('name=^')) ?? '').slice('name=^'.length).replace(/\$$/, '');
        return host.containers.filter((c) => c.Names === filter).map((c) => `id-${c.Names}`).join('\n');
      }
      return host.containers.map((c) => JSON.stringify(c)).join('\n');
    }
    if (a[0] === 'volume' && a[1] === 'ls') return host.volumeLs;
    if (a[0] === 'volume' && a[1] === 'inspect' && a.includes('--format')) return '{}';
    if (a[0] === 'volume' && a[1] === 'inspect') return 'Error: No such volume';
    if (a[0] === 'network' && a[1] === 'ls') return host.networks;
    if (a[0] === 'network' && a[1] === 'inspect') return host.networkMembers[String(a[2])] ?? '';
    if (a[0] === 'images') return host.images;
    if (a[0] === 'system') return host.df;
    if (a[0] === 'run') return '1048576 /v'; // du sidecar for orphan volume sizing
    return '';
  });
});

const svcRow = (over: Record<string, unknown> = {}) => ({
  id: 1, ownerUserId: 1, name: 'Web', slug: 'web', status: 'running',
  runtimeId: 'nd-web-1', type: 'docker', ...over,
});
const dbRow = (over: Record<string, unknown> = {}) => ({
  id: 1, ownerUserId: 1, name: 'DB', slug: 'web-db', engine: 'postgres', status: 'running',
  containerName: 'nd-db-web-db', volumeName: 'nd-db-web-db-data', createdAt: new Date(), ...over,
});

describe('doctor scan', () => {
  it('reports a healthy host when nothing is stale', async () => {
    host.containers = [{ Names: 'ninedeploy-traefik', State: 'running', Image: 'traefik:3' }];
    const report = await scanDoctor(createFakeDb());
    expect(report.healthy).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it('flags an exited Hub container nothing claims as removable junk', async () => {
    host.containers = [{ Names: 'nd-old-deploy', State: 'exited', Image: 'nginx:1' }];
    const report = await scanDoctor(createFakeDb());
    const f = report.findings.find((x) => x.kind === 'exited_container');
    expect(f).toMatchObject({ id: 'exited_container:nd-old-deploy', action: 'remove_container', severity: 'info' });
    expect(report.healthy).toBe(true); // info-only host is still healthy
  });

  it('flags a running service whose runtime container is gone (critical desync)', async () => {
    host.containers = [];
    const report = await scanDoctor(createFakeDb({ select: { services: [svcRow()] } }));
    const f = report.findings.find((x) => x.kind === 'service_runtime_desync');
    expect(f).toMatchObject({ id: 'service_runtime_desync:1', severity: 'critical', action: 'sync_service' });
    expect(report.healthy).toBe(false);
    expect(report.totals.critical).toBe(1);
  });

  it('r228: never flags a PM2 process or a remote-node container as a local desync', async () => {
    host.containers = [];
    const report = await scanDoctor(createFakeDb({
      select: {
        services: [
          svcRow({ id: 1, type: 'pm2', runtimeId: 'web-pm2' }),
          svcRow({ id: 2, type: 'docker', runtimeId: 'api-2-9', serverId: 4 }),
        ],
      },
    }));
    expect(report.findings.filter((x) => x.kind === 'service_runtime_desync')).toEqual([]);
  });

  it('flags a database marked running with a dead container, and stuck creating rows', async () => {
    host.containers = [{ Names: 'nd-db-web-db', State: 'exited', Image: 'postgres:18' }];
    const report = await scanDoctor(createFakeDb({
      select: { databases: [dbRow(), dbRow({ id: 2, status: 'creating', containerName: 'nd-db-slow', updatedAt: new Date(Date.now() - 3 * 3600_000) })] },
    }));
    expect(report.findings.find((x) => x.kind === 'database_down')).toMatchObject({ id: 'database_down:1', action: 'start_database' });
    expect(report.findings.find((x) => x.kind === 'database_stuck')).toMatchObject({ id: 'database_stuck:2', action: 'mark_database_error' });
  });

  it('flags orphan volumes with their retained origin and size', async () => {
    host.volumeLs = 'nd-svc-ghost-data\n';
    ex.capture.mockImplementation(async (_cmd: string, args: string[]) => {
      const a = args as string[];
      if (a[0] === 'volume' && a[1] === 'ls') return host.volumeLs;
      if (a[0] === 'volume' && a[1] === 'inspect' && a.includes('--format')) {
        return JSON.stringify({ 'ninedeploy.managed': 'database', 'ninedeploy.database.name': 'Ghost DB', 'ninedeploy.database.engine': 'mysql' });
      }
      if (a[0] === 'volume' && a[1] === 'inspect') return 'not exists';
      if (a[0] === 'run') return '2097152 /v';
      return '';
    });
    const report = await scanDoctor(createFakeDb());
    const f = report.findings.find((x) => x.kind === 'orphan_volume');
    expect(f).toMatchObject({ id: 'orphan_volume:nd-svc-ghost-data', action: 'delete_volume', sizeBytes: 2097152 });
    expect(f?.detail).toContain('Previously "Ghost DB" (mysql)');
    expect(report.totals.reclaimableBytes).toBeGreaterThan(0);
  });

  it('never marks the shared network or foreign networks as orphans', async () => {
    host.networks = 'bridge\nhost\nnone\nninedeploy\nndcmp-web\tbridge\ndocker\tbridge\n';
    host.networkMembers['ndcmp-web'] = 'web-1 ';
    const report = await scanDoctor(createFakeDb({ select: { services: [svcRow()] } }));
    expect(report.findings.filter((f) => f.kind === 'orphan_network')).toEqual([]);
  });

  it('recognizes a live compose stack through its <slug>_default network', async () => {
    host.networks = 'ndcmp-web_default\tbridge\n';
    host.networkMembers['ndcmp-web_default'] = 'web-1 ';
    const report = await scanDoctor(createFakeDb({ select: { services: [svcRow()] } }));
    expect(report.findings.filter((f) => f.kind === 'orphan_network')).toEqual([]);
  });

  it('flags an empty compose network whose service is gone, suffix and all', async () => {
    host.networks = 'ndcmp-gone_default\tbridge\n';
    host.networkMembers['ndcmp-gone_default'] = '';
    const report = await scanDoctor(createFakeDb());
    const f = report.findings.find((x) => x.kind === 'orphan_network');
    expect(f).toMatchObject({ id: 'orphan_network:ndcmp-gone_default', action: 'remove_network' });
  });

  it('flags an empty compose network whose service is gone', async () => {
    host.networks = 'ndcmp-gone\tbridge\n';
    host.networkMembers['ndcmp-gone'] = '';
    const report = await scanDoctor(createFakeDb());
    const f = report.findings.find((x) => x.kind === 'orphan_network');
    expect(f).toMatchObject({ id: 'orphan_network:ndcmp-gone', action: 'remove_network' });
  });

  it('counts dangling images and disk pressure as reclaimable findings', async () => {
    host.images = [JSON.stringify({ Repository: '<none>', Tag: '<none>', Size: '500MB' }), JSON.stringify({ Repository: 'nginx', Tag: '1', Size: '100MB' })].join('\n');
    ap.getDiskUsage.mockReturnValue({ diskUsedPercent: 92, diskTotalBytes: 100, diskFreeBytes: 8 });
    const report = await scanDoctor(createFakeDb());
    expect(report.findings.find((x) => x.kind === 'dangling_images')?.action).toBe('prune_dangling_images');
    expect(report.findings.find((x) => x.kind === 'disk_pressure')).toMatchObject({ severity: 'critical', action: 'run_autoprune' });
    expect(report.host.dockerImagesBytes).toBeGreaterThan(0);
  });

  it('flags a deploy frozen in queued past the stale window', async () => {
    const report = await scanDoctor(createFakeDb({
      select: { deployments: [{ id: 55, status: 'queued', createdAt: new Date(Date.now() - 10 * 3600_000) }] },
    }));
    expect(report.findings.find((x) => x.kind === 'stuck_deployment')).toMatchObject({ id: 'stuck_deployment:55', action: 'cancel_deployment' });
  });
});

describe('doctor fix', () => {
  it('removes an exited Hub container for real', async () => {
    host.containers = [{ Names: 'nd-old', State: 'exited', Image: 'nginx' }];
    const log = vi.fn();
    const res = await fixDoctorFinding(createFakeDb(), 'exited_container:nd-old', log);
    expect(res?.fixed).toBe(true);
    expect(res?.action).toBe('remove_container');
    expect(ex.run).toHaveBeenCalledWith('docker', ['rm', '-f', 'nd-old'], {}, expect.any(Function));
  });

  it('deletes an orphan volume (and keeps its label-driven provenance in the log path)', async () => {
    host.volumeLs = 'nd-db-gone-data\n';
    const res = await fixDoctorFinding(createFakeDb(), 'orphan_volume:nd-db-gone-data', vi.fn());
    expect(res?.action).toBe('delete_volume');
    expect(ex.run).toHaveBeenCalledWith('docker', ['volume', 'rm', 'nd-db-gone-data'], {}, expect.any(Function));
  });

  it('syncs a lying service row to error', async () => {
    host.containers = [];
    const updates: Array<Record<string, unknown>> = [];
    const db = createFakeDb({
      select: { services: [svcRow()] },
      update: { services: (value) => { updates.push(value); return [value]; } },
    });
    const res = await fixDoctorFinding(db, 'service_runtime_desync:1', vi.fn());
    expect(res?.action).toBe('sync_service');
    expect(updates).toContainEqual(expect.objectContaining({ status: 'error' }));
  });

  it('cancels a stuck queued deploy', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const db = createFakeDb({
      select: { deployments: [{ id: 55, status: 'queued', createdAt: new Date(Date.now() - 10 * 3600_000) }] },
      update: { deployments: (value) => { updates.push(value); return [value]; } },
    });
    const res = await fixDoctorFinding(db, 'stuck_deployment:55', vi.fn());
    expect(res?.action).toBe('cancel_deployment');
    expect(updates[0]).toMatchObject({ status: 'cancelled' });
  });

  it('runs auto-prune for disk pressure', async () => {
    ap.getDiskUsage.mockReturnValue({ diskUsedPercent: 95, diskTotalBytes: 100, diskFreeBytes: 5 });
    const res = await fixDoctorFinding(createFakeDb(), 'disk_pressure', vi.fn());
    expect(res?.action).toBe('run_autoprune');
    expect(ap.executeAutoPrune).toHaveBeenCalledTimes(1);
  });

  it('refuses with null when the finding no longer exists (stale report guard)', async () => {
    await expect(fixDoctorFinding(createFakeDb(), 'orphan_volume:nd-never-existed', vi.fn())).resolves.toBeNull();
  });

  it('answers 409 (not 500) when the container came back up mid-fix — the state moved on', async () => {
    // The scan lists the container as exited (desync finding exists), but by
    // the time the fix's fresh `containerRunning` probe looks, it is up again —
    // exactly the race the guard exists for.
    host.containers = [{ Names: 'nd-web-1', State: 'exited', Image: 'nginx' }];
    const db = createFakeDb({ select: { services: [svcRow()] } });
    const err = await fixDoctorFinding(db, 'service_runtime_desync:1', vi.fn()).catch((e: unknown) => e);
    expect((err as { statusCode?: number }).statusCode).toBe(409);
    expect((err as Error).message).toContain('back up');
  });

  it('answers 409 instead of lying about success when a volume rm fails and the volume survives', async () => {
    host.volumeLs = 'nd-db-stuck-data\n';
    ex.run.mockRejectedValueOnce(new Error('volume is in use'));
    // removeVolume swallows the rm failure, but the post-delete verification
    // probe still finds the volume — the fix must refuse with 409, not report
    // success while the volume is still on disk.
    ex.capture.mockImplementation(async (_cmd: string, args: string[]) => {
      const a = args as string[];
      if (a[0] === 'volume' && a[1] === 'ls') return host.volumeLs;
      if (a[0] === 'volume' && a[1] === 'inspect') return 'nd-db-stuck-data';
      if (a[0] === 'run') return '0 /v';
      return '';
    });
    const err = await fixDoctorFinding(createFakeDb(), 'orphan_volume:nd-db-stuck-data', vi.fn()).catch((e: unknown) => e);
    expect((err as { statusCode?: number }).statusCode).toBe(409);
    expect((err as Error).message).toContain('could not be deleted');
  });

  it('keeps genuine docker failures as plain 500-class errors', async () => {
    host.containers = [{ Names: 'nd-old', State: 'exited', Image: 'nginx' }];
    ex.run.mockRejectedValueOnce(new Error('docker daemon unreachable'));
    const err = await fixDoctorFinding(createFakeDb(), 'exited_container:nd-old', vi.fn()).catch((e: unknown) => e);
    expect((err as { statusCode?: number }).statusCode).toBeUndefined();
    expect((err as Error).message).toContain('docker daemon unreachable');
  });
});

describe('doctor routes', () => {
  it('returns the scan report to operators', async () => {
    host.containers = [{ Names: 'nd-old', State: 'exited', Image: 'nginx' }];
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(doctorRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.healthy).toBe(true);
    expect(body.findings[0]).toMatchObject({ id: 'exited_container:nd-old', action: 'remove_container' });
  });

  it('rejects non-admin callers', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(doctorRoutes);
    const res = await app.inject({ method: 'GET', url: '/', headers: asUser({ id: 7, isOperator: false }) });
    expect(res.statusCode).toBe(403);
  });

  it('answers 409 (not a destructive action) when a fix targets a vanished finding', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(doctorRoutes);
    const res = await app.inject({ method: 'POST', url: '/fix', headers: asUser(), payload: { findingId: 'orphan_volume:nd-nope' } });
    expect(res.statusCode).toBe(409);
  });

  it('surfaces state-moved-on refusals as 409 with the reason, not a 500', async () => {
    host.containers = [{ Names: 'nd-web-1', State: 'exited', Image: 'nginx' }];
    const app = await buildTestApp({ db: createFakeDb({ select: { services: [svcRow()] } }) });
    await app.register(doctorRoutes);
    const res = await app.inject({ method: 'POST', url: '/fix', headers: asUser(), payload: { findingId: 'service_runtime_desync:1' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('back up');
  });

  it('validates the fix body', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(doctorRoutes);
    const res = await app.inject({ method: 'POST', url: '/fix', headers: asUser(), payload: {} });
    expect(res.statusCode).toBe(422);
  });
});
