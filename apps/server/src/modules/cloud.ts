import type { FastifyPluginAsync } from 'fastify';
import { hetznerServerCreate, hetznerTokenInput } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { parseId } from '../lib/errors.js';
import {
  createHetznerServer,
  deleteHetznerServer,
  deleteHetznerToken,
  hetznerOptions,
  hetznerStatus,
  listHetznerServers,
  saveHetznerToken,
  waitForAgentInBackground,
} from '../lib/hetznerCloud.js';

/**
 * G4.3 cloud servers, operator only: `/v1/cloud/hetzner/*`. The token is
 * write-only (its last four characters are shown back). Creating a server
 * starts a VM that bootstraps the agent by itself; the node turns online when
 * the agent first answers.
 */
export const cloudRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requireOperator);

  app.get('/hetzner', async () => hetznerStatus(app.db));

  app.put('/hetzner/token', async (req) => {
    const { token } = hetznerTokenInput.parse(req.body ?? {});
    const status = await saveHetznerToken(app.db, token);
    void audit(app.db, req.user!.id, 'cloud.hetzner_token_set', 'hetzner', { tokenHint: status.tokenHint });
    return status;
  });

  app.delete('/hetzner/token', async (req) => {
    await deleteHetznerToken(app.db);
    void audit(app.db, req.user!.id, 'cloud.hetzner_token_delete', 'hetzner');
    return hetznerStatus(app.db);
  });

  app.get('/hetzner/options', async () => hetznerOptions(app.db));

  app.get('/hetzner/servers', async () => listHetznerServers(app.db));

  app.post('/hetzner/servers', async (req) => {
    const input = hetznerServerCreate.parse(req.body ?? {});
    const created = await createHetznerServer(app.db, input, { waitForAgent: waitForAgentInBackground(app.db, req.log) });
    void audit(app.db, req.user!.id, 'cloud.server_create', input.name, {
      provider: 'hetzner',
      serverId: created.serverId,
      providerServerId: created.providerServerId,
      ipv4: created.ipv4,
      location: input.location,
      serverType: input.serverType,
      image: input.image,
    });
    return created;
  });

  app.delete('/hetzner/servers/:serverId', async (req) => {
    const serverId = parseId((req.params as { serverId: string }).serverId, 'Invalid node id');
    const removed = await deleteHetznerServer(app.db, serverId);
    void audit(app.db, req.user!.id, 'cloud.server_delete', removed.name, {
      provider: 'hetzner',
      serverId,
      providerServerId: removed.providerServerId,
    });
    return { ok: true };
  });
};
