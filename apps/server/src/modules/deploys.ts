import { spawn } from 'node:child_process';
import { and, asc, desc, eq, inArray, isNotNull, lt, notInArray } from 'drizzle-orm';
import { deployments, services } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { diffLines, renderDiff } from '../lib/diff.js';
import { buildEnv, capture } from '../lib/exec.js';
import { audit } from '../lib/audit.js';
import { deleteLog, logBus } from '../engine/logs.js';
import { resolveUser } from '../lib/auth.js';
import { loadServiceForUser } from '../lib/serviceAccess.js';
import { assertMayDeployStoredService } from '../lib/hostPrivilege.js';
import { assertRemoteDeploySupported } from '../lib/remoteDeploy.js';
import { assertServiceRole, visibleServiceIdSet } from '../lib/resourceAccess.js';
import { badRequest, notFound, parseId as num } from '../lib/errors.js';
import { websocketBearerToken } from '../lib/websocketAuth.js';

/**
 * Statuses that mean the worker or the pipeline may still write to the row.
 * Shared by cancel (which is the only legal transition out of them) and delete
 * (which refuses them outright).
 */
const IN_FLIGHT_STATUSES = ['queued', 'building', 'deploying'] as const;

/** True while the worker or the pipeline may still write to this row. */
const isInFlight = (status: string): boolean =>
  (IN_FLIGHT_STATUSES as readonly string[]).includes(status);

export const deploysRoutes: FastifyPluginAsync = async (app) => {
  // Trigger a new deployment (enqueues a `queued` row the worker picks up).
  app.post('/:id/deploys', { onRequest: [app.authenticate] }, async (req) => {
    const id = num((req.params as { id: string }).id);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    // Triggering a deploy is a write: `viewer` seats are read-only.
    await assertServiceRole(app.db, svc, req.user!, 'member');
    // Definitions created before this rule (or by an admin) must not become a
    // back door: deploying them is what actually executes on the host.
    await assertMayDeployStoredService(app.db, req.user!, svc);
    // Upfront 400 for a service pinned to a node whose TYPE cannot run there;
    // the pipeline checks again (that is the guard every queue path passes
    // through). A docker service passes straight through to the node.
    assertRemoteDeploySupported(svc);
    // In-progress dedup: a service that is CURRENTLY building or deploying
    // gets that deployment returned (the worker only claims a queued
    // row once the in-flight one finishes, so a brand-new trigger
    // would just sit behind it). Queued rows, on the other hand, ARE
    // the queue: the operator expects to be able to stack more than
    // one and have them run in enqueue order. The 50-row cap stops
    // unbounded growth from a runaway client without needing to fail
    // a legitimate second-click.
    const MAX_QUEUED_PER_SERVICE = 50;
    const inflight = await app.db.query.deployments.findFirst({
      where: and(
        eq(deployments.serviceId, id),
        inArray(deployments.status, ['building', 'deploying']),
      ),
      orderBy: desc(deployments.id),
    });
    if (inflight) return { deploymentId: inflight.id, alreadyInProgress: true };
    const queuedRows = await app.db.query.deployments.findMany({
      where: and(eq(deployments.serviceId, id), eq(deployments.status, 'queued')),
      columns: { id: true },
    });
    if (queuedRows.length >= MAX_QUEUED_PER_SERVICE) {
      throw badRequest(
        `Service already has ${queuedRows.length} queued deploys (max ${MAX_QUEUED_PER_SERVICE}). Cancel one first.`,
      );
    }
    void audit(app.db, req.user!.id, 'deploy.trigger', svc.name);
    const [dep] = await app.db
      .insert(deployments)
      .values({ serviceId: id, status: 'queued', trigger: 'user', message: 'Manual deploy' })
      .returning();
    return { deploymentId: dep!.id };
  });

  // List deployments for a service.
  app.get('/:id/deploys', { onRequest: [app.authenticate] }, async (req) => {
    const id = num((req.params as { id: string }).id);
    await loadServiceForUser(app.db, id, req.user!);
    const rows = await app.db.query.deployments.findMany({
      where: eq(deployments.serviceId, id),
      // id is monotonic and unambiguous — createdAt is second-precision, so
      // ordering by it ties for same-second deploys.
      orderBy: desc(deployments.id),
      limit: 50,
    });
    return rows.map((d) => ({
      id: d.id,
      status: d.status,
      commitSha: d.commitSha,
      message: d.message,
      author: d.author,
      trigger: d.trigger,
      startedAt: d.startedAt ? d.startedAt.toISOString() : null,
      finishedAt: d.finishedAt ? d.finishedAt.toISOString() : null,
      createdAt: d.createdAt.toISOString(),
    }));
  });

  /**
   * Global deploy queue.
   *
   * Returns every in-flight deployment (queued, building, deploying) the
   * caller can see, with enough service metadata to operate on it without
   * the panel having to make a second roundtrip. Ordered the way the
   * worker claims them: building/deploying first (oldest in-flight wins),
   * then queued (oldest enqueue wins), so the UI can show a single
   * "what is happening and what is coming next" column without re-sorting.
   *
   * The status filter is optional and accepts the same tokens the worker
   * writes; an empty list means "all in-flight" (the panel's normal view).
   * The "claimed" row is the building/deploying deploy for a service; the
   * remaining queued rows for the same service are not yet visible to
   * the worker because of the per-service concurrency rule, and the UI
   * must surface that with the position number.
   */
  app.get('/queue', { onRequest: [app.authenticate] }, async (req) => {
    const query = req.query as { status?: string };
    const allowed = ['queued', 'building', 'deploying'] as const;
    type AllowedStatus = (typeof allowed)[number];
    const statusFilter: AllowedStatus[] | null = query.status
      ? allowed.filter((s) => query.status!.split(',').map((s) => s.trim()).includes(s))
      : null;

    // Scope by the caller's visible service set; operators see everything
    // (visibleServiceIdSet returns null in that case and the filter is
    // skipped).
    const visible = await visibleServiceIdSet(app.db, req.user!);
    if (visible && visible.size === 0) {
      return { items: [], count: 0, byStatus: { queued: 0, building: 0, deploying: 0 } };
    }

    // Two-step query: the deployment rows through the relational helper
    // (which the test fake supports), then a single services lookup to
    // hydrate the service name. A JOIN-via-drizzle-select() would need a
    // chainable stub the fake DB does not provide.
    const whereClauses = [inArray(deployments.status, statusFilter ?? [...allowed])];
    if (visible) whereClauses.push(inArray(deployments.serviceId, Array.from(visible)));

    const rows = await app.db.query.deployments.findMany({
      where: and(...whereClauses),
      // Claim order: building / deploying first (oldest id first within
      // each), then queued (oldest id first). drizzle's relational query
      // does not support CASE in orderBy, so we sort in JS after the
      // fetch — the row count is bounded by `limit` and the IN-flight
      // set is small in practice.
      orderBy: asc(deployments.id),
      limit: 200,
    });

    // Hydrate service names with a single query.
    const serviceIds = Array.from(new Set(rows.map((r) => r.serviceId)));
    const serviceRows = serviceIds.length
      ? await app.db.query.services.findMany({ where: inArray(services.id, serviceIds) })
      : [];
    const serviceNameById = new Map<number, string>();
    for (const s of serviceRows) serviceNameById.set(s.id, s.name);

    // Stable, status-aware reorder: building / deploying come above
    // queued, oldest id first inside each bucket. SQL ORDER BY would
    // be more efficient, but the in-flight set is bounded and the
    // JS sort keeps the fake-DB contract intact.
    const items = rows
      .map((d) => ({
        id: d.id,
        serviceId: d.serviceId,
        serviceName: serviceNameById.get(d.serviceId) ?? `service-${d.serviceId}`,
        status: d.status,
        commitSha: d.commitSha,
        imageDigest: d.imageDigest,
        message: d.message,
        author: d.author,
        trigger: d.trigger,
        startedAt: d.startedAt ? d.startedAt.toISOString() : null,
        finishedAt: d.finishedAt ? d.finishedAt.toISOString() : null,
        createdAt: d.createdAt.toISOString(),
      }))
      .sort((a, b) => {
        const rank = (s: string) => (s === 'building' ? 0 : s === 'deploying' ? 1 : 2);
        const ra = rank(a.status);
        const rb = rank(b.status);
        if (ra !== rb) return ra - rb;
        return a.id - b.id;
      });

    // Aggregate counts for the badge in the top bar.
    const byStatus = { queued: 0, building: 0, deploying: 0 };
    for (const it of items) byStatus[it.status as AllowedStatus] += 1;

    return { items, count: items.length, byStatus };
  });

  // Rollback to a previous deployment. Re-runs the exact commit SHA (repo
  // deploys) or the exact image digest (image deploys) so a moved `:latest`
  // tag can't silently change what gets deployed.
  app.post('/:id/deploys/:depId/rollback', { onRequest: [app.authenticate] }, async (req) => {
    const id = num((req.params as { id: string }).id);
    const depId = num((req.params as { depId: string }).depId);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, svc, req.user!, 'member');
    await assertMayDeployStoredService(app.db, req.user!, svc);
    // Upfront 400 for a service pinned to a node whose TYPE cannot run there;
    // the pipeline checks again (that is the guard every queue path passes
    // through). A docker service passes straight through to the node.
    assertRemoteDeploySupported(svc);
    const old = await app.db.query.deployments.findFirst({ where: eq(deployments.id, depId) });
    if (!old || old.serviceId !== id) throw notFound('Deployment not found');
    // An inline compose stack is defined by the YAML on the service row, and
    // deployments keep no history of it: "rolling back" would re-run the
    // CURRENT file and change nothing while reporting success. Refuse with the
    // action that actually works instead of staging a no-op.
    if (svc.composeContent) {
      throw badRequest(
        'This service deploys an inline compose stack — there is no previous revision to roll back to. Edit the compose file and redeploy instead.',
      );
    }
    void audit(app.db, req.user!.id, 'deploy.rollback', `#${depId} → ${old.commitSha?.slice(0, 7) ?? old.imageDigest?.slice(0, 15) ?? '—'}`);
    const [dep] = await app.db
      .insert(deployments)
      .values({
        serviceId: id,
        status: 'queued',
        trigger: 'user',
        commitSha: old.commitSha,
        imageDigest: old.imageDigest,
        message: `Rollback to #${depId}`,
      })
      .returning();
    return { deploymentId: dep!.id };
  });

  // Cancel a deployment. `queued` rows flip atomically (the worker never claims
  // a cancelled row); `building` rows flip so the pipeline's checkpoints abort
  // at the next step boundary and the previous runtime keeps serving.
  app.post('/:id/deploys/:depId/cancel', { onRequest: [app.authenticate] }, async (req) => {
    const id = num((req.params as { id: string }).id);
    const depId = num((req.params as { depId: string }).depId);
    const cancelTarget = await loadServiceForUser(app.db, id, req.user!);
    await assertServiceRole(app.db, cancelTarget, req.user!, 'member');
    const dep = await app.db.query.deployments.findFirst({ where: eq(deployments.id, depId) });
    if (!dep || dep.serviceId !== id) throw notFound('Deployment not found');
    if (!isInFlight(dep.status)) {
      throw badRequest('Deployment is not in progress');
    }
    const flipped = await app.db
      .update(deployments)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(and(eq(deployments.id, depId), inArray(deployments.status, [...IN_FLIGHT_STATUSES])))
      .returning({ id: deployments.id });
    if (flipped.length === 0) throw badRequest('Deployment is not in progress');
    if (dep.status === 'queued') {
      // Never picked up — it is fully cancelled here.
      logBus.publish(depId, '⏹ Cancelled before the worker picked it up');
    } else {
      // In-flight: the pipeline observes the flip at its next checkpoint.
      logBus.publish(depId, '⏹ Cancellation requested — stopping at the next step');
    }
    void audit(app.db, req.user!.id, 'deploy.cancel', `#${depId}`);
    return { ok: true, status: 'cancelled' };
  });

  /**
   * Remove one deployment from a service's history.
   *
   * Deployment rows had no delete path at all: the only thing that ever aged
   * out was the deploy-log FILE (30 days, `plugins/housekeeping.ts`), so a
   * long-lived instance kept every row forever — and the older half of the
   * Deploys tab listed builds whose logs had already been swept, with nothing
   * to say why they were empty. This is the manual half of the fix; the sweep
   * in `housekeeping.ts` is the automatic one.
   *
   * Two states are refused rather than deleted:
   *
   *   • in-flight (`queued` / `building` / `deploying`) — cancel it first, so
   *     the worker and the pipeline are never left updating a row that no
   *     longer exists;
   *   • `running` — that row IS the record of what is serving traffic right
   *     now. It carries the image digest rollback re-deploys and the config
   *     snapshot the next deploy diffs against, and the Deploys tab would
   *     start claiming nothing is live.
   */
  app.delete('/:id/deploys/:depId', { onRequest: [app.authenticate] }, async (req) => {
    const id = num((req.params as { id: string }).id);
    const depId = num((req.params as { depId: string }).depId);
    const svc = await loadServiceForUser(app.db, id, req.user!);
    // Destroying history matches the other destructive verbs: `admin`, not
    // `member` (see the role table in ARCHITECTURE §8.1).
    await assertServiceRole(app.db, svc, req.user!, 'admin');
    const dep = await app.db.query.deployments.findFirst({ where: eq(deployments.id, depId) });
    if (!dep || dep.serviceId !== id) throw notFound('Deployment not found');
    if (isInFlight(dep.status)) {
      throw badRequest('Cancel the deployment before removing it');
    }
    if (dep.status === 'running') {
      throw badRequest('This deployment is the version currently serving traffic and cannot be removed');
    }
    // Guarded by the same status set the check above used, so a deploy that
    // was re-queued between the read and here is not deleted out from under
    // the worker.
    const removed = await app.db
      .delete(deployments)
      .where(and(eq(deployments.id, depId), notInArray(deployments.status, [...IN_FLIGHT_STATUSES, 'running'])))
      .returning({ id: deployments.id });
    if (removed.length === 0) throw badRequest('Deployment changed state — reload and try again');
    deleteLog(depId);
    void audit(app.db, req.user!.id, 'deploy.delete', `${svc.name} #${depId}`);
    return { ok: true, id: depId };
  });

  // Config diff: what changed between this deployment and the previous one
  // (build config + env key fingerprint). Secret VALUES are never snapshotted —
  // only key names (marked with *).
  app.get('/:id/deploys/:depId/diff', { onRequest: [app.authenticate] }, async (req) => {
    const id = num((req.params as { id: string }).id);
    const depId = num((req.params as { depId: string }).depId);
    await loadServiceForUser(app.db, id, req.user!);
    const dep = await app.db.query.deployments.findFirst({ where: eq(deployments.id, depId) });
    if (!dep || dep.serviceId !== id) throw notFound('Deployment not found');
    // The nearest OLDER deployment of the same service with a snapshot.
    const prev = await app.db.query.deployments.findFirst({
      where: and(eq(deployments.serviceId, id), lt(deployments.id, depId), isNotNull(deployments.configSnapshot)),
      orderBy: desc(deployments.id),
    });
    const current = dep.configSnapshot ? JSON.parse(dep.configSnapshot) as Record<string, unknown> : null;
    const previous = prev?.configSnapshot ? JSON.parse(prev.configSnapshot!) as Record<string, unknown> : null;
    const ops = diffLines(
      previous ? Object.entries(previous).map(([k, v]) => `${k}: ${JSON.stringify(v)}`) : [],
      current ? Object.entries(current).map(([k, v]) => `${k}: ${JSON.stringify(v)}`) : [],
    );
    return {
      deploymentId: depId,
      previousDeploymentId: prev?.id ?? null,
      changed: ops.some((op) => op.kind !== 'same'),
      diff: renderDiff(ops),
    };
  });

  // Live log stream over WebSocket. Browser auth travels in a subprotocol header.
  app.get('/:id/deploys/:depId/logs', { websocket: true }, async (socket, req) => {
    const token = websocketBearerToken(req.headers);
    const id = num((req.params as { id: string; depId: string }).id);
    const depId = num((req.params as { id: string; depId: string }).depId);
    const user = token ? await resolveUser(app.db, token) : null;
    if (!user) {
      socket.close(1008, 'unauthorized');
      return;
    }
    // Ownership check mirrors the HTTP routes: a member may only stream logs
    // of their own services.
    try {
      await loadServiceForUser(app.db, id, user);
    } catch {
      socket.close(1008, 'not found');
      return;
    }
    // The deployment itself must belong to the service in the URL — without
    // this binding, `depId` alone would read/subscribe any tenant's build
    // log (they routinely echo secrets), passing the service check above.
    const dep = await app.db.query.deployments.findFirst({ where: eq(deployments.id, depId) });
    if (!dep || dep.serviceId !== id) {
      socket.close(1008, 'not found');
      return;
    }

    // Replay backlog, then stream live lines.
    const backlog = logBus.read(depId);
    if (backlog) socket.send(backlog);
    const unsub = logBus.subscribe(depId, (line) => {
      try {
        socket.send(`${line}\n`);
      } catch {
        /* socket closed */
      }
    });
    socket.on('close', unsub);
    socket.on('error', unsub);
  });

  // Container exec — interactive shell via WebSocket (`docker exec -it`).
  // Admin-only + audited: this is a root shell inside the service container
  // (it can read env vars incl. DB credentials and mounted data).
  //
  // TTY: `docker exec -t` requires the docker client's stdio to be a tty, which
  // a plain Node pipe is not — without one the shell has no prompt, no echo
  // and no line editing, which reads as "terminal is broken". When python3 is
  // available we wrap docker in `pty.spawn(...)` (real pty, full interactivity);
  // otherwise we fall back to the legacy pipe mode (works, just less shell-like).
  // Probed per connection (~30ms) — cheap next to a WS handshake.
  const isPtyAvailable = async (): Promise<boolean> => {
    try {
      await capture('python3', ['-c', 'import pty']);
      return true;
    } catch {
      return false;
    }
  };

  app.get('/:id/exec', { websocket: true }, async (socket, req) => {
    const token = websocketBearerToken(req.headers);
    const id = num((req.params as { id: string }).id);
    const user = token ? await resolveUser(app.db, token) : null;
    if (!user) {
      socket.close(1008, 'unauthorized');
      return;
    }
    // WebSocket routes do not pass through the HTTP auth plugin's onRequest
    // hook, so repeat its API-token privilege narrowing here. A scoped CI
    // token owned by an operator needs an explicit `operator` scope before it
    // can open an interactive container shell.
    if (!user.isOperator || (Array.isArray(user.tokenScopes) && !user.tokenScopes.includes('operator'))) {
      socket.close(1008, 'operator access required');
      return;
    }
    // Workspace guard: match the deploy handler — the operator must have membership
    // in the service's workspace before they can open a shell in any of its containers.
    // Without this, an instance operator could exec into any workspace's service.
    await loadServiceForUser(app.db, user, id);
    const svc = await app.db.query.services.findFirst({ where: eq(services.id, id) });
    if (!svc) {
      socket.close(1008, 'service not found');
      return;
    }
    if (!svc.runtimeId) {
      socket.close(1008, 'container is not running');
      return;
    }
    const targetContainer = svc.runtimeId;
    void audit(app.db, user.id, 'service.exec', svc.name);

    socket.send(`\x1b[36m⚡ Attached to container shell [${targetContainer}]\x1b[0m\r\n`);

    // The container name reaches python via the environment — never through
    // the command string — so a hostile-looking runtimeId can't inject options.
    // Both docker invocations use `--` before the dynamic container name.
    const hasPty = await isPtyAvailable();
    const child = hasPty
      ? spawn(
          'python3',
          ['-c', 'import os,pty; pty.spawn(["docker","exec","-i","-t","-e","TERM=xterm","--",os.environ["ND_EXEC_CONTAINER"],"sh"])'],
          {
            env: buildEnv({ ND_EXEC_CONTAINER: targetContainer }),
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        )
      : spawn('docker', ['exec', '-i', '-e', 'TERM=xterm', '--', targetContainer, 'sh', '-i'], {
          env: buildEnv(),
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

    // Absorb EPIPE on stdin: a keystroke racing the child's exit must never
    // crash the process (unhandled 'error' on a stream is fatal).
    child.stdin.on('error', () => { /* child already gone */ });
    child.on('error', (err) => {
      try {
        socket.send(`\r\n\x1b[31m✕ Failed to spawn container shell: ${err.message}\x1b[0m\r\n`);
        socket.close();
      } catch {
        /* already closed */
      }
    });

    socket.on('message', (data) => {
      if (child.stdin && !child.stdin.destroyed) {
        try {
          if (Buffer.isBuffer(data)) {
            child.stdin.write(data);
          } else if (data instanceof ArrayBuffer) {
            child.stdin.write(Buffer.from(data));
          } else if (Array.isArray(data)) {
            child.stdin.write(Buffer.concat(data));
          } else {
            child.stdin.write(String(data));
          }
        } catch {
          // ignore
        }
      }
    });

    child.stdout.on('data', (data) => {
      try {
        socket.send(data);
      } catch {
        /* closed */
      }
    });

    child.stderr.on('data', (data) => {
      try {
        socket.send(data);
      } catch {
        /* closed */
      }
    });

    socket.on('close', () => {
      try {
        child.kill();
      } catch {
        // ignore
      }
    });

    socket.on('error', () => {
      try {
        child.kill();
      } catch {
        // ignore
      }
    });

    child.on('exit', () => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    });
  });
};
