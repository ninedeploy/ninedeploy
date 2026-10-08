import { Cron } from 'croner';
import fp from 'fastify-plugin';
import {
  clearPanelBackupScratch,
  getPanelBackupConfig,
  runPanelBackup,
  setPanelBackupScheduleListener,
} from '../lib/panelBackup.js';

/**
 * Panel self-backup schedule. Arms ONE croner job from the `panel_backup`
 * settings row when it is enabled; a disabled or absent row arms nothing (the
 * upgrade default). Settings changes re-arm at once through the listener, and
 * a 5-minute reload covers anything else (a restored database, a manual edit).
 *
 * Overlap: runPanelBackup refuses while a run or restore is in flight, so a
 * tick that lands mid-run is skipped (and audited as `backup.panel.skipped`).
 */
export default fp(
  async (fastify) => {
    let stopped = false;
    let active: Cron | null = null;
    let armedFor = '';
    let reloadTimer: NodeJS.Timeout | undefined;
    const log = (line: string) => fastify.log.info({ component: 'panel-backup' }, line);

    const arm = async (): Promise<void> => {
      let cfg: Awaited<ReturnType<typeof getPanelBackupConfig>>;
      try {
        cfg = await getPanelBackupConfig(fastify.db);
      } catch {
        return; // settings unreadable (pre-migration database): leave as is
      }
      if (stopped) return;
      const wanted = cfg.enabled && cfg.destinationId != null ? cfg.cron : '';
      if (wanted === armedFor && (wanted === '' || active)) return;
      active?.stop();
      active = null;
      armedFor = wanted;
      if (!wanted) return;
      try {
        active = new Cron(wanted, { name: 'panel-backup', unref: true, mode: '5-part' }, () => {
          void (async () => {
            // Re-read at fire time: a disable that raced the reload wins.
            const live = await getPanelBackupConfig(fastify.db).catch(() => null);
            if (!live?.enabled) return;
            await runPanelBackup(fastify.db, { trigger: 'schedule', actorUserId: null, log });
          })().catch((err) => fastify.log.error({ err, component: 'panel-backup' }, 'scheduled panel backup crashed'));
        });
        log(`panel backup scheduled (${wanted})`);
      } catch (err) {
        fastify.log.warn({ err, cron: wanted, component: 'panel-backup' }, 'invalid panel backup cron — schedule disarmed');
      }
    };

    setPanelBackupScheduleListener(() => void arm());

    fastify.addHook('onClose', async () => {
      stopped = true;
      clearTimeout(reloadTimer);
      setPanelBackupScheduleListener(null);
      active?.stop();
      active = null;
    });

    // Nothing can be running yet: drop scratch files a crashed run left behind
    // (they may hold a plaintext archive of the database and master key).
    try {
      clearPanelBackupScratch();
    } catch {
      /* best effort */
    }
    await arm();
    const scheduleReload = (): void => {
      if (stopped) return;
      reloadTimer = setTimeout(() => {
        void arm().finally(scheduleReload);
      }, 5 * 60 * 1000);
      reloadTimer.unref();
    };
    scheduleReload();
  },
  { name: 'ninedeploy-panel-backup' },
);
