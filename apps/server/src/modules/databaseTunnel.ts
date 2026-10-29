import net from 'node:net';
import type { FastifyPluginAsync } from 'fastify';
import { audit } from '../lib/audit.js';
import { resolveUser } from '../lib/auth.js';
import { assertDatabaseRole, loadDatabaseForUser } from '../lib/resourceAccess.js';
import { MAX_TUNNELS_PER_USER, bridgeTunnel, reserveTunnel, tokenMayWrite } from '../lib/tunnelBridge.js';
import { websocketBearerToken } from '../lib/websocketAuth.js';
import { authorizeWebsocketUser } from '../plugins/auth.js';
import { containerIp } from '../engine/builders/docker.js';

export { MAX_TUNNELS_PER_USER, TUNNEL_IDLE_MS } from '../lib/tunnelBridge.js';

/**
 * G5.8 database tunnels: `GET /v1/databases/:id/tunnel` (WebSocket) carries
 * one TCP connection to a panel-host database, byte for byte, so
 * `ninedeploy tunnel db <id>` can offer it on a local port while the database
 * port stays closed to the internet.
 *
 * Who: the database's `admin` role or higher, the same as revealing its
 * credentials; a scope-restricted API token must also be allowed to write.
 * The database's own login still applies on top. Access is re-checked every
 * minute: a revoked grant or token closes the tunnel. Each tunnel is audited.
 * The bridge itself is lib/tunnelBridge.ts, shared with service tunnels.
 */

/** Test seam: how the panel reaches a database container. */
export const tunnelDeps = {
  resolveAddress: containerIp,
  connect: (host: string, port: number): net.Socket => net.connect({ host, port }),
};

export const databaseTunnelRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:id/tunnel', { websocket: true }, async (socket, req) => {
    const refuse = (reason: string) => socket.close(1008, reason);
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
    if (d.serverId != null) return refuse('the database runs on a node; tunnels reach panel-host databases only for now');
    if (d.status !== 'running' || !d.containerName || !d.internalPort) return refuse('the database is not running');
    const release = reserveTunnel(user.id);
    if (!release) return refuse(`at most ${MAX_TUNNELS_PER_USER} tunnels at once`);
    const host = await tunnelDeps.resolveAddress(d.containerName);
    if (!host) {
      release();
      return refuse('the database container has no address');
    }
    // The client may have left while the address was resolved: open nothing for it.
    if (socket.readyState !== socket.OPEN) return release();
    void audit(app.db, user.id, 'database.tunnel.open', d.name, { databaseId: d.id, engine: d.engine }, { ip: req.ip, userAgent: req.headers['user-agent'] });
    bridgeTunnel({
      socket,
      tcp: tunnelDeps.connect(host, d.internalPort),
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
