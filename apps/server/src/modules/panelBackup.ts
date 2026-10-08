import { eq } from 'drizzle-orm';
import { backupDestinations } from '@ninedeploy/db';
import { panelBackupRestore, panelBackupSettingsPatch } from '@ninedeploy/schemas';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';
import {
  getPanelBackupConfig,
  getPanelBackupStatus,
  hasPanelBackupPassphrase,
  isValidPanelBackupCron,
  listPanelBackups,
  notifyPanelBackupScheduleChanged,
  restorePanelBackup,
  setPanelBackupConfig,
  setPanelBackupPassphrase,
  startPanelBackup,
} from '../lib/panelBackup.js';

const listQuery = z.object({ destinationId: z.coerce.number().int().positive().optional() });

/**
 * Panel self-backup (operator-only). Mounted under /system/panel-backup.
 * Configuration lives in the settings table; see lib/panelBackup.ts and
 * docs/PANEL_BACKUP.md for the artifact, the passphrase and the restore path.
 */
export const panelBackupRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  // The archive holds the database and the master key: every route here is
  // instance-operator territory, like /system/export and /system/import.
  app.addHook('preHandler', app.requireOperator);

  app.get('/', async () => getPanelBackupStatus(app.db));

  app.put('/', async (req) => {
    const input = panelBackupSettingsPatch.parse(req.body ?? {});
    const current = await getPanelBackupConfig(app.db);
    const next = {
      enabled: input.enabled ?? current.enabled,
      cron: input.cron ?? current.cron,
      destinationId: input.destinationId === undefined ? current.destinationId : input.destinationId,
      retain: input.retain ?? current.retain,
    };
    if (!isValidPanelBackupCron(next.cron)) {
      throw badRequest('Invalid cron expression (expected 5 fields: minute hour day month weekday)');
    }
    if (input.destinationId != null) {
      const row = await app.db.query.backupDestinations.findFirst({ where: eq(backupDestinations.id, input.destinationId) });
      if (!row) throw badRequest(`Backup destination #${input.destinationId} does not exist`);
    }
    if (next.enabled) {
      if (next.destinationId == null) throw badRequest('Pick a backup destination before enabling panel backups');
      if (!input.passphrase && !(await hasPanelBackupPassphrase(app.db))) {
        throw badRequest('Set a recovery passphrase before enabling panel backups — it is required to restore');
      }
    }
    if (input.passphrase) await setPanelBackupPassphrase(app.db, input.passphrase);
    await setPanelBackupConfig(app.db, next);
    notifyPanelBackupScheduleChanged();
    void audit(
      app.db,
      req.user!.id,
      'backup.panel.settings',
      `${next.enabled ? 'enabled' : 'disabled'} · ${next.cron} · keep ${next.retain}`,
      // Never the passphrase itself — only that it changed.
      { ...next, passphraseChanged: !!input.passphrase },
    );
    return getPanelBackupStatus(app.db);
  });

  // "Back up now" — runs in the background; poll GET / for the outcome.
  app.post('/run', async (req, reply) => {
    const { started } = startPanelBackup(app.db, {
      actorUserId: req.user!.id,
      log: (line) => app.log.info({ component: 'panel-backup' }, line),
    });
    if (!started) {
      return reply.status(409).send({
        error: { code: 'conflict', message: 'A panel backup or restore is already running — wait for it to finish' },
      });
    }
    return reply.status(202).send({ ok: true, started: true });
  });

  // Panel backups in a destination (default: the configured one), newest first.
  app.get('/remote', async (req) => {
    const { destinationId: requested } = listQuery.parse(req.query ?? {});
    const destinationId = requested ?? (await getPanelBackupConfig(app.db)).destinationId;
    if (destinationId == null) throw badRequest('Pick a backup destination to list');
    return { destinationId, items: await listPanelBackups(app.db, destinationId) };
  });

  // Destructive: replaces this panel's database, master key, .env and Traefik
  // config with the backup's. Confirmed by repeating the object's file name;
  // the panel must be restarted afterwards, as after any import.
  app.post('/restore', async (req, reply) => {
    const input = panelBackupRestore.parse(req.body ?? {});
    const outcome = await restorePanelBackup(app, input, req.user!.id);
    return reply.status(outcome.status).send(outcome.body);
  });
};
