import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import { ciAttempts, ciJobs, ciRunners, type DB, envVars, type services } from '@ninedeploy/db';
import { CI_RESERVED_ENV, type CiClaimResponse, type CiPipeline, ciPipeline } from '@ninedeploy/schemas';
import { config } from '../config.js';
import { decrypt } from './crypto.js';
import { getSettingJson, setSettingJson } from './settings.js';
import { isUploadSourced } from './sourceUpload.js';

/**
 * R5: CI jobs run by enrolled runners.
 *
 * Durability comes from the database alone:
 * - a job is claimed by flipping it queued → running with a conditional
 *   UPDATE, so two runners can never both get it;
 * - every attempt holds a lease that its runner renews by heartbeat;
 * - a finish counts only from the job's current attempt while its lease is
 *   live, so a runner that was declared lost and comes back cannot report a
 *   second result;
 * - a lapsed lease marks the attempt lost and requeues the job (up to its
 *   attempt limit), and the heartbeat tells a runner whose attempt is no
 *   longer current to stop, so no work is left running unowned.
 */

export const RUNNER_TOKEN_PREFIX = 'ndrun_';
const LEASE_TOKEN_PREFIX = 'ndlease_';
export const LEASE_MS = 60_000;
export const HEARTBEAT_SECONDS = 15;
/** A runner seen within this window counts as online. */
const ONLINE_MS = 90_000;
/** Per attempt; a job printing more is cut, with a note. */
export const MAX_LOG_BYTES = 8 * 1024 * 1024;
const PIPELINE_KEY = 'ci_pipeline:';

type Service = typeof services.$inferSelect;
type Runner = typeof ciRunners.$inferSelect;
type Job = typeof ciJobs.$inferSelect;
type Attempt = typeof ciAttempts.$inferSelect;

export class CiError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 404 | 409,
  ) {
    super(message);
  }
}

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const newToken = (prefix: string): string => `${prefix}${randomBytes(32).toString('base64url')}`;
const affected = (r: unknown): number => (r as { rowsAffected?: number } | undefined)?.rowsAffected ?? 0;

// ── pipeline definition (one settings row per service) ─────────────────────

export async function getPipeline(db: DB, serviceId: number): Promise<CiPipeline | null> {
  const raw = await getSettingJson<unknown>(db, `${PIPELINE_KEY}${serviceId}`);
  const parsed = ciPipeline.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function setPipeline(db: DB, serviceId: number, pipeline: CiPipeline | null): Promise<void> {
  await setSettingJson(db, `${PIPELINE_KEY}${serviceId}`, pipeline);
}

// ── runners ─────────────────────────────────────────────────────────────────

export async function createRunner(
  db: DB,
  input: { name: string; labels: string[]; capacity: number },
  userId: number,
): Promise<{ runner: Runner; token: string }> {
  const token = newToken(RUNNER_TOKEN_PREFIX);
  const [runner] = await db
    .insert(ciRunners)
    .values({ name: input.name, labels: [...new Set(input.labels)].sort(), capacity: input.capacity, tokenHash: hashToken(token), createdBy: userId })
    .returning();
  if (!runner) throw new Error('Could not create the runner');
  return { runner, token };
}

/** The runner behind a bearer token, or null for an unknown or revoked one. */
export async function authenticateRunner(db: DB, bearer: string | undefined): Promise<Runner | null> {
  if (!bearer?.startsWith(RUNNER_TOKEN_PREFIX)) return null;
  const hash = hashToken(bearer);
  const runner = await db.query.ciRunners.findFirst({ where: eq(ciRunners.tokenHash, hash) });
  if (!runner || runner.revokedAt) return null;
  if (!timingSafeEqual(Buffer.from(runner.tokenHash), Buffer.from(hash))) return null;
  return runner;
}

async function touchRunner(db: DB, runner: Runner, version?: string): Promise<void> {
  await db
    .update(ciRunners)
    .set({ lastSeenAt: new Date(), ...(version ? { version } : {}) })
    .where(eq(ciRunners.id, runner.id));
}

/** Revoke a runner: its token stops working and its running attempts are lost (and requeued) at once. */
export async function revokeRunner(db: DB, runnerId: number): Promise<boolean> {
  const done = await db
    .update(ciRunners)
    .set({ revokedAt: new Date() })
    .where(and(eq(ciRunners.id, runnerId), sql`${ciRunners.revokedAt} IS NULL`));
  if (affected(done) !== 1) return false;
  const running = await db.query.ciAttempts.findMany({
    where: and(eq(ciAttempts.runnerId, runnerId), eq(ciAttempts.status, 'running')),
  });
  for (const attempt of running) await loseAttempt(db, attempt, 'The runner was revoked');
  return true;
}

export async function listRunners(db: DB, now = Date.now()) {
  const rows = await db.query.ciRunners.findMany({ orderBy: [asc(ciRunners.id)] });
  const running = await db
    .select({ runnerId: ciAttempts.runnerId, n: sql<number>`count(*)` })
    .from(ciAttempts)
    .where(eq(ciAttempts.status, 'running'))
    .groupBy(ciAttempts.runnerId);
  const counts = new Map(running.map((r) => [r.runnerId, Number(r.n)]));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    labels: r.labels,
    capacity: r.capacity,
    version: r.version,
    lastSeenAt: r.lastSeenAt ? r.lastSeenAt.toISOString() : null,
    online: !r.revokedAt && !!r.lastSeenAt && now - r.lastSeenAt.getTime() < ONLINE_MS,
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
    running: counts.get(r.id) ?? 0,
    createdAt: r.createdAt.toISOString(),
  }));
}

// ── jobs ────────────────────────────────────────────────────────────────────

const SHA_RE = /^[0-9a-f]{40}$/i;

export async function createJob(
  db: DB,
  service: Pick<Service, 'id'>,
  pipeline: CiPipeline,
  opts: { ref?: string; trigger: string; userId: number | null; deploymentId?: number; requireApproval?: boolean },
): Promise<Job> {
  const ref = opts.ref ?? null;
  const [job] = await db
    .insert(ciJobs)
    .values({
      serviceId: service.id,
      status: pipeline.requireApproval || opts.requireApproval ? 'awaiting_approval' : 'queued',
      deploymentId: opts.deploymentId ?? null,
      ref,
      commitSha: ref && SHA_RE.test(ref) ? ref.toLowerCase() : null,
      image: pipeline.image,
      script: pipeline.script,
      labels: [...new Set(pipeline.labels)].sort(),
      secretNames: [...new Set(pipeline.secrets)],
      timeoutSeconds: pipeline.timeoutMinutes * 60,
      maxAttempts: pipeline.maxAttempts,
      trigger: opts.trigger,
      createdBy: opts.userId,
    })
    .returning();
  if (!job) throw new Error('Could not create the job');
  return job;
}

export async function approveJob(db: DB, jobId: number, userId: number): Promise<boolean> {
  const r = await db
    .update(ciJobs)
    .set({ status: 'queued', approvedBy: userId })
    .where(and(eq(ciJobs.id, jobId), eq(ciJobs.status, 'awaiting_approval')));
  return affected(r) === 1;
}

/** Cancel a job in any unfinished state. A running attempt's runner is told to stop at its next heartbeat. */
export async function cancelJob(db: DB, jobId: number, userId: number | null): Promise<boolean> {
  const job = await db.query.ciJobs.findFirst({ where: eq(ciJobs.id, jobId) });
  if (!job || !['awaiting_approval', 'queued', 'running'].includes(job.status)) return false;
  const r = await db
    .update(ciJobs)
    .set({ status: 'cancelled', cancelledBy: userId, finishedAt: new Date(), error: 'Cancelled' })
    .where(and(eq(ciJobs.id, jobId), inArray(ciJobs.status, ['awaiting_approval', 'queued', 'running'])));
  if (affected(r) !== 1) return false;
  if (job.currentAttemptId) {
    await db
      .update(ciAttempts)
      .set({ status: 'cancelled', finishedAt: new Date(), error: 'Cancelled' })
      .where(and(eq(ciAttempts.id, job.currentAttemptId), eq(ciAttempts.status, 'running')));
  }
  return true;
}

export function jobView(j: Job) {
  return {
    id: j.id,
    serviceId: j.serviceId,
    status: j.status,
    ref: j.ref,
    commitSha: j.commitSha,
    image: j.image,
    labels: j.labels,
    secretNames: j.secretNames,
    trigger: j.trigger,
    deploymentId: j.deploymentId,
    attempts: j.attempts,
    maxAttempts: j.maxAttempts,
    timeoutSeconds: j.timeoutSeconds,
    error: j.error,
    createdBy: j.createdBy,
    approvedBy: j.approvedBy,
    createdAt: j.createdAt.toISOString(),
    startedAt: j.startedAt ? j.startedAt.toISOString() : null,
    finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
  };
}

export async function attemptViews(db: DB, jobId: number) {
  const rows = await db.query.ciAttempts.findMany({ where: eq(ciAttempts.jobId, jobId), orderBy: [asc(ciAttempts.number)] });
  const runnerIds = [...new Set(rows.map((r) => r.runnerId).filter((v): v is number => v !== null))];
  const runners = runnerIds.length ? await db.query.ciRunners.findMany({ where: inArray(ciRunners.id, runnerIds) }) : [];
  const names = new Map(runners.map((r) => [r.id, r.name]));
  return rows.map((a) => ({
    id: a.id,
    number: a.number,
    runnerId: a.runnerId,
    runnerName: a.runnerId ? (names.get(a.runnerId) ?? null) : null,
    status: a.status,
    exitCode: a.exitCode,
    error: a.error,
    logBytes: a.logBytes,
    startedAt: a.startedAt.toISOString(),
    finishedAt: a.finishedAt ? a.finishedAt.toISOString() : null,
  }));
}

// ── the runner protocol ─────────────────────────────────────────────────────

const labelsFit = (wanted: string[], has: string[]): boolean => wanted.every((l) => has.includes(l));

/** Service variables the pipeline names, decrypted for the lease holder only. A preview gets none. */
async function jobEnv(db: DB, job: Job): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  if (job.secretNames.length === 0) return env;
  const service = await db.query.services.findFirst({ where: (s, { eq: e }) => e(s.id, job.serviceId) });
  if (!service || service.isEphemeralPreview === true) return env;
  const rows = await db.query.envVars.findMany({
    where: and(eq(envVars.serviceId, job.serviceId), inArray(envVars.key, job.secretNames)),
  });
  // A pipeline stored before a name became reserved still never hands it out.
  for (const r of rows) if (!CI_RESERVED_ENV.test(r.key)) env[r.key] = decrypt(r.valueEncrypted);
  return env;
}

/**
 * Offer the oldest queued job this runner can take. `running` is what the
 * runner reports; the panel's own count of its live attempts is used when
 * larger, so a runner cannot claim past its capacity by under-reporting.
 */
export async function claimJob(
  db: DB,
  runner: Runner,
  reported: { running: number; version?: string },
  now = Date.now(),
): Promise<CiClaimResponse | null> {
  await touchRunner(db, runner, reported.version);
  const live = await db
    .select({ n: sql<number>`count(*)` })
    .from(ciAttempts)
    .where(and(eq(ciAttempts.runnerId, runner.id), eq(ciAttempts.status, 'running')));
  if (Math.max(reported.running, Number(live[0]?.n ?? 0)) >= runner.capacity) return null;

  const queued = await db.query.ciJobs.findMany({ where: eq(ciJobs.status, 'queued'), orderBy: [asc(ciJobs.id)], limit: 50 });
  for (const job of queued) {
    if (!labelsFit(job.labels, runner.labels)) continue;
    const won = await db
      .update(ciJobs)
      .set({ status: 'running', attempts: sql`${ciJobs.attempts} + 1`, startedAt: job.startedAt ?? new Date(now) })
      .where(and(eq(ciJobs.id, job.id), eq(ciJobs.status, 'queued')));
    if (affected(won) !== 1) continue;
    const leaseToken = newToken(LEASE_TOKEN_PREFIX);
    const number = job.attempts + 1;
    const [attempt] = await db
      .insert(ciAttempts)
      .values({ jobId: job.id, runnerId: runner.id, number, leaseHash: hashToken(leaseToken), leaseExpiresAt: now + LEASE_MS })
      .returning();
    if (!attempt) throw new Error('Could not record the attempt');
    await db.update(ciJobs).set({ currentAttemptId: attempt.id }).where(eq(ciJobs.id, job.id));
    const service = await db.query.services.findFirst({ where: (s, { eq: e }) => e(s.id, job.serviceId) });
    return {
      attemptId: attempt.id,
      jobId: job.id,
      number,
      leaseToken,
      leaseSeconds: LEASE_MS / 1000,
      heartbeatSeconds: HEARTBEAT_SECONDS,
      image: job.image,
      script: job.script,
      timeoutSeconds: job.timeoutSeconds,
      env: await jobEnv(db, job),
      commitSha: job.commitSha,
      sourcePath: service && hasSource(service) ? `/v1/ci/runner/attempts/${attempt.id}/source` : null,
    };
  }
  return null;
}

/**
 * The attempt a lease token belongs to, for a runner that still owns it.
 * Throws 401 for a wrong runner or token: a lease is bound to one runner.
 */
export async function attemptForLease(db: DB, runner: Runner, attemptId: number, leaseToken: string | undefined): Promise<{ attempt: Attempt; job: Job }> {
  const attempt = await db.query.ciAttempts.findFirst({ where: eq(ciAttempts.id, attemptId) });
  if (!attempt || attempt.runnerId !== runner.id || !leaseToken) throw new CiError('Unknown attempt', 401);
  const a = Buffer.from(attempt.leaseHash);
  const b = Buffer.from(hashToken(leaseToken));
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new CiError('Unknown attempt', 401);
  const job = await db.query.ciJobs.findFirst({ where: eq(ciJobs.id, attempt.jobId) });
  if (!job) throw new CiError('Unknown attempt', 404);
  return { attempt, job };
}

const isCurrent = (attempt: Attempt, job: Job): boolean =>
  attempt.status === 'running' && job.status === 'running' && job.currentAttemptId === attempt.id;

/** Renew the lease. `stop` tells the runner to kill the job: cancelled, lost, or no longer current. */
export async function heartbeat(db: DB, runner: Runner, attempt: Attempt, job: Job, now = Date.now()): Promise<{ action: 'continue' | 'stop'; reason?: string }> {
  await touchRunner(db, runner);
  if (!isCurrent(attempt, job)) return { action: 'stop', reason: job.status === 'cancelled' ? 'cancelled' : 'superseded' };
  const renewed = await db
    .update(ciAttempts)
    .set({ leaseExpiresAt: now + LEASE_MS })
    .where(and(eq(ciAttempts.id, attempt.id), eq(ciAttempts.status, 'running')));
  return affected(renewed) === 1 ? { action: 'continue' } : { action: 'stop', reason: 'superseded' };
}

export function logFile(jobId: number, attemptNumber: number): string {
  return path.join(config.paths.logsDir, 'ci', String(jobId), `${attemptNumber}.log`);
}

/**
 * Append one chunk. Chunks carry a sequence number; a repeated number (a
 * retried POST) is acknowledged without appending it twice, and a gap is
 * refused so the runner resends in order.
 */
export async function appendLog(db: DB, attempt: Attempt, seq: number, data: string): Promise<{ stored: boolean }> {
  if (attempt.status !== 'running') throw new CiError('The attempt is over', 409);
  if (seq <= attempt.logSeq) return { stored: false };
  if (seq !== attempt.logSeq + 1) throw new CiError(`Expected chunk ${attempt.logSeq + 1}`, 409);
  let chunk = data;
  const room = MAX_LOG_BYTES - attempt.logBytes;
  if (room <= 0) chunk = '';
  else if (Buffer.byteLength(chunk) > room) chunk = `${Buffer.from(chunk).subarray(0, room).toString()}\n[log cut at ${MAX_LOG_BYTES} bytes]\n`;
  const r = await db
    .update(ciAttempts)
    .set({ logSeq: seq, logBytes: sql`${ciAttempts.logBytes} + ${Buffer.byteLength(chunk)}` })
    .where(and(eq(ciAttempts.id, attempt.id), eq(ciAttempts.logSeq, attempt.logSeq), eq(ciAttempts.status, 'running')));
  if (affected(r) !== 1) throw new CiError('Concurrent log write', 409);
  if (chunk) {
    const file = logFile(attempt.jobId, attempt.number);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, chunk);
  }
  return { stored: true };
}

export function readLog(jobId: number, attemptNumber: number): string {
  try {
    return readFileSync(logFile(jobId, attemptNumber), 'utf8');
  } catch {
    return '';
  }
}

/**
 * Record the attempt's result. Only the current attempt with a live lease may
 * finish the job; anything else is told it no longer counts (409), which is
 * what keeps a job from succeeding twice.
 */
export async function finishAttempt(
  db: DB,
  attempt: Attempt,
  job: Job,
  result: { status: 'succeeded' | 'failed'; exitCode: number | null; error?: string },
  now = Date.now(),
): Promise<void> {
  if (!isCurrent(attempt, job) || attempt.leaseExpiresAt < now) throw new CiError('This attempt no longer counts', 409);
  const at = new Date(now);
  const closed = await db
    .update(ciAttempts)
    .set({ status: result.status, exitCode: result.exitCode, error: result.error ?? null, finishedAt: at })
    .where(and(eq(ciAttempts.id, attempt.id), eq(ciAttempts.status, 'running')));
  if (affected(closed) !== 1) throw new CiError('This attempt no longer counts', 409);
  await db
    .update(ciJobs)
    .set({ status: result.status, finishedAt: at, error: result.status === 'failed' ? (result.error ?? `Exited with ${result.exitCode}`) : null })
    .where(and(eq(ciJobs.id, job.id), eq(ciJobs.status, 'running'), eq(ciJobs.currentAttemptId, attempt.id)));
}

/** Mark an attempt lost and give its job another attempt, or fail it when none are left. */
async function loseAttempt(db: DB, attempt: Attempt, reason: string): Promise<void> {
  const lost = await db
    .update(ciAttempts)
    .set({ status: 'lost', error: reason, finishedAt: new Date() })
    .where(and(eq(ciAttempts.id, attempt.id), eq(ciAttempts.status, 'running')));
  if (affected(lost) !== 1) return;
  const job = await db.query.ciJobs.findFirst({ where: eq(ciJobs.id, attempt.jobId) });
  if (!job || job.status !== 'running' || job.currentAttemptId !== attempt.id) return;
  if (job.attempts < job.maxAttempts) {
    await db
      .update(ciJobs)
      .set({ status: 'queued', currentAttemptId: null })
      .where(and(eq(ciJobs.id, job.id), eq(ciJobs.status, 'running'), eq(ciJobs.currentAttemptId, attempt.id)));
  } else {
    await db
      .update(ciJobs)
      .set({ status: 'failed', finishedAt: new Date(), error: `${reason}; no attempts left` })
      .where(and(eq(ciJobs.id, job.id), eq(ciJobs.status, 'running'), eq(ciJobs.currentAttemptId, attempt.id)));
  }
}

/** Attempts whose lease lapsed: their runner stopped reporting. */
export async function sweepLostAttempts(db: DB, now = Date.now()): Promise<number> {
  const expired = await db.query.ciAttempts.findMany({
    where: and(eq(ciAttempts.status, 'running'), lt(ciAttempts.leaseExpiresAt, now)),
  });
  for (const attempt of expired) await loseAttempt(db, attempt, 'The runner stopped reporting (lease expired)');
  return expired.length;
}

/**
 * After a panel restart, runners could not reach it while it was down. Give
 * every live lease a fresh period so they can report in before being
 * declared lost.
 */
export async function extendLeasesAfterRestart(db: DB, now = Date.now()): Promise<void> {
  await db.update(ciAttempts).set({ leaseExpiresAt: now + LEASE_MS }).where(eq(ciAttempts.status, 'running'));
}

/** Finished jobs older than the retention, with their log files. */
export async function pruneCiJobs(db: DB, olderThanDays: number, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - olderThanDays * 86_400_000);
  const old = await db.query.ciJobs.findMany({
    where: and(inArray(ciJobs.status, ['succeeded', 'failed', 'cancelled']), lt(ciJobs.finishedAt, cutoff)),
    columns: { id: true },
    limit: 500,
  });
  if (old.length === 0) return 0;
  await db.delete(ciJobs).where(inArray(ciJobs.id, old.map((j) => j.id)));
  for (const j of old) rmSync(path.join(config.paths.logsDir, 'ci', String(j.id)), { recursive: true, force: true });
  return old.length;
}

/** A repository to check out, or an uploaded source archive. Image-only services have neither. */
export function hasSource(service: Service): boolean {
  return Boolean(service.repoUrl) || isUploadSourced(service);
}

export function logSize(jobId: number, attemptNumber: number): number {
  try {
    return statSync(logFile(jobId, attemptNumber)).size;
  } catch {
    return 0;
  }
}
