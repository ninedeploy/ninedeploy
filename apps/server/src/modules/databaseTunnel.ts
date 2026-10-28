import net from 'node:net';
import type { FastifyPluginAsync } from 'fastify';
import { audit } from '../lib/audit.js';
import { resolveUser } from '../lib/auth.js';
import { assertDatabaseRole, loadDatabaseForUser } from '../lib/resourceAccess.js';
import { websocketBearerToken } from '../lib/websocketAuth.js';
import { authorizeWebsocketUser } from '../plugins/auth.js';
import { containerIp } from '../engine/builders/docker.js';

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
 *
 * Binary frames are the stream in both directions; a text frame is never
 * sent. Close codes: 1008 refused, 1011 the database connection failed,
 * 1000 either side ended.
 */

/** Open tunnels per user: a client opens one per local connection. */
export const MAX_TUNNELS_PER_USER = 32;
/** A tunnel with no traffic in either direction for this long is closed. */
export const TUNNEL_IDLE_MS = 30 * 60_000;
const RECHECK_MS = 60_000;
/** Pause the database side while this much is waiting to reach the client. */
const HIGH_WATER = 4 * 1024 * 1024;

const open = new Map<number, number>();

/** A scoped API token may open a tunnel only when it may also write. */
function tokenMayWrite(scopes: string[] | null): boolean {
  if (scopes === null) return true;
  return scopes.includes('write') || scopes.includes('operator') || scopes.some((s) => /^nd:\/\/scope\/(write|admin)\/databases$/.test(s));
}

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
    if (!user || !authorizeWebsocketUser(user, req.url) || !tokenMayWrite(user.tokenScopes)) return refuse('unauthorized');
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
    if ((open.get(user.id) ?? 0) >= MAX_TUNNELS_PER_USER) return refuse(`at most ${MAX_TUNNELS_PER_USER} tunnels at once`);
    // Reserve the slot before the next await, so parallel opens cannot all pass the check.
    open.set(user.id, (open.get(user.id) ?? 0) + 1);
    const release = () => open.set(user.id, Math.max(0, (open.get(user.id) ?? 1) - 1));
    const host = await tunnelDeps.resolveAddress(d.containerName);
    if (!host) {
      release();
      return refuse('the database container has no address');
    }
    // The client may have left while the address was resolved: open nothing for it.
    if (socket.readyState !== socket.OPEN) return release();
    const started = Date.now();
    let bytesIn = 0;
    let bytesOut = 0;
    let lastActivity = Date.now();
    let closed = false;
    const tcp = tunnelDeps.connect(host, d.internalPort);
    tcp.setNoDelay(true);

    const finish = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      release();
      tcp.destroy();
      try {
        socket.close(code, reason);
      } catch {
        /* already closed */
      }
      void audit(app.db, user.id, 'database.tunnel.close', d.name, {
        databaseId: d.id,
        seconds: Math.round((Date.now() - started) / 1000),
        bytesIn,
        bytesOut,
        reason,
      });
    };

    void audit(app.db, user.id, 'database.tunnel.open', d.name, { databaseId: d.id, engine: d.engine }, { ip: req.ip, userAgent: req.headers['user-agent'] });

    tcp.on('data', (chunk: Buffer) => {
      bytesOut += chunk.length;
      lastActivity = Date.now();
      socket.send(chunk, { binary: true });
      if (socket.bufferedAmount > HIGH_WATER) tcp.pause();
    });
    tcp.on('error', () => finish(1011, 'database connection failed'));
    tcp.on('close', () => finish(1000, 'database closed the connection'));

    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (!isBinary) return finish(1008, 'binary frames only');
      const chunk = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      bytesIn += chunk.length;
      lastActivity = Date.now();
      if (!tcp.write(chunk)) {
        socket.pause();
        tcp.once('drain', () => socket.resume());
      }
    });
    socket.on('close', () => finish(1000, 'client closed the tunnel'));
    socket.on('error', () => finish(1011, 'tunnel error'));

    // Re-check access, resume a paused database side, and close idle tunnels.
    let lastCheck = Date.now();
    const timer = setInterval(() => {
      if (tcp.isPaused() && socket.bufferedAmount <= HIGH_WATER / 2) tcp.resume();
      if (Date.now() - lastActivity > TUNNEL_IDLE_MS) return finish(1000, 'idle');
      if (Date.now() - lastCheck < RECHECK_MS) return;
      lastCheck = Date.now();
      void (async () => {
        const fresh = await resolveUser(app.db, token!);
        if (!fresh || !authorizeWebsocketUser(fresh, req.url) || !tokenMayWrite(fresh.tokenScopes)) return finish(1008, 'access revoked');
        try {
          await assertDatabaseRole(app.db, await loadDatabaseForUser(app.db, id, fresh), fresh, 'admin');
        } catch {
          finish(1008, 'access revoked');
        }
      })().catch(() => finish(1011, 'access check failed'));
    }, 250);
    timer.unref();
  });
};
