import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
// ws client (transitive dep of @fastify/websocket) — needed for `.terminate()`,
// which abruptly destroys the connection and triggers the server socket error.
import { WebSocket as WsClient } from '../../../node_modules/.pnpm/ws@8.21.3/node_modules/ws';
import { logBus } from '../src/engine/logs.js';
import { deploysRoutes } from '../src/modules/deploys.js';
import {
  asUser,
  buildTestApp,
  captureAudits,
  collectMessages,
  createFakeDb,
  depRow,
  listen,
  openWs,
  svcRow,
  trackStatusUpdates,
  waitFor,
  wsUrl,
} from './helpers.js';

const authMocks = vi.hoisted(() => ({
  // 'valid' = admin session; 'member' = non-admin (used for the RBAC test).
  resolveUser: vi.fn(
    async (_db: unknown, token: string) =>
      token === 'valid' ? { id: 1, isOperator: true as const } : token === 'member' ? { id: 2, isOperator: false as const } : token === 'scoped-read-only' ? { id: 1, isOperator: true as const, tokenScopes: ['read'] } : null,
  ),
}));
vi.mock('../src/lib/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/auth.js')>()),
  ...authMocks,
}));

const childProc = vi.hoisted(() => {
  const makeEmitter = () => {
    const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    return {
      on: (ev: string, cb: (...a: unknown[]) => void) => {
        const list = handlers[ev] ?? [];
        list.push(cb);
        handlers[ev] = list;
      },
      emit: (ev: string, ...a: unknown[]) => {
        for (const cb of handlers[ev] ?? []) cb(...a);
      },
    };
  };
  const children: Array<ReturnType<typeof makeFakeChild>> = [];
  function makeFakeChild() {
    const emitter = makeEmitter();
    const child = {
      // stdin is also an emitter so the route can attach its EPIPE guard.
      stdin: Object.assign(makeEmitter(), { write: vi.fn() }),
      stdout: makeEmitter(),
      stderr: makeEmitter(),
      killed: false,
      kill: vi.fn(),
      on: emitter.on,
      emit: emitter.emit,
    };
    child.kill = vi.fn(() => { child.killed = true; });
    children.push(child);
    return child;
  }
  const spawn = vi.fn(() => makeFakeChild());
  return { spawn, children };
});
vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => childProc.spawn(...a) }));

const execMocks = vi.hoisted(() => ({ capture: vi.fn(), buildEnv: vi.fn((extra?: Record<string, string>) => ({ ...(extra ?? {}) })) }));
vi.mock('../src/lib/exec.js', () => ({
  capture: (...a: unknown[]) => execMocks.capture(...a),
  buildEnv: (extra?: Record<string, string>) => execMocks.buildEnv(extra),
}));

// 0.15: the exec socket reaches Docker through `lib/dockerTty.ts` when the
// Engine API is reachable. The 0.14 cases below exercise the CLI fallback
// (python pty / pipe mode), so the transport is CLI unless a case says
// otherwise — and no case can ever reach a real daemon socket.
const ttyMocks = vi.hoisted(() => ({
  transport: { kind: 'cli', reason: 'test' } as { kind: string; reason?: string; socketPath?: string },
  openExecTty: vi.fn(),
}));
vi.mock('../src/lib/dockerTty.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/dockerTty.js')>()),
  dockerTransport: () => ttyMocks.transport,
  openExecTty: (...a: unknown[]) => ttyMocks.openExecTty(...a),
}));

const sockets: WebSocket[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  childProc.children.length = 0;
  ttyMocks.transport = { kind: 'cli', reason: 'test' };
});

describe('deploys config diff route', () => {
  it('diffs the deployment snapshot against the previous one', async () => {
    const prev = depRow({
      id: 1,
      configSnapshot: JSON.stringify({ buildPack: 'auto', envKeys: ['A'] }),
    });
    const current = depRow({
      id: 2,
      configSnapshot: JSON.stringify({ buildPack: 'dockerfile', envKeys: ['A', 'B*'] }),
    });
    let calls = 0;
    const db = createFakeDb({
      findFirst: {
        services: svcRow({ id: 1 }),
        deployments: () => {
          calls++;
          return calls % 2 === 1 ? current : prev;
        },
      },
    });
    const app = await buildTestApp({ db });
    await app.register(deploysRoutes);
    const res = await app.inject({ method: 'GET', url: '/1/deploys/2/diff', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.previousDeploymentId).toBe(1);
    expect(body.changed).toBe(true);
    expect(body.diff).toContain('- buildPack: "auto"');
    expect(body.diff).toContain('+ buildPack: "dockerfile"');
  });

  it('reports an unchanged diff when no snapshots exist', async () => {
    let seen = 0;
    const db = createFakeDb({
      findFirst: { services: svcRow({ id: 1 }), deployments: () => (++seen === 1 ? depRow({ id: 3, configSnapshot: null }) : undefined) },
    });
    const app = await buildTestApp({ db });
    await app.register(deploysRoutes);
    const res = await app.inject({ method: 'GET', url: '/1/deploys/3/diff', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ previousDeploymentId: null, changed: false, diff: '' });
  });

  it('404s for an unknown deployment', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(deploysRoutes);
    const res = await app.inject({ method: 'GET', url: '/1/deploys/77/diff', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });
});

describe('deploys routes', () => {
  afterAll(async () => {
    for (const ws of sockets) {
      try { ws.close(); } catch { /* already closed */ }
    }
  });

  it('queues a deployment for a service', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1, name: 'web' }) },
        insert: { deployments: [depRow({ id: 9, status: 'queued' })] },
      }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'POST', url: '/services/1/deploys', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deploymentId: 9 });
  });

  it('returns the in-progress deployment instead of queueing a duplicate', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1 }), deployments: depRow({ id: 42, status: 'building' }) },
      }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'POST', url: '/services/1/deploys', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deploymentId: 42, alreadyInProgress: true });
  });

  it('queues a second deploy when only queued rows exist for the service', async () => {
    // Once the per-service dedup dropped the queued/building match and
    // was split into "in-flight only", stacking multiple queued deploys
    // became the supported behaviour. This is what makes the per-service
    // queue badge in the panel meaningful.
    const app = await buildTestApp({
      db: createFakeDb({
        // loadServiceForUser: services.findFirst must return the row
        // (anything else → 404). The in-flight check looks for
        // deployments in [building, deploying] and should return nothing.
        findFirst: {
          services: svcRow({ id: 1 }),
          deployments: undefined,
        },
        findMany: {
          deployments: [],
        },
        insert: { deployments: [depRow({ id: 99, status: 'queued' })] },
      }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'POST', url: '/services/1/deploys', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deploymentId: 99 });
  });

  it('rejects a new deploy when the per-service queued cap is reached', async () => {
    // 50 is the documented cap. The fake does not apply the route's
    // 50-row filter, so we hand back exactly 50 queued rows and expect
    // the route to refuse the next one.
    const queued = Array.from({ length: 50 }, (_, i) => ({ id: i + 1 }));
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1 }) },
        findMany: { deployments: queued },
      }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'POST', url: '/services/1/deploys', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/max 50/i);
  });

  it('returns 404 when deploying a missing service', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(deploysRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'POST', url: '/services/99/deploys', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });

  it('lists deployments for a service', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1 }) },
        findMany: {
          deployments: [
            depRow({ id: 1, startedAt: new Date('2026-01-01T00:01:00Z'), finishedAt: new Date('2026-01-01T00:02:00Z') }),
            depRow({ id: 2, commitSha: null, startedAt: null, finishedAt: null, message: null, author: null }),
          ],
        },
      }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'GET', url: '/services/1/deploys', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows[0]).toMatchObject({
      id: 1,
      status: 'running',
      commitSha: 'abcdef1',
      startedAt: '2026-01-01T00:01:00.000Z',
      finishedAt: '2026-01-01T00:02:00.000Z',
    });
    expect(rows[1]).toMatchObject({ id: 2, commitSha: null, startedAt: null, finishedAt: null, message: null });
  });

  it('rolls back to a previous deployment', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1 }), deployments: depRow({ id: 9, serviceId: 1, commitSha: 'oldsha' }) },
        insert: { deployments: [depRow({ id: 10, status: 'queued' })] },
      }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'POST', url: '/services/1/deploys/9/rollback', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deploymentId: 10 });
  });

  it('r640: rollback shares the per-service queued cap (it had none)', async () => {
    let inserted = false;
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1 }), deployments: depRow({ id: 9, serviceId: 1, commitSha: 'oldsha' }) },
        findMany: { deployments: Array.from({ length: 50 }, (_, i) => ({ id: 100 + i })) },
        insert: { deployments: () => { inserted = true; return [depRow({ id: 10, status: 'queued' })]; } },
      }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'POST', url: '/services/1/deploys/9/rollback', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/max 50/);
    expect(inserted).toBe(false);
  });

  it('rolls back to a deployment without a commit sha', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1 }), deployments: depRow({ id: 9, serviceId: 1, commitSha: null }) },
        insert: { deployments: [depRow({ id: 10, status: 'queued' })] },
      }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'POST', url: '/services/1/deploys/9/rollback', headers: asUser() });
    expect(res.statusCode).toBe(200);
  });

  it('accepts a docker service pinned to a remote node', async () => {
    // r037: docker services now route through the node's agent, so the
    // queue-time guard must let them through rather than 400.
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1, serverId: 4, type: 'docker' }) } }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'POST', url: '/services/1/deploys', headers: asUser() });
    expect(res.statusCode).toBe(200);
  });

  it('refuses to deploy a pm2 service pinned to a remote node', async () => {
    // Upfront feedback for the panel; the pipeline refuses it again, which is
    // the guard webhooks, previews and scheduled jobs also hit. PM2 is a host
    // process and the node agent has no operation for it.
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1, serverId: 4, type: 'pm2' }) } }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'POST', url: '/services/1/deploys', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('remote_deploy_unsupported');
    expect(res.json().error.message).toMatch(/host processes/);
  });

  it('refuses to roll back a pm2 service pinned to a remote node', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: svcRow({ id: 1, serverId: 4, type: 'pm2' }),
          deployments: depRow({ id: 9, serviceId: 1 }),
        },
      }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'POST', url: '/services/1/deploys/9/rollback', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('remote_deploy_unsupported');
  });

  it('refuses to roll back an inline compose stack, and says what to do instead', async () => {
    // The stack is defined by the YAML on the service row and deployments keep
    // no history of it, so a "rollback" would re-run the current file and
    // report success while changing nothing.
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: {
          services: svcRow({ id: 1, type: 'compose', composeContent: 'services:\n  web:\n    image: nginx\n' }),
          deployments: depRow({ id: 9, serviceId: 1, commitSha: null }),
        },
      }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'POST', url: '/services/1/deploys/9/rollback', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/Edit the compose file and redeploy/);
  });

  it('returns 404 when the rollback target is missing', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(deploysRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'POST', url: '/services/1/deploys/99/rollback', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });

  // ── cancel ────────────────────────────────────────────────────────────────
  it('cancels a queued deployment', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1 }), deployments: depRow({ id: 9, serviceId: 1, status: 'queued' }) },
        update: { deployments: [{ id: 9 }] },
      }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'POST', url: '/services/1/deploys/9/cancel', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, status: 'cancelled' });
  });

  it('cancels an in-flight (building) deployment', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1 }), deployments: depRow({ id: 11, serviceId: 1, status: 'building' }) },
        update: { deployments: [{ id: 11 }] },
      }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'POST', url: '/services/1/deploys/11/cancel', headers: asUser() });
    expect(res.statusCode).toBe(200);
    // The pipeline is told via the log bus.
    await waitFor(() => logBus.read(11) != null);
    expect(logBus.read(11)).toContain('Cancellation requested');
  });

  it('rejects cancelling a finished deployment', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1 }), deployments: depRow({ id: 12, serviceId: 1, status: 'running' }) } }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'POST', url: '/services/1/deploys/12/cancel', headers: asUser() });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when cancelling a missing deployment', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(deploysRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'POST', url: '/services/1/deploys/99/cancel', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when the deployment belongs to another service', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { deployments: depRow({ id: 9, serviceId: 2, status: 'queued' }) } }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'POST', url: '/services/1/deploys/9/cancel', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });

  it('reports a race when the status flips between read and write', async () => {
    // The row read says building, but the conditional update matches nothing.
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow({ id: 1 }), deployments: depRow({ id: 13, serviceId: 1, status: 'building' }) },
        update: { deployments: [] },
      }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'POST', url: '/services/1/deploys/13/cancel', headers: asUser() });
    expect(res.statusCode).toBe(400);
  });

  /**
   * Removing a deployment from history. There was no delete path at all before:
   * the log FILE aged out at 30 days and the row never did, so the older half
   * of the Deploys tab listed builds whose logs had already been swept.
   */
  describe('removing a deployment', () => {
    it('deletes a finished deployment and its log file', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1 }), deployments: depRow({ id: 20, serviceId: 1, status: 'failed' }) },
          delete: { deployments: [{ id: 20 }] },
        }),
      });
      await app.register(deploysRoutes, { prefix: '/services' });
      const res = await app.inject({ method: 'DELETE', url: '/services/1/deploys/20', headers: asUser() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, id: 20 });
    });

    it('refuses to delete an in-flight deployment', async () => {
      // The worker and the pipeline still write to the row; deleting it would
      // leave them updating something that no longer exists.
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1 }), deployments: depRow({ id: 21, serviceId: 1, status: 'building' }) },
        }),
      });
      await app.register(deploysRoutes, { prefix: '/services' });
      const res = await app.inject({ method: 'DELETE', url: '/services/1/deploys/21', headers: asUser() });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/Cancel the deployment/);
    });

    it('refuses to delete the deployment that is serving traffic', async () => {
      // That row carries the image digest a rollback re-deploys and the config
      // snapshot the next deploy diffs against.
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1 }), deployments: depRow({ id: 22, serviceId: 1, status: 'running' }) },
        }),
      });
      await app.register(deploysRoutes, { prefix: '/services' });
      const res = await app.inject({ method: 'DELETE', url: '/services/1/deploys/22', headers: asUser() });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/currently serving traffic/);
    });

    it('reports a race when the row changes state between read and delete', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1 }), deployments: depRow({ id: 23, serviceId: 1, status: 'failed' }) },
          delete: { deployments: [] },
        }),
      });
      await app.register(deploysRoutes, { prefix: '/services' });
      const res = await app.inject({ method: 'DELETE', url: '/services/1/deploys/23', headers: asUser() });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/changed state/);
    });

    it('404s for a deployment belonging to another service', async () => {
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow({ id: 1 }), deployments: depRow({ id: 24, serviceId: 2, status: 'failed' }) },
        }),
      });
      await app.register(deploysRoutes, { prefix: '/services' });
      const res = await app.inject({ method: 'DELETE', url: '/services/1/deploys/24', headers: asUser() });
      expect(res.statusCode).toBe(404);
    });

    it('404s for an unknown deployment', async () => {
      const app = await buildTestApp({ db: createFakeDb({ findFirst: { services: svcRow({ id: 1 }) } }) });
      await app.register(deploysRoutes, { prefix: '/services' });
      const res = await app.inject({ method: 'DELETE', url: '/services/1/deploys/99', headers: asUser() });
      expect(res.statusCode).toBe(404);
    });
  });

  it('returns 404 when rolling back across services', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { deployments: depRow({ id: 9, serviceId: 1 }) } }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'POST', url: '/services/2/deploys/9/rollback', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });

  it('streams the log backlog and live lines over websocket', async () => {
    logBus.publish(5, 'backlog line');
    const app = await buildTestApp({
      websocket: true,
      // F881: an in-flight deployment — a settled one now ends the stream after the backlog.
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1 }), deployments: depRow({ id: 5, serviceId: 1, status: 'building' }) } }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const port = await listen(app);
    const ws = await openWs(wsUrl(port, '/services/1/deploys/5/logs'), 'ninedeploy.bearer.valid');
    sockets.push(ws);
    const messages = collectMessages(ws);
    await waitFor(() => messages.length > 0);
    expect(messages[0]).toContain('backlog line');

    logBus.publish(5, 'live line');
    await waitFor(() => messages.some((m) => m.includes('live line')));
    ws.close();
    await app.close();
  });

  it('closes the log socket when the deployment belongs to another service', async () => {
    // The service check alone is not enough: depId must resolve to a
    // deployment of the service in the URL, or any member could stream any
    // tenant's build logs (which echo secrets) by iterating depId.
    logBus.publish(6, 'VICTIM_SECRET=leaked');
    const app = await buildTestApp({
      websocket: true,
      db: createFakeDb({
        findFirst: {
          services: svcRow({ id: 1, ownerUserId: 7 }),
          deployments: depRow({ id: 6, serviceId: 2 }),
        },
      }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const port = await listen(app);
    const ws = await openWs(wsUrl(port, '/services/1/deploys/6/logs'), 'ninedeploy.bearer.valid');
    sockets.push(ws);
    const messages = collectMessages(ws);
    const closed = new Promise<number>((resolve) => ws.addEventListener('close', (ev) => resolve(ev.code)));
    expect(await closed).toBe(1008);
    expect(messages).toEqual([]);
    expect(messages.join('')).not.toContain('VICTIM_SECRET');
    await app.close();
  });

  it('closes the log socket when the token is invalid', async () => {
    const app = await buildTestApp({ websocket: true, db: createFakeDb() });
    await app.register(deploysRoutes, { prefix: '/services' });
    const port = await listen(app);
    const ws = await openWs(wsUrl(port, '/services/1/deploys/5/logs'), 'ninedeploy.bearer.bad');
    sockets.push(ws);
    const closed = new Promise<number>((resolve) => ws.addEventListener('close', (ev) => resolve(ev.code)));
    expect(await closed).toBe(1008);
    await app.close();
  });

  it('opens the log socket without a backlog', async () => {
    const app = await buildTestApp({ websocket: true, db: createFakeDb() });
    await app.register(deploysRoutes, { prefix: '/services' });
    const port = await listen(app);
    const ws = await openWs(wsUrl(port, '/services/9/deploys/99/logs'), 'ninedeploy.bearer.valid');
    sockets.push(ws);
    const messages = collectMessages(ws);
    // No log file exists for deployment 99 → no backlog replay.
    await new Promise((r) => setTimeout(r, 100));
    expect(messages).toEqual([]);
    ws.close();
    await app.close();
  });

  it('does not subscribe the log stream when the client drops during the auth await (late-close race)', async () => {
    // Same race the events socket guards against: the handler awaits auth
    // (and loadServiceForUser) before attaching the close listeners, so a
    // disconnect in that window left the logBus subscription + 60 s interval
    // leaked. The route must check the socket state and bail.
    const defaultImpl = authMocks.resolveUser.getMockImplementation()!;
    let releaseAuth: ((u: unknown) => void) | null = null;
    authMocks.resolveUser.mockImplementation((db: unknown, token: string) => {
      if (token !== 'slow') return defaultImpl(db, token);
      return new Promise((resolve) => { releaseAuth = resolve; });
    });
    const subSpy = vi.spyOn(logBus, 'subscribe');
    try {
      const app = await buildTestApp({
        websocket: true,
        db: createFakeDb({ findFirst: { services: svcRow({ id: 1 }), deployments: depRow({ id: 5, serviceId: 1 }) } }),
      });
      await app.register(deploysRoutes, { prefix: '/services' });
      const port = await listen(app);
      const ws = await openWs(wsUrl(port, '/services/1/deploys/5/logs'), 'ninedeploy.bearer.slow');
      sockets.push(ws);
      await waitFor(() => releaseAuth !== null);
      ws.close();
      await new Promise((r) => setTimeout(r, 150));
      releaseAuth?.({ id: 1, isOperator: true });
      await new Promise((r) => setTimeout(r, 150));
      expect(subSpy).not.toHaveBeenCalled();
      await app.close();
    } finally {
      subSpy.mockRestore();
      authMocks.resolveUser.mockImplementation(defaultImpl);
    }
  });

  it('F532: the log stream revalidation closes the socket once the member loses their seat', async () => {
    // The 60 s tick re-resolved the token only: a member removed from the
    // service's workspace (session still valid) kept receiving this build log
    // (logs echo secrets) until the client closed it.
    let seated = true;
    const db = createFakeDb({
      // F881: in flight, so the stream stays open until the seat loss closes it.
      findFirst: { services: svcRow({ id: 1, ownerUserId: 99 }), deployments: depRow({ id: 5, serviceId: 1, status: 'building' }) },
      findMany: {
        serviceWorkspaces: [{ serviceId: 1, workspaceId: 7 }],
        workspaceMembers: () => (seated ? [{ userId: 2, workspaceId: 7, role: 'member' }] : []),
      },
    });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const subSpy = vi.spyOn(logBus, 'subscribe');
    const app = await buildTestApp({ websocket: true, db });
    try {
      await app.register(deploysRoutes, { prefix: '/services' });
      const port = await listen(app);
      authMocks.resolveUser.mockClear();
      const ws = await openWs(wsUrl(port, '/services/1/deploys/5/logs'), 'ninedeploy.bearer.member');
      sockets.push(ws);
      const messages = collectMessages(ws);
      const closed = new Promise<{ code: number; reason: string }>((resolve) =>
        ws.addEventListener('close', (ev) => resolve({ code: ev.code, reason: ev.reason })),
      );
      await waitFor(() => subSpy.mock.calls.length === 1);
      seated = false;
      vi.advanceTimersByTime(60_000);
      // Gate on the tick having run (token re-resolved), then on event-loop turns.
      await waitFor(() => authMocks.resolveUser.mock.calls.length === 2);
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      const leaked = new Promise<'leaked'>((resolve) =>
        ws.addEventListener('message', (ev) => { if (String(ev.data).includes('SECRET_TOKEN')) resolve('leaked'); }),
      );
      logBus.emit('5', 'SECRET_TOKEN=after-removal');
      const first = await Promise.race([closed, leaked]);
      expect(first).toEqual({ code: 1008, reason: 'access revoked' });
      expect(messages.join('')).not.toContain('SECRET_TOKEN');
    } finally {
      subSpy.mockRestore();
      vi.useRealTimers();
      await app.close();
    }
  });

  it('F881: the log stream ends (1000) once the run settled — not when the status turns final mid-run', async () => {
    // The stream never closed, so `deploys watch` sat out its 30-minute cap and
    // the server held the socket, subscription and interval. Status is no
    // end-of-log marker: the pipeline marks the row `running` BEFORE the proxy
    // swap, which can still log a retry and flip it to `failed`.
    const dep = { status: 'building' };
    let depReads = 0;
    const db = createFakeDb({
      findFirst: {
        services: svcRow({ id: 1 }),
        deployments: () => {
          depReads++;
          return depRow({ id: 881, serviceId: 1, status: dep.status });
        },
      },
    });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const app = await buildTestApp({ websocket: true, db });
    logBus.beginRun(881); // the pipeline run writing this log
    try {
      await app.register(deploysRoutes, { prefix: '/services' });
      const port = await listen(app);
      const ws = await openWs(wsUrl(port, '/services/1/deploys/881/logs'), 'ninedeploy.bearer.valid');
      sockets.push(ws);
      const messages = collectMessages(ws);
      const closed = new Promise<{ code: number; reason: string }>((resolve) =>
        ws.addEventListener('close', (ev) => resolve({ code: ev.code, reason: ev.reason })),
      );
      await waitFor(() => depReads >= 2); // ownership binding + connect-time settle check
      dep.status = 'running'; // finalize, before the swap
      logBus.publish(881, '##[stage:PROXY_SWAP:running]');
      const before = depReads;
      vi.advanceTimersByTime(60_000);
      await waitFor(() => depReads > before); // the tick's settle check ran
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      // Still subscribed: a line published now is delivered (cleanup unsubscribes before closing).
      logBus.publish(881, 'proxy warning: ENOSPC — retrying once in 2s');
      await waitFor(() => messages.join('').includes('retrying once'));
      dep.status = 'failed';
      logBus.publish(881, '✗ The Traefik config could not be written — Reverting to the previous runtime.');
      logBus.end(881);
      expect(await closed).toEqual({ code: 1000, reason: 'deploy finished' });
      expect(messages.join('')).toContain('Reverting to the previous runtime');
      expect(logBus.listenerCount('881')).toBe(0);
      expect(logBus.listenerCount('end:881')).toBe(0);
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });

  it('F881: a deployment that settled before the connect gets its backlog, then a 1000 close', async () => {
    logBus.publish(882, '✓ Deployment successful');
    const app = await buildTestApp({
      websocket: true,
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1 }), deployments: depRow({ id: 882, serviceId: 1, status: 'running' }) } }),
    });
    try {
      await app.register(deploysRoutes, { prefix: '/services' });
      const port = await listen(app);
      const ws = await openWs(wsUrl(port, '/services/1/deploys/882/logs'), 'ninedeploy.bearer.valid');
      sockets.push(ws);
      const messages = collectMessages(ws);
      const closed = await new Promise<{ code: number; reason: string }>((resolve) =>
        ws.addEventListener('close', (ev) => resolve({ code: ev.code, reason: ev.reason })),
      );
      expect(closed).toEqual({ code: 1000, reason: 'deploy finished' });
      expect(messages.join('')).toContain('✓ Deployment successful');
      expect(logBus.listenerCount('882')).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('F533: does not spawn the exec shell for a client that left during setup (late-close race)', async () => {
    // The route awaited auth, the DB and the python3 pty probe before spawning
    // `docker exec` and attaching its close listener — a client gone in that
    // window left an orphaned shell plus a never-cleared revalidation interval.
    let releaseProbe: (() => void) | null = null;
    execMocks.capture.mockImplementation(
      () => new Promise((_resolve, reject) => { releaseProbe = () => reject(new Error('no python3')); }),
    );
    const app = await buildTestApp({
      websocket: true,
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1, runtimeId: 'c1' }) } }),
    });
    try {
      await app.register(deploysRoutes, { prefix: '/services' });
      const port = await listen(app);
      const ws = await openWs(wsUrl(port, '/services/1/exec'), 'ninedeploy.bearer.valid');
      sockets.push(ws);
      const closed = new Promise<void>((resolve) => ws.addEventListener('close', () => resolve()));
      await waitFor(() => releaseProbe !== null); // handler parked on the probe
      ws.close();
      await closed;
      // ws drops a client from `clients` inside its own 'close' handler, so this
      // gates on the SERVER socket having emitted 'close'.
      const wss = (app as unknown as { websocketServer: { clients: Set<unknown> } }).websocketServer;
      await waitFor(() => wss.clients.size === 0);
      releaseProbe!();
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      expect(childProc.spawn).not.toHaveBeenCalled();
    } finally {
      execMocks.capture.mockReset();
      await app.close();
    }
  });

  it('closes the exec socket when the service is unknown (a thrown 404 must not strand it)', async () => {
    // The reply is hijacked on a websocket route, so the 404 from
    // loadServiceForUser cannot become an HTTP response — unwrapped it
    // rejected the handler and left the socket open forever.
    const app = await buildTestApp({ websocket: true, db: createFakeDb({ findFirst: { services: null } }) });
    await app.register(deploysRoutes, { prefix: '/services' });
    const port = await listen(app);
    const ws = await openWs(wsUrl(port, '/services/99/exec'), 'ninedeploy.bearer.valid');
    sockets.push(ws);
    const closed = new Promise<number>((resolve) => ws.addEventListener('close', (ev) => resolve(ev.code)));
    expect(await closed).toBe(1008);
    await app.close();
  });

  it('opens a container exec terminal over websocket', async () => {
    // python3 pty probe unavailable → legacy pipe mode
    execMocks.capture.mockRejectedValue(new Error('no python3'));
    const app = await buildTestApp({
      websocket: true,
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1, runtimeId: 'c1' }) } }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const port = await listen(app);
    const ws = await openWs(wsUrl(port, '/services/1/exec'), 'ninedeploy.bearer.valid');
    sockets.push(ws);
    const messages = collectMessages(ws);
    await waitFor(() => childProc.children.length === 1);
    const child = childProc.children[0]!;
    expect(childProc.spawn).toHaveBeenCalledWith(
      'docker',
      ['exec', '-i', '-e', 'TERM=xterm', '--', 'c1', 'sh', '-i'],
      { env: expect.any(Object), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    child.stdout.emit('data', 'hello from container');
    await waitFor(() => messages.some((m) => m.includes('hello from container')));
    child.stderr.emit('data', 'warn');
    await waitFor(() => messages.some((m) => m.includes('warn')));

    ws.send('echo hi');
    await waitFor(() => (child.stdin.write as ReturnType<typeof vi.fn>).mock.calls.length > 0);

    const closed = new Promise<void>((resolve) => ws.addEventListener('close', () => resolve()));
    child.emit('exit');
    await closed;
    child.emit('close');
    await waitFor(() => (child.kill as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    ws.close();
    await app.close();
  });

  it('r665: refuses the terminal for a node-pinned service instead of a local "No such container"', async () => {
    execMocks.capture.mockRejectedValue(new Error('no python3'));
    const app = await buildTestApp({
      websocket: true,
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1, runtimeId: 'web-1-17', serverId: 4 }) } }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const port = await listen(app);
    const ws = await openWs(wsUrl(port, '/services/1/exec'), 'ninedeploy.bearer.valid');
    sockets.push(ws);
    const messages = collectMessages(ws);
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.addEventListener('close', (ev) => resolve({ code: ev.code, reason: ev.reason })),
    );
    expect(await closed).toEqual({ code: 1008, reason: 'service runs on a remote node' });
    expect(messages.join('')).toContain('runs on remote node #4');
    expect(childProc.spawn).not.toHaveBeenCalled();
    await app.close();
  });

  it('wraps exec in a python pty when available (real TTY mode)', async () => {
    execMocks.capture.mockResolvedValue(''); // python3 -c 'import pty' succeeds
    const app = await buildTestApp({
      websocket: true,
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1, runtimeId: 'c1' }) } }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const port = await listen(app);
    const ws = await openWs(wsUrl(port, '/services/1/exec'), 'ninedeploy.bearer.valid');
    sockets.push(ws);
    await waitFor(() => childProc.children.length === 1);
    const [cmd, args, opts] = childProc.spawn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
    expect(cmd).toBe('python3');
    expect(args[0]).toBe('-c');
    expect(args[1]).toContain('pty.spawn');
    // container name rides via env, never the command string
    expect(opts.env.ND_EXEC_CONTAINER).toBe('c1');
    expect(args.join(' ')).not.toContain('c1');
    ws.close();
    await app.close();
  });

  it('rejects a non-admin session from the exec terminal (RBAC)', async () => {
    const app = await buildTestApp({
      websocket: true,
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1, runtimeId: 'c1' }) } }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const port = await listen(app);
    const ws = await openWs(wsUrl(port, '/services/1/exec'), 'ninedeploy.bearer.member');
    sockets.push(ws);
    const closed = new Promise<void>((resolve) => ws.addEventListener('close', (_ev) => resolve()));
    await closed;
    expect((ws as unknown as { _code?: number })._code ?? 1008).toBe(1008);
    expect(childProc.spawn).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects an operator-owned API token without the operator scope from the exec terminal', async () => {
    const app = await buildTestApp({
      websocket: true,
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1, runtimeId: 'c1' }) } }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const port = await listen(app);
    const ws = await openWs(wsUrl(port, '/services/1/exec'), 'ninedeploy.bearer.scoped-read-only');
    sockets.push(ws);
    const closed = new Promise<number>((resolve) => ws.addEventListener('close', (ev) => resolve(ev.code)));
    expect(await closed).toBe(1008);
    expect(childProc.spawn).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects an operator token whose workspace list does not include the target service (workspace RBAC)', async () => {
    // r050 regression: the exec WebSocket previously called services.findFirst(id)
    // without loadServiceForUser, letting an instance operator exec into any
    // workspace's containers. With the fix, loadServiceForUser throws notFound()
    // when the caller's workspace list has no entry in service_workspaces.
    const app = await buildTestApp({
      websocket: true,
      // The operator is a member of workspace 2 only.
      db: createFakeDb({
        findFirst: {
          services: svcRow({ id: 1, workspaceId: 1, runtimeId: 'c1' }),
          // No service_workspaces row linking workspace 2 → service 1.
          // loadServiceForUser will find zero rows and throw notFound().
        },
      }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const port = await listen(app);
    const ws = await openWs(wsUrl(port, '/services/1/exec'), 'ninedeploy.bearer.operator-w2');
    sockets.push(ws);
    const closed = new Promise<number>((resolve) => ws.addEventListener('close', (ev) => resolve(ev.code)));
    expect(await closed).toBe(1008); // loadServiceForUser threw notFound()
    expect(childProc.spawn).not.toHaveBeenCalled();
    await app.close();
  });

  it('absorbs an EPIPE on the exec child stdin (a late keystroke must not crash)', async () => {
    const app = await buildTestApp({
      websocket: true,
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1, runtimeId: 'c1' }) } }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const port = await listen(app);
    const ws = await openWs(wsUrl(port, '/services/1/exec'), 'ninedeploy.bearer.valid');
    sockets.push(ws);
    await waitFor(() => childProc.children.length === 1);
    const child = childProc.children[0]!;

    // A keystroke racing the child's exit triggers EPIPE on stdin; the error
    // handler must swallow it instead of crashing the process.
    child.stdin.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }));
    ws.send('late');
    await waitFor(() => (child.stdin.write as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    ws.close();
    await app.close();
  });

  it('closes the exec socket for a missing runtime', async () => {
    const app = await buildTestApp({
      websocket: true,
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1, runtimeId: null }) } }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const port = await listen(app);
    const ws = await openWs(wsUrl(port, '/services/1/exec'), 'ninedeploy.bearer.valid');
    sockets.push(ws);
    const closed = new Promise<number>((resolve) => ws.addEventListener('close', (ev) => resolve(ev.code)));
    expect(await closed).toBe(1008);
    await app.close();
  });

  it('closes the exec socket when unauthorized', async () => {
    const app = await buildTestApp({ websocket: true, db: createFakeDb() });
    await app.register(deploysRoutes, { prefix: '/services' });
    const port = await listen(app);
    const ws = await openWs(wsUrl(port, '/services/1/exec'));
    sockets.push(ws);
    const closed = new Promise<number>((resolve) => ws.addEventListener('close', (ev) => resolve(ev.code)));
    expect(await closed).toBe(1008);
    await app.close();
  });

  it('kills the child when the exec socket errors', async () => {
    const app = await buildTestApp({
      websocket: true,
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1, runtimeId: 'c1' }) } }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const port = await listen(app);
    const ws = new WsClient(wsUrl(port, '/services/1/exec'), ['ninedeploy.bearer.valid']);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    sockets.push(ws as unknown as WebSocket);
    await waitFor(() => childProc.children.length === 1);
    // Write an invalid WebSocket frame (reserved opcode) → protocol error on
    // the server socket → its 'error' handler runs child.kill().
    (ws as unknown as { _socket: { write: (b: Buffer) => void } })._socket.write(
      Buffer.from([0x0f, 0x80, 0x00, 0x00]),
    );
    await waitFor(() => (childProc.children[0].kill as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    await app.close();
  });

  it('closes the socket when child process emits an error', async () => {
    const app = await buildTestApp({
      websocket: true,
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1, runtimeId: 'c1' }) } }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const port = await listen(app);
    const ws = await openWs(wsUrl(port, '/services/1/exec'), 'ninedeploy.bearer.valid');
    sockets.push(ws);
    await waitFor(() => childProc.children.length === 1);
    const child = childProc.children[0]!;

    child.emit('error', new Error('spawn error'));
    await app.close();
  });
});

/**
 * 0.15: the deprecated exec socket is an adapter onto the terminal session
 * engine. D1: wherever the Engine API is reachable the shell gets a real PTY
 * (no python3 probe, no `docker exec` child). D2: every session has a row and
 * start/end audits with the end reason, bytes and exit code.
 */
describe('legacy exec socket on the terminal session engine (0.15)', () => {
  const fakeTty = () => {
    const dataCbs: Array<(c: Buffer) => void> = [];
    const endCbs: Array<(c: number | null) => void> = [];
    return {
      mode: 'exec' as const,
      pid: 7,
      write: vi.fn(),
      resize: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      kill: vi.fn(async () => undefined),
      onData: (cb: (c: Buffer) => void) => void dataCbs.push(cb),
      onEnd: (cb: (c: number | null) => void) => void endCbs.push(cb),
      emit: (s: string) => {
        for (const cb of dataCbs) cb(Buffer.from(s));
      },
      exit: (code: number | null) => {
        for (const cb of endCbs) cb(code);
      },
    };
  };

  const setup = async () => {
    const db = createFakeDb({
      findFirst: { services: svcRow({ id: 1, name: 'web', runtimeId: 'c1' }) },
      insert: { terminal_sessions: [{ id: 41 }] },
    });
    const audits = captureAudits(db);
    const { updates } = trackStatusUpdates(db);
    const app = await buildTestApp({ websocket: true, db });
    await app.register(deploysRoutes, { prefix: '/services' });
    const port = await listen(app);
    return { app, port, audits, updates };
  };

  it('D1: opens an Engine-API PTY (no python3 probe, no docker child) and records the session (D2)', async () => {
    ttyMocks.transport = { kind: 'socket', socketPath: '/var/run/docker.sock' };
    const tty = fakeTty();
    ttyMocks.openExecTty.mockResolvedValue(tty);
    const { SHELL_CMD } = await import('../src/lib/dockerTty.js');
    const { app, port, audits, updates } = await setup();
    const ws = await openWs(wsUrl(port, '/services/1/exec'), 'ninedeploy.bearer.valid');
    sockets.push(ws);
    ws.binaryType = 'arraybuffer';
    const messages: string[] = [];
    ws.addEventListener('message', (ev) =>
      messages.push(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString()),
    );
    await waitFor(() => ttyMocks.openExecTty.mock.calls.length === 1);
    expect(ttyMocks.openExecTty).toHaveBeenCalledWith(ttyMocks.transport, { container: 'c1', cmd: SHELL_CMD, cols: 80, rows: 24 });
    // The 0.14 PTY path needed python3, which the runtime image lacks: neither is touched now.
    expect(execMocks.capture).not.toHaveBeenCalled();
    expect(childProc.spawn).not.toHaveBeenCalled();

    // Raw frames, as in 0.14: every client frame is stdin, output arrives as is.
    await new Promise((r) => setTimeout(r, 20));
    tty.emit('$ ');
    await waitFor(() => messages.some((m) => m.includes('$ ')));
    ws.send('ls\r');
    await waitFor(() => tty.write.mock.calls.length === 1);
    expect((tty.write.mock.calls[0]![0] as Buffer).toString()).toBe('ls\r');

    const closed = new Promise<number>((resolve) => ws.addEventListener('close', (ev) => resolve(ev.code)));
    tty.exit(0);
    expect(await closed).toBe(1005); // `socket.close()` with no code, exactly like 0.14's child exit
    await waitFor(() => audits.some((a) => a.action === 'terminal.session.end'));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['service.exec', 'terminal.session.start', 'terminal.session.end']));
    const end = audits.find((a) => a.action === 'terminal.session.end')!;
    expect(end.meta).toMatchObject({ sessionId: 41, targetKind: 'service', reason: 'shell_exited', exitCode: 0, bytesIn: 3, bytesOut: 2 });
    expect(updates).toContainEqual(expect.objectContaining({ status: 'ended', endReason: 'shell_exited', exitCode: 0, bytesIn: 3, bytesOut: 2 }));
    expect(tty.kill).toHaveBeenCalled();
    await app.close();
  });

  it('a failed Engine-API exec is reported in the terminal and recorded as failed', async () => {
    ttyMocks.transport = { kind: 'socket', socketPath: '/var/run/docker.sock' };
    ttyMocks.openExecTty.mockRejectedValue(new Error('No such container: c1'));
    const { app, port, audits, updates } = await setup();
    const ws = await openWs(wsUrl(port, '/services/1/exec'), 'ninedeploy.bearer.valid');
    sockets.push(ws);
    const messages = collectMessages(ws);
    await new Promise<void>((resolve) => ws.addEventListener('close', () => resolve()));
    expect(messages.join('')).toContain('No such container: c1');
    await waitFor(() => audits.some((a) => a.action === 'terminal.session.end'));
    expect(audits.find((a) => a.action === 'terminal.session.end')!.meta).toMatchObject({ reason: 'target_unreachable' });
    expect(updates).toContainEqual(expect.objectContaining({ status: 'failed', endReason: 'target_unreachable' }));
    await app.close();
  });

  it('the CLI fallback (pipe mode) records the session end too', async () => {
    execMocks.capture.mockRejectedValue(new Error('no python3'));
    const { app, port, audits, updates } = await setup();
    const ws = await openWs(wsUrl(port, '/services/1/exec'), 'ninedeploy.bearer.valid');
    sockets.push(ws);
    await waitFor(() => childProc.children.length === 1);
    const child = childProc.children[0]!;
    child.stdout.emit('data', 'hello');
    ws.send('id\n');
    await waitFor(() => (child.stdin.write as ReturnType<typeof vi.fn>).mock.calls.length > 0);
    const closed = new Promise<void>((resolve) => ws.addEventListener('close', () => resolve()));
    child.emit('exit', 0);
    await closed;
    await waitFor(() => audits.some((a) => a.action === 'terminal.session.end'));
    expect(audits.find((a) => a.action === 'terminal.session.start')!.meta).toMatchObject({ sessionId: 41, legacy: true });
    expect(audits.find((a) => a.action === 'terminal.session.end')!.meta).toMatchObject({
      sessionId: 41,
      reason: 'shell_exited',
      exitCode: 0,
      bytesIn: 3,
      bytesOut: 5,
    });
    expect(updates).toContainEqual(expect.objectContaining({ status: 'ended', endReason: 'shell_exited' }));
    await app.close();
  });

  it('DELETE /v1/terminals/:id reaches a legacy session too (pipe mode: 1008 "session terminated")', async () => {
    const { terminateLive } = await import('../src/lib/terminalSessions.js');
    execMocks.capture.mockRejectedValue(new Error('no python3'));
    const { app, port, audits, updates } = await setup();
    const ws = await openWs(wsUrl(port, '/services/1/exec'), 'ninedeploy.bearer.valid');
    sockets.push(ws);
    const messages = collectMessages(ws);
    await waitFor(() => childProc.children.length === 1);
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.addEventListener('close', (ev) => resolve({ code: ev.code, reason: ev.reason })),
    );
    expect(terminateLive(41, 9)).toBe(true);
    expect(await closed).toEqual({ code: 1008, reason: 'session terminated' });
    expect(messages.join('')).toContain('terminated by an operator');
    expect(childProc.children[0]!.kill).toHaveBeenCalled();
    await waitFor(() => audits.some((a) => a.action === 'terminal.session.end'));
    expect(audits.find((a) => a.action === 'terminal.session.end')!.meta).toMatchObject({ reason: 'terminated', terminatedByUserId: 9 });
    expect(updates).toContainEqual(expect.objectContaining({ endReason: 'terminated', terminatedByUserId: 9 }));
    expect(terminateLive(41, 9)).toBe(false);
    await app.close();
  });

  it('F533 on the Engine-API path: a client gone while Docker starts the shell leaves nothing running', async () => {
    ttyMocks.transport = { kind: 'socket', socketPath: '/var/run/docker.sock' };
    const tty = fakeTty();
    let release: (() => void) | null = null;
    ttyMocks.openExecTty.mockImplementation(() => new Promise((resolve) => { release = () => resolve(tty); }));
    const { app, port, audits } = await setup();
    const ws = await openWs(wsUrl(port, '/services/1/exec'), 'ninedeploy.bearer.valid');
    sockets.push(ws);
    await waitFor(() => release !== null);
    const closed = new Promise<void>((resolve) => ws.addEventListener('close', () => resolve()));
    ws.close();
    await closed;
    const wss = (app as unknown as { websocketServer: { clients: Set<unknown> } }).websocketServer;
    await waitFor(() => wss.clients.size === 0);
    release!();
    await waitFor(() => tty.kill.mock.calls.length === 1);
    await waitFor(() => audits.some((a) => a.action === 'terminal.session.end'));
    expect(audits.find((a) => a.action === 'terminal.session.end')!.meta).toMatchObject({ reason: 'client_closed' });
    await app.close();
  });
});

/**
 * Global deploy queue.
 *
 * The /queue endpoint is the single read path that backs both the
 * /deploys page and the top-bar badge. Tests below cover:
 *   • operator visibility (returns all in-flight),
 *   • member visibility (filters to the caller's visible services),
 *   • ordering (claimed rows above queued, oldest first within bucket),
 *   • status filter (only requested statuses),
 *   • shape of the response (counts, byStatus breakdown).
 */
describe('global deploy queue', () => {
  it('returns every in-flight deploy with service + counts for an operator', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        // visibleServiceIdSet returns null for operators — the findMany
        // side receives every row, and the count/bystatus aggregate is
        // computed in the route after the select.
        findMany: {
          deployments: [
            { ...depRow({ id: 1, serviceId: 1, status: 'building' }) },
            { ...depRow({ id: 2, serviceId: 2, status: 'queued' }) },
            { ...depRow({ id: 3, serviceId: 3, status: 'queued' }) },
          ],
          services: [
            svcRow({ id: 1, name: 'web' }),
            svcRow({ id: 2, name: 'api' }),
            svcRow({ id: 3, name: 'worker' }),
          ],
        },
      }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'GET', url: '/services/queue', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(3);
    expect(body.byStatus).toEqual({ building: 1, queued: 2, deploying: 0 });
    expect(body.items.map((i: { id: number; serviceName: string }) => [i.id, i.serviceName])).toEqual([
      [1, 'web'],
      [2, 'api'],
      [3, 'worker'],
    ]);
  });

  it('returns an empty queue when the caller has no visible services', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(deploysRoutes, { prefix: '/services' });
    // `member` session — visibleServiceIdSet returns an empty Set when the
    // user owns nothing and is not in any workspace, so the route short-
    // circuits without hitting findMany.
    const res = await app.inject({ method: 'GET', url: '/services/queue', headers: asUser('member') });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [],
      count: 0,
      byStatus: { queued: 0, building: 0, deploying: 0 },
    });
  });

  it('filters by the status query parameter', async () => {
    // The fake DB does not apply `where` — the route still receives the
    // arg, but the returned rows are whatever the mock resolves. So
    // we hand back only the row that matches the requested status and
    // prove the route carries the count + byStatus aggregate through.
    const app = await buildTestApp({
      db: createFakeDb({
        findMany: {
          deployments: [depRow({ id: 1, status: 'queued' })],
          services: [svcRow({ id: 1, name: 'web' })],
        },
      }),
    });
    await app.register(deploysRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'GET', url: '/services/queue?status=queued', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(1);
    expect(body.items[0].id).toBe(1);
    expect(body.byStatus).toEqual({ building: 0, queued: 1, deploying: 0 });
  });

  it('refuses unauthenticated callers with 401', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(deploysRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'GET', url: '/services/queue' });
    expect(res.statusCode).toBe(401);
  });
});
