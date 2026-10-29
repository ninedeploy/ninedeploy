/**
 * G5.1 image scanning (`lib/imageScan.ts`), the edges the main suite leaves:
 * the Trivy image override, a damaged stored policy, pruning, the report
 * parser's tolerance, the gate, docker argv for containers, Swarm services
 * and compose stacks, the node scan through the agent op, the deploy hook on
 * a node, and the scheduled rescan of node and Swarm services. docker, the
 * agent and Trivy are stand-ins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { services, users, type DB } from '@ninedeploy/db';

vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ab'.repeat(32);
});
const m = vi.hoisted(() => ({
  capture: vi.fn<(cmd: string, args: string[], opts?: unknown) => Promise<string>>(),
  agentOp: vi.fn<(...a: unknown[]) => Promise<{ exitCode: number; lines: string[] }>>(),
  capability: vi.fn<(...a: unknown[]) => Promise<void>>(),
}));
vi.mock('../../src/lib/exec.js', async (orig) => ({ ...(await orig<object>()), capture: m.capture }));
vi.mock('../../src/lib/agentClient.js', async (orig) => ({ ...(await orig<object>()), agentOp: m.agentOp }));
vi.mock('../../src/lib/agentCapabilities.js', async (orig) => ({ ...(await orig<object>()), assertNodeCapability: m.capability }));

const lib = await import('../../src/lib/imageScan.js');
const { setSettingJson, getSettingJson } = await import('../../src/lib/settings.js');
const { closeMigratedDb, migratedDb } = await import('./githubAppKit.js');

const IMG = `sha256:${'a'.repeat(64)}`;
const IMG2 = `sha256:${'b'.repeat(64)}`;
const IMG3 = `sha256:${'c'.repeat(64)}`;
const report = (vulns: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ SchemaVersion: 2, Metadata: { OS: { Family: 'alpine', Name: '3.20' } }, Results: [{ Target: 'img (alpine 3.20)', Vulnerabilities: vulns }], ...extra });
const vuln = (id: string, sev: string, fixed: string | null, pkg = 'musl') => ({ VulnerabilityID: id, PkgName: pkg, InstalledVersion: '1.0', FixedVersion: fixed ?? undefined, Severity: sev });
const nodeReport = (critical: number, extra: Record<string, unknown> = {}) => ({
  imageId: IMG,
  os: 'debian 12',
  counts: { critical, high: 0, medium: 0, low: 0, unknown: 0 },
  fixable: { critical, high: 0, medium: 0, low: 0, unknown: 0 },
  findings: Array.from({ length: critical }, (_, i) => ({ id: `CVE-${i}`, severity: 'CRITICAL', pkg: 'openssl', installed: '1', fixed: '2', title: null, url: null, target: 'img' })),
  findingsTruncated: false,
  ...extra,
});

let db: DB;
beforeEach(async () => {
  m.capture.mockReset();
  m.agentOp.mockReset();
  m.capability.mockReset().mockResolvedValue(undefined);
  db = await migratedDb();
  await db.insert(users).values({ id: 2, email: 'ops@example.com', passwordHash: 'x' });
});
afterEach(() => {
  delete process.env['NINEDEPLOY_TRIVY_IMAGE'];
  return closeMigratedDb(db);
});

describe('policy, results and the Trivy image', () => {
  it('uses a configured Trivy image only when it is a plain reference', () => {
    expect(lib.trivyImage()).toBe(lib.DEFAULT_TRIVY_IMAGE);
    process.env['NINEDEPLOY_TRIVY_IMAGE'] = '  registry.local/trivy:0.69.3  ';
    expect(lib.trivyImage()).toBe('registry.local/trivy:0.69.3');
    process.env['NINEDEPLOY_TRIVY_IMAGE'] = 'trivy; rm -rf /';
    expect(lib.trivyImage()).toBe(lib.DEFAULT_TRIVY_IMAGE);
  });

  it('falls back to the defaults for a damaged stored policy', async () => {
    await setSettingJson(db, 'image_scan_policy', { enabled: 'yes', gate: 'everything' });
    expect(await lib.getImageScanPolicy(db)).toEqual({ enabled: false, gate: 'off', gateFixableOnly: true, rescanHours: 24 });
    await expect(lib.setImageScanPolicy(db, { rescanHours: -3 } as never)).rejects.toThrow();
  });

  it('prunes results of deleted services and of keys that name no service', async () => {
    await db.insert(services).values({ id: 5, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 2 } as never);
    await setSettingJson(db, 'image_scan:5', { a: 1 });
    await setSettingJson(db, 'image_scan:6', { a: 1 });
    await setSettingJson(db, 'image_scan:junk', { a: 1 });
    expect(await lib.pruneImageScanResults(db)).toBe(2);
    expect(await getSettingJson(db, 'image_scan:5', null)).toEqual({ a: 1 });
    expect(await getSettingJson(db, 'image_scan:junk', null)).toBeNull();
    expect(await lib.pruneImageScanResults(db)).toBe(0);
  });
});

describe('parseTrivyReport tolerance', () => {
  it('reads a report without results, OS or vulnerability lists', () => {
    expect(lib.parseTrivyReport(JSON.stringify({ SchemaVersion: 2 }))).toEqual({
      os: null,
      counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
      fixable: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
      findings: [],
      findingsTruncated: false,
    });
    const r = lib.parseTrivyReport(JSON.stringify({ SchemaVersion: 2, Metadata: { OS: { Family: 'alpine' } }, Results: [{ Target: 5, Vulnerabilities: 'none' }, {}] }));
    expect(r.os).toBe('alpine');
    expect(r.findings).toEqual([]);
    expect(() => lib.parseTrivyReport('null')).toThrow(/JSON report/);
  });

  it('skips findings without an id or package, and defaults severity, version and target', () => {
    const r = lib.parseTrivyReport(
      JSON.stringify({
        SchemaVersion: 2,
        Results: [
          {
            Vulnerabilities: [
              { VulnerabilityID: 'CVE-A', PkgName: '' },
              { PkgName: 'zlib' },
              { VulnerabilityID: 'CVE-B', PkgName: 'zlib' },
              { VulnerabilityID: 'CVE-C', PkgName: 'zlib', Severity: 'medium', FixedVersion: '2', Title: 't', PrimaryURL: 'https://x' },
              { VulnerabilityID: 'CVE-D', PkgName: 'zlib', Severity: 'MEDIUM' },
            ],
          },
        ],
      }),
    );
    expect(r.counts).toEqual({ critical: 0, high: 0, medium: 2, low: 0, unknown: 1 });
    expect(r.fixable.medium).toBe(1);
    expect(r.findings).toEqual([
      { id: 'CVE-C', severity: 'MEDIUM', pkg: 'zlib', installed: '', fixed: '2', title: 't', url: 'https://x', target: '' },
      { id: 'CVE-D', severity: 'MEDIUM', pkg: 'zlib', installed: '', fixed: null, title: null, url: null, target: '' },
      { id: 'CVE-B', severity: 'UNKNOWN', pkg: 'zlib', installed: '', fixed: null, title: null, url: null, target: '' },
    ]);
  });
});

describe('gateFindings and summaryLine', () => {
  const counts = { critical: 2, high: 3, medium: 0, low: 0, unknown: 0 };
  const fixable = { critical: 1, high: 1, medium: 0, low: 0, unknown: 0 };
  it('counts what the gate covers and nothing for a failed scan', () => {
    const r = { counts, fixable, status: 'ok' as const };
    expect(lib.gateFindings({ enabled: true, gate: 'off', gateFixableOnly: true, rescanHours: 24 }, r)).toBe(0);
    expect(lib.gateFindings({ enabled: true, gate: 'critical', gateFixableOnly: true, rescanHours: 24 }, r)).toBe(1);
    expect(lib.gateFindings({ enabled: true, gate: 'high', gateFixableOnly: true, rescanHours: 24 }, r)).toBe(2);
    expect(lib.gateFindings({ enabled: true, gate: 'high', gateFixableOnly: false, rescanHours: 24 }, r)).toBe(5);
    expect(lib.gateFindings({ enabled: true, gate: 'high', gateFixableOnly: false, rescanHours: 24 }, { ...r, status: 'error' })).toBe(0);
  });

  it('mentions unknown findings only when there are some', () => {
    const base = { counts, fixable } as never as Parameters<typeof lib.summaryLine>[0];
    expect(lib.summaryLine(base)).toBe('2 critical (1 fixable), 3 high (1 fixable), 0 medium, 0 low');
    expect(lib.summaryLine({ ...base, counts: { ...counts, unknown: 4 } })).toBe('2 critical (1 fixable), 3 high (1 fixable), 0 medium, 0 low, 4 unknown');
  });

  it('classifies services by where they are scanned', () => {
    expect(lib.scannableSwarm({ type: 'docker' }, true)).toBe(true);
    expect(lib.scannableSwarm({ type: 'docker' }, false)).toBe(false);
    expect(lib.scannableSwarm({ type: 'compose' }, true)).toBe(false);
    expect(lib.scannableOnNode({ type: 'docker', serverId: 3 }, false)).toBe(true);
    expect(lib.scannableOnNode({ type: 'docker', serverId: 3 }, true)).toBe(false);
    expect(lib.scannableOnNode({ type: 'docker', serverId: null }, false)).toBe(false);
    expect(lib.scannableOnNode({ type: 'compose', serverId: 3 }, false)).toBe(false);
    expect(lib.composeScannableOnPanel({ type: 'compose', serverId: null })).toBe(true);
    expect(lib.composeScannableOnPanel({ type: 'compose', serverId: 2 })).toBe(false);
    expect(lib.composeScannableOnPanel({ type: 'docker', serverId: null })).toBe(false);
  });
});

describe('docker lookups', () => {
  it('reads the image id a container runs, and refuses anything that is not one', async () => {
    m.capture.mockResolvedValueOnce(`${IMG}\n`);
    expect(await lib.containerImageId('web-1')).toBe(IMG);
    expect(m.capture).toHaveBeenCalledWith('docker', ['inspect', '--format', '{{.Image}}', 'web-1'], { timeoutMs: 30_000 });
    m.capture.mockResolvedValueOnce('nginx:latest');
    await expect(lib.containerImageId('web-1')).rejects.toThrow('No image id for container web-1');
  });

  it('resolves a Swarm service spec image to a local image id', async () => {
    m.capture.mockResolvedValueOnce('nginx:1.27@sha256:abc\n').mockResolvedValueOnce(`${IMG}\n`);
    expect(await lib.swarmServiceImageId('svc1')).toBe(IMG);
    expect(m.capture.mock.calls.map((c) => c[1])).toEqual([
      ['service', 'inspect', '--format', '{{.Spec.TaskTemplate.ContainerSpec.Image}}', 'svc1'],
      ['image', 'inspect', '--format', '{{.Id}}', 'nginx:1.27@sha256:abc'],
    ]);
  });

  it('says why a Swarm service has no scannable image', async () => {
    m.capture.mockResolvedValueOnce('  \n');
    await expect(lib.swarmServiceImageId('svc1')).rejects.toThrow('Swarm service svc1 names no image');
    m.capture.mockResolvedValueOnce('nginx:1.27').mockRejectedValueOnce(new Error('No such image'));
    await expect(lib.swarmServiceImageId('svc1')).rejects.toThrow('The image nginx:1.27 of this Swarm service is not on the panel host, so it cannot be scanned here');
    m.capture.mockResolvedValueOnce('nginx:1.27').mockResolvedValueOnce('garbage');
    await expect(lib.swarmServiceImageId('svc1')).rejects.toThrow(/not on the panel host/);
  });

  it('lists a compose stack image set, grouped by image with sorted services', async () => {
    m.capture.mockResolvedValueOnce('');
    expect(await lib.composeStackImages('shop')).toEqual([]);
    expect(m.capture.mock.calls[0]![1]).toEqual(['ps', '-q', '--filter', 'label=com.docker.compose.project=ndcmp-shop']);

    m.capture.mockReset();
    m.capture.mockResolvedValueOnce('aaaaaaaaaaaa\nbbbbbbbbbbbb\ncccccccccccc\n').mockResolvedValueOnce(`${IMG2}\tworker\n${IMG}\tapi\n${IMG2}\tcron\n`);
    expect(await lib.composeStackImages('shop')).toEqual([
      { imageId: IMG, services: ['api'] },
      { imageId: IMG2, services: ['cron', 'worker'] },
    ]);
    expect(m.capture.mock.calls[1]![1]).toEqual([
      'inspect', '--format', '{{.Image}}\t{{ index .Config.Labels "com.docker.compose.service" }}', 'aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'cccccccccccc',
    ]);
  });

  it('refuses an incomplete or unconfirmed compose inventory', async () => {
    const cases: Array<[string, string | null]> = [
      ['NOT-AN-ID\n', null],
      ['aaaaaaaaaaaa\naaaaaaaaaaaa\n', null],
      ['aaaaaaaaaaaa\nbbbbbbbbbbbb\n', `${IMG}\tapi\n`],
      ['aaaaaaaaaaaa\n', 'nginx\tapi\n'],
      ['aaaaaaaaaaaa\n', `${IMG}\n`],
      ['aaaaaaaaaaaa\n', `${IMG}\t-bad\n`],
      ['aaaaaaaaaaaa\n', `${IMG}\tapi\textra\n`],
    ];
    for (const [ps, inspect] of cases) {
      m.capture.mockReset();
      m.capture.mockResolvedValueOnce(ps);
      if (inspect !== null) m.capture.mockResolvedValueOnce(inspect);
      await expect(lib.composeStackImages('shop')).rejects.toThrow(/inventory is incomplete or unconfirmed/);
    }
  });
});

describe('scanComposeStack', () => {
  it('labels findings by image id when no compose service is known, and records every failure', async () => {
    const trivy = vi.fn(async (img: string) => {
      if (img === IMG) return report([vuln('CVE-1', 'HIGH', '2'), vuln('CVE-2', 'CRITICAL', null)]);
      throw img === IMG2 ? new Error('scanner offline') : 'plain failure';
    });
    const r = await lib.scanComposeStack(db, 6, [
      { imageId: IMG, services: [] },
      { imageId: IMG2, services: ['db'] },
      { imageId: IMG3, services: [] },
    ], 'manual', { deps: { trivy } });
    expect(r.status).toBe('ok');
    expect(r.os).toBe('1 image');
    expect(r.findings.map((f) => `${f.id} ${f.target}`)).toEqual([`CVE-2 ${'a'.repeat(12)}: img (alpine 3.20)`, `CVE-1 ${'a'.repeat(12)}: img (alpine 3.20)`]);
    expect(r.error).toBe(`db: scanner offline; ${IMG3}: plain failure`);
    expect(r.images).toEqual([{ services: [], imageId: IMG, os: 'alpine 3.20' }]);
    expect(await lib.getImageScanResult(db, 6)).toMatchObject({ trigger: 'manual', imageId: lib.composeImageSetId([{ imageId: IMG }, { imageId: IMG2 }, { imageId: IMG3 }]) });
  });

  it('is an error when no image could be scanned, and caps merged findings', async () => {
    const failed = await lib.scanComposeStack(db, 6, [{ imageId: IMG, services: ['api'] }], 'schedule', {
      deps: { trivy: async () => Promise.reject(new Error('down')) },
    });
    expect(failed).toMatchObject({ status: 'error', os: null, error: 'api: down', images: [] });

    const many = (p: string) => Array.from({ length: 200 }, (_, i) => vuln(`CVE-${p}${i}`, 'LOW', null, `${p}${i}`));
    const big = await lib.scanComposeStack(db, 6, [{ imageId: IMG, services: ['a'] }, { imageId: IMG2, services: ['b'] }], 'schedule', {
      deps: { trivy: async (img) => report(many(img === IMG ? 'a' : 'b')) },
    });
    expect(big.findings).toHaveLength(300);
    expect(big.findingsTruncated).toBe(true);
    expect(big.counts.low).toBe(400);
    expect(big.os).toBe('2 images');
  });

  it('records a non-Error throw from Trivy as the scan error', async () => {
    const r = await lib.scanServiceImage(db, 5, IMG, 'manual', { deps: { trivy: async () => Promise.reject('boom') } });
    expect(r).toMatchObject({ status: 'error', error: 'boom', deploymentId: null });
  });
});

describe('scanNodeServiceImage', () => {
  const svc = { id: 8, serverId: 3, runtimeId: 'nd-svc-edge' };
  const scanWith = (raw: string | (() => Promise<string>), opts: Record<string, unknown> = {}) =>
    lib.scanNodeServiceImage(db, svc, 'manual', { ...opts, deps: { nodeScan: typeof raw === 'string' ? async () => raw : raw } });

  it('runs the sealed agent op and reads its one receipt frame', async () => {
    m.agentOp.mockResolvedValue({ exitCode: 0, lines: ['progress', `ND-IMAGE-SCAN ${JSON.stringify(nodeReport(1))}`] });
    const r = await lib.scanNodeServiceImage(db, svc, 'manual', { knownImageId: IMG2 });
    expect(m.capability).toHaveBeenCalledWith(db, 3, { cap: 'image.scan', feature: 'scan images for vulnerabilities', sealedRequired: true });
    expect(m.agentOp).toHaveBeenCalledWith(db, 3, 'image.scan', { container: 'nd-svc-edge', knownImageId: IMG2 }, expect.any(Function));
    expect((m.agentOp.mock.calls[0]![4] as () => unknown)()).toBeUndefined();
    expect(r).toMatchObject({ status: 'ok', imageId: IMG, os: 'debian 12', counts: { critical: 1 } });
  });

  it('refuses a missing, doubled or failed receipt from the agent', async () => {
    for (const res of [
      { exitCode: 0, lines: ['no frame'] },
      { exitCode: 0, lines: ['ND-IMAGE-SCAN {}', 'ND-IMAGE-SCAN {}'] },
      { exitCode: 1, lines: [`ND-IMAGE-SCAN ${JSON.stringify(nodeReport(0))}`] },
      { exitCode: 0, lines: [`ND-IMAGE-SCAN ${'x'.repeat(1_048_577)}`] },
    ]) {
      m.agentOp.mockResolvedValueOnce(res);
      const r = await lib.scanNodeServiceImage(db, svc, 'schedule');
      expect(r).toMatchObject({ status: 'error', error: 'The node scan receipt is unavailable or ambiguous', imageId: 'node:unknown' });
    }
    m.capability.mockRejectedValueOnce(new Error('agent lacks image.scan'));
    expect(await lib.scanNodeServiceImage(db, svc, 'schedule')).toMatchObject({ status: 'error', error: 'agent lacks image.scan' });
  });

  it('refuses answers that are oversized, without an image id, unconfirmed or incomplete', async () => {
    expect(await scanWith('x'.repeat(1_048_577))).toMatchObject({ status: 'error', error: 'The node scan receipt exceeds its limit' });
    expect(await scanWith(JSON.stringify({ imageId: 'nginx' }))).toMatchObject({ error: 'The node answered no image id' });
    expect(await scanWith(JSON.stringify({ imageId: IMG, unchanged: true }))).toMatchObject({ error: 'The node returned an unconfirmed unchanged image' });
    expect(await scanWith(JSON.stringify({ imageId: IMG, unchanged: true }), { knownImageId: IMG2 })).toMatchObject({
      error: 'The node returned an unconfirmed unchanged image',
      imageId: IMG2,
    });
    expect(await scanWith(JSON.stringify({ imageId: IMG, counts: {} }))).toMatchObject({ error: 'The node answered an incomplete report' });
    // The stored shape is enforced on another machine's answer.
    const bad = await scanWith(JSON.stringify(nodeReport(0, { counts: { critical: -1, high: 0, medium: 0, low: 0, unknown: 0 } })));
    expect(bad).toMatchObject({ status: 'error', imageId: 'node:unknown' });
    expect(await scanWith(async () => Promise.reject('offline'))).toMatchObject({ error: 'offline' });
  });

  it('confirms an unchanged image without storing anything, and caps a long report', async () => {
    expect(await scanWith(JSON.stringify({ imageId: IMG, unchanged: true }), { knownImageId: IMG })).toBeNull();
    expect(await lib.getImageScanResult(db, 8)).toBeNull();

    const findings = Array.from({ length: 301 }, (_, i) => ({ id: `CVE-${i}`, severity: 'LOW', pkg: 'p', installed: '1', fixed: null, title: null, url: null, target: 't' }));
    const r = await scanWith(JSON.stringify(nodeReport(0, { os: 7, findings })), { deploymentId: 4 });
    expect(r).toMatchObject({ status: 'ok', os: null, findingsTruncated: true, deploymentId: 4 });
    expect(r!.findings).toHaveLength(300);
    const flagged = await scanWith(JSON.stringify(nodeReport(0, { findingsTruncated: true })));
    expect(flagged!.findingsTruncated).toBe(true);
  });
});

describe('scanBeforeTraffic', () => {
  const lines: string[] = [];
  const log = (l: string) => void lines.push(l);
  beforeEach(() => {
    lines.length = 0;
  });

  it('scans on the node, and the gate blocks a node image', async () => {
    await lib.setImageScanPolicy(db, { enabled: true, gate: 'critical' });
    const nodeScan = vi.fn(async () => JSON.stringify(nodeReport(2)));
    await expect(lib.scanBeforeTraffic(db, { serviceId: 8, deploymentId: 9, container: 'nd-svc-edge', serverId: 3 }, log, { nodeScan })).rejects.toThrow(
      'Image scan gate: 2 critical fixable vulnerabilities in the new image.',
    );
    expect(nodeScan).toHaveBeenCalledWith(db, 3, { container: 'nd-svc-edge' });
    expect(lines[0]).toContain('(Trivy, on the node)');
    expect(lines[1]).toBe('Image scan (debian 12): 2 critical (2 fixable), 0 high (0 fixable), 0 medium, 0 low');
    expect(await lib.getImageScanResult(db, 8)).toMatchObject({ blocked: true, trigger: 'deploy', deploymentId: 9 });
  });

  it('passes a clean node image and logs a node that cannot scan without blocking', async () => {
    await lib.setImageScanPolicy(db, { enabled: true, gate: 'high' });
    const ok = await lib.scanBeforeTraffic(db, { serviceId: 8, deploymentId: 9, container: 'c', serverId: 3 }, log, { nodeScan: async () => JSON.stringify(nodeReport(0, { os: null })) });
    expect(ok).toMatchObject({ status: 'ok', blocked: false });
    expect(lines).toContain('Image scan: 0 critical (0 fixable), 0 high (0 fixable), 0 medium, 0 low');

    const failed = await lib.scanBeforeTraffic(db, { serviceId: 8, deploymentId: 9, container: 'c', serverId: 3 }, log, { nodeScan: async () => Promise.reject(new Error('agent offline')) });
    expect(failed).toMatchObject({ status: 'error', error: 'agent offline' });
    expect(lines.at(-1)).toBe('warning: the image scan could not run, so it does not block this deploy: agent offline');
  });

  it('skips the scan when the container image cannot be read', async () => {
    await lib.setImageScanPolicy(db, { enabled: true });
    const trivy = vi.fn();
    expect(await lib.scanBeforeTraffic(db, { serviceId: 5, deploymentId: 9, container: 'gone' }, log, { trivy, imageIdOf: async () => Promise.reject(new Error('No such container')) })).toBeNull();
    expect(lines.at(-1)).toBe('warning: image scan skipped: No such container');
    expect(await lib.scanBeforeTraffic(db, { serviceId: 5, deploymentId: 9, container: 'gone', serverId: null }, log, { trivy, imageIdOf: async () => Promise.reject('gone') })).toBeNull();
    expect(lines.at(-1)).toBe('warning: image scan skipped: gone');
    expect(trivy).not.toHaveBeenCalled();
  });

  it('blocks on one high finding with the singular wording, counting unfixable ones', async () => {
    await lib.setImageScanPolicy(db, { enabled: true, gate: 'high', gateFixableOnly: false });
    await expect(
      lib.scanBeforeTraffic(db, { serviceId: 5, deploymentId: 9, container: 'web-1' }, log, { trivy: async () => report([vuln('CVE-1', 'HIGH', null)]), imageIdOf: async () => IMG }),
    ).rejects.toThrow('Image scan gate: 1 critical or high vulnerability in the new image.');
  });
});

describe('rescanRunningImages on nodes and Swarm', () => {
  beforeEach(async () => {
    await db.insert(services).values([
      { id: 8, name: 'edge', slug: 'edge', type: 'docker', branch: 'main', ownerUserId: 2, runtimeId: 'nd-svc-edge' },
      { id: 9, name: 'swarmy', slug: 'swarmy', type: 'docker', branch: 'main', ownerUserId: 2, runtimeId: 'swarm-svc', orchestrator: 'swarm' },
      { id: 10, name: 'idle', slug: 'idle', type: 'docker', branch: 'main', ownerUserId: 2, runtimeId: null },
    ] as never);
    await db.run(sql`PRAGMA foreign_keys = OFF`);
    await db.run(sql`UPDATE services SET server_id = 3 WHERE id = 8`);
  });

  it('does nothing while the schedule is off', async () => {
    await lib.setImageScanPolicy(db, { enabled: true, rescanHours: 0 });
    const nodeScan = vi.fn();
    expect(await lib.rescanRunningImages(db, { nodeScan })).toBe(0);
    expect(nodeScan).not.toHaveBeenCalled();
  });

  it('rescans node services, passes a fresh image as known, and reports a new fixable critical', async () => {
    await lib.setImageScanPolicy(db, { enabled: true, rescanHours: 24 });
    let answer = JSON.stringify(nodeReport(0));
    const nodeScan = vi.fn(async () => answer);
    const swarmImageIdOf = vi.fn(async () => IMG2);
    const onNewCritical = vi.fn();
    const deps = { nodeScan, swarmImageIdOf, onNewCritical, trivy: async () => report([]) };

    expect(await lib.rescanRunningImages(db, deps)).toBe(2); // the node service and the Swarm service
    expect(nodeScan).toHaveBeenLastCalledWith(db, 3, { container: 'nd-svc-edge' });
    expect(swarmImageIdOf).toHaveBeenCalledWith('swarm-svc');
    expect(await lib.getImageScanResult(db, 9)).toMatchObject({ status: 'ok', imageId: IMG2, trigger: 'schedule' });

    // Fresh: the node is told the known image and answers "unchanged"; Swarm is skipped.
    answer = JSON.stringify({ imageId: IMG, unchanged: true });
    expect(await lib.rescanRunningImages(db, deps)).toBe(0);
    expect(nodeScan).toHaveBeenLastCalledWith(db, 3, { container: 'nd-svc-edge', knownImageId: IMG });

    // A changed node image with a fixable critical is reported.
    answer = JSON.stringify(nodeReport(1));
    expect(await lib.rescanRunningImages(db, deps)).toBe(1);
    expect(onNewCritical).toHaveBeenCalledTimes(1);
    expect(onNewCritical.mock.calls[0]![0]).toMatchObject({ id: 8, name: 'edge' });
    // The same critical again is not new.
    expect(await lib.rescanRunningImages(db, deps)).toBe(1);
    expect(onNewCritical).toHaveBeenCalledTimes(1);
  });

  it('reports a new fixable critical on a Swarm image', async () => {
    await lib.setImageScanPolicy(db, { enabled: true, rescanHours: 24 });
    const onNewCritical = vi.fn();
    const deps = {
      nodeScan: async () => Promise.reject(new Error('offline')),
      swarmImageIdOf: async () => IMG2,
      onNewCritical,
      trivy: async () => report([vuln('CVE-9', 'CRITICAL', '2')]),
    };
    expect(await lib.rescanRunningImages(db, deps)).toBe(2);
    expect(onNewCritical).toHaveBeenCalledTimes(1);
    expect(onNewCritical.mock.calls[0]![0]).toMatchObject({ id: 9 });
    // The failed node scan was recorded and counted, but is not a critical to report.
    expect(await lib.getImageScanResult(db, 8)).toMatchObject({ status: 'error', error: 'offline' });
  });

  it('records why a Swarm image cannot be scanned once per stale period', async () => {
    await lib.setImageScanPolicy(db, { enabled: true, rescanHours: 24 });
    const swarmImageIdOf = vi.fn(async () => Promise.reject(new Error('The image x of this Swarm service is not on the panel host')));
    const deps = { nodeScan: async () => JSON.stringify({ imageId: IMG, unchanged: true }), swarmImageIdOf };
    expect(await lib.rescanRunningImages(db, deps)).toBe(1); // the node scan with no known image fails and is stored
    const first = (await lib.getImageScanResult(db, 9))!;
    expect(first).toMatchObject({ status: 'error', imageId: 'swarm:unknown', error: 'The image x of this Swarm service is not on the panel host' });
    // Within the period the stored reason is kept as it was.
    await lib.rescanRunningImages(db, deps);
    expect((await lib.getImageScanResult(db, 9))!.scannedAt).toBe(first.scannedAt);

    // A day later it is recorded again, keeping the last image id it knew.
    await setSettingJson(db, 'image_scan:9', { ...first, imageId: IMG3, scannedAt: new Date(Date.now() - 25 * 3_600_000).toISOString() });
    swarmImageIdOf.mockRejectedValueOnce('daemon gone');
    await lib.rescanRunningImages(db, deps);
    expect(await lib.getImageScanResult(db, 9)).toMatchObject({ status: 'error', imageId: IMG3, error: 'daemon gone' });
  });
});
