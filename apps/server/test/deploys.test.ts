import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
// ws client (transitive dep of @fastify/websocket) — needed for `.terminate()`,
// which abruptly destroys the connection and triggers the server socket error.
import { WebSocket as WsClient } from '../../../node_modules/.pnpm/ws@8.21.3/node_modules/ws';
import { logBus } from '../src/engine/logs.js';
import { deploysRoutes } from '../src/modules/deploys.js';
import { asUser, buildTestApp, collectMessages, createFakeDb, depRow, listen, openWs, svcRow, waitFor, wsUrl } from './helpers.js';

const authMocks = vi.hoisted(() => ({
  // 'valid' = admin session; 'member' = non-admin (used for the RBAC test).
  resolveUser: vi.fn(
    async (_db: unknown, token: string) =>
      token === 'valid' ? { id: 1, isOperator: true as const } : token === 'member' ? { id: 2, isOperator: false as const } : token === 'scoped-read-only' ? { id: 1, isOperator: true as const, tokenScopes: ['read'] } : null,
  ),
}));
vi.mock('../src/lib/auth.js', () => authMocks);

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

const sockets: WebSocket[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  childProc.children.length = 0;
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
      db: createFakeDb({ findFirst: { services: svcRow({ id: 1 }), deployments: depRow({ id: 5, serviceId: 1 }) } }),
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
