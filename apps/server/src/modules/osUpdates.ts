import type { FastifyPluginAsync } from 'fastify';
import { eq, servers, type DB } from '@ninedeploy/db';
import { osAutoUpdatesInput, osUpdateStatus, osUpdateStatusQuery, type OsUpdateStatus } from '@ninedeploy/schemas';
import { assertNodeCapability } from '../lib/agentCapabilities.js';
import { agentOp } from '../lib/agentClient.js';
import { audit } from '../lib/audit.js';
import { HttpError, notFound, parseId } from '../lib/errors.js';
import { runOsUpdateAction, type OsUpdateAction } from '../lib/osUpdates.js';
import { hostShellImage } from '../lib/terminalSessions.js';

/**
 * OS security updates (G4.2), operator only: the panel host under
 * `/v1/os-updates`, a node under `/v1/servers/:serverId/os-updates` (agent op
 * `host.packages`, sealed). Reading is `GET` (`?refresh=1` refreshes the
 * package lists first); `POST …/auto {enabled}` switches automatic security
 * updates. Nothing here reboots a host.
 */

/** One action per host at a time: two package-manager runs would fight over its lock. */
const busy = new Set<string>();

async function exclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
  if (busy.has(key)) throw new HttpError(409, 'os_updates_busy', 'Another OS update action is still running on this host');
  busy.add(key);
  try {
    return await run();
  } finally {
    busy.delete(key);
  }
}

function hostFailure(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new HttpError(502, 'os_updates_failed', `The host did not complete the OS update action: ${message.slice(0, 500)}`);
}

async function panelAction(action: OsUpdateAction): Promise<OsUpdateStatus> {
  return exclusive('panel', async () => {
    try {
      return await runOsUpdateAction(hostShellImage(), action);
    } catch (err) {
      throw hostFailure(err);
    }
  });
}

async function nodeAction(db: DB, serverId: number, action: OsUpdateAction): Promise<OsUpdateStatus> {
  const node = await db.query.servers.findFirst({ where: eq(servers.id, serverId), columns: { id: true } });
  if (!node) throw notFound('Node not found');
  await assertNodeCapability(db, serverId, { cap: 'host.packages', feature: 'read and change OS updates', sealedRequired: true });
  return exclusive(`node:${serverId}`, async () => {
    let lines: string[];
    try {
      lines = (await agentOp(db, serverId, 'host.packages', { action }, () => undefined)).lines.filter((l) => l.trim());
    } catch (err) {
      throw hostFailure(err);
    }
    const last = lines.at(-1);
    let parsed: unknown;
    try {
      parsed = last ? JSON.parse(last) : null;
    } catch {
      parsed = null;
    }
    const status = osUpdateStatus.safeParse(parsed);
    if (!status.success) throw new HttpError(502, 'os_updates_unconfirmed', 'The node answered without a readable OS update status');
    return status.data;
  });
}

export const osUpdateRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requireOperator);

  app.get('/', async (req) => {
    const { refresh } = osUpdateStatusQuery.parse(req.query ?? {});
    return panelAction(refresh === '1' ? 'refresh' : 'status');
  });

  app.post('/auto', async (req) => {
    const { enabled } = osAutoUpdatesInput.parse(req.body ?? {});
    const status = await panelAction(enabled ? 'enable' : 'disable');
    void audit(app.db, req.user!.id, enabled ? 'os_updates.auto_enable' : 'os_updates.auto_disable', 'panel host', {
      packageManager: status.packageManager,
      os: status.os.id,
    });
    return status;
  });
};

export const nodeOsUpdateRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requireOperator);

  app.get('/', async (req) => {
    const serverId = parseId((req.params as { serverId: string }).serverId, 'Invalid node id');
    const { refresh } = osUpdateStatusQuery.parse(req.query ?? {});
    return nodeAction(app.db, serverId, refresh === '1' ? 'refresh' : 'status');
  });

  app.post('/auto', async (req) => {
    const serverId = parseId((req.params as { serverId: string }).serverId, 'Invalid node id');
    const { enabled } = osAutoUpdatesInput.parse(req.body ?? {});
    const status = await nodeAction(app.db, serverId, enabled ? 'enable' : 'disable');
    void audit(app.db, req.user!.id, enabled ? 'os_updates.auto_enable' : 'os_updates.auto_disable', `node #${serverId}`, {
      serverId,
      packageManager: status.packageManager,
      os: status.os.id,
    });
    return status;
  });
};
