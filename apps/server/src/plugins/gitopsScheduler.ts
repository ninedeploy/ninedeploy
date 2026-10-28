import fp from 'fastify-plugin';
import { audit } from '../lib/audit.js';
import { driftFingerprint, getGitopsConfig, getLastCheck, runGitopsCheck } from '../lib/instanceGitops.js';

/**
 * G5.3: read the instance file on the configured interval and alert when
 * the drift changes (`alert.gitops_drift`) or the file cannot be read
 * (`alert.gitops_failed`). The alerts are audited, which notifies the
 * channels that receive alerts. Off unless instance GitOps is configured.
 */
export default fp(
  async (fastify) => {
    let busy = false;
    const tick = async () => {
      const cfg = await getGitopsConfig(fastify.db);
      if (!cfg?.enabled || cfg.intervalMinutes === 0) return;
      const last = await getLastCheck(fastify.db);
      if (last && Date.now() - Date.parse(last.at) < cfg.intervalMinutes * 60_000) return;
      const { check, previous } = await runGitopsCheck(fastify.db);
      if (check.error) {
        if (!previous?.error) void audit(fastify.db, null, 'alert.gitops_failed', check.error.slice(0, 300));
        return;
      }
      if (check.drift.length && driftFingerprint(check.drift) !== driftFingerprint(previous?.drift ?? [])) {
        const sample = check.drift.slice(0, 5).map((d) => `${d.change} ${d.kind} ${d.key}`);
        void audit(fastify.db, null, 'alert.gitops_drift', `${check.drift.length} difference(s): ${sample.join('; ')}`.slice(0, 300), { commit: check.commit });
      }
    };
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void tick()
        .catch((err) => fastify.log.warn({ err, component: 'gitops' }, 'instance GitOps check failed'))
        .finally(() => {
          busy = false;
        });
    }, 60_000);
    timer.unref();
    fastify.addHook('onClose', async () => clearInterval(timer));
  },
  { name: 'ninedeploy-instance-gitops' },
);
