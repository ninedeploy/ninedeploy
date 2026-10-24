import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { logDrainBatches, logDrainCursors, logDrains, services, type DB, type LogDrain } from '@ninedeploy/db';
import type { LogDrainFormat, LogDrainType, LogQueueStatus } from '@ninedeploy/schemas';
import { decrypt, encrypt } from '../lib/crypto.js';
import { run } from '../lib/exec.js';
import { dispatchLogBatch, type LogPayloadEntry } from './logDrainManager.js';
import { replicaNames } from './dockerNames.js';
import { agentOp } from '../lib/agentClient.js';
import { readObservabilitySettings } from '../lib/observabilitySettings.js';

export const MAX_LINES_PER_RUNTIME = 1000;
const MAX_BATCH_BYTES = 256 * 1024;
const MAX_DELIVERIES = 20;

export interface ShipperDeps {
  readRemoteLogs?: (serverId: number, container: string, since: string) => Promise<string[]>;
  readLogs: (container: string, since: string) => Promise<string[]>;
  dispatch: typeof dispatchLogBatch;
  now: () => Date;
  signal?: AbortSignal;
}
const defaultDeps: ShipperDeps = {
  readLogs: async (container, since) => {
    const lines: string[] = [];
    await run('docker', ['logs', '--timestamps', '--since', since, container],
      { timeoutMs: 10_000 }, (line) => { if (lines.length < MAX_LINES_PER_RUNTIME * 2) lines.push(line); });
    return lines;
  },
  dispatch: dispatchLogBatch,
  now: () => new Date(),
};

export function parseDockerLogLine(raw: string): { ts: string; line: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) ?(.*)$/.exec(raw);
  return m && Number.isFinite(Date.parse(m[1]!)) ? { ts: m[1]!, line: m[2]! } : null;
}
function timestampKey(ts: string): string {
  return ts.replace(/(?:\.(\d+))?Z$/, (_m, fraction: string | undefined) => '.' + (fraction ?? '').padEnd(9, '0') + 'Z');
}

function destination(d: LogDrain) {
  return {
    url: d.url, type: d.type as LogDrainType, format: d.format as LogDrainFormat,
    apiKey: d.apiKeyEncrypted ? decrypt(d.apiKeyEncrypted) : null,
    headers: d.headersJson ? JSON.parse(d.headersJson) as Record<string, string> : null,
  };
}
/** A credential or destination edit must not redirect already captured logs to another account. */
export function logDrainBinding(d: LogDrain): string {
  return createHash('sha256').update(JSON.stringify({ ...destination(d), serviceId: d.serviceId })).digest('hex');
}

export async function logQueueStatus(db: DB, drain: LogDrain): Promise<LogQueueStatus> {
  let binding: string | null = null;
  try { binding = logDrainBinding(drain); } catch { /* unreadable key => every old batch is blocked */ }
  const [q] = await db.select({
    pendingBatches: sql<number>`count(*)`,
    pendingEntries: sql<number>`coalesce(sum(${logDrainBatches.entryCount}), 0)`,
    payloadBytes: sql<number>`coalesce(sum(${logDrainBatches.payloadBytes}), 0)`,
    blockedBatches: sql<number>`coalesce(sum(case when ${logDrainBatches.binding} = ${binding ?? ''} then 0 else 1 end), 0)`,
    oldest: sql<number | null>`min(${logDrainBatches.createdAt})`,
  }).from(logDrainBatches).where(eq(logDrainBatches.drainId, drain.id));
  const [p] = await db.select({ n: sql<number>`count(*)` }).from(logDrainCursors)
    .where(and(eq(logDrainCursors.drainId, drain.id), sql`${logDrainCursors.pausedReason} is not null`));
  return {
    pendingBatches: Number(q?.pendingBatches ?? 0), pendingEntries: Number(q?.pendingEntries ?? 0),
    payloadBytes: Number(q?.payloadBytes ?? 0), blockedBatches: Number(q?.blockedBatches ?? 0),
    pausedSources: Number(p?.n ?? 0), oldestAt: q?.oldest == null ? null : new Date(q.oldest * 1000).toISOString(),
  };
}

/** Capturing advances a durable per-destination cursor only in the transaction that stores its encrypted batch. */
export async function shipLogsOnce(
  db: DB,
  deps: ShipperDeps = defaultDeps,
  signal?: AbortSignal,
): Promise<{ shipped: number; failed: number; queued: number; paused: number }> {
  deps = { ...deps, signal: signal ?? deps.signal };
  const { logQueueMaxMb } = await readObservabilitySettings(db);
  const drains = await db.select().from(logDrains).where(eq(logDrains.enabled, true));
  const configured = new Map<number, { row: LogDrain; binding: string; target: ReturnType<typeof destination> }>();
  for (const d of drains) {
    try { configured.set(d.id, { row: d, binding: logDrainBinding(d), target: destination(d) }); }
    catch { /* do not drop ciphertext whose key is temporarily unavailable */ }
  }
  let shipped = 0, failed = 0, queued = 0, paused = 0, deliveries = 0;
  const deliver = async () => {
    if (!configured.size || deps.signal?.aborted) return;
    const eligible = [...configured.values()].map((d) => and(eq(logDrainBatches.drainId, d.row.id), eq(logDrainBatches.binding, d.binding)));
    while (deliveries < MAX_DELIVERIES && !deps.signal?.aborted) {
      const heads = await db.select().from(logDrainBatches).where(and(
        lte(logDrainBatches.nextAttemptAt, deps.now()), or(...eligible),
        sql`not exists (select 1 from log_drain_batches older where older.drain_id = ${logDrainBatches.drainId} and older.binding = ${logDrainBatches.binding} and older.id < ${logDrainBatches.id})`,
      )).orderBy(asc(logDrainBatches.nextAttemptAt), asc(logDrainBatches.id)).limit(MAX_DELIVERIES - deliveries);
      if (!heads.length) break;
      const previousDeliveries = deliveries;
      for (const head of heads) {
        if (deps.signal?.aborted) return;
        const fresh = await db.query.logDrains.findFirst({ where: eq(logDrains.id, head.drainId) });
        if (!fresh?.enabled) continue;
        let target: ReturnType<typeof destination>;
        try { if (logDrainBinding(fresh) !== head.binding) continue; target = destination(fresh); }
        catch { continue; }
        deliveries++;
        const pending = await db.select().from(logDrainBatches).where(and(
          eq(logDrainBatches.drainId, head.drainId), eq(logDrainBatches.binding, head.binding),
        )).orderBy(asc(logDrainBatches.id)).limit(20);
        const group: typeof pending = [];
        const entries: LogPayloadEntry[] = [];
        let bytes = 2, error: string | null = null;
        for (const batch of pending) {
          if (batch.nextAttemptAt > deps.now()) break;
          let decoded: LogPayloadEntry[];
          try { decoded = JSON.parse(decrypt(batch.payloadEncrypted)) as LogPayloadEntry[]; }
          catch { if (!group.length) { group.push(batch); error = 'key_or_payload_unavailable'; } break; }
          const size = Buffer.byteLength(JSON.stringify(decoded));
          if (group.length && (bytes + size > MAX_BATCH_BYTES || entries.length + decoded.length > MAX_LINES_PER_RUNTIME)) break;
          group.push(batch); entries.push(...decoded); bytes += size;
        }
        if (!group.length) continue;
        const ids = group.map((b) => b.id);
        const count = group.reduce((n, b) => n + b.entryCount, 0);
        if (!error) {
          try {
            const response = await deps.dispatch(target, entries, undefined, deps.signal);
            if (response.ok) {
              await db.delete(logDrainBatches).where(inArray(logDrainBatches.id, ids));
              shipped += count; continue;
            }
            error = response.status ? 'http_' + response.status : 'transport_error';
          } catch { error = 'delivery_unavailable'; }
        }
        failed += count;
        const attempts = Math.max(...group.map((b) => b.attempts)) + 1;
        await db.update(logDrainBatches).set({
          attempts, lastError: error,
          nextAttemptAt: new Date(deps.now().getTime() + Math.min(300, 10 * 2 ** Math.min(attempts - 1, 5)) * 1000),
        }).where(inArray(logDrainBatches.id, ids));
      }
      if (deliveries === previousDeliveries) break;
    }
  };
  await deliver();
  const running = await db.select().from(services)
    .where(and(eq(services.status, 'running'), inArray(services.type, ['docker', 'compose'])));
  for (const svc of running) {
    if (!svc.runtimeId || deps.signal?.aborted) continue;
    for (const container of replicaNames(svc.runtimeId, svc.runtimeReplicas ?? svc.replicas)) {
      const runtimeKey = svc.serverId == null ? container : 'node:' + svc.serverId + ':' + container;
      for (const d of configured.values()) {
        if (d.row.serviceId != null && d.row.serviceId !== svc.id) continue;
        if (deps.signal?.aborted) break;
        const key = and(eq(logDrainCursors.drainId, d.row.id), eq(logDrainCursors.runtimeKey, runtimeKey), eq(logDrainCursors.binding, d.binding));
        const cursor = await db.query.logDrainCursors.findFirst({ where: key });
        if (!cursor) {
          await db.insert(logDrainCursors).values({
            drainId: d.row.id, serviceId: svc.id, runtimeKey, binding: d.binding,
            lastTimestamp: deps.now().toISOString(), boundaryCount: -1, updatedAt: deps.now(),
          }).onConflictDoNothing();
          continue; // A newly enabled destination starts now, without historical backfill.
        }
        let raw: string[];
        try {
          raw = svc.serverId == null ? await deps.readLogs(container, cursor.lastTimestamp)
            : deps.readRemoteLogs ? await deps.readRemoteLogs(svc.serverId, container, cursor.lastTimestamp)
              : (await agentOp(db, svc.serverId, 'docker.logsSince', { name: container, since: cursor.lastTimestamp },
                () => undefined, { timeoutMs: 10_000, signal: deps.signal })).lines;
        } catch { continue; }
        const parsed = raw.map(parseDockerLogLine).filter((v): v is NonNullable<typeof v> => v !== null)
          .sort((a, b) => timestampKey(a.ts).localeCompare(timestampKey(b.ts)));
        const entries: LogPayloadEntry[] = [];
        const since = timestampKey(cursor.lastTimestamp);
        let last = cursor.lastTimestamp, boundaryCount = Math.max(cursor.boundaryCount, 0), atBoundary = 0, bytes = 2;
        let oversized = false;
        for (const line of parsed) {
          const stamp = timestampKey(line.ts);
          if (stamp < since) continue;
          if (stamp === since && (cursor.boundaryCount < 0 || ++atBoundary <= cursor.boundaryCount)) continue;
          const entry = { timestamp: line.ts, service: svc.slug, container, line: line.line };
          const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
          if (bytes + size > MAX_BATCH_BYTES) { oversized = entries.length === 0; break; }
          entries.push(entry); bytes += size;
          boundaryCount = timestampKey(last) === stamp ? boundaryCount + 1 : 1;
          last = line.ts;
          if (entries.length >= MAX_LINES_PER_RUNTIME) break;
        }
        if (!entries.length) {
          if (oversized) paused++;
          await db.update(logDrainCursors).set({ pausedReason: oversized ? 'line_too_large' : null, updatedAt: deps.now() }).where(key);
          continue;
        }
        const payloadEncrypted = encrypt(JSON.stringify(entries));
        const payloadBytes = Buffer.byteLength(payloadEncrypted);
        const stored = await db.transaction(async (tx) => {
          const current = await tx.query.logDrainCursors.findFirst({ where: key });
          if (!current || current.lastTimestamp !== cursor.lastTimestamp || current.boundaryCount !== cursor.boundaryCount) return false;
          const [usage] = await tx.select({ bytes: sql<number>`coalesce(sum(${logDrainBatches.payloadBytes}), 0)`, batches: sql<number>`count(*)` })
            .from(logDrainBatches).where(eq(logDrainBatches.drainId, d.row.id));
          if (Number(usage?.bytes ?? 0) + payloadBytes > logQueueMaxMb * 1024 ** 2 || Number(usage?.batches ?? 0) >= 10_000) {
            await tx.update(logDrainCursors).set({ pausedReason: 'queue_full', updatedAt: deps.now() }).where(key);
            return false;
          }
          await tx.insert(logDrainBatches).values({
            drainId: d.row.id, serviceId: svc.id, runtimeKey, binding: d.binding,
            payloadEncrypted, payloadBytes, entryCount: entries.length, nextAttemptAt: deps.now(), createdAt: deps.now(),
          });
          await tx.update(logDrainCursors).set({ lastTimestamp: last, boundaryCount, pausedReason: null, updatedAt: deps.now() }).where(key);
          return true;
        });
        if (stored) queued += entries.length; else paused++;
      }
    }
  }
  await deliver();
  await pruneLogDrainCursors(db, deps.now());
  return { shipped, failed, queued, paused };
}

/** Remove only retired cursor metadata; pending payloads have no automatic expiry. */
export async function pruneLogDrainCursors(db: DB, now = new Date()): Promise<void> {
  // Retired cursor records have no payload of their own. Keep any cursor that
  // still has captured batches; active/quiet sources were touched above.
  const retired = await db.select().from(logDrainCursors).where(and(
    lt(logDrainCursors.updatedAt, new Date(now.getTime() - 7 * 86400000)),
    sql`not exists (select 1 from log_drain_batches b where b.drain_id = ${logDrainCursors.drainId} and b.runtime_key = ${logDrainCursors.runtimeKey} and b.binding = ${logDrainCursors.binding})`,
  )).limit(200);
  for (const cursor of retired) await db.delete(logDrainCursors).where(and(eq(logDrainCursors.drainId, cursor.drainId), eq(logDrainCursors.runtimeKey, cursor.runtimeKey), eq(logDrainCursors.binding, cursor.binding)));
}
