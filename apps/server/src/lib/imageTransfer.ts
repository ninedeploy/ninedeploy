import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, rmSync, statfsSync } from 'node:fs';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { type DB, imageTransfers, sources } from '@ninedeploy/db';
import { config } from '../config.js';
import { agentOp, agentTransportSealed } from './agentClient.js';
import { type AgentCaller, capabilityRefusal, nodeLabel } from './agentCapabilities.js';
import { openAgentStream } from './agentStream.js';
import { decrypt } from './crypto.js';
import { HttpError } from './errors.js';
import { buildEnv, capture, run } from './exec.js';
import { acquireRegistryLock, registryLockKey } from './registryLock.js';
import { boundRegistryHosts } from './registryBinding.js';

/**
 * Image transfer between build hosts and the hosts that run a service
 * (multi-node, design §6.3, §6.4; owner decision O3).
 *
 * Two methods:
 *
 *  - **Stream relay** (the default, no configuration): `image.save` on the
 *    build node — or a local `docker save <id> | gzip` on the panel — piped
 *    into `image.load` on the target node, or into a verified local load when
 *    the panel runs the service. Node to node goes through the panel in
 *    memory; the bytes never touch the panel's disk. Each hop is a sealed
 *    stream (per-channel key, strict counters, GCM); the end frame's
 *    `{bytes, sha256}` must match on both sides, and the loaded image's id
 *    must be the build's `imageId` (a content address), or the target
 *    removes what it loaded and the transfer fails. The archive is saved BY
 *    ID, so it carries no tag; the target tags it itself after checking the
 *    archive could not smuggle one (agentOps/images.ts).
 *  - **Registry** (opt-in per service: `push_registry_source_id` +
 *    `push_repository`): the build host logs in with the registry source's
 *    credential, tags and pushes `<host>/<repo>:<tag>`, and every target
 *    pulls `<host>/<repo>@<digest>` — content addressing gives integrity.
 *    The credential travels only in the existing `docker.login` op (sealed,
 *    stdin on the node) or the panel's own `docker login --password-stdin`;
 *    it is never logged.
 *
 * Every shipped image is recorded as one `image_transfers` row per target
 * (method, bytes, sha256, duration, outcome); `image-transfers` housekeeping
 * sweeps them after `image_transfer_retention_days`.
 *
 * A transfer failure is retried once on a fresh channel, then fails that
 * target; nothing half-loaded remains (the node's `image.load` loads only a
 * fully received and verified archive, and removes an image whose id does
 * not match).
 */

/** A host: a node id, or null for the panel host. */
export type ImageHost = number | null;

export const hostLabel = (host: ImageHost): string => (host == null ? 'the panel host' : `node #${host}`);

/** One finished transfer. */
export interface TransferResult {
  method: 'stream' | 'registry';
  /** What the target runs: the tag (stream) or `<repo>@<digest>` (registry). */
  ref: string;
  bytes: number;
  sha256: string | null;
  durationMs: number;
}

/** The tag every host of one deployment's build carries (design §6.3 step 1). */
export function buildTag(slug: string, commitSha: string, deploymentId: number): string {
  return `ninedeploy/${slug}:${commitSha.slice(0, 7) || 'latest'}-b${deploymentId}`;
}

const RE_IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
/** How long a local image metadata read may take (a wedged daemon must not hold the deploy). */
const INSPECT_TIMEOUT_MS = 30_000;
/** Headroom kept on the panel's disk beyond an image archive. */
const PANEL_DISK_HEADROOM = 256 * 1024 * 1024;

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ── image metadata ───────────────────────────────────────────────────────────

/** `docker image inspect --format '{{.Id}}|{{.Size}}'` on the panel host. */
export async function panelImageInfo(ref: string): Promise<{ id: string; size: number }> {
  const out = (await capture('docker', ['image', 'inspect', '--format', '{{.Id}}|{{.Size}}', ref], { timeoutMs: INSPECT_TIMEOUT_MS })).trim();
  return parseImageInfo(out, ref, 'the panel host');
}

/** The same on a node, through `docker.imageInspect` (capability `image.manage`). */
export async function nodeImageInfo(agent: AgentCaller, ref: string, label: string): Promise<{ id: string; size: number }> {
  const res = await agent('docker.imageInspect', { image: ref }, () => undefined);
  return parseImageInfo(res.lines.filter((l) => l.trim() !== '').at(-1)?.trim() ?? '', ref, `node ${label}`);
}

function parseImageInfo(line: string, ref: string, where: string): { id: string; size: number } {
  const [id = '', size = ''] = line.split('|');
  if (!RE_IMAGE_ID.test(id)) throw new Error(`Image ${ref} has no readable id on ${where}`);
  const n = Number(size);
  return { id, size: Number.isSafeInteger(n) && n > 0 ? n : 0 };
}

// ── the panel's own end of a stream ──────────────────────────────────────────

/** `docker save <imageId> | gzip` on the panel host, as a byte stream. */
function panelSave(imageId: string): { stream: Readable; done: Promise<void>; kill: () => void } {
  const child = spawn('docker', ['save', imageId], { env: buildEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  const gzip = createGzip();
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString('utf8')).slice(-2000);
  });
  child.stdout?.on('error', (err) => gzip.destroy(err));
  child.stdout?.pipe(gzip);
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`docker save exited with ${code}: ${stderr.trim().slice(-500)}`))));
  });
  done.catch(() => undefined);
  return {
    stream: gzip,
    done,
    kill: () => {
      child.kill('SIGTERM');
      gzip.destroy();
    },
  };
}

/** Free bytes on the filesystem that holds `dir`, or null when unknown. */
function freeBytes(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/**
 * The panel's twin of the node's `image.load` (agentOps/images.ts): the
 * archive is read STRICTLY before Docker sees it (exactly one image, config
 * `expectId`, tags empty or exactly `expectTag`), Docker's own report of what
 * it tagged and every infrastructure tag are compared before and after the
 * load, the loaded id must be `expectId` (else it is removed), and the panel
 * tags it `expectTag` itself.
 */
export async function panelLoadArchive(file: string, expectTag: string, expectId: string, log: (line: string) => void): Promise<void> {
  const { assertNoTagSmuggled, imageTagSnapshot, inspectImageArchive } = await import('../agentOps/images.js');
  inspectImageArchive(file, { expectTag, expectId });
  const before = await imageTagSnapshot();
  const loadLines: string[] = [];
  let loadError: unknown = null;
  await run('docker', ['load', '-i', file], {}, (l) => loadLines.push(l)).catch((err: unknown) => {
    loadError = err;
  });
  await assertNoTagSmuggled({ before, after: await imageTagSnapshot(), loadLines, expectTag });
  if (loadError) throw loadError;
  let loadedId = '';
  try {
    loadedId = (await panelImageInfo(expectId)).id;
  } catch {
    loadedId = '';
  }
  if (loadedId !== expectId) {
    for (const ref of loadLines.map((l) => /Loaded image(?: ID)?: (\S+)/.exec(l)?.[1]).filter((v): v is string => v !== undefined)) {
      if (RE_IMAGE_ID.test(ref) || ref === expectTag) await run('docker', ['image', 'rm', ref], {}, () => undefined).catch(() => undefined);
    }
    throw new Error(`The loaded image's id does not match ${expectId}; it was removed`);
  }
  await run('docker', ['tag', expectId, expectTag], {}, () => undefined);
  log(`Loaded ${expectTag} (${expectId.slice(0, 19)}) on the panel host`);
}

// ── stream relay ─────────────────────────────────────────────────────────────

/** What one relay moves. */
export interface RelaySpec {
  source: ImageHost;
  target: ImageHost;
  /** The tag on the source, and the one the target writes (`ninedeploy/<slug>:<tag>`). */
  tag: string;
  /** The build's image id (`sha256:<hex>`). */
  imageId: string;
  /** The uncompressed image size, for the target's free-space precheck. */
  sizeBytes?: number;
}

/** Test seam: how streams are opened (default: the sealed agent stream). */
export interface RelayDeps {
  openStream?: typeof openAgentStream;
  panelSave?: typeof panelSave;
  panelLoad?: typeof panelLoadArchive;
}

/** One relay attempt; throws on any failure (nothing half-loaded stays: see the module comment). */
async function relayOnce(db: DB, spec: RelaySpec, log: (line: string) => void, deps: RelayDeps): Promise<{ bytes: number; sha256: string }> {
  const open = deps.openStream ?? openAgentStream;
  const save = deps.panelSave ?? panelSave;
  const load = deps.panelLoad ?? panelLoadArchive;
  if (spec.source === spec.target) throw new Error('an image is never shipped to its own build host');

  // The source: bytes (gzip of `docker save <id>`) and how the sender ends.
  let source: Readable;
  let sourceDone: Promise<{ bytes: number; sha256: string } | null>;
  let abortSource: () => void;
  if (spec.source == null) {
    const s = save(spec.imageId);
    source = s.stream;
    sourceDone = s.done.then(() => null);
    abortSource = s.kill;
  } else {
    const h = await open(db, spec.source, 'image.save', { image: spec.imageId });
    if (h.direction !== 'agent-to-panel') throw new Error('image.save answered with the wrong direction');
    source = h.readable;
    sourceDone = h.done.then((d) => {
      if (d.result['imageId'] !== spec.imageId) {
        throw new Error(`${hostLabel(spec.source)} saved image ${String(d.result['imageId'])}, not ${spec.imageId}`);
      }
      return { bytes: d.bytes, sha256: d.sha256 };
    });
    abortSource = () => h.abort('the transfer was abandoned');
  }
  sourceDone.catch(() => undefined);

  try {
    if (spec.target == null) {
      // Node → panel: buffered once on the panel's disk (gunzipped), verified, loaded, removed.
      const dir = path.join(config.paths.dataDir, 'transfers');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const free = freeBytes(dir);
      if (free !== null && spec.sizeBytes && free < spec.sizeBytes + PANEL_DISK_HEADROOM) {
        throw new Error(`Not enough free disk space on the panel host for this image (${free} bytes free, ${spec.sizeBytes + PANEL_DISK_HEADROOM} needed)`);
      }
      const file = path.join(dir, `${randomBytes(16).toString('hex')}.tar`);
      try {
        await pipeline(source, createGunzip(), createWriteStream(file, { mode: 0o600 }));
        const sent = await sourceDone;
        if (!sent) throw new Error('the panel cannot be both ends of a transfer');
        await load(file, spec.tag, spec.imageId, log);
        return sent;
      } finally {
        rmSync(file, { force: true });
      }
    }
    // → node: the target's `image.load` buffers, verifies, loads and tags.
    const sink = await open(db, spec.target, 'image.load', {
      expectTag: spec.tag,
      expectId: spec.imageId,
      ...(spec.sizeBytes ? { sizeBytes: spec.sizeBytes } : {}),
    });
    if (sink.direction !== 'panel-to-agent') throw new Error('image.load answered with the wrong direction');
    try {
      await pipeline(source, sink.writable as Writable);
    } catch (err) {
      sink.abort(msg(err));
      throw err;
    }
    const [received] = await Promise.all([sink.done, sourceDone]);
    if (received.result['imageId'] !== spec.imageId) {
      throw new Error(`${hostLabel(spec.target)} loaded image ${String(received.result['imageId'])}, not ${spec.imageId}`);
    }
    const sent = await sourceDone;
    // A relay passes bytes through unchanged: what the source's end frame
    // announced must be what the target's end frame confirmed.
    if (sent && (sent.bytes !== received.bytes || sent.sha256 !== received.sha256)) {
      throw new Error(`the relayed image changed in transit (${sent.sha256} sent, ${received.sha256} received)`);
    }
    return { bytes: received.bytes, sha256: received.sha256 };
  } catch (err) {
    abortSource();
    throw err;
  }
}

/** Is this error a refusal the second attempt cannot change (an old agent, an unsealed transport)? */
const isRefusal = (err: unknown): boolean => err instanceof HttpError;

/**
 * Relay the image with one retry on a fresh channel (design §6.3), recording
 * the `image_transfers` row. Throws the last error; the row is then `failed`.
 */
export async function shipImageByStream(
  db: DB,
  spec: RelaySpec & { deploymentId: number | null; serviceId: number },
  log: (line: string) => void,
  deps: RelayDeps = {},
): Promise<TransferResult> {
  const row = await startTransferRow(db, {
    deploymentId: spec.deploymentId,
    serviceId: spec.serviceId,
    sourceServerId: spec.source,
    targetServerId: spec.target,
    method: 'stream',
    imageRef: spec.tag,
    imageId: spec.imageId,
  });
  const started = Date.now();
  log(`Shipping ${spec.tag} from ${hostLabel(spec.source)} to ${hostLabel(spec.target)} (stream relay) …`);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { bytes, sha256 } = await relayOnce(db, spec, log, deps);
      const durationMs = Date.now() - started;
      await finishTransferRow(db, row, { status: 'completed', bytes, sha256, durationMs });
      log(`✓ ${hostLabel(spec.target)} has ${spec.tag}: ${bytes} bytes, sha256 ${sha256.slice(0, 16)}…, ${Math.round(durationMs / 100) / 10}s`);
      return { method: 'stream', ref: spec.tag, bytes, sha256, durationMs };
    } catch (err) {
      lastError = err;
      if (attempt === 1 && !isRefusal(err)) {
        log(`transfer to ${hostLabel(spec.target)} failed (${msg(err)}) — retrying once on a fresh channel`);
        continue;
      }
      break;
    }
  }
  await finishTransferRow(db, row, { status: 'failed', error: msg(lastError).slice(0, 1000), durationMs: Date.now() - started });
  throw lastError instanceof Error ? lastError : new Error(msg(lastError));
}

// ── registry ─────────────────────────────────────────────────────────────────

/** Where a service's image is pushed: `<host>/<repo>`, and the login for it (never logged). */
export interface PushTarget {
  /** `<host>/<repository>` (no tag, no digest). */
  repository: string;
  host: string;
  username: string;
  password: string;
  /** The `docker login` server operand (undefined for Docker Hub). */
  server?: string;
}

/**
 * The registry target of a service with `push_registry_source_id` and
 * `push_repository`, or null when the service has none (the stream relay).
 * Throws with the reason when it is set but unusable: the source is gone, is
 * not a registry credential, has no login, or is not bound to exactly one
 * registry host (lib/registryBinding.ts, r512: a credential only ever goes
 * to the host it is bound to).
 */
export async function resolvePushTarget(
  db: DB,
  service: { pushRegistrySourceId?: number | null; pushRepository?: string | null },
): Promise<PushTarget | null> {
  if (service.pushRegistrySourceId == null && !service.pushRepository) return null;
  // Deploy-time re-check of what the placement PUT allowed: the credential
  // still exists (its deletion sets the id NULL — that must not silently turn
  // a registry service into a relay one), is still a registry credential,
  // and is bound to exactly one registry host (below).
  if (service.pushRegistrySourceId == null || !service.pushRepository) {
    throw new Error('The push registry of this service was removed or is incomplete; choose another in Service → Settings → Build, or clear it to ship by stream relay.');
  }
  const src = await db.query.sources.findFirst({ where: eq(sources.id, service.pushRegistrySourceId) });
  if (!src || src.type !== 'registry') {
    throw new Error('The push registry of this service is not a registry credential any more; choose another in Service → Settings → Build, or clear it to ship by stream relay.');
  }
  const username = src.registryUsername ?? '';
  const password = src.tokenEncrypted ? decrypt(src.tokenEncrypted) : '';
  if (!username || !password) throw new Error(`The registry credential "${src.name}" has no username or token, so nothing can be pushed with it.`);
  const bound = await boundRegistryHosts(db, src.id);
  if (bound.length !== 1) {
    throw new Error(
      `The registry credential "${src.name}" is bound to ${bound.length ? bound.join(', ') : 'no registry host'}; ` +
        'a push needs exactly one (Settings → Sources), so the credential only ever reaches that host.',
    );
  }
  const host = bound[0]!;
  return { repository: `${host}/${service.pushRepository}`, host, username, password, server: host === 'docker.io' ? undefined : host };
}

const RE_PUSH_DIGEST = /digest: (sha256:[0-9a-f]{64})/;

/** Log in on `host` (node or panel), run `fn`, always log out; serialised per host and registry (r230). */
async function withRegistryLogin<T>(host: ImageHost, agent: AgentCaller | null, target: PushTarget, log: (line: string) => void, fn: () => Promise<T>): Promise<T> {
  const release = await acquireRegistryLock(registryLockKey(host ?? null, target.server));
  try {
    log(`Logging in to ${target.host} on ${hostLabel(host)} …`);
    if (agent) {
      await agent('docker.login', { username: target.username, password: target.password, ...(target.server ? { server: target.server } : {}) }, log);
    } else {
      await run('docker', ['login', '--username', target.username, '--password-stdin', ...(target.server ? [target.server] : [])], { timeoutMs: 120_000 }, log, Buffer.from(`${target.password}\n`));
    }
    try {
      return await fn();
    } finally {
      if (agent) await agent('docker.logout', target.server ? { server: target.server } : {}, () => undefined).catch(() => undefined);
      else await run('docker', ['logout', ...(target.server ? [target.server] : [])], {}, () => undefined).catch(() => undefined);
    }
  } finally {
    release();
  }
}

/**
 * Push the build host's image to the registry: tag `<repo>:<tagPart>`, push,
 * read the pushed digest. A node needs `image.manage` (`docker.tag`,
 * `docker.push`); refused with the update message otherwise.
 */
export async function pushImage(
  db: DB,
  buildHost: ImageHost,
  input: { tag: string; target: PushTarget },
  log: (line: string) => void,
): Promise<{ digest: string; pushedRef: string }> {
  const tagPart = input.tag.slice(input.tag.lastIndexOf(':') + 1);
  const pushedRef = `${input.target.repository}:${tagPart}`;
  let agent: AgentCaller | null = null;
  if (buildHost != null) {
    const id = buildHost;
    agent = (op, params, sink) => agentOp(db, id, op, params, sink);
    const refusal = await capabilityRefusal(agent, await nodeLabel(db, id), await agentTransportSealed(db, id), {
      cap: 'image.manage',
      feature: 'push an image to a registry',
      sealedRequired: false,
      persist: { db, serverId: id },
    });
    if (refusal) throw new HttpError(refusal.status, refusal.code, refusal.message);
  }
  const lines: string[] = [];
  await withRegistryLogin(buildHost, agent, input.target, log, async () => {
    log(`Pushing ${pushedRef} from ${hostLabel(buildHost)} …`);
    const sink = (l: string) => {
      lines.push(l);
      log(l);
    };
    if (agent) {
      await agent('docker.tag', { source: input.tag, target: pushedRef }, sink);
      await agent('docker.push', { image: pushedRef }, sink);
    } else {
      await run('docker', ['tag', input.tag, pushedRef], {}, sink);
      await run('docker', ['push', pushedRef], {}, sink);
    }
  });
  const digest = lines.map((l) => RE_PUSH_DIGEST.exec(l)?.[1]).filter((d): d is string => d !== undefined).at(-1);
  if (!digest) throw new Error(`The registry did not report a digest for ${pushedRef}`);
  return { digest, pushedRef };
}

/**
 * Pull `<repo>@<digest>` on a target and check it is the build's image (by id
 * when the host can tell: the panel always, a node with `image.manage`).
 * Recorded as one `image_transfers` row (method `registry`).
 */
export async function pullImageByDigest(
  db: DB,
  spec: { deploymentId: number | null; serviceId: number; source: ImageHost; target: ImageHost; imageId: string; repository: string; digest: string },
  pushTarget: PushTarget,
  log: (line: string) => void,
): Promise<TransferResult> {
  const ref = `${spec.repository}@${spec.digest}`;
  const row = await startTransferRow(db, {
    deploymentId: spec.deploymentId,
    serviceId: spec.serviceId,
    sourceServerId: spec.source,
    targetServerId: spec.target,
    method: 'registry',
    imageRef: ref,
    imageId: spec.imageId,
  });
  const started = Date.now();
  try {
    const target = spec.target;
    const agent: AgentCaller | null = target == null ? null : (op, params, sink) => agentOp(db, target, op, params, sink);
    await withRegistryLogin(target, agent, pushTarget, log, async () => {
      log(`Pulling ${ref} on ${hostLabel(target)} …`);
      if (agent) await agent('docker.pull', { image: ref }, log);
      else await run('docker', ['pull', ref], {}, log);
    });
    let id: string | null = null;
    if (agent) {
      id = await nodeImageInfo(agent, ref, `#${target}`).then((i) => i.id).catch(() => null);
    } else {
      id = (await panelImageInfo(ref)).id;
    }
    if (id !== null && id !== spec.imageId) {
      if (agent) await agent('docker.imageRm', { image: ref }, () => undefined).catch(() => undefined);
      else await run('docker', ['image', 'rm', ref], {}, () => undefined).catch(() => undefined);
      throw new Error(`${hostLabel(target)} pulled image ${id} for ${ref}, not ${spec.imageId}; it was removed`);
    }
    const durationMs = Date.now() - started;
    await finishTransferRow(db, row, { status: 'completed', bytes: 0, sha256: spec.digest.replace(/^sha256:/, ''), durationMs });
    return { method: 'registry', ref, bytes: 0, sha256: spec.digest, durationMs };
  } catch (err) {
    await finishTransferRow(db, row, { status: 'failed', error: msg(err).slice(0, 1000), durationMs: Date.now() - started });
    throw err;
  }
}

// ── image_transfers rows ─────────────────────────────────────────────────────

type TransferRowStart = {
  deploymentId: number | null;
  serviceId: number;
  sourceServerId: number | null;
  targetServerId: number | null;
  method: 'stream' | 'registry';
  imageRef: string;
  imageId: string;
};

/** Insert the `running` row; best-effort (a history row never fails a deploy). */
async function startTransferRow(db: DB, values: TransferRowStart): Promise<number | null> {
  try {
    const [row] = await db.insert(imageTransfers).values({ ...values, status: 'running' }).returning({ id: imageTransfers.id });
    return row?.id ?? null;
  } catch {
    return null;
  }
}

async function finishTransferRow(
  db: DB,
  id: number | null,
  values: { status: 'completed' | 'failed'; bytes?: number; sha256?: string; error?: string; durationMs: number },
): Promise<void> {
  if (id == null) return;
  try {
    await db
      .update(imageTransfers)
      .set({ ...values, finishedAt: new Date() })
      .where(eq(imageTransfers.id, id));
  } catch {
    /* history only */
  }
}
