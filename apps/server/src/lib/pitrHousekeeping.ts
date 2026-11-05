/**
 * R3: the two point-in-time recovery sweeps housekeeping runs. A light
 * module on purpose (exec, drizzle and the schema only): the housekeeping
 * plugin must not load the database engine just to prune.
 */
import { and, inArray, lt } from 'drizzle-orm';
import { pitrRecoveries, type DB } from '@ninedeploy/db';
import { capture } from './exec.js';

const RECOVERY_HELPER_ROLE = 'ninedeploy.role=pitr-recovery';
const RECOVERY_HELPER_NAME = /^\/?nd-pitr-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Remove recovery helpers a crashed process left behind. Only a container
 * with the label AND the exact helper name, older than `maxAgeMs` (longer
 * than a replay may take), is removed. Returns how many went.
 */
export async function prunePitrRecoveryHelpers(maxAgeMs: number, now = Date.now()): Promise<number> {
  const quick = { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 };
  const ids = (await capture('docker', ['ps', '-a', '--no-trunc', '-q', '--filter', `label=${RECOVERY_HELPER_ROLE}`], quick))
    .split('\n').map((line) => line.trim()).filter((id) => /^[a-f0-9]{64}$/.test(id));
  let removed = 0;
  for (const id of ids) {
    try {
      const [created = '', name = ''] = (await capture('docker', ['inspect', '--format', '{{.Created}} {{.Name}}', id], quick)).trim().split(' ');
      const createdMs = Date.parse(created);
      if (!RECOVERY_HELPER_NAME.test(name) || !Number.isFinite(createdMs) || now - createdMs < maxAgeMs) continue;
      await capture('docker', ['rm', '-f', id], quick);
      removed++;
    } catch {
      /* best effort: the container vanished, or one daemon call failed */
    }
  }
  return removed;
}

/** Finished recoveries are kept this long: the evidence of what was recovered, and when. */
export const PITR_RECOVERY_MAX_AGE_MS = 400 * 24 * 60 * 60_000;

/** Drop finished recovery rows past the window (a running one is never touched). */
export async function prunePitrRecoveries(db: DB, now = Date.now()): Promise<void> {
  await db
    .delete(pitrRecoveries)
    .where(and(inArray(pitrRecoveries.status, ['completed', 'failed']), lt(pitrRecoveries.startedAt, new Date(now - PITR_RECOVERY_MAX_AGE_MS))));
}
