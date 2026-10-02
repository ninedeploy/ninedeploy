import type { FastifyPluginAsync } from 'fastify';
import { canReceiveEvent, eventBus } from '../lib/events.js';
import { narrowScopes, resolveUser } from '../lib/auth.js';
import { authorizeWebsocketUser } from '../plugins/auth.js';
import { websocketBearerToken } from '../lib/websocketAuth.js';

/** Real-time event stream over WebSocket. Mounted at root level. */
export const eventRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/events', { websocket: true }, async (socket, req) => {
    const token = websocketBearerToken(req.headers);
    const user = token ? await resolveUser(app.db, token) : null;
    if (!user || !token) {
      socket.close(1008, 'unauthorized');
      return;
    }
    // Same narrowing the HTTP auth plugin applies: a scope-restricted API
    // token must not inherit its owner's operator flag here, or it would see
    // the global feed (system events are delivered to operators only) plus
    // every tenant's activity. r419: the fine-grained URI-scope check the
    // log socket already applies (r154) — a `services`-scoped CI token
    // cannot hold a live `/v1/events` stream, matching the HTTP route's
    // fail-closed classification.
    narrowScopes(user);
    if (!authorizeWebsocketUser(user, req.url)) {
      socket.close(1008, 'forbidden');
      return;
    }

    // Replay recent events, then stream live — both filtered to what this
    // subscriber may see. The bus is process-wide and carries every tenant's
    // activity (and, for user.*/auth.* actions, email addresses), so the
    // authorization decision belongs on delivery, not only on connect.
    // `live` is what the delivery filter consults: the revalidation below
    // swaps in the FRESH user so a granted/revoked operator flag applies
    // without a reconnect.
    //
    // ws emits `close` the moment the TCP connection drops, and the handler
    // already awaited a DB roundtrip above — a client that disconnects inside
    // that window fires `close` BEFORE the listeners below are attached, so
    // cleanup would never run. Guard on the socket state before subscribing
    // and inside the interval; WebSocket.OPEN is a constructor static in ws,
    // hence the literal.
    const open = () => socket.readyState === 1;
    if (!open()) return;
    let live = user;
    for (const event of eventBus.backlog()) {
      if (!canReceiveEvent(event, live)) continue;
      try { socket.send(`${JSON.stringify(event)}\n`); } catch { /* closed */ }
    }
    const unsub = eventBus.subscribe((event) => {
      if (!canReceiveEvent(event, live)) return;
      try { socket.send(`${JSON.stringify(event)}\n`); } catch { /* closed */ }
    });
    // r401: an established socket was authenticated ONCE at connect — a
    // bumped tokenVersion (logout-everywhere, password change) or a revoked
    // operator flag kept streaming the feed until the client closed it.
    // Re-resolve the token every minute; a dead session closes the socket.
    const revalidate = setInterval(async () => {
      if (!open()) { cleanup(); return; }
      const fresh = await resolveUser(app.db, token).catch(() => null);
      if (!fresh || !authorizeWebsocketUser(fresh, req.url)) {
        socket.close(1008, 'session revoked');
        cleanup();
        return;
      }
      narrowScopes(fresh);
      live = fresh;
    }, 60_000);
    const cleanup = () => {
      clearInterval(revalidate);
      unsub();
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });
};
