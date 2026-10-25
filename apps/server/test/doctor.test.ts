import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTestApp, asUser, createFakeDb } from './helpers.js';
import { doctorRoutes } from '../src/modules/doctor.js';
import { fixDoctorFinding, panelExposureFinding, sandboxNetworkFinding, scanDoctor, templatesSourceFinding } from '../src/engine/doctor.js';
import { SandboxPlugin } from '../src/kernel/sandbox/sandboxPlugin.js';

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
// r575: host/port are mutable so the plaintext-exposure check can be driven;
// the default (loopback) keeps every other scan free of that finding.
const cfg = vi.hoisted(() => ({ paths: { dataDir: '/tmp/nd-doctor-test' }, host: '127.0.0.1', port: 3000 }));
vi.mock('../src/config.js', () => ({ config: cfg }));
// The routing check reads the written Traefik file; its rewrite is the fix.
const proxyState = vi.hoisted(() => ({ file: '/nonexistent/nd-doctor-test/ninedeploy.yml', write: vi.fn(async () => undefined) }));
vi.mock('../src/engine/proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/proxy.js')>()),
  generatedConfigPath: () => proxyState.file,
  writeDynamicConfig: proxyState.write,
}));
const fsState = vi.hoisted(() => ({ dockerenv: false }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return { ...real, existsSync: (p: Parameters<typeof real.existsSync>[0]) => (p === '/.dockerenv' ? fsState.dockerenv : real.existsSync(p)) };
});

/** The docker facade the scan reads. */
const host = {
  containers: [] as Array<{ Names: string; State: string; Image: string; Labels?: string }>,
  /** Names only the fix's fresh `containerRunning` probe sees (a container that came back mid-fix). */
  cameBack: [] as string[],
  volumeLs: '',
  networks: 'ninedeploy\n',
  networkMembers: {} as Record<string, string>,
  images: '',
  df: '',
};

beforeEach(() => {
  vi.clearAllMocks();
  cfg.host = '127.0.0.1';
  fsState.dockerenv = false;
  host.containers = [];
  host.cameBack = [];
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
        if (host.cameBack.includes(filter)) return `id-${filter}`;
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
    if (a[0] === 'inspect' && a.includes('{{.State.Status}}')) {
      const c = host.containers.find((x) => x.Names === a[1]);
      if (!c) throw new Error(`No such object: ${a[1]}`);
      return c.State;
    }
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

  it('F528: an unreadable `docker ps` fails the scan instead of reporting every running service as gone', async () => {
    host.containers = [{ Names: 'nd-web-1', State: 'running', Image: 'nginx' }];
    const base = ex.capture.getMockImplementation()!;
    ex.capture.mockImplementation(async (cmd: string, args: string[]) => {
      if (args[0] === 'ps') throw new Error('Cannot connect to the Docker daemon');
      return base(cmd, args);
    });
    const updates: Array<Record<string, unknown>> = [];
    const db = createFakeDb({
      select: { services: [svcRow()] },
      update: { services: (value) => { updates.push(value); return [value]; } },
    });
    await expect(scanDoctor(db)).rejects.toThrow('Cannot connect to the Docker daemon');
    await expect(fixDoctorFinding(db, 'service_runtime_desync:1', vi.fn())).rejects.toThrow('Cannot connect');
    expect(updates).toEqual([]);
  });

  it('F529: exited siblings of a live compose stack are not removable junk; a deleted stack\'s leftovers are', async () => {
    host.containers = [
      { Names: 'ndcmp-shop-app-1', State: 'running', Image: 'shop' },
      { Names: 'ndcmp-shop-db-1', State: 'exited', Image: 'postgres:17' },
      { Names: 'ndcmp-gone-app-1', State: 'exited', Image: 'x' },
    ];
    const db = createFakeDb({ select: { services: [svcRow({ id: 9, slug: 'shop', type: 'compose', runtimeId: 'ndcmp-shop-app-1' })] } });
    const report = await scanDoctor(db);
    expect(report.findings.filter((f) => f.kind === 'exited_container').map((f) => f.id)).toEqual(['exited_container:ndcmp-gone-app-1']);
    await expect(fixDoctorFinding(db, 'exited_container:ndcmp-shop-db-1', vi.fn())).resolves.toBeNull();
    expect(ex.run).not.toHaveBeenCalled();
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

  it('starts a stopped runtime instead of marking the service errored', async () => {
    // A host-port deploy stopped the previous generation and nothing started it again.
    host.containers = [{ Names: 'nd-web-1', State: 'exited', Image: 'nginx' }];
    ex.run.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === 'start') host.cameBack = [String(args[1])];
    });
    const updates: Array<Record<string, unknown>> = [];
    const db = createFakeDb({
      select: { services: [svcRow()] },
      update: { services: (value) => { updates.push(value); return [value]; } },
    });
    const report = await scanDoctor(db);
    expect(report.findings.map((f) => f.kind)).toContain('service_runtime_stopped');
    expect(report.findings.map((f) => f.kind)).not.toContain('service_runtime_desync');
    const res = await fixDoctorFinding(db, 'service_runtime_stopped:1', vi.fn());
    expect(res?.action).toBe('start_service_runtime');
    expect(ex.run).toHaveBeenCalledWith('docker', ['start', 'nd-web-1'], {}, expect.any(Function));
    expect(updates).toEqual([]);
  });

  it('removes a running candidate a failed deploy left behind, and re-validates first', async () => {
    host.containers = [
      { Names: 'web-11', State: 'running', Image: 'web:sha', Labels: 'ninedeploy.managed=service,ninedeploy.deployment=11,ninedeploy.service=1' },
    ];
    const db = createFakeDb({ select: { services: [svcRow()], deployments: [{ id: 11, status: 'failed', createdAt: new Date() }] } });
    const res = await fixDoctorFinding(db, 'deploy_leftover_container:web-11', vi.fn());
    expect(res?.action).toBe('remove_deploy_leftover');
    expect(ex.run).toHaveBeenCalledWith('docker', ['rm', '-f', 'web-11'], {}, expect.any(Function));
    // The same container while its deploy is still building is not a leftover.
    vi.clearAllMocks();
    const busy = createFakeDb({ select: { services: [svcRow()], deployments: [{ id: 11, status: 'building', createdAt: new Date() }] } });
    await expect(fixDoctorFinding(busy, 'deploy_leftover_container:web-11', vi.fn())).resolves.toBeNull();
    expect(ex.run).not.toHaveBeenCalled();
  });

  it('switches a UDP-only service to the running readiness check', async () => {
    const updates: Array<Record<string, unknown>> = [];
    host.containers = [{ Names: 'nd-web-1', State: 'running', Image: 'pbx' }];
    const db = createFakeDb({
      select: { services: [svcRow({ port: 5060, portMappings: [{ hostPort: 5060, containerPort: 5060, protocol: 'udp' }] })] },
      update: { services: (value) => { updates.push(value); return [value]; } },
    });
    const res = await fixDoctorFinding(db, 'healthcheck_unpassable:1', vi.fn());
    expect(res?.action).toBe('set_healthcheck_running');
    expect(updates).toEqual([{ healthCheck: 'running' }]);
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
    // The scan finds no container (desync finding exists), but by the time the
    // fix's fresh `containerRunning` probe looks, it is up again — exactly the
    // race the guard exists for. (An exited one is service_runtime_stopped.)
    host.cameBack = ['nd-web-1'];
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
    host.cameBack = ['nd-web-1'];
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

// ── r575: plaintext panel port on a non-loopback address ──────────────
describe('doctor: panel plaintext exposure (r575)', () => {
  it('warns when the panel listens on 0.0.0.0 over plain HTTP (the bare-metal default)', async () => {
    cfg.host = '0.0.0.0';
    host.containers = [{ Names: 'ninedeploy-traefik', State: 'running', Image: 'traefik:3' }];
    const report = await scanDoctor(createFakeDb());
    const f = report.findings.find((x) => x.kind === 'panel_plaintext_exposure');
    expect(f).toMatchObject({ id: 'panel_plaintext_exposure', severity: 'warn', action: null, target: { type: 'host', name: '0.0.0.0:3000' } });
    expect(f?.detail).toContain('NINEDEPLOY_HOST=127.0.0.1');
    expect(report.healthy).toBe(false);
  });

  it('is silent on loopback binds', async () => {
    for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.0.0.2']) {
      cfg.host = h;
      const report = await scanDoctor(createFakeDb());
      expect(report.findings.filter((x) => x.kind === 'panel_plaintext_exposure'), h).toEqual([]);
    }
  });

  it('is silent inside a container (the compose file decides the published bind)', async () => {
    cfg.host = '0.0.0.0';
    fsState.dockerenv = true;
    const report = await scanDoctor(createFakeDb());
    expect(report.findings.filter((x) => x.kind === 'panel_plaintext_exposure')).toEqual([]);
  });

  it('names a specific interface bind and tolerates an unset host/port', () => {
    expect(panelExposureFinding('10.0.0.5', 8080, false)?.title).toBe('The panel listens on 10.0.0.5:8080 over plain HTTP');
    expect(panelExposureFinding('10.0.0.5', undefined, false)?.target.name).toBe('10.0.0.5:3000');
    expect(panelExposureFinding(undefined, 3000, false)).toBeNull();
  });
});

// ── r600: grandfathered sandbox plugins with unrestricted network ─────
describe('doctor: sandbox plugin network (r600)', () => {
  const sb = (id: string, enabled = true) => ({ id, enabled, manifest: { source: 'sandbox', target: id, code: 'x' } });

  it('warns about ENABLED sandbox plugins when this Node cannot deny network (wired into the scan)', async () => {
    const spy = vi.spyOn(SandboxPlugin, 'networkDenied').mockReturnValue(false);
    try {
      const db = createFakeDb({
        select: { installed_plugins: [sb('acme'), sb('off', false), { id: 'mk', enabled: true, manifest: { source: 'marketplace' } }] },
      });
      const report = await scanDoctor(db);
      const f = report.findings.find((x) => x.kind === 'sandbox_plugin_network');
      expect(f).toMatchObject({ id: 'sandbox_plugin_network', severity: 'warn', action: null, target: { type: 'host', name: 'acme' } });
      expect(f?.detail).toContain(process.version);
      expect(f?.detail).toContain('Node.js to 25 or newer');
      expect(f?.detail).not.toContain('off');
      expect(report.healthy).toBe(false);

      spy.mockReturnValue(true);
      const clean = await scanDoctor(db);
      expect(clean.findings.filter((x) => x.kind === 'sandbox_plugin_network')).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('is silent with no enabled sandbox plugins', () => {
    expect(sandboxNetworkFinding([], false)).toBeNull();
    expect(sandboxNetworkFinding([sb('off', false)], false)).toBeNull();
    expect(sandboxNetworkFinding([sb('a'), sb('b')], false, 'v24.1.0')?.title).toBe(
      '2 sandbox plugin(s) have unrestricted network access on Node v24.1.0',
    );
  });
});

// ── r655: plaintext remote template registry ──────────────────────────
describe('doctor: plaintext template source (r655)', () => {
  it('warns about a stored http:// template source (wired into the scan)', async () => {
    const db = createFakeDb({
      findFirst: { settings: () => ({ key: 'templates_source', value: 'http://registry.example.com/r.json' }) },
    });
    const report = await scanDoctor(db);
    const f = report.findings.find((x) => x.kind === 'templates_source_plaintext');
    expect(f).toMatchObject({ severity: 'warn', action: null, target: { type: 'host', name: 'templates_source' } });
    expect(f?.detail).toContain('http://registry.example.com/r.json');
    expect(f?.detail).toContain('https://');
  });

  it('is silent for https, local and unset sources', async () => {
    expect(templatesSourceFinding(null)).toBeNull();
    expect(templatesSourceFinding('https://registry.example.com/r.json')).toBeNull();
    expect(templatesSourceFinding('/var/lib/ninedeploy/registry.json')).toBeNull();
    expect(templatesSourceFinding('HTTP://registry.example.com/r.json')?.kind).toBe('templates_source_plaintext');
    const clean = await scanDoctor(createFakeDb());
    expect(clean.findings.filter((x) => x.kind === 'templates_source_plaintext')).toEqual([]);
  });
});

describe('doctor: live routing (domains through Traefik, host ports through Docker)', () => {
  const tmpDir = path.join(os.tmpdir(), `nd-doctor-routing-${process.pid}`);
  const routeTo = (runtime: string) => writeFileSync(proxyState.file, [
    'http:', '  routers:', '    web_3:', '      rule: "Host(`web.test`)"', '      service: svc_web_3',
    '  services:', '    svc_web_3:', '      loadBalancer:', '        servers:', `          - url: "http://${runtime}:8080"`, '',
  ].join('\n'));
  const inspectPorts = { value: {} as Record<string, unknown> };
  const routedDb = (over: Record<string, unknown> = {}) => createFakeDb({ select: {
    services: [svcRow({ runtimeId: 'web-5', port: 8080, serverId: null, ...over })],
    domains: [{ id: 3, serviceId: 1, hostname: 'web.test', path: null, ssl: false, status: 'active' }],
  } });

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
    proxyState.file = path.join(tmpDir, 'ninedeploy.yml');
    inspectPorts.value = {};
    host.containers = [{ Names: 'web-5', State: 'running', Image: 'web:5' }];
    const base = ex.capture.getMockImplementation()!;
    ex.capture.mockImplementation(async (cmd: string, args: string[]) => (args[0] === 'inspect' && args.includes('--type')
      ? JSON.stringify([{ State: { Status: 'running' }, NetworkSettings: { Ports: inspectPorts.value, Networks: {} } }])
      : base(cmd, args)));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    proxyState.file = '/nonexistent/nd-doctor-test/ninedeploy.yml';
  });

  it('flags a domain Traefik still routes to an old container and rewrites the file to fix it', async () => {
    routeTo('web-4');
    const report = await scanDoctor(routedDb());
    const f = report.findings.find((x) => x.kind === 'http_route_broken');
    expect(f).toMatchObject({ id: 'http_route_broken:1:3', severity: 'critical', action: 'rewrite_proxy_config', detail: expect.stringContaining('web-4') });

    const res = await fixDoctorFinding(routedDb(), 'http_route_broken:1:3', vi.fn());
    expect(res).toMatchObject({ fixed: true, action: 'rewrite_proxy_config' });
    expect(proxyState.write).toHaveBeenCalledOnce();
  });

  it('stays quiet for a correct route, and while a deploy of the service runs', async () => {
    routeTo('web-5');
    expect((await scanDoctor(routedDb())).findings.filter((x) => x.kind === 'http_route_broken')).toEqual([]);
    routeTo('web-4');
    const deploying = createFakeDb({ select: {
      services: [svcRow({ runtimeId: 'web-5', port: 8080, serverId: null })],
      domains: [{ id: 3, serviceId: 1, hostname: 'web.test', path: null, ssl: false, status: 'active' }],
      deployments: [{ id: 12, serviceId: 1, status: 'deploying', createdAt: new Date() }],
    } });
    expect((await scanDoctor(deploying)).findings.filter((x) => x.kind === 'http_route_broken')).toEqual([]);
  });

  it('flags a UDP port mapping Docker did not bind', async () => {
    routeTo('web-5');
    inspectPorts.value = { '5060/udp': null };
    const report = await scanDoctor(routedDb({ portMappings: [{ hostPort: 5060, containerPort: 5060, protocol: 'udp' }] }));
    expect(report.findings.find((x) => x.kind === 'host_port_unbound')).toMatchObject({
      id: 'host_port_unbound:1:*:5060/udp', severity: 'critical', action: null, detail: expect.stringContaining('redeploy'),
    });
    inspectPorts.value = { '5060/udp': [{ HostIp: '0.0.0.0', HostPort: '5060' }] };
    const bound = await scanDoctor(routedDb({ portMappings: [{ hostPort: 5060, containerPort: 5060, protocol: 'udp' }] }));
    expect(bound.findings.filter((x) => x.kind === 'host_port_unbound')).toEqual([]);
  });
});
