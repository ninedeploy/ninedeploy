/**
 * G5.1 image vulnerability scanning (`lib/imageScan.ts`, `modules/imageScans.ts`)
 * against a migrated in-memory SQLite. Trivy and docker are faked; the report
 * shape follows a real Trivy 0.69.3 report of debian:12.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { services, users, type DB } from '@ninedeploy/db';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});

const lib = await import('../../src/lib/imageScan.js');
const { imageScanPolicyRoutes, serviceImageScanRoutes } = await import('../../src/modules/imageScans.js');
const { buildTestApp, asUser } = await import('../helpers.js');
const { closeMigratedDb, migratedDb } = await import('./githubAppKit.js');

const IMG = `sha256:${'a'.repeat(64)}`;
const IMG2 = `sha256:${'b'.repeat(64)}`;
const vuln = (id: string, sev: string, fixed: string | null, pkg = 'openssl') => ({
  VulnerabilityID: id,
  PkgName: pkg,
  InstalledVersion: '3.0.11-1',
  FixedVersion: fixed ?? undefined,
  Severity: sev,
  Title: `${id} title`,
  PrimaryURL: `https://avd.aquasec.com/nvd/${id.toLowerCase()}`,
  Status: fixed ? 'fixed' : 'affected',
});
const report = (vulns: unknown[]) =>
  JSON.stringify({
    SchemaVersion: 2,
    Trivy: { Version: '0.69.3' },
    ArtifactName: '/tmp/image.tar',
    Metadata: { OS: { Family: 'debian', Name: '12.15' } },
    Results: [{ Target: '/tmp/image.tar (debian 12.15)', Class: 'os-pkgs', Type: 'debian', Vulnerabilities: vulns }],
  });

let db: DB;
beforeEach(async () => {
  db = await migratedDb();
  await db.insert(users).values({ id: 2, email: 'ops@example.com', passwordHash: 'x' });
  await db.insert(services).values([
    { id: 5, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 2, runtimeId: 'web-1' },
    { id: 6, name: 'stack', slug: 'stack', type: 'compose', branch: 'main', ownerUserId: 2, runtimeId: 'ndcmp-stack' },
    { id: 7, name: 'edge', slug: 'edge', type: 'docker', branch: 'main', ownerUserId: 2, runtimeId: 'edge-1', serverId: null, orchestrator: 'swarm' },
  ] as never);
});
afterEach(() => closeMigratedDb(db));

describe('parseTrivyReport', () => {
  it('counts by severity, separates fixable findings, dedupes and sorts most severe and fixable first', () => {
    const parsed = lib.parseTrivyReport(
      report([
        vuln('CVE-1', 'LOW', null, 'apt'),
        vuln('CVE-2', 'CRITICAL', null, 'zlib'),
        vuln('CVE-3', 'CRITICAL', '3.0.15-1'),
        vuln('CVE-3', 'CRITICAL', '3.0.15-1'), // same finding twice
        vuln('CVE-4', 'HIGH', '1.2'),
        vuln('CVE-5', 'weird', null),
      ]),
    );
    expect(parsed.os).toBe('debian 12.15');
    expect(parsed.counts).toEqual({ critical: 2, high: 1, medium: 0, low: 1, unknown: 1 });
    expect(parsed.fixable).toEqual({ critical: 1, high: 1, medium: 0, low: 0, unknown: 0 });
    expect(parsed.findings.map((f) => f.id)).toEqual(['CVE-3', 'CVE-2', 'CVE-4', 'CVE-1', 'CVE-5']);
    expect(parsed.findings[0]).toMatchObject({ pkg: 'openssl', installed: '3.0.11-1', fixed: '3.0.15-1', target: '/tmp/image.tar (debian 12.15)' });
  });

  it('keeps at most the cap of findings and says so; refuses what is not a report', () => {
    const many = Array.from({ length: 350 }, (_, i) => vuln(`CVE-${i}`, 'MEDIUM', null, `p${i}`));
    const parsed = lib.parseTrivyReport(report(many));
    expect(parsed.findings).toHaveLength(300);
    expect(parsed.findingsTruncated).toBe(true);
    expect(parsed.counts.medium).toBe(350);
    expect(() => lib.parseTrivyReport('{"error":"x"}')).toThrow(/JSON report/);
    expect(() => lib.parseTrivyReport('not json')).toThrow();
  });
});

describe('the deploy hook', () => {
  const log = () => {
    const lines: string[] = [];
    return { lines, fn: (l: string) => lines.push(l) };
  };
  const scan = (trivy: () => Promise<string>, l = log()) =>
    lib.scanBeforeTraffic(db, { serviceId: 5, deploymentId: 9, container: 'web-1' }, l.fn, { trivy, imageIdOf: async () => IMG });

  it('does nothing while scanning is off', async () => {
    const trivy = vi.fn();
    expect(await scan(trivy as never)).toBeNull();
    expect(trivy).not.toHaveBeenCalled();
  });

  it('records and logs the result; the gate counts only fixable findings by default', async () => {
    await lib.setImageScanPolicy(db, { enabled: true, gate: 'critical' });
    const l = log();
    const r = await scan(async () => report([vuln('CVE-2', 'CRITICAL', null), vuln('CVE-4', 'HIGH', '1.2')]), l);
    expect(r?.status).toBe('ok');
    expect(l.lines.join('\n')).toContain('Image scan (debian 12.15): 1 critical (0 fixable), 1 high (1 fixable)');
    expect(await lib.getImageScanResult(db, 5)).toMatchObject({ imageId: IMG, trigger: 'deploy', deploymentId: 9, blocked: false });
  });

  it('fails the deploy on a gated finding and marks the result blocked', async () => {
    await lib.setImageScanPolicy(db, { enabled: true, gate: 'high' });
    await expect(scan(async () => report([vuln('CVE-4', 'HIGH', '1.2')]))).rejects.toThrow(/Image scan gate: 1 critical or high fixable vulnerability/);
    expect((await lib.getImageScanResult(db, 5))?.blocked).toBe(true);
    // Counting unfixable ones too.
    await lib.setImageScanPolicy(db, { gate: 'critical', gateFixableOnly: false });
    await expect(scan(async () => report([vuln('CVE-2', 'CRITICAL', null)]))).rejects.toThrow(/1 critical vulnerability/);
  });

  it('never blocks when the scan cannot run', async () => {
    await lib.setImageScanPolicy(db, { enabled: true, gate: 'critical' });
    const l = log();
    const r = await scan(async () => {
      throw new Error('Trivy failed: database download refused');
    }, l);
    expect(r).toMatchObject({ status: 'error', error: 'Trivy failed: database download refused' });
    expect(l.lines.join('\n')).toContain('could not run, so it does not block this deploy');
  });

  it('covers docker services on the panel host only', () => {
    expect(lib.scannableOnPanel({ type: 'docker', serverId: null }, false)).toBe(true);
    expect(lib.scannableOnPanel({ type: 'docker', serverId: 3 }, false)).toBe(false);
    expect(lib.scannableOnPanel({ type: 'docker', serverId: null }, true)).toBe(false);
    expect(lib.scannableOnPanel({ type: 'compose', serverId: null }, false)).toBe(false);
  });
});

describe('scheduled rescans', () => {
  it('rescan stale or changed images only, report new fixable criticals, and drop results of deleted services', async () => {
    const images: Record<string, string> = { 'web-1': IMG, 'edge-1': IMG2 };
    const imageIdOf = vi.fn(async (c: string) => images[c] ?? Promise.reject(new Error('no such container')));
    let next = report([]);
    const trivy = vi.fn(async () => next);
    const onNewCritical = vi.fn();
    const deps = { trivy, imageIdOf, onNewCritical };

    expect(await lib.rescanRunningImages(db, deps)).toBe(0); // off
    await lib.setImageScanPolicy(db, { enabled: true, rescanHours: 24 });
    expect(await lib.rescanRunningImages(db, deps)).toBe(1); // web only: compose and Swarm are skipped
    expect(await lib.rescanRunningImages(db, deps)).toBe(0); // fresh
    expect(onNewCritical).not.toHaveBeenCalled();

    // A new deploy changed the image: rescanned, and the new critical is reported once.
    images['web-1'] = IMG2;
    next = report([vuln('CVE-9', 'CRITICAL', '2.0')]);
    expect(await lib.rescanRunningImages(db, deps)).toBe(1);
    expect(onNewCritical).toHaveBeenCalledTimes(1);
    expect(onNewCritical.mock.calls[0]![0]).toMatchObject({ id: 5, name: 'web' });

    // A day later: rescanned, nothing new to report.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 25 * 3_600_000);
      expect(await lib.rescanRunningImages(db, deps)).toBe(1);
      expect(onNewCritical).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }

    const { eq } = await import('drizzle-orm');
    await db.delete(services).where(eq(services.id, 5));
    await lib.rescanRunningImages(db, deps);
    expect(await lib.getImageScanResult(db, 5)).toBeNull();
  });
});

describe('routes', () => {
  it('policy for operators; a service scan is readable by viewers and refused while scanning is off', async () => {
    const app = await buildTestApp({ db });
    await app.register(imageScanPolicyRoutes, { prefix: '/image-scanning' });
    await app.register(serviceImageScanRoutes, { prefix: '/services' });
    const put = await app.inject({ method: 'PUT', url: '/image-scanning', headers: asUser(1), payload: { gate: 'critical' } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ policy: { enabled: false, gate: 'critical', gateFixableOnly: true, rescanHours: 24 } });
    expect(put.json().trivyImage).toContain('aquasec/trivy:0.69.3@sha256:');
    expect((await app.inject({ method: 'PUT', url: '/image-scanning', headers: asUser(1), payload: { rescanHours: -1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/image-scanning', headers: asUser({ id: 2, isOperator: false }) })).statusCode).toBe(403);

    expect((await app.inject({ method: 'GET', url: '/services/5/image-scan', headers: asUser(1) })).json()).toEqual({ result: null, scanning: false });
    const post = await app.inject({ method: 'POST', url: '/services/5/image-scan', headers: asUser(1) });
    expect(post.statusCode).toBe(409);
    expect(post.json().error.code).toBe('image_scanning_off');
    await app.inject({ method: 'PUT', url: '/image-scanning', headers: asUser(1), payload: { enabled: true } });
    const compose = await app.inject({ method: 'POST', url: '/services/6/image-scan', headers: asUser(1) });
    expect(compose.json().error.code).toBe('image_scan_unsupported');
  });
});
