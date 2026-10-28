import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { deployments, serviceVolumeAttachments, services, type DB } from '@ninedeploy/db';
import { serviceMoveInput, type ServiceMoveView } from '@ninedeploy/schemas';
import { config } from '../config.js';
import { backupVolume, restoreVolume, volumeExists } from '../engine/database.js';
import { audit } from '../lib/audit.js';
import { capture } from '../lib/exec.js';
import { enqueueUserDeploy } from '../lib/deployQueue.js';
import { HttpError, badRequest, parseId } from '../lib/errors.js';
import { backupNodeVolume, createNodeVolume, nodeVolumeExists, restoreNodeVolume } from '../lib/nodeVolumes.js';
import { loadServiceForUser } from '../lib/resourceAccess.js';
import { primaryServiceVolumeName } from '../lib/retainedSlugVolume.js';
import { getSettingJson, setSettingJson } from '../lib/settings.js';
import type { AuthUser } from '../plugins/auth.js';

/**
 * G3.1 move a service WITH its data between the panel host and nodes.
 * Configuration moves already exist (`PATCH /v1/services/:id { serverId }`);
 * this adds the primary data volume (`nd-svc-<slug>-data`):
 *
 *  1. The service must be stopped, with nothing deploying, and have no extra
 *     volume attachments (only the primary volume moves).
 *  2. The move itself is that PATCH, with every check it makes (attached
 *     databases, a volume already on the target, operator only).
 *  3. The volume is archived on the source (encrypted, as a snapshot is),
 *     created on the target and restored there; node transfers use the
 *     sealed stream channel, which checks bytes and sha256 end to end.
 *  4. The service is deployed on the target.
 *
 * The source volume is kept until the operator removes it (Volumes page).
 * A failed copy leaves the service on the target, undeployed, with the
 * reason on `GET …/move`; moving it back is a plain move.
 *
 * No migration: the progress is the settings row `service_move:<id>`.
 */

const key = (id: number) => `service_move:${id}`;
const running = new Set<number>();

export interface MoveDeps {
  backupLocal: typeof backupVolume;
  restoreLocal: typeof restoreVolume;
  localExists: typeof volumeExists;
  createLocal: (name: string) => Promise<void>;
  backupNode: typeof backupNodeVolume;
  restoreNode: typeof restoreNodeVolume;
  nodeExists: typeof nodeVolumeExists;
  createNode: typeof createNodeVolume;
}

export const defaultMoveDeps: MoveDeps = {
  backupLocal: backupVolume,
  restoreLocal: restoreVolume,
  localExists: volumeExists,
  createLocal: async (name) => {
    await capture('docker', ['volume', 'create', name], { timeoutMs: 60_000 });
  },
  backupNode: backupNodeVolume,
  restoreNode: restoreNodeVolume,
  nodeExists: nodeVolumeExists,
  createNode: createNodeVolume,
};

async function setState(db: DB, id: number, state: ServiceMoveView): Promise<void> {
  await setSettingJson(db, key(id), state);
}

/** Copy one volume from `from` to `to` (null = the panel host). */
export async function copyVolume(db: DB, name: string, from: number | null, to: number | null, log: (line: string) => void, deps: MoveDeps = defaultMoveDeps): Promise<void> {
  const file = path.join(config.paths.backupsDir, `move-${name}-${randomUUID()}.tar.gz`);
  try {
    if (from === null) await deps.backupLocal(name, file, log);
    else await deps.backupNode(db, from, name, file, log);
    if (to === null) {
      if (!(await deps.localExists(name))) await deps.createLocal(name);
      await deps.restoreLocal(name, file, log);
    } else {
      if (!(await deps.nodeExists(db, to, name))) await deps.createNode(db, to, name, {});
      await deps.restoreNode(db, to, name, file, log);
    }
  } finally {
    rmSync(file, { force: true });
  }
}

export function serviceMoveRoutes(deps: MoveDeps = defaultMoveDeps): FastifyPluginAsync {
  return async (app) => {
    app.addHook('onRequest', app.authenticate);
    app.addHook('preHandler', app.requireOperator);

    app.get('/:id/move', async (req): Promise<ServiceMoveView> => {
      const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
      return (await getSettingJson<ServiceMoveView>(app.db, key(svc.id), null)) ?? { state: 'none', from: null, to: null, step: null, error: null, startedAt: null, finishedAt: null, deploymentId: null };
    });

    app.post('/:id/move', async (req, reply): Promise<ServiceMoveView> => {
      const svc = await loadServiceForUser(app.db, parseId((req.params as { id: string }).id), req.user!);
      const { serverId: to } = serviceMoveInput.parse(req.body ?? {});
      const from = svc.serverId ?? null;
      if (to === from) throw badRequest('The service already runs there', 'move_same_host');
      if (svc.type !== 'docker' || svc.orchestrator === 'swarm') throw badRequest('Moving with data is for docker services (not Swarm, compose or PM2)', 'move_unsupported');
      if (!svc.volumeMount) throw badRequest('This service has no data volume; move it with a plain host change instead', 'move_no_volume');
      if (svc.status !== 'stopped') throw new HttpError(409, 'move_stop_first', 'Stop the service first, so its data does not change while it is copied');
      if (running.has(svc.id)) throw new HttpError(409, 'move_running', 'A move of this service is already running');
      const busy = await app.db.query.deployments.findFirst({
        where: and(eq(deployments.serviceId, svc.id), inArray(deployments.status, ['queued', 'building', 'deploying'])),
      });
      if (busy) throw new HttpError(409, 'move_deploying', 'Wait for the running deployment to finish');
      const extra = await app.db.query.serviceVolumeAttachments.findFirst({ where: eq(serviceVolumeAttachments.serviceId, svc.id) });
      if (extra) throw badRequest('Only the primary data volume moves; detach the extra volumes first', 'move_extra_volumes');
      const volume = primaryServiceVolumeName(svc.slug);
      const present = from === null ? await deps.localExists(volume) : await deps.nodeExists(app.db, from, volume);
      if (!present) throw badRequest(`The data volume ${volume} is not on the current host; move it with a plain host change instead`, 'move_no_volume');

      // The move itself, with every check the plain host change makes.
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      for (const h of ['authorization', 'cookie']) {
        const v = req.headers[h];
        if (typeof v === 'string') headers[h] = v;
      }
      const moved = await app.inject({ method: 'PATCH', url: `/v1/services/${svc.id}`, headers, payload: { serverId: to } });
      if (moved.statusCode >= 400) {
        const body = moved.json() as { error?: { code?: string; message?: string } };
        throw new HttpError(moved.statusCode, body.error?.code ?? 'move_refused', body.error?.message ?? 'The move was refused');
      }

      const startedAt = new Date().toISOString();
      const state: ServiceMoveView = { state: 'running', from, to, step: 'copying', error: null, startedAt, finishedAt: null, deploymentId: null };
      await setState(app.db, svc.id, state);
      void audit(app.db, req.user!.id, 'service.move_with_data', `${svc.name}: ${from ?? 'panel host'} → ${to ?? 'panel host'}`, { serviceId: svc.id, from, to });
      running.add(svc.id);
      const user: AuthUser = { ...req.user! };
      const log = (line: string) => req.log.info({ serviceId: svc.id, component: 'move' }, line);
      void (async () => {
        try {
          await copyVolume(app.db, volume, from, to, log, deps);
          await setState(app.db, svc.id, { ...state, step: 'deploying' });
          const fresh = await app.db.query.services.findFirst({ where: eq(services.id, svc.id) });
          const deploymentId = fresh ? await enqueueUserDeploy(app.db, user, fresh, { message: 'Moved with its data' }) : null;
          await setState(app.db, svc.id, { ...state, state: 'done', step: null, finishedAt: new Date().toISOString(), deploymentId });
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          await setState(app.db, svc.id, { ...state, state: 'failed', error, finishedAt: new Date().toISOString() }).catch(() => undefined);
          void audit(app.db, user.id, 'service.move_with_data_failed', `${svc.name}: ${error}`.slice(0, 300), { serviceId: svc.id });
        } finally {
          running.delete(svc.id);
        }
      })();
      reply.code(202);
      return state;
    });
  };
}
