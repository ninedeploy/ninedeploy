import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { FastifyPluginAsync } from 'fastify';
import { audit } from '../lib/audit.js';
import { resolveUser } from '../lib/auth.js';
import { assertServiceRole, loadServiceForUser } from '../lib/resourceAccess.js';
import { MAX_TUNNELS_PER_USER, bridgeTunnel, reserveTunnel, tokenMayWrite } from '../lib/tunnelBridge.js';
import { websocketBearerToken } from '../lib/websocketAuth.js';
import { swarmRuntimeOf } from '../lib/swarm.js';
import { authorizeWebsocketUser } from '../plugins/auth.js';
import { containerIp } from '../engine/builders/docker.js';
import { replicaNames } from '../engine/dockerNames.js';
import { openNodeTunnel } from '../lib/nodeTunnel.js';

/**
 * G5.8 service tunnels: `GET /v1/services/:id/tunnel?port=&replica=`
 * (WebSocket) carries one TCP connection to a port of a running docker
 * service, so `ninedeploy tunnel service <id>` can reach an admin port, a
 * debugger or a service with no domain without publishing anything. On the
 * panel host the panel connects to the container; on a node (agent 0.18.7,
 * `tunnel.tcp`) the node's agent does, over an encrypted channel
 * (lib/nodeTunnel.ts).
 *
 * Who: the service's `admin` role or higher. The tunnel reaches the container
 * directly, past what its domains enforce (forward auth, IP allow lists,
 * basic auth), so the role is the one that may change those. A scoped API
 * token must also be allowed to write services. Re-checked every minute;
 * audited with byte counts.
 */

/** Test seam: how the panel reaches a service container. */
export const serviceTunnelDeps = {
  resolveAddress: containerIp,
  connect: (host: string, port: number): net.Socket => net.connect({ host, port }),
  openNode: openNodeTunnel as (db: Parameters<typeof openNodeTunnel>[0], serverId: number, target: { container: string; port: number }) => Promise<Duplex>,
};

export const serviceTunnelRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:id/tunnel', { websocket: true }, async (socket, req) => {
    const refuse = (reason: string) => socket.close(1008, reason);
    const token = websocketBearerToken(req.headers);
    const user = token ? await resolveUser(app.db, token) : null;
    if (!user || !authorizeWebsocketUser(user, req.url) || !tokenMayWrite(user.tokenScopes, 'services')) return refuse('unauthorized');
    const id = Number((req.params as { id: string }).id);
    if (!Number.isSafeInteger(id) || id <= 0) return refuse('not found');
    const q = req.query as { port?: string; replica?: string };
    let svc: Awaited<ReturnType<typeof loadServiceForUser>>;
    try {
      svc = await loadServiceForUser(app.db, id, user);
      await assertServiceRole(app.db, svc, user, 'admin');
    } catch {
      return refuse('not found or not allowed');
    }
    if (svc.type !== 'docker' || svc.orchestrator === 'swarm' || swarmRuntimeOf(svc)) return refuse('tunnels reach docker services (not Swarm, compose or PM2)');
    const port = q.port === undefined ? (svc.port ?? null) : Number(q.port);
    if (port === null || !Number.isInteger(port) || port < 1 || port > 65535) return refuse('name the container port with ?port=');
    const replica = q.replica === undefined ? 1 : Number(q.replica);
    const names = svc.runtimeId ? replicaNames(svc.runtimeId, svc.runtimeReplicas ?? 1) : [];
    if (!names.length) return refuse('the service is not running');
    const container = Number.isInteger(replica) ? names[replica - 1] : undefined;
    if (!container) return refuse(`the service runs ${names.length} replica(s)`);
    const release = reserveTunnel(user.id);
    if (!release) return refuse(`at most ${MAX_TUNNELS_PER_USER} tunnels at once`);
    let target: net.Socket | Duplex;
    if (svc.serverId != null) {
      try {
        target = await serviceTunnelDeps.openNode(app.db, svc.serverId, { container, port });
      } catch (err) {
        release();
        return refuse((err instanceof Error ? err.message : String(err)).slice(0, 120));
      }
    } else {
      const host = await serviceTunnelDeps.resolveAddress(container);
      if (!host) {
        release();
        return refuse('the service container has no address');
      }
      target = serviceTunnelDeps.connect(host, port);
    }
    if (socket.readyState !== socket.OPEN) {
      target.destroy();
      return release();
    }
    void audit(app.db, user.id, 'service.tunnel.open', `${svc.name}:${port}`, { serviceId: svc.id, port, replica, serverId: svc.serverId ?? null }, { ip: req.ip, userAgent: req.headers['user-agent'] });
    bridgeTunnel({
      socket,
      tcp: target,
      release,
      label: 'service',
      stillAllowed: async () => {
        const fresh = await resolveUser(app.db, token!);
        if (!fresh || !authorizeWebsocketUser(fresh, req.url) || !tokenMayWrite(fresh.tokenScopes, 'services')) return false;
        try {
          await assertServiceRole(app.db, await loadServiceForUser(app.db, id, fresh), fresh, 'admin');
          return true;
        } catch {
          return false;
        }
      },
      onClose: (s) => void audit(app.db, user.id, 'service.tunnel.close', `${svc.name}:${port}`, { serviceId: svc.id, port, ...s }),
    });
  });
};
