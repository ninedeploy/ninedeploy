import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import { services, settings, type DB } from '@ninedeploy/db';
import {
  DEFAULT_IMAGE_SCAN_POLICY,
  IMAGE_SCAN_FINDINGS_MAX,
  imageScanPolicy,
  imageScanPolicyPatch,
  imageScanResult,
  type ImageScanCounts,
  type ImageScanFinding,
  type ImageScanPolicy,
  type ImageScanPolicyPatch,
  type ImageScanResult,
  type ImageScanSeverity,
} from '@ninedeploy/schemas';
import { buildEnv, capture, killTree } from './exec.js';
import { getSettingJson, setSettingJson } from './settings.js';

/**
 * G5.1 image vulnerability scanning with Trivy, panel host only.
 *
 * Trivy runs in a throwaway container that reads the image from
 * `docker save` on its stdin, so it never gets the Docker socket (root on the
 * host) and needs no host path. Only its vulnerability database persists, in
 * the `ninedeploy-trivy-cache` volume. The image is pinned by digest: Trivy's
 * own release channel was compromised in March 2026 (CVE-2026-33634, 0.69.4–
 * 0.69.6); 0.69.3 predates it. `NINEDEPLOY_TRIVY_IMAGE` points elsewhere (a
 * mirror, a newer pinned release).
 *
 * A deploy scans its new image after it starts and before it gets traffic
 * (`scanBeforeTraffic`); the gate fails the deploy there, so the previous
 * release keeps serving. A scan that cannot run (no network for the database,
 * Trivy refused) never blocks a deploy: it is recorded as `error` and logged.
 * No migration: the policy and each service's latest result are settings rows.
 */

export const DEFAULT_TRIVY_IMAGE =
  'aquasec/trivy:0.69.3@sha256:bcc376de8d77cfe086a917230e818dc9f8528e3c852f7b1aff648949b6258d1c';
export const TRIVY_CACHE_VOLUME = 'ninedeploy-trivy-cache';
const POLICY_KEY = 'image_scan_policy';
const RESULT_PREFIX = 'image_scan:';
const resultKey = (serviceId: number) => `${RESULT_PREFIX}${serviceId}`;
const SCAN_TIMEOUT_MS = 15 * 60_000;
const MAX_REPORT_BYTES = 64 * 1024 * 1024;

export function trivyImage(): string {
  const configured = (process.env['NINEDEPLOY_TRIVY_IMAGE'] ?? '').trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,254}$/.test(configured) ? configured : DEFAULT_TRIVY_IMAGE;
}

// ── policy and results ─────────────────────────────────────────────────────

export async function getImageScanPolicy(db: DB): Promise<ImageScanPolicy> {
  const stored = imageScanPolicy.partial().safeParse(await getSettingJson<unknown>(db, POLICY_KEY, null));
  return { ...DEFAULT_IMAGE_SCAN_POLICY, ...(stored.success ? stored.data : {}) };
}

export async function setImageScanPolicy(db: DB, patch: ImageScanPolicyPatch): Promise<ImageScanPolicy> {
  const next = imageScanPolicy.parse({ ...(await getImageScanPolicy(db)), ...imageScanPolicyPatch.parse(patch) });
  await setSettingJson(db, POLICY_KEY, next);
  return next;
}

export async function getImageScanResult(db: DB, serviceId: number): Promise<ImageScanResult | null> {
  return getSettingJson<ImageScanResult>(db, resultKey(serviceId), null);
}

/** Drop the results of services that no longer exist. Returns how many went. */
export async function pruneImageScanResults(db: DB): Promise<number> {
  const rows = await db.select({ key: settings.key }).from(settings).where(like(settings.key, `${RESULT_PREFIX}%`));
  let pruned = 0;
  for (const { key } of rows) {
    const id = Number(key.slice(RESULT_PREFIX.length));
    const alive = Number.isInteger(id) && (await db.query.services.findFirst({ where: eq(services.id, id), columns: { id: true } }));
    if (!alive) {
      await db.delete(settings).where(eq(settings.key, key));
      pruned++;
    }
  }
  return pruned;
}

// ── the Trivy report ───────────────────────────────────────────────────────

const ORDER: ImageScanSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'];
const zero = (): ImageScanCounts => ({ critical: 0, high: 0, medium: 0, low: 0, unknown: 0 });
const countKey = (s: ImageScanSeverity) => s.toLowerCase() as keyof ImageScanCounts;
const str = (v: unknown, max = 500): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);

export interface ParsedTrivyReport {
  os: string | null;
  counts: ImageScanCounts;
  fixable: ImageScanCounts;
  findings: ImageScanFinding[];
  findingsTruncated: boolean;
}

/** Read Trivy's `--format json` report. Throws when it is not one. */
export function parseTrivyReport(text: string): ParsedTrivyReport {
  const report = JSON.parse(text) as { SchemaVersion?: unknown; Metadata?: { OS?: { Family?: unknown; Name?: unknown } }; Results?: unknown };
  if (!report || typeof report !== 'object' || report.SchemaVersion === undefined) throw new Error('Trivy did not answer with a JSON report');
  const counts = zero();
  const fixable = zero();
  const all: ImageScanFinding[] = [];
  const seen = new Set<string>();
  for (const result of Array.isArray(report.Results) ? report.Results : []) {
    const target = str((result as { Target?: unknown }).Target, 300) ?? '';
    const vulns = (result as { Vulnerabilities?: unknown }).Vulnerabilities;
    for (const v of Array.isArray(vulns) ? (vulns as Array<Record<string, unknown>>) : []) {
      const id = str(v['VulnerabilityID'], 100);
      const pkg = str(v['PkgName'], 200);
      if (!id || !pkg) continue;
      const installed = str(v['InstalledVersion'], 200) ?? '';
      // One package can carry a CVE in several layers' views: count it once.
      const dedupe = `${id}|${pkg}|${installed}|${target}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const sev = String(v['Severity'] ?? 'UNKNOWN').toUpperCase();
      const severity: ImageScanSeverity = (ORDER as string[]).includes(sev) ? (sev as ImageScanSeverity) : 'UNKNOWN';
      const fixed = str(v['FixedVersion'], 200);
      counts[countKey(severity)]++;
      if (fixed) fixable[countKey(severity)]++;
      all.push({ id, severity, pkg, installed, fixed, title: str(v['Title']), url: str(v['PrimaryURL']), target });
    }
  }
  // Most severe first; within a severity, the ones that can be fixed first.
  all.sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity) || Number(b.fixed !== null) - Number(a.fixed !== null));
  const family = str(report.Metadata?.OS?.Family, 50);
  const name = str(report.Metadata?.OS?.Name, 50);
  return {
    os: family ? `${family}${name ? ` ${name}` : ''}` : null,
    counts,
    fixable,
    findings: all.slice(0, IMAGE_SCAN_FINDINGS_MAX),
    findingsTruncated: all.length > IMAGE_SCAN_FINDINGS_MAX,
  };
}

/** How many findings the gate counts against this result (0 = passes). */
export function gateFindings(policy: ImageScanPolicy, result: Pick<ImageScanResult, 'counts' | 'fixable' | 'status'>): number {
  if (policy.gate === 'off' || result.status !== 'ok') return 0;
  const c = policy.gateFixableOnly ? result.fixable : result.counts;
  return policy.gate === 'critical' ? c.critical : c.critical + c.high;
}

// ── running Trivy ──────────────────────────────────────────────────────────

/** `docker save <image> | docker run -i … trivy`: the report's JSON text. */
export function runTrivy(imageId: string, opts: { timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = buildEnv();
    const save = spawn('docker', ['save', imageId], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const scan = spawn(
      'docker',
      [
        'run', '-i', '--rm',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--pids-limit', '512',
        '--label', 'ninedeploy.role=image-scan',
        '-v', `${TRIVY_CACHE_VOLUME}:/root/.cache/trivy`,
        '--entrypoint', 'sh',
        trivyImage(),
        '-c', 'cat > /tmp/image.tar && trivy image --quiet --format json --scanners vuln --input /tmp/image.tar',
      ],
      { env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let settled = false;
    const out: Buffer[] = [];
    let outBytes = 0;
    let saveErr = '';
    let scanErr = '';
    const finish = (err: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        killTree(save, 'SIGKILL');
        killTree(scan, 'SIGKILL');
        reject(err);
      } else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error('The image scan timed out')), opts.timeoutMs ?? SCAN_TIMEOUT_MS);
    save.stdout.pipe(scan.stdin);
    scan.stdin.on('error', () => undefined); // the scanner exiting early surfaces through its exit code
    save.stderr.on('data', (d: Buffer) => (saveErr = (saveErr + d.toString()).slice(-2000)));
    scan.stderr.on('data', (d: Buffer) => (scanErr = (scanErr + d.toString()).slice(-2000)));
    scan.stdout.on('data', (d: Buffer) => {
      outBytes += d.length;
      if (outBytes > MAX_REPORT_BYTES) return finish(new Error('The scan report is too large'));
      out.push(d);
    });
    save.on('error', (e) => finish(e));
    scan.on('error', (e) => finish(e));
    let saveCode: number | null | undefined;
    let scanCode: number | null | undefined;
    const completeIfSuccessful = () => {
      if (saveCode === 0 && scanCode === 0) finish(null, Buffer.concat(out).toString('utf8'));
    };
    save.on('close', (code) => {
      saveCode = code;
      if (code !== 0) return finish(new Error(`docker save failed: ${saveErr.trim() || `exit ${code}`}`));
      completeIfSuccessful();
    });
    scan.on('close', (code) => {
      scanCode = code;
      if (code !== 0) return finish(new Error(`Trivy failed: ${scanErr.trim() || `exit ${code}`}`));
      completeIfSuccessful();
    });
  });
}

/** The local image id a container runs. */
export async function containerImageId(container: string): Promise<string> {
  const id = (await capture('docker', ['inspect', '--format', '{{.Image}}', container], { timeoutMs: 30_000 })).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error(`No image id for container ${container}`);
  return id;
}

export interface ScanDeps {
  trivy?: typeof runTrivy;
  /** G5.1: runs `image.scan` on a node and answers its result line (default: the sealed agent op). */
  nodeScan?: (db: DB, serverId: number, params: Record<string, unknown>) => Promise<string>;
}

/** One scan at a time on the host: Trivy is heavy, and deploy scans wait behind scheduled ones. */
let scanChain: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const next = scanChain.then(fn, fn);
  scanChain = next.catch(() => undefined);
  return next;
}

/** Scan an image for a service and store the result as its latest. Never throws for a failed scan. */
export async function scanServiceImage(
  db: DB,
  serviceId: number,
  imageId: string,
  trigger: ImageScanResult['trigger'],
  opts: { deploymentId?: number | null; deps?: ScanDeps } = {},
): Promise<ImageScanResult> {
  const trivy = opts.deps?.trivy ?? runTrivy;
  const base = { serviceId, imageId, trigger, deploymentId: opts.deploymentId ?? null, blocked: false };
  let result: ImageScanResult;
  try {
    const parsed = parseTrivyReport(await oneAtATime(() => trivy(imageId)));
    result = { ...base, scannedAt: new Date().toISOString(), status: 'ok', error: null, ...parsed };
  } catch (err) {
    result = {
      ...base,
      scannedAt: new Date().toISOString(),
      status: 'error',
      error: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
      os: null,
      counts: zero(),
      fixable: zero(),
      findings: [],
      findingsTruncated: false,
    };
  }
  await setSettingJson(db, resultKey(serviceId), result);
  return result;
}

/** G5.1: docker services on a node (not Swarm) are scanned by the node's agent, on schedule and on request. */
export function scannableOnNode(service: { type: string; serverId: number | null }, onSwarm: boolean): boolean {
  return service.type === 'docker' && service.serverId != null && !onSwarm;
}

async function defaultNodeScan(db: DB, serverId: number, params: Record<string, unknown>): Promise<string> {
  const { assertNodeCapability } = await import('./agentCapabilities.js');
  await assertNodeCapability(db, serverId, { cap: 'image.scan', feature: 'scan images for vulnerabilities', sealedRequired: true });
  const { agentOp } = await import('./agentClient.js');
  const res = await agentOp(db, serverId, 'image.scan', params, () => undefined);
  const frames = res.lines.filter((l) => l.startsWith('ND-IMAGE-SCAN '));
  if (res.exitCode !== 0 || frames.length !== 1 || Buffer.byteLength(frames[0]!) > 1_048_576) throw new Error('The node scan receipt is unavailable or ambiguous');
  return frames[0]!.slice('ND-IMAGE-SCAN '.length);
}

/**
 * Scan a node service's running image on its node and store the result.
 * `knownImageId`: when the container still runs that image the node answers
 * "unchanged" and null is returned (nothing stored). Never throws for a failed scan.
 */
export async function scanNodeServiceImage(
  db: DB,
  svc: { id: number; serverId: number; runtimeId: string },
  trigger: ImageScanResult['trigger'],
  opts: { knownImageId?: string; deps?: ScanDeps } = {},
): Promise<ImageScanResult | null> {
  const nodeScan = opts.deps?.nodeScan ?? defaultNodeScan;
  const base = { serviceId: svc.id, trigger, deploymentId: null, blocked: false };
  let result: ImageScanResult;
  try {
    const raw = await oneAtATime(() => nodeScan(db, svc.serverId, { container: svc.runtimeId, ...(opts.knownImageId ? { knownImageId: opts.knownImageId } : {}) }));
    if (Buffer.byteLength(raw) > 1_048_576) throw new Error('The node scan receipt exceeds its limit');
    const answer = JSON.parse(raw) as Partial<ParsedTrivyReport> & { imageId?: unknown; unchanged?: unknown };
    if (typeof answer.imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(answer.imageId)) throw new Error('The node answered no image id');
    if (answer.unchanged === true) {
      if (!opts.knownImageId || answer.imageId !== opts.knownImageId) throw new Error('The node returned an unconfirmed unchanged image');
      return null;
    }
    if (!answer.counts || !answer.fixable || !Array.isArray(answer.findings)) throw new Error('The node answered an incomplete report');
    result = {
      ...base,
      imageId: answer.imageId,
      scannedAt: new Date().toISOString(),
      status: 'ok',
      error: null,
      os: typeof answer.os === 'string' ? answer.os : null,
      counts: answer.counts,
      fixable: answer.fixable,
      findings: answer.findings.slice(0, IMAGE_SCAN_FINDINGS_MAX),
      findingsTruncated: answer.findingsTruncated === true || answer.findings.length > IMAGE_SCAN_FINDINGS_MAX,
    };
    // The node's answer is data from another machine: hold it to the stored shape.
    imageScanResult.parse(result);
  } catch (err) {
    result = {
      ...base,
      imageId: opts.knownImageId ?? 'node:unknown',
      scannedAt: new Date().toISOString(),
      status: 'error',
      error: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
      os: null,
      counts: zero(),
      fixable: zero(),
      findings: [],
      findingsTruncated: false,
    };
  }
  await setSettingJson(db, resultKey(svc.id), result);
  return result;
}

export function summaryLine(r: ImageScanResult): string {
  const c = r.counts;
  const f = r.fixable;
  return `${c.critical} critical (${f.critical} fixable), ${c.high} high (${f.high} fixable), ${c.medium} medium, ${c.low} low${c.unknown ? `, ${c.unknown} unknown` : ''}`;
}

/** The services a deploy scan covers: docker services that run on the panel host, not on Swarm. */
export function scannableOnPanel(service: { type: string; serverId: number | null }, onSwarm: boolean): boolean {
  return service.type === 'docker' && service.serverId == null && !onSwarm;
}

/** Compose stacks on the panel host are scanned on schedule and on request (report only: `up` starts the whole stack at once, so there is no point before traffic to gate). */
export function composeScannableOnPanel(service: { type: string; serverId: number | null }): boolean {
  return service.type === 'compose' && service.serverId == null;
}

/** The distinct images a compose stack runs, with the compose services of each. */
export async function composeStackImages(slug: string): Promise<Array<{ imageId: string; services: string[] }>> {
  const ids = (await capture('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=ndcmp-${slug}`], { timeoutMs: 30_000 }))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!ids.length) return [];
  if (ids.some(id => !/^[a-f0-9]{12,64}$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('Compose container inventory is incomplete or unconfirmed');
  const lines = (await capture('docker', ['inspect', '--format', '{{.Image}}\t{{ index .Config.Labels "com.docker.compose.service" }}', ...ids], { timeoutMs: 30_000 }))
    .split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length !== ids.length) throw new Error('Compose image inventory is incomplete or unconfirmed');
  const byImage = new Map<string, Set<string>>();
  for (const line of lines) {
    const [imageId, service, extra] = line.split('\t');
    if (!imageId || !/^sha256:[a-f0-9]{64}$/.test(imageId) || !service || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(service) || extra !== undefined) {
      throw new Error('Compose image inventory is incomplete or unconfirmed');
    }
    const set = byImage.get(imageId) ?? new Set<string>();
    set.add(service);
    byImage.set(imageId, set);
  }
  return [...byImage.entries()].map(([imageId, services]) => ({ imageId, services: [...services].sort() })).sort((a, b) => a.imageId.localeCompare(b.imageId));
}

/** The stable id of a stack's image set, so a rescan of unchanged images is skipped. */
export const composeImageSetId = (images: Array<{ imageId: string }>) =>
  `compose:${createHash('sha256').update(images.map((i) => i.imageId).join(',')).digest('hex').slice(0, 32)}`;

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'unknown'] as const;

/** Scan every image of a compose stack, one after the other, and store one merged result. Never throws for a failed scan. */
export async function scanComposeStack(
  db: DB,
  serviceId: number,
  images: Array<{ imageId: string; services: string[] }>,
  trigger: ImageScanResult['trigger'],
  opts: { deps?: ScanDeps } = {},
): Promise<ImageScanResult> {
  const trivy = opts.deps?.trivy ?? runTrivy;
  const counts = zero();
  const fixable = zero();
  const findings: ImageScanResult['findings'] = [];
  const scanned: NonNullable<ImageScanResult['images']> = [];
  const errors: string[] = [];
  let truncated = false;
  for (const img of images) {
    try {
      const parsed = parseTrivyReport(await oneAtATime(() => trivy(img.imageId)));
      for (const k of SEVERITY_ORDER) {
        counts[k] += parsed.counts[k];
        fixable[k] += parsed.fixable[k];
      }
      const label = img.services.join(', ') || img.imageId.slice(7, 19);
      for (const f of parsed.findings) findings.push({ ...f, target: `${label}: ${f.target}` });
      truncated ||= parsed.findingsTruncated;
      scanned.push({ services: img.services, imageId: img.imageId, os: parsed.os });
    } catch (err) {
      errors.push(`${img.services.join(', ') || img.imageId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const rank = (s: string) => SEVERITY_ORDER.indexOf(s.toLowerCase() as (typeof SEVERITY_ORDER)[number]);
  findings.sort((a, b) => rank(a.severity) - rank(b.severity));
  const ok = scanned.length > 0;
  const result: ImageScanResult = {
    serviceId,
    imageId: composeImageSetId(images),
    trigger,
    deploymentId: null,
    blocked: false,
    scannedAt: new Date().toISOString(),
    status: ok ? 'ok' : 'error',
    error: errors.length ? errors.join('; ').slice(0, 1000) : null,
    os: ok ? `${scanned.length} image${scanned.length === 1 ? '' : 's'}` : null,
    counts,
    fixable,
    findings: findings.slice(0, IMAGE_SCAN_FINDINGS_MAX),
    findingsTruncated: truncated || findings.length > IMAGE_SCAN_FINDINGS_MAX,
    images: scanned,
  };
  await setSettingJson(db, resultKey(serviceId), result);
  return result;
}

/**
 * Pipeline hook: scan the new container's image before it gets traffic. Throws
 * (failing the deploy; the previous release keeps serving) only when the gate
 * counts findings. Off unless an operator enabled scanning.
 */
export async function scanBeforeTraffic(
  db: DB,
  input: { serviceId: number; deploymentId: number; container: string },
  log: (line: string) => void,
  deps: ScanDeps & { imageIdOf?: typeof containerImageId } = {},
): Promise<ImageScanResult | null> {
  const policy = await getImageScanPolicy(db);
  if (!policy.enabled) return null;
  log('▶ Scanning the new image for known vulnerabilities (Trivy) …');
  let imageId: string;
  try {
    imageId = await (deps.imageIdOf ?? containerImageId)(input.container);
  } catch (err) {
    log(`warning: image scan skipped: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const result = await scanServiceImage(db, input.serviceId, imageId, 'deploy', { deploymentId: input.deploymentId, deps });
  if (result.status === 'error') {
    log(`warning: the image scan could not run, so it does not block this deploy: ${result.error}`);
    return result;
  }
  log(`Image scan${result.os ? ` (${result.os})` : ''}: ${summaryLine(result)}`);
  const blocking = gateFindings(policy, result);
  if (blocking > 0) {
    await setSettingJson(db, resultKey(input.serviceId), { ...result, blocked: true });
    const what = policy.gate === 'critical' ? 'critical' : 'critical or high';
    throw new Error(
      `Image scan gate: ${blocking} ${what}${policy.gateFixableOnly ? ' fixable' : ''} vulnerabilit${blocking === 1 ? 'y' : 'ies'} in the new image. ` +
        'Update the affected packages (the service page lists them), or change the gate under Settings → Image scanning.',
    );
  }
  return result;
}

// ── scheduled rescans ──────────────────────────────────────────────────────

export interface RescanDeps extends ScanDeps {
  imageIdOf?: typeof containerImageId;
  stackImagesOf?: typeof composeStackImages;
  /** Called when a rescan finds fixable critical findings that the previous scan did not have. */
  onNewCritical?: (service: { id: number; name: string }, result: ImageScanResult) => void;
}

/**
 * Rescan what runs on the panel host: a service whose latest scan is older
 * than the policy's interval, or was of another image. New vulnerabilities
 * are published against old images every day, so a clean deploy-time scan
 * goes stale. Returns how many services were scanned.
 */
export async function rescanRunningImages(db: DB, deps: RescanDeps = {}): Promise<number> {
  const policy = await getImageScanPolicy(db);
  await pruneImageScanResults(db);
  if (!policy.enabled || policy.rescanHours === 0) return 0;
  const { isSwarmService } = await import('../engine/swarmDeploy.js');
  const rows = await db.query.services.findMany({
    columns: { id: true, name: true, slug: true, type: true, serverId: true, runtimeId: true, orchestrator: true, isEphemeralPreview: true },
  });
  const staleBefore = Date.now() - policy.rescanHours * 3_600_000;
  let scanned = 0;
  for (const svc of rows) {
    if (svc.runtimeId && composeScannableOnPanel(svc)) {
      let images: Array<{ imageId: string; services: string[] }>;
      try {
        images = await (deps.stackImagesOf ?? composeStackImages)(svc.slug);
      } catch {
        const result: ImageScanResult = {
          serviceId: svc.id, imageId: 'compose:unconfirmed', trigger: 'schedule', deploymentId: null,
          blocked: false, scannedAt: new Date().toISOString(), status: 'error',
          error: 'The running Compose image inventory could not be confirmed', os: null,
          counts: zero(), fixable: zero(), findings: [], findingsTruncated: false, images: [],
        };
        await setSettingJson(db, resultKey(svc.id), result);
        continue;
      }
      if (!images.length) continue; // not running right now
      const last = await getImageScanResult(db, svc.id);
      const setId = composeImageSetId(images);
      if (last && last.status === 'ok' && !last.error && last.imageId === setId && Date.parse(last.scannedAt) > staleBefore) continue;
      const result = await scanComposeStack(db, svc.id, images, 'schedule', { deps });
      scanned++;
      const before = last && last.imageId === setId && last.status === 'ok' ? last.fixable.critical : 0;
      if (result.status === 'ok' && result.fixable.critical > before) deps.onNewCritical?.(svc, result);
      continue;
    }
    if (svc.runtimeId && svc.serverId != null && scannableOnNode(svc, isSwarmService(svc))) {
      const last = await getImageScanResult(db, svc.id);
      const fresh = last && last.status === 'ok' && Date.parse(last.scannedAt) > staleBefore;
      // A fresh result of the same image is kept: the node answers "unchanged" without scanning.
      const result = await scanNodeServiceImage(db, { id: svc.id, serverId: svc.serverId, runtimeId: svc.runtimeId }, 'schedule', {
        ...(fresh ? { knownImageId: last.imageId } : {}),
        deps,
      });
      if (!result) continue;
      scanned++;
      const before = last && last.imageId === result.imageId && last.status === 'ok' ? last.fixable.critical : 0;
      if (result.status === 'ok' && result.fixable.critical > before) deps.onNewCritical?.(svc, result);
      continue;
    }
    if (!svc.runtimeId || !scannableOnPanel(svc, isSwarmService(svc))) continue;
    let imageId: string;
    try {
      imageId = await (deps.imageIdOf ?? containerImageId)(svc.runtimeId);
    } catch {
      continue; // not running right now
    }
    const last = await getImageScanResult(db, svc.id);
    if (last && last.status === 'ok' && !last.error && last.imageId === imageId && Date.parse(last.scannedAt) > staleBefore) continue;
    const result = await scanServiceImage(db, svc.id, imageId, 'schedule', { deps });
    scanned++;
    const before = last && last.imageId === imageId && last.status === 'ok' ? last.fixable.critical : 0;
    if (result.status === 'ok' && result.fixable.critical > before) deps.onNewCritical?.(svc, result);
  }
  return scanned;
}
