import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { FastifyPluginAsync } from 'fastify';
import { audit } from '../lib/audit.js';
import { resolveUser } from '../lib/auth.js';
import { assertDatabaseRole, loadDatabaseForUser } from '../lib/resourceAccess.js';
import { MAX_TUNNELS_PER_USER, bridgeTunnel, holdEarlyMessages, reserveTunnel, tokenMayWrite } from '../lib/tunnelBridge.js';
import { websocketBearerToken } from '../lib/websocketAuth.js';
import { authorizeWebsocketUser } from '../plugins/auth.js';
import { containerIp } from '../engine/builders/docker.js';
import { openNodeTunnel } from '../lib/nodeTunnel.js';

export { MAX_TUNNELS_PER_USER, TUNNEL_IDLE_MS } from '../lib/tunnelBridge.js';

/**
 * G5.8 database tunnels: `GET /v1/databases/:id/tunnel` (WebSocket) carries
 * one TCP connection to a database, byte for byte, so
 * `ninedeploy tunnel db <id>` can offer it on a local port while the database
 * port stays closed to the internet.
 *
 * Who: the database's `admin` role or higher, the same as revealing its
 * credentials; a scope-restricted API token must also be allowed to write.
 * The database's own login still applies on top. Access is re-checked every
 * minute: a revoked grant or token closes the tunnel. Each tunnel is audited.
 * The bridge itself is lib/tunnelBridge.ts, shared with service tunnels.
 * A database on a node is reached through its agent (0.18.7, `tunnel.tcp`)
 * over the encrypted channel of lib/nodeTunnel.ts; the agent connects only
 * to a container it confirms the panel started as a database.
 */

/** Test seam: how the panel reaches a database container. */
export const tunnelDeps = {
  resolveAddress: containerIp,
  connect: (host: string, port: number): net.Socket => net.connect({ host, port }),
  openNode: openNodeTunnel as (
    db: Parameters<typeof openNodeTunnel>[0],
    serverId: number,
    target: { container: string; port: number; kind: 'database' },
  ) => Promise<Duplex>,
};

export const databaseTunnelRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:id/tunnel', { websocket: true }, async (socket, req) => {
    const refuse = (reason: string) => socket.close(1008, reason);
    // Before any await: what the client sends meanwhile must reach the target.
    const takeEarly = holdEarlyMessages(socket);
    const token = websocketBearerToken(req.headers);
    const user = token ? await resolveUser(app.db, token) : null;
    if (!user || !authorizeWebsocketUser(user, req.url) || !tokenMayWrite(user.tokenScopes, 'databases')) return refuse('unauthorized');
    const id = Number((req.params as { id: string }).id);
    if (!Number.isSafeInteger(id) || id <= 0) return refuse('not found');
    // The reply is hijacked on a websocket route: a thrown error cannot become
    // an HTTP answer, so every refusal closes the socket instead.
    let d: Awaited<ReturnType<typeof loadDatabaseForUser>>;
    try {
      d = await loadDatabaseForUser(app.db, id, user);
      await assertDatabaseRole(app.db, d, user, 'admin');
    } catch {
      return refuse('not found or not allowed');
    }
    // A node database's container is `nodeContainerName`; `containerName` stays null for it.
    const container = d.serverId != null ? d.nodeContainerName : d.containerName;
    if (d.status !== 'running' || !container || !d.internalPort) return refuse('the database is not running');
    const release = reserveTunnel(user.id);
    if (!release) return refuse(`at most ${MAX_TUNNELS_PER_USER} tunnels at once`);
    let target: net.Socket | Duplex;
    if (d.serverId != null) {
      try {
        target = await tunnelDeps.openNode(app.db, d.serverId, { container, port: d.internalPort, kind: 'database' });
      } catch (err) {
        release();
        return refuse((err instanceof Error ? err.message : String(err)).slice(0, 120));
      }
    } else {
      const host = await tunnelDeps.resolveAddress(container);
      if (!host) {
        release();
        return refuse('the database container has no address');
      }
      target = tunnelDeps.connect(host, d.internalPort);
    }
    // The client may have left while the target was opened: keep nothing for it.
    const early = takeEarly();
    if (socket.readyState !== socket.OPEN || early.refused) {
      target.destroy();
      release();
      return early.refused ? refuse(early.refused) : undefined;
    }
    void audit(app.db, user.id, 'database.tunnel.open', d.name, { databaseId: d.id, engine: d.engine, serverId: d.serverId ?? null }, { ip: req.ip, userAgent: req.headers['user-agent'] });
    bridgeTunnel({
      socket,
      tcp: target,
      early: early.chunks,
      release,
      label: 'database',
      stillAllowed: async () => {
        const fresh = await resolveUser(app.db, token!);
        if (!fresh || !authorizeWebsocketUser(fresh, req.url) || !tokenMayWrite(fresh.tokenScopes, 'databases')) return false;
        try {
          await assertDatabaseRole(app.db, await loadDatabaseForUser(app.db, id, fresh), fresh, 'admin');
          return true;
        } catch {
          return false;
        }
      },
      onClose: (s) => void audit(app.db, user.id, 'database.tunnel.close', d.name, { databaseId: d.id, ...s }),
    });
  });
};
