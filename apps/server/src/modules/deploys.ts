import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { and, asc, desc, eq, inArray, isNotNull, lt, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import { deployments, services } from '@ninedeploy/db';
import type { FastifyPluginAsync } from 'fastify';
import { diffLines, renderDiff } from '../lib/diff.js';
import { buildEnv, capture } from '../lib/exec.js';
import { audit } from '../lib/audit.js';
import { deleteLog, logBus } from '../engine/logs.js';
import { resolveUser } from '../lib/auth.js';
import { authorizeWebsocketUser } from '../plugins/auth.js';
import { loadServiceForUser } from '../lib/serviceAccess.js';
import { assertMayDeployStoredService } from '../lib/hostPrivilege.js';
import { enqueueUserDeploy } from '../lib/deployQueue.js';
import { assertRemoteDatabaseReachable, assertRemoteDeploySupported, assertRemoteServiceSupported } from '../lib/remoteDeploy.js';
import { assertServiceRole, visibleServiceIdSet } from '../lib/resourceAccess.js';
import { badRequest, notFound, parseId as num } from '../lib/errors.js';
import { websocketBearerToken } from '../lib/websocketAuth.js';
import { dockerTransport, isEngineTransport, openExecTty, SHELL_CMD } from '../lib/dockerTty.js';
import { reserveLive, runTerminalSession, startLegacyExecRecord, type TerminalSocket } from '../lib/terminalSessions.js';

/**
 * Statuses that mean the worker or the pipeline may still write to the row.
 * Shared by cancel (which is the only legal transition out of them) and delete
 * (which refuses them outright).
 */
const IN_FLIGHT_STATUSES = ['queued', 'building', 'deploying'] as const;

/** True while the worker or the pipeline may still write to this row. */
const isInFlight = (status: string): boolean =>
  (IN_FLIGHT_STATUSES as readonly string[]).includes(status);

const promoteInput = z.object({
  /** The service to redeploy at this lane's pinned commit. */
  targetServiceId: z.number().int().positive(),
});

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
    await assertRemoteDatabaseReachable(app.db, svc);
    await assertRemoteServiceSupported(app.db, svc);
    // In-progress dedup: a service that is CURRENTLY building or deploying
    // gets that deployment returned (the worker only claims a queued
    // row once the in-flight one finishes, so a brand-new trigger
    // would just sit behind it). Queued rows, on the other hand, ARE
    // the queue: the operator expects to be able to stack more than
    // one and have them run in enqueue order. The queued cap (shared
    // enqueue helper) stops unbounded growth from a runaway client
    // without needing to fail a legitimate second-click.
    const inflight = await app.db.query.deployments.findFirst({
      where: and(
        eq(deployments.serviceId, id),
        inArray(deployments.status, ['building', 'deploying']),
      ),
      orderBy: desc(deployments.id),
    });
    if (inflight) return { deploymentId: inflight.id, alreadyInProgress: true };
    // r640: privilege re-check + queued cap + insert live in one helper that
    // every user-triggered enqueue shares (the volume routes skipped both).
    const deploymentId = await enqueueUserDeploy(app.db, req.user!, svc, { message: 'Manual deploy' });
    // D3/F837: `<name> #<deploymentId>`, the shape deploy.delete and the
    // pipeline outcomes already use — the bridge decodes the LAST `#<n>` as the
    // deployment id. The bare name gave webhook-out no deploymentId, and a
    // service named "api #4" spoofed deployment 4. meta.serviceId feeds the
    // per-service Activity filter; lib/notifier keeps per-service `deploy`
    // rules on outcomes only (scopeMatchesAction).
    void audit(app.db, req.user!.id, 'deploy.trigger', `${svc.name} #${deploymentId}`, { serviceId: svc.id, deploymentId });
    return { deploymentId };
  });

  // Promote: deploy ANOTHER service at this service's exact running commit —
  // the canonical staging → production flow. The source lane soaks a commit;
  // one call re-deploys the target at the same SHA.
  app.post('/:id/promote', { onRequest: [app.authenticate] }, async (req) => {
    const id = num((req.params as { id: string }).id);
    const input = promoteInput.parse(req.body ?? {});
    if (input.targetServiceId === id) throw badRequest('Cannot promote a service to itself');
    const source = await loadServiceForUser(app.db, id, req.user!);
    // Triggering a promotion deploys the target: member floor on both sides.
    await assertServiceRole(app.db, source, req.user!, 'member');
    const target = await loadServiceForUser(app.db, input.targetServiceId, req.user!);
    await assertServiceRole(app.db, target, req.user!, 'member');
    await assertMayDeployStoredService(app.db, req.user!, target);
    assertRemoteDeploySupported(target);
    await assertRemoteDatabaseReachable(app.db, target);
    await assertRemoteServiceSupported(app.db, target);
    // Same repository is the promotion invariant: the target redeploys at the
    // source's pinned SHA, which only makes sense over a shared history.
    // F534: a repo-less target (image / inline compose) never checks the SHA
    // out — it would redeploy as-is while recording the source commit.
    if (!source.repoUrl || !target.repoUrl || source.repoUrl !== target.repoUrl) {
      throw badRequest('Promotion requires both services to track the same repository');
    }
    const latest = await app.db.query.deployments.findFirst({
      where: and(eq(deployments.serviceId, source.id), eq(deployments.status, 'running')),
      orderBy: desc(deployments.id),
    });
    if (!latest?.commitSha) {
      throw badRequest('Source has no running deployment with a pinned commit — deploy it first');
    }
    // r640: shared enqueue (privilege re-check + queued cap + insert).
    const deploymentId = await enqueueUserDeploy(
      app.db,
      req.user!,
      target,
      { commitSha: latest.commitSha, message: `Promoted from ${source.name} @ ${latest.commitSha.slice(0, 7)}` },
      { subject: 'Target' },
    );
    void audit(app.db, req.user!.id, 'deploy.promote', `${source.name} → ${target.name} @ ${latest.commitSha.slice(0, 7)}`);
    return { ok: true, deploymentId, commitSha: latest.commitSha, promotedFrom: source.name };
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
    await assertRemoteDatabaseReachable(app.db, svc);
    await assertRemoteServiceSupported(app.db, svc);
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
    // r640: shared enqueue — the rollback route had no queued cap at all.
    const deploymentId = await enqueueUserDeploy(app.db, req.user!, svc, {
      commitSha: old.commitSha,
      imageDigest: old.imageDigest,
      message: `Rollback to #${depId}`,
    });
    void audit(app.db, req.user!.id, 'deploy.rollback', `#${depId} → ${old.commitSha?.slice(0, 7) ?? old.imageDigest?.slice(0, 15) ?? '—'}`);
    return { deploymentId };
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

  // Download the raw build log as a file attachment.
  app.get('/:id/deploys/:depId/logs/download', { onRequest: [app.authenticate] }, async (req, reply) => {
    const id = num((req.params as { id: string }).id);
    const depId = num((req.params as { depId: string }).depId);
    await loadServiceForUser(app.db, id, req.user!);
    const dep = await app.db.query.deployments.findFirst({
      where: and(eq(deployments.id, depId), eq(deployments.serviceId, id)),
    });
    if (!dep) throw notFound('Deployment not found');

    const logPath = path.join(config.paths.logsDir, `${depId}.log`);
    if (!existsSync(logPath)) throw notFound('Build log not found');
    const stream = createReadStream(logPath);
    reply
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="deploy-${depId}.log"`);
    return reply.send(stream);
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
    // r154: a scoped CI token owned by an operator kept the operator flag
    // here and could stream any tenant's build log (logs echo secrets).
    if (!authorizeWebsocketUser(user, req.url)) {
      socket.close(1008, 'forbidden');
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
    //
    // Same late-close race the events socket guards against: `close` can fire
    // during the awaits above, before the cleanup listeners exist. Check the
    // socket state before subscribing and inside the interval (WebSocket.OPEN
    // is a constructor static in ws, hence the literal).
    const open = () => socket.readyState === 1;
    if (!open()) return;
    const backlog = logBus.read(depId);
    if (backlog) socket.send(backlog);
    // F881: end the stream (1000 'deploy finished') once the deployment has
    // settled — a final status AND no run in this process still writing its
    // log. Status alone is no end-of-log marker: the pipeline marks the row
    // `running` before the proxy swap, which can still log a retry and flip
    // it to `failed`. Re-checked at connect, on logBus's end-of-log signal and
    // on every revalidation tick (a queued deploy cancelled by the route has
    // no run to signal). Lines are sent synchronously as published, so every
    // line precedes the close frame.
    let finished = false;
    const finishIfSettled = async (): Promise<void> => {
      if (finished || !open()) return;
      const row = await app.db.query.deployments.findFirst({ where: eq(deployments.id, depId) }).catch(() => null);
      if (row === null || (row && isInFlight(row.status))) return;
      if (finished || !open() || logBus.isWriting(depId)) return;
      finished = true;
      cleanup();
      socket.close(1000, 'deploy finished');
    };
    const unsub = logBus.subscribe(
      depId,
      (line) => {
        try {
          socket.send(`${line}\n`);
        } catch {
          /* socket closed */
        }
      },
      () => void finishIfSettled(),
    );
    // r418: same revalidation the events socket got in r401 — a revoked
    // session (logout-everywhere, password change) must stop streaming build
    // logs (they routinely echo secrets), not hold the socket until the
    // client closes it.
    const revalidate = setInterval(async () => {
      if (!open()) { cleanup(); return; }
      const fresh = token ? await resolveUser(app.db, token).catch(() => null) : null;
      if (!fresh || !authorizeWebsocketUser(fresh, req.url)) {
        socket.close(1008, 'session revoked');
        cleanup();
        return;
      }
      // F532: a live session is not live access — a member removed from the
      // service's workspace (r694 seat loss) kept receiving this build log
      // until the client closed it. Re-run the connect-time ownership check.
      const stillAllowed = await loadServiceForUser(app.db, id, fresh).then(() => true, () => false);
      if (!stillAllowed) {
        socket.close(1008, 'access revoked');
        cleanup();
        return;
      }
      await finishIfSettled(); // F881
    }, 60_000);
    const cleanup = () => {
      clearInterval(revalidate);
      unsub();
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    // F881: a deployment that settled before this connect — backlog replayed
    // above, nothing more will come.
    void finishIfSettled();
  });

  // Container exec — interactive shell via WebSocket (`docker exec -it`).
  // Admin-only + audited: this is a root shell inside the service container
  // (it can read env vars incl. DB credentials and mounted data).
  //
  // 0.15: DEPRECATED in favour of `/v1/terminals` (protocol v1: resize, limits,
  // terminate), removed no earlier than 0.17. Its raw-frame protocol, auth and
  // close codes are unchanged; it is now an adapter onto the terminal session
  // engine: every session gets a `terminal_sessions` row and start/end audits
  // (D2), and wherever the Docker Engine API is reachable (the default socket,
  // `unix://`, plain `tcp://`) the shell gets a real PTY from `lib/dockerTty.ts`
  // (D1: the runtime image has no python3, so docker installs never had one).
  //
  // CLI fallback (TLS / ssh / context DOCKER_HOST): `docker exec -t` requires
  // the docker client's stdio to be a tty, which a plain Node pipe is not —
  // without one the shell has no prompt, no echo and no line editing. When
  // python3 is available we wrap docker in `pty.spawn(...)`; otherwise pipe
  // mode. Probed per connection (~30ms) — cheap next to a WS handshake.
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
    // Resolve the service through the access choke point, like the deploy
    // handler. D4 (0.15): an instance operator passes `loadServiceForUser` for
    // EVERY service (operators are `owner` everywhere; no workspace seat is
    // needed) — the operator gate above is the authorization; this call keeps
    // the 404 for an unknown id and stays correct should the gate ever widen.
    // The reply is hijacked on a websocket route, so a thrown 404 cannot become an
    // HTTP response — it would strand the socket open forever. Close it explicitly,
    // like the log-stream route above.
    try {
      await loadServiceForUser(app.db, id, user);
    } catch {
      socket.close(1008, 'not found');
      return;
    }
    const svc = await app.db.query.services.findFirst({ where: eq(services.id, id) });
    if (!svc) {
      socket.close(1008, 'service not found');
      return;
    }
    if (!svc.runtimeId) {
      socket.close(1008, 'container is not running');
      return;
    }
    // r665: the shell below is the PANEL host's `docker exec`. A service
    // pinned to a node runs there, so the terminal opened onto "No such
    // container" — say why instead (the agent has no interactive op).
    if (svc.serverId != null) {
      socket.send(
        `\x1b[33m✕ "${svc.name}" runs on remote node #${svc.serverId} — the web terminal only reaches containers on the panel host. ` +
          `Open a shell on the node itself (docker exec -it ${svc.runtimeId} sh), or use the service's Terminal (/v1/terminals).\x1b[0m\r\n`,
      );
      socket.close(1008, 'service runs on a remote node');
      return;
    }
    const targetContainer = svc.runtimeId;
    void audit(app.db, user.id, 'service.exec', svc.name);
    const recorder = await startLegacyExecRecord(app.db, {
      userId: user.id,
      serviceId: svc.id,
      container: targetContainer,
      label: svc.name,
      authKind: user.viaApiToken ? 'api_token' : 'session',
      ctx: { ip: req.ip, userAgent: req.headers['user-agent'] },
    });
    const revalidateExec = async (): Promise<string | null> => {
      const fresh = token ? await resolveUser(app.db, token).catch(() => null) : null;
      const ok = fresh && fresh.isOperator && !(Array.isArray(fresh.tokenScopes) && !fresh.tokenScopes.includes('operator'));
      return ok ? null : 'session revoked';
    };
    if (socket.readyState !== 1) {
      await recorder.end('client_closed');
      return;
    }

    socket.send(`\x1b[36m⚡ Attached to container shell [${targetContainer}]\x1b[0m\r\n`);

    // D1: a real PTY over the Engine API wherever it is reachable.
    const transport = dockerTransport();
    if (isEngineTransport(transport)) {
      const slot = reserveLive({ id: recorder.info.id ?? 0, userId: user.id, targetKind: 'service', legacy: true });
      let tty: Awaited<ReturnType<typeof openExecTty>>;
      try {
        tty = await openExecTty(transport, { container: targetContainer, cmd: SHELL_CMD, cols: 80, rows: 24 });
      } catch (err) {
        slot.release();
        const message = err instanceof Error ? err.message : String(err);
        try {
          socket.send(`\r\n\x1b[31m✕ Failed to open container shell: ${message}\x1b[0m\r\n`);
          socket.close();
        } catch {
          /* already closed */
        }
        await recorder.end('target_unreachable', { failed: true, error: message });
        return;
      }
      // F533: the client may have left while Docker started the shell.
      if (socket.readyState !== 1) {
        slot.release();
        await tty.kill();
        await recorder.end('client_closed');
        return;
      }
      const run = runTerminalSession({
        socket: socket as unknown as TerminalSocket,
        tty,
        recorder,
        protocol: 'legacy',
        // 0.14 behaviour: no idle or duration limit on this socket.
        idleMs: null,
        maxMs: null,
        revalidate: revalidateExec,
        liveKey: slot.key,
      });
      slot.attach(run.live);
      return;
    }

    // The container name reaches python via the environment — never through
    // the command string — so a hostile-looking runtimeId can't inject options.
    // Both docker invocations use `--` before the dynamic container name.
    const hasPty = await isPtyAvailable();
    // F533: last suspension point before the shell exists. A client that left
    // during the awaits above already fired `close` — the listeners below would
    // never run, orphaning `docker exec` and its revalidation interval.
    if (socket.readyState !== 1) {
      await recorder.end('client_closed');
      return;
    }
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

    // D2: the session's end (reason, exit code, bytes) is recorded once, when
    // the socket closes — every path below ends there.
    let endReason = 'client_closed';
    let exitCode: number | null = null;
    let terminatedBy: number | null = null;
    const slot = reserveLive({ id: recorder.info.id ?? 0, userId: user.id, targetKind: 'service', legacy: true });
    const stop = (reason: string, message: string, closeReason: string) => {
      endReason = reason;
      try {
        socket.send(message);
      } catch { /* already closed */ }
      try { child.kill(); } catch { /* already gone */ }
      socket.close(1008, closeReason);
    };
    slot.attach({
      terminate: (by) => {
        terminatedBy = by;
        stop('terminated', '\r\n\x1b[31m✕ Session terminated by an operator — disconnecting.\x1b[0m\r\n', 'session terminated');
      },
      revoke: () => stop('revoked', '\r\n\x1b[31m✕ Session revoked — disconnecting.\x1b[0m\r\n', 'session revoked'),
    });
    socket.on('close', () => {
      slot.release();
      void recorder.end(endReason, { exitCode, terminatedByUserId: terminatedBy });
    });
    child.on('exit', (code: unknown) => {
      if (endReason === 'client_closed') endReason = 'shell_exited';
      exitCode = typeof code === 'number' ? code : null;
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
      recorder.bytesIn += Buffer.isBuffer(data)
        ? data.length
        : data instanceof ArrayBuffer
          ? data.byteLength
          : Array.isArray(data)
            ? data.reduce((n, b) => n + b.length, 0)
            : Buffer.byteLength(String(data));
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
      recorder.bytesOut += Buffer.byteLength(data);
      try {
        socket.send(data);
      } catch {
        /* closed */
      }
    });

    child.stderr.on('data', (data) => {
      recorder.bytesOut += Buffer.byteLength(data);
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

    // r418: this socket IS a root shell in the container — the r401
    // revalidation standard matters most here. A revoked session (bumped
    // tokenVersion, password change, operator flag pulled) kills the shell
    // within a minute instead of keeping it open until the client closes.
    const execRevalidate = setInterval(async () => {
      if (await revalidateExec()) {
        endReason = 'revoked';
        try {
          socket.send('\r\n\x1b[31m✕ Session revoked — disconnecting.\x1b[0m\r\n');
        } catch { /* already closed */ }
        try { child.kill(); } catch { /* already gone */ }
        socket.close(1008, 'session revoked');
      }
    }, 60_000);
    socket.on('close', () => clearInterval(execRevalidate));

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
