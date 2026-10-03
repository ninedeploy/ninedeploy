import { Cron } from 'croner';
import type { scheduledJobs, DB } from '@ninedeploy/db';
import fp from 'fastify-plugin';
import { runJob } from '../lib/jobRunner.js';

/**
 * Cron scheduler for scheduled_jobs: reloads the job set every 5 minutes (and
 * on plugin close), so CRUD changes apply within minutes without a restart.
 * Invalid/never-firing cron expressions are surfaced per job in the log.
 */
export default fp(
  async (fastify) => {
    const db: DB = fastify.db;
    let stopped = false;
    let reloadTimer: NodeJS.Timeout | undefined;
    const activeCrons: Array<{ stop(): void }> = [];

    const armJobs = async (): Promise<void> => {
      // Tear down the previous set; cheap at this scale (handful of jobs).
      for (const c of activeCrons.splice(0)) c.stop();
      let jobs: Array<typeof scheduledJobs.$inferSelect> = [];
      try {
        jobs = (await db.query.scheduledJobs.findMany()).filter((j) => j.enabled);
      } catch {
        return; // table might not exist yet (pre-migration)
      }
      for (const job of jobs) {
        try {
          const cron = new Cron(job.cron, { name: `job-${job.id}`, unref: true }, () => {
            // r303: `scheduled` makes runJob re-check `enabled` on the live row.
            void runJob(db, job.id, { scheduled: true }).catch((err) =>
              fastify.log.error({ err, jobId: job.id }, 'scheduled job failed'),
            );
          });
          activeCrons.push(cron);
        } catch (err) {
          fastify.log.warn({ err, jobId: job.id, cron: job.cron }, 'invalid cron expression — job disabled');
        }
      }
    };

    fastify.addHook('onClose', async () => {
      stopped = true;
      clearTimeout(reloadTimer);
      for (const c of activeCrons.splice(0)) c.stop();
    });

    await armJobs();
    const scheduleReload = (): void => {
      if (stopped) return;
      reloadTimer = setTimeout(() => {
        void armJobs().finally(scheduleReload);
      }, 5 * 60 * 1000);
      reloadTimer.unref();
    };
    scheduleReload();
    fastify.log.info('job scheduler armed (5-minute reload)');
  },
  { name: 'ninedeploy-jobs' },
);
