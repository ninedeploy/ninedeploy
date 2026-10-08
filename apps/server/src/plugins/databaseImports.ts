import fp from 'fastify-plugin';
import {
  expireStaleImports,
  pruneFinishedImports,
  pruneOrphanStaging,
  recoverInterruptedImports,
} from '../lib/databaseImport.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Database dump imports (0.14, DESIGN §3.2):
 *  - boot recovery: `running` rows the previous process left become `failed`
 *    ("interrupted by panel restart") and lose their staging file;
 *  - the sweep, at boot and then hourly: `uploading` / `pending` imports idle
 *    for 24h become `expired` (staging deleted), staging files no live import
 *    owns are deleted, and finished rows older than 90 days are pruned — the
 *    table's retention, on the audit log's window, so it never grows without
 *    bound (housekeeping.ts sweeps the other event tables the same way).
 *
 * Every step is isolated and never blocks startup.
 */
export default fp(
  async (fastify, opts: { intervalMs?: number } = {}) => {
    const interval = opts.intervalMs ?? HOUR_MS;
    let running = true;
    let timer: NodeJS.Timeout | undefined;

    const step = async (name: string, fn: () => Promise<unknown>) => {
      try {
        const result = await fn();
        const count = Array.isArray(result) ? result.length : typeof result === 'number' ? result : 0;
        if (count > 0) fastify.log.info({ step: name, count }, `database imports: ${name}`);
      } catch (err) {
        fastify.log.warn({ err, step: name }, `database import sweep step failed: ${name}`);
      }
    };
    const sweep = async () => {
      const now = Date.now();
      await step('expire-stale', () => expireStaleImports(fastify.db, now));
      await step('orphan-staging', () => pruneOrphanStaging(fastify.db, undefined, now));
      await step('retention', () => pruneFinishedImports(fastify.db, now));
    };
    const tick = async () => {
      try {
        await sweep();
      } finally {
        if (running) {
          timer = setTimeout(() => void tick(), interval);
          timer.unref();
        }
      }
    };

    fastify.addHook('onClose', async () => {
      running = false;
      clearTimeout(timer);
    });

    // Nothing this process started can be running yet: every `running` row is
    // the previous process's.
    await step('recover-interrupted', () => recoverInterruptedImports(fastify.db));
    await sweep();
    timer = setTimeout(() => void tick(), interval);
    timer.unref();
  },
  { name: 'ninedeploy-database-imports' },
);
