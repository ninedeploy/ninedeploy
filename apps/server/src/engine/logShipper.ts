import { and, eq, inArray, isNull } from 'drizzle-orm';
import { logDrains, services, type DB } from '@ninedeploy/db';
import type { LogDrainFormat, LogDrainType } from '@ninedeploy/schemas';
import { decrypt } from '../lib/crypto.js';
import { run } from '../lib/exec.js';
import { dispatchLogBatch, type LogPayloadEntry } from './logDrainManager.js';
import { replicaNames } from './dockerNames.js';

/**
 * r231: the log-drain shipper.
 *
 * Drains could be created, listed and "tested", and nothing ever sent them a
 * line: `dispatchLogToDrain` was called only by the connectivity test. This
 * tails every running LOCAL container runtime a drain covers (`docker logs
 * --since`, per replica) and forwards new lines in batches.
 *
 * Scope and limits, on purpose:
 *  - local docker/compose runtimes only — a remote node's containers are not
 *    on this daemon, and PM2 logs are files, not a container stream;
 *  - no backfill: a runtime's cursor starts when the shipper first sees it;
 *  - at most {@link MAX_LINES_PER_RUNTIME} lines per runtime per tick, so a
 *    chatty container cannot starve the others or the drain.
 */

export const MAX_LINES_PER_RUNTIME = 1000;

/** Per-container cursor: the last docker timestamp already shipped. */
export type ShipperCursors = Map<string, string>;

export interface ShipperDeps {
  /** Collect a container's log lines (docker adds the RFC3339Nano timestamp). */
  readLogs: (container: string, since: string) => Promise<string[]>;
  dispatch: typeof dispatchLogBatch;
  now: () => Date;
}

const defaultDeps: ShipperDeps = {
  readLogs: async (container, since) => {
    const lines: string[] = [];
    await run(
      'docker',
      ['logs', '--timestamps', '--since', since, container],
      { timeoutMs: 30_000 },
      (line) => {
        if (lines.length < MAX_LINES_PER_RUNTIME * 2) lines.push(line);
      },
    );
    return lines;
  },
  dispatch: dispatchLogBatch,
  now: () => new Date(),
};

/** Split `2026-09-18T10:00:00.123456789Z message` into its parts. */
export function parseDockerLogLine(raw: string): { ts: string; line: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) ?(.*)$/.exec(raw);
  return m ? { ts: m[1]!, line: m[2]! } : null;
}

/** One pass: forward every new line to the drains that cover its service. */
export async function shipLogsOnce(
  db: DB,
  cursors: ShipperCursors,
  deps: ShipperDeps = defaultDeps,
): Promise<{ shipped: number; failed: number }> {
  const drains = await db.select().from(logDrains).where(eq(logDrains.enabled, true));
  if (drains.length === 0) {
    cursors.clear();
    return { shipped: 0, failed: 0 };
  }
  const running = await db
    .select()
    .from(services)
    .where(and(eq(services.status, 'running'), isNull(services.serverId), inArray(services.type, ['docker', 'compose'])));

  let shipped = 0;
  let failed = 0;
  const live = new Set<string>();
  for (const svc of running) {
    if (!svc.runtimeId) continue;
    const covering = drains.filter((d) => d.serviceId == null || d.serviceId === svc.id);
    if (covering.length === 0) continue;
    for (const container of replicaNames(svc.runtimeId, svc.replicas)) {
      live.add(container);
      const since = cursors.get(container);
      if (since === undefined) {
        // First sight: start from now, never backfill a container's history.
        cursors.set(container, deps.now().toISOString());
        continue;
      }
      let raw: string[];
      try {
        raw = await deps.readLogs(container, since);
      } catch {
        continue; // container restarting/gone — the next tick retries
      }
      const entries: LogPayloadEntry[] = [];
      let last = since;
      for (const r of raw) {
        const parsed = parseDockerLogLine(r);
        // `--since` is inclusive: drop what the previous tick already sent.
        if (!parsed || parsed.ts <= since) continue;
        entries.push({ timestamp: parsed.ts, service: svc.slug, container, line: parsed.line });
        last = parsed.ts;
        if (entries.length >= MAX_LINES_PER_RUNTIME) break;
      }
      cursors.set(container, last);
      if (entries.length === 0) continue;
      for (const drain of covering) {
        const res = await deps.dispatch(
          {
            url: drain.url,
            type: drain.type as LogDrainType,
            format: drain.format as LogDrainFormat,
            apiKey: drain.apiKeyEncrypted ? decrypt(drain.apiKeyEncrypted) : null,
            headers: drain.headersJson ? (JSON.parse(drain.headersJson) as Record<string, string>) : null,
          },
          entries,
        );
        if (res.ok) shipped += entries.length;
        else failed += entries.length;
      }
    }
  }
  // Forget containers that stopped (a redeploy mints a new name).
  for (const key of [...cursors.keys()]) if (!live.has(key)) cursors.delete(key);
  return { shipped, failed };
}
