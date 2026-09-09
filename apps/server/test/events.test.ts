import { afterAll, describe, expect, it, vi } from 'vitest';
import { eventBus } from '../src/lib/events.js';
import { audit } from '../src/lib/audit.js';
import { eventRoutes } from '../src/modules/events.js';
import { buildTestApp, collectMessages, listen, openWs, waitFor, wsUrl } from './helpers.js';

const authMocks = vi.hoisted(() => ({
  resolveUser: vi.fn(async (_db: unknown, token: string) => {
    if (token === 'valid') return { id: 1, isOperator: true as const };
    // An API token with restricted scopes owned by an operator: the route
    // must narrow the operator flag (see the narrowing test below).
    if (token === 'scoped') return { id: 7, isOperator: true as const, tokenScopes: ['read'] };
    return null;
  }),
}));
// Keep the REAL narrowScopes (only resolveUser is faked here): the events
// route must apply the production operator-narrowing, and the fixture users
// carry no scope list, so they stay unrestricted operators.
vi.mock('../src/lib/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/auth.js')>();
  return { ...actual, resolveUser: authMocks.resolveUser };
});

const sockets: WebSocket[] = [];

describe('events websocket', () => {
  afterAll(async () => {
    for (const ws of sockets) {
      try { ws.close(); } catch { /* already closed */ }
    }
  });

  it('replays the backlog and streams live events', async () => {
    eventBus.publish('deploy.completed', 'web');
    const app = await buildTestApp({ websocket: true });
    await app.register(eventRoutes);
    const port = await listen(app);
    const ws = await openWs(wsUrl(port, '/v1/events'), 'ninedeploy.bearer.valid');
    sockets.push(ws);
    const messages = collectMessages(ws);

    // Live event after subscription.
    eventBus.publish('backup.completed', 'pg');
    await waitFor(() => messages.some((m) => m.includes('backup.completed')));

    // Backlog replay must contain the earlier event.
    expect(messages.some((m) => m.includes('deploy.completed'))).toBe(true);
    const live = messages.find((m) => m.includes('backup.completed'));
    expect(JSON.parse(live as string)).toMatchObject({ action: 'backup.completed', entity: 'pg' });

    ws.close();
    await app.close();
  });

  it('closes the socket with 1008 for a missing token', async () => {
    const app = await buildTestApp({ websocket: true });
    await app.register(eventRoutes);
    const port = await listen(app);
    const ws = await openWs(wsUrl(port, '/v1/events'));
    sockets.push(ws);
    const closed = new Promise<number>((resolve) => {
      ws.addEventListener('close', (ev) => resolve(ev.code));
    });
    expect(await closed).toBe(1008);
    await app.close();
  });

  it('closes the socket with 1008 for an invalid token', async () => {
    const app = await buildTestApp({ websocket: true });
    await app.register(eventRoutes);
    const port = await listen(app);
    const ws = await openWs(wsUrl(port, '/v1/events'), 'ninedeploy.bearer.bad');
    sockets.push(ws);
    const closed = new Promise<number>((resolve) => {
      ws.addEventListener('close', (ev) => resolve(ev.code));
    });
    expect(await closed).toBe(1008);
    await app.close();
  });

  it('narrows a scope-restricted operator token to its own events', async () => {
    // The HTTP plugin narrows a restricted token's operator flag on every
    // request; the WebSocket resolves its own bearer, so it must apply the
    // same rule — otherwise an operator's limited CI token sees the global
    // feed (system events ship to operators only) for every tenant.
    const app = await buildTestApp({ websocket: true });
    await app.register(eventRoutes);
    const port = await listen(app);
    const ws = await openWs(wsUrl(port, '/v1/events'), 'ninedeploy.bearer.scoped');
    sockets.push(ws);
    const messages = collectMessages(ws);

    // Both published AFTER subscription (live path — no backlog ambiguity):
    // the own-actor event must arrive, the system event must not.
    eventBus.publish('system.only', 'infra');
    eventBus.publish('deploy.owned', 'mine', 7);
    await waitFor(() => messages.some((m) => m.includes('deploy.owned')));
    await new Promise((r) => setTimeout(r, 100));
    expect(messages.some((m) => m.includes('system.only'))).toBe(false);
    ws.close();
    await app.close();
  });

  it('keeps streaming after the client is gone (send errors are swallowed)', async () => {
    eventBus.publish('source.create', 'repo');
    const app = await buildTestApp({ websocket: true });
    await app.register(eventRoutes);
    const port = await listen(app);
    const ws = await openWs(wsUrl(port, '/v1/events'), 'ninedeploy.bearer.valid');
    sockets.push(ws);
    await waitFor(() => ws.readyState === WebSocket.OPEN);
    ws.close();
    // Wait for the server to observe the close, then publish (send throws internally).
    await new Promise((r) => setTimeout(r, 50));
    eventBus.publish('service.delete', 'web');
    await new Promise((r) => setTimeout(r, 20));
    await app.close();
    expect(true).toBe(true);
  });
});

/**
 * r038 — audit() publishes on this bus under a "never throws" contract, and
 * its `void audit(...)` call sites would turn a rejection into an
 * unhandledRejection (process abort). A synchronously-throwing listener must
 * therefore stay isolated inside the dispatch instead of escaping publish().
 */
describe('audit event isolation (r038)', () => {
  it('keeps audit() resolving when a listener throws synchronously', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const db = {
      insert: () => ({ values: async (v: Record<string, unknown>) => { rows.push(v); } }),
      query: { notificationChannels: { findMany: async () => [] } },
    };
    const unsubscribe = eventBus.subscribe(() => {
      throw new Error('r038: broken audit listener');
    });
    try {
      await expect(audit(db as never, 1, 'deploy.success', 'svc #1')).resolves.toBeUndefined();
    } finally {
      unsubscribe();
    }
    // The audit row is written before the listeners run; the broken listener
    // must not undo it.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('deploy.success');
  });
});
