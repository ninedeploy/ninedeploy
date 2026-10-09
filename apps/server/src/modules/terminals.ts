import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { and, desc, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { type Database, type Service, servers, serviceTargets, services, terminalSessions, users } from '@ninedeploy/db';
import {
  createTerminalSession,
  TERMINAL_CLOSE,
  type TerminalSessionCreated,
  type TerminalSessionList,
  type TerminalSettingsView,
  type TerminalTarget,
  type TerminalTerminateResult,
  terminalSessionListQuery,
  terminalSettings,
} from '@ninedeploy/schemas';
import { replicaNames } from '../engine/dockerNames.js';
import { isSwarmRuntimeId, localSwarmTaskFor } from '../lib/swarm.js';
import { ENGINES } from '../engine/database.js';
import { type AgentCaller, terminalRefusal } from '../lib/agentCapabilities.js';
import { agentOp, agentTransportSealed } from '../lib/agentClient.js';
import { openNodeTerminalTty } from '../lib/agentTerminal.js';
import { panelAllowedOrigins } from '../lib/allowedOrigins.js';
import { audit } from '../lib/audit.js';
import { decrypt } from '../lib/crypto.js';
import {
  type ContainerSummary,
  type DockerTransport,
  DockerEngineError,
  dockerTransport,
  inspectContainer,
  isEngineTransport,
  probeHostShellImage,
} from '../lib/dockerTty.js';
import { HttpError, notFound, parseId } from '../lib/errors.js';
import { capture } from '../lib/exec.js';
import { loadDatabaseForUser, loadServiceForUser } from '../lib/resourceAccess.js';
import { setSetting, setSettingJson } from '../lib/settings.js';
import { assertStepUp } from '../lib/stepUp.js';
import { attachHandshake, originAllowed } from '../lib/terminalProtocol.js';
import {
  consumeTicket,
  forgetPending,
  hostTerminalAllowed,
  hostShellImage,
  issueTicket,
  liveTerminalCount,
  liveTerminalCountForUser,
  openTargetTty,
  principalFor,
  readTerminalSettings,
  rememberPending,
  reserveLive,
  type ResolvedTerminalTarget,
  revalidatePrincipal,
  revokeLiveHostSessions,
  runTerminalSession,
  TERMINAL_PER_USER_MAX,
  TERMINAL_SETTING_KEYS,
  TerminalSessionRecorder,
  type TerminalSocket,
  takePending,
  terminalSettingsView,
  terminateLive,
  toTerminalSession,
} from '../lib/terminalSessions.js';

/**
 * Terminals (0.15): interactive shells into a service replica, a managed
 * database, any managed container or (off by default, owner decision O1) a
 * server host, under `/v1/terminals`.
 *
 *   POST   /                 create a session → a single-use ticket (30s)
 *   GET    /:id/attach       WebSocket, protocol v1 (ticket in a subprotocol)
 *   GET    /                 history (metadata only: no transcript, O2)
 *   GET    /:id              one session
 *   DELETE /:id              terminate a live session (close 4410)
 *   GET    /settings         host switch, limits, retention
 *   PUT    /settings         change them (turning host shells on needs step-up)
 *
 * Every HTTP route is operator-only (`authenticate` + `requireOperator`) and
 * has no PREFIX_SCOPES entry, so fine-grained tokens are refused. Host shells
 * additionally need an interactive session (no API token), a password
 * re-check, the setting, and no `NINEDEPLOY_HOST_TERMINAL=off`.
 *
 * Node targets (a service on a node — primary placement or fan-out target —
 * and a node's host) run through the node's agent (T2b, lib/agentTerminal.ts):
 * the sealed `terminal.open` op plus an encrypted frame channel, under the
 * same caps, limits, revalidation, terminate and audit as a local session.
 * They need the sealed transport and an agent that advertises `terminal`
 * (v0.15.0+); an older agent is refused with 422 `node_terminal_unsupported`
 * and an "update the agent" message. A node host shell also needs the
 * agent's `terminal.host` (the node owner's `NINEDEPLOY_AGENT_HOST_TERMINAL`).
 *
 * Design: .temp_files/run_0.15/DESIGN.md §1. Contract: `@ninedeploy/schemas` terminals.ts.
 */

const err = (status: number, code: string, message: string) => new HttpError(status, code, message);

/** Database clients: credentials travel in the exec's Env, never in argv (DESIGN §1.6). */
function databaseClient(d: Database): { cmd: string[]; env: string[] } {
  const cfg = ENGINES[d.engine];
  const password = decrypt(d.passwordEncrypted);
  switch (d.engine) {
    case 'postgres':
      return {
        cmd: ['psql', '-U', d.username ?? cfg?.username() ?? 'nine', '-d', d.dbName ?? cfg?.dbName() ?? 'app'],
        env: [`PGPASSWORD=${password}`],
      };
    case 'mysql':
    case 'mariadb':
      return { cmd: [d.engine, '-uroot'], env: [`MYSQL_PWD=${password}`] };
    case 'redis':
      return { cmd: ['redis-cli'], env: [`REDISCLI_AUTH=${password}`] };
    case 'valkey':
      return { cmd: ['valkey-cli'], env: [`REDISCLI_AUTH=${password}`, `VALKEYCLI_AUTH=${password}`] };
    default:
      throw err(422, 'client_mode_unsupported', `No interactive client for ${d.engine}: open a shell (mode "shell") instead.`);
  }
}

/** True when `summary` is the container this panel runs in (a shell there would expose master.key and the database). */
function isPanelContainer(summary: ContainerSummary): boolean {
  const own = hostname();
  if (/^[0-9a-f]{12,64}$/.test(own) && summary.id.startsWith(own)) return true;
  return existsSync('/.dockerenv') && summary.hostname === own;
}

/** Inspect over the Engine API, or through the CLI when only the CLI reaches the daemon. */
async function inspectTarget(transport: DockerTransport, name: string): Promise<ContainerSummary | null> {
  if (isEngineTransport(transport)) return inspectContainer(transport, name);
  try {
    const out = await capture('docker', ['inspect', '--type', 'container', '--format', '{{.Id}}|{{.Config.Hostname}}|{{.State.Running}}', '--', name]);
    const [id = '', host = '', running = ''] = out.trim().split('|');
    return { id, hostname: host || null, running: running === 'true', labels: {} };
  } catch {
    return null;
  }
}

async function assertRunningLocal(transport: DockerTransport, name: string): Promise<ContainerSummary> {
  const summary = await inspectTarget(transport, name);
  if (!summary) throw err(409, 'not_running', `Container ${name} does not exist on the panel host.`);
  if (!summary.running) throw err(409, 'not_running', `Container ${name} is not running.`);
  if (isPanelContainer(summary)) throw err(403, 'panel_container_refused', "A shell inside the panel's own container is refused.");
  return summary;
}

function serviceContainer(svc: Service, replica: number | undefined): string {
  if (!svc.runtimeId) throw err(409, 'not_running', `Service "${svc.name}" has no running container.`);
  const n = replica ?? 1;
  const names = replicaNames(svc.runtimeId, svc.runtimeReplicas ?? 1);
  const name = names[n - 1];
  if (!name) throw err(422, 'replica_out_of_range', `Service "${svc.name}" runs ${names.length} replica(s); replica ${n} does not exist.`);
  return name;
}

export const terminalRoutes: FastifyPluginAsync = async (app) => {
  const guard = { onRequest: [app.authenticate], preHandler: [app.requireOperator] };

  // ── 0.15 T2b: node targets ────────────────────────────────────────────────
  const nodeAgent =
    (serverId: number): AgentCaller =>
    (op, params, sink) =>
      agentOp(app.db, serverId, op, params, sink);

  /** The node, after `terminalRefusal` (sealed transport, `terminal` capability, `terminal.host` for a host shell). */
  const assertNodeTerminal = async (serverId: number, host: boolean): Promise<{ name: string }> => {
    const node = await app.db.query.servers.findFirst({ where: eq(servers.id, serverId) });
    if (!node) throw notFound(`Node #${serverId} not found`);
    const label = `"${node.name}" (#${serverId})`;
    const sealed = await agentTransportSealed(app.db, serverId).catch(() => false);
    const refusal = await terminalRefusal(nodeAgent(serverId), label, sealed, { host, serverId });
    if (refusal) throw err(refusal.status, refusal.code, refusal.message);
    return node;
  };

  /** 409 unless `container` exists and runs on the node (the existing `docker.inspect` op, which every agent has). */
  const assertRunningOnNode = async (serverId: number, nodeName: string, container: string): Promise<void> => {
    let res: { exitCode: number; lines: string[] };
    try {
      res = await agentOp(app.db, serverId, 'docker.inspect', { name: container, format: 'state' }, () => undefined, { tolerateExit: true });
    } catch (e) {
      throw err(502, 'node_unreachable', `Could not reach the agent on node "${nodeName}": ${e instanceof Error ? e.message : String(e)}`);
    }
    const state = res.exitCode === 0 ? (res.lines.find((l) => l.includes('|')) ?? '').split('|')[0]?.trim() : null;
    if (state === null) throw err(409, 'not_running', `Container ${container} does not exist on node "${nodeName}".`);
    if (state !== 'running') throw err(409, 'not_running', `Container ${container} is not running on node "${nodeName}".`);
  };
  // ── end 0.15 T2b ──

  /** Resolve and authorise a target (DESIGN §1.6). Throws an HttpError the client can act on. */
  const resolveTarget = async (
    req: FastifyRequest,
    target: TerminalTarget,
    password: string | undefined,
    transport: DockerTransport,
  ): Promise<ResolvedTerminalTarget> => {
    const user = req.user!;
    const base = { serviceId: null, databaseId: null, cmd: null, env: [] as string[] };
    switch (target.kind) {
      case 'service': {
        const svc = await loadServiceForUser(app.db, target.serviceId, user);
        if (svc.type === 'compose') {
          throw err(
            422,
            'use_container_target',
            `"${svc.name}" is a compose service: list its containers with GET /v1/services/${svc.id}/containers and open one with the "container" target.`,
          );
        }
        if (svc.type !== 'docker') throw err(422, 'not_a_container', `"${svc.name}" does not run in a container.`);
        let serverId: number | null = svc.serverId ?? null;
        let container: string;
        if (target.serverId !== undefined && target.serverId !== svc.serverId) {
          const fanout = await app.db.query.serviceTargets.findFirst({
            where: and(eq(serviceTargets.serviceId, svc.id), eq(serviceTargets.serverId, target.serverId)),
          });
          if (!fanout) throw err(422, 'not_a_target', `"${svc.name}" does not run on node #${target.serverId}.`);
          if (target.replica !== undefined && target.replica > 1) {
            throw err(422, 'replica_out_of_range', 'Replicas apply to the primary placement only.');
          }
          if (!fanout.runtimeId) throw err(409, 'not_running', `"${svc.name}" has no running container on node #${target.serverId}.`);
          serverId = target.serverId;
          container = fanout.runtimeId;
        } else if (isSwarmRuntimeId(svc.runtimeId)) {
          // ── 0.16 T7 swarm ── a task of the Swarm service on the panel host, else where the replica runs.
          const task = await localSwarmTaskFor(svc.runtimeId, target.replica ?? 1);
          if ('refusal' in task) throw err(422, 'swarm_task_elsewhere', task.refusal);
          container = task.container;
          // ── end 0.16 T7 ──
        } else {
          container = serviceContainer(svc, target.replica);
        }
        const label = target.replica && target.replica > 1 ? `${svc.name} (replica ${target.replica})` : svc.name;
        if (serverId !== null) {
          // 0.15 T2b: the container lives on a node.
          const node = await assertNodeTerminal(serverId, false);
          await assertRunningOnNode(serverId, node.name, container);
          return { ...base, kind: 'service', label, serverId, serviceId: svc.id, containerName: container };
        }
        await assertRunningLocal(transport, container);
        return { ...base, kind: 'service', label, serverId: null, serviceId: svc.id, containerName: container };
      }
      case 'database': {
        const d = await loadDatabaseForUser(app.db, target.databaseId, user);
        // ── 0.16 T6 node databases (design §5.4 "Terminal") ──
        // A node database's shell opens through the node's agent (the 0.15
        // node terminal: sealed `terminal.open` + the encrypted channel). The
        // agent's container terminal runs a shell only — it carries no exec
        // command or env — so the client mode stays panel-host only.
        if (d.serverId != null) {
          const container = d.nodeContainerName ?? `nd-db-${d.slug}`;
          if (d.status !== 'running') throw err(409, 'not_running', `Database "${d.name}" is not running.`);
          if (target.mode === 'client') {
            throw err(
              422,
              'client_mode_unsupported',
              `Database "${d.name}" runs on a node, whose agent opens shells only: open a shell (mode "shell") and run the client there (the connection string is under Credentials).`,
            );
          }
          const node = await assertNodeTerminal(d.serverId, false);
          await assertRunningOnNode(d.serverId, node.name, container);
          return { ...base, kind: 'database', label: d.name, serverId: d.serverId, databaseId: d.id, containerName: container };
        }
        // ── end 0.16 T6 ──
        if (!d.containerName || d.status !== 'running') throw err(409, 'not_running', `Database "${d.name}" is not running.`);
        const client = target.mode === 'client' ? databaseClient(d) : null;
        await assertRunningLocal(transport, d.containerName);
        return {
          ...base,
          kind: 'database',
          label: client ? `${d.name} (client)` : d.name,
          serverId: null,
          databaseId: d.id,
          containerName: d.containerName,
          cmd: client?.cmd ?? null,
          env: client?.env ?? [],
        };
      }
      case 'container': {
        // r665: a container of a node-placed service lives on that node.
        const primary = target.name.replace(/-r\d+$/, '');
        const remote = await app.db.query.services.findFirst({
          where: and(inArray(services.runtimeId, [target.name, primary]), isNotNull(services.serverId)),
        });
        const remoteTarget = remote
          ? undefined
          : await app.db.query.serviceTargets.findFirst({ where: eq(serviceTargets.runtimeId, target.name) });
        const remoteServer = remote?.serverId ?? remoteTarget?.serverId;
        if (remoteServer != null) {
          throw err(422, 'remote_container', `Container ${target.name} runs on node #${remoteServer}; the "container" target reaches the panel host only.`);
        }
        await assertRunningLocal(transport, target.name);
        return { ...base, kind: 'container', label: target.name, serverId: null, containerName: target.name };
      }
      case 'host': {
        // O1: all four gates, in this order, before anything touches Docker.
        if (!(await hostTerminalAllowed(app.db))) {
          throw err(403, 'host_terminal_disabled', 'Host shells are disabled. An operator can enable them in Settings → Security → Terminals (NINEDEPLOY_HOST_TERMINAL=off forbids them).');
        }
        if (user.viaApiToken) throw err(403, 'forbidden', 'Host shells require an interactive session, not an API token');
        const row = await app.db.query.users.findFirst({ where: eq(users.id, user.id) });
        if (!row) throw err(401, 'unauthorized', 'Unauthorized');
        await assertStepUp(app.db, req, row, password);
        if (target.serverId !== null) {
          // 0.15 T2b: the panel gates above, then the node's own (capability + its owner's switch).
          const node = await assertNodeTerminal(target.serverId, true);
          return { ...base, kind: 'host', label: `node ${node.name} host`, serverId: target.serverId, containerName: null };
        }
        if (!isEngineTransport(transport)) {
          throw err(422, 'host_shell_unsupported_docker_host', `Host shells need the Docker Engine API: ${transport.reason}.`);
        }
        const image = hostShellImage();
        const probe = await probeHostShellImage(transport, image).catch((e: unknown) => ({
          ok: false as const,
          reason: e instanceof Error ? e.message : String(e),
        }));
        if (!probe.ok) {
          throw err(422, 'host_shell_image_unsupported', `Cannot start a host shell: ${probe.reason}. Set NINEDEPLOY_HOST_SHELL_IMAGE to an image with nsenter.`);
        }
        return { ...base, kind: 'host', label: 'panel host', serverId: null, containerName: null };
      }
    }
  };

  const emailOf = async (userId: number | null): Promise<string | null> => {
    if (userId === null) return null;
    const row = await app.db.query.users.findFirst({ where: eq(users.id, userId) });
    return row?.email ?? null;
  };

  // ── create ────────────────────────────────────────────────────────────────
  app.post('/', guard, async (req, reply) => {
    const input = createTerminalSession.parse(req.body);
    const user = req.user!;
    const transport = dockerTransport();
    const target = await resolveTarget(req, input.target, input.password, transport);
    const principal = await principalFor(user, req.headers.authorization);
    const ticket = issueTicket();
    const [row] = await app.db
      .insert(terminalSessions)
      .values({
        userId: user.id,
        targetKind: target.kind,
        serviceId: target.serviceId,
        databaseId: target.databaseId,
        serverId: target.serverId,
        containerName: target.containerName,
        targetLabel: target.label,
        status: 'pending',
        ticketHash: ticket.hash,
        ticketExpiresAt: ticket.expiresAt,
        authKind: principal.authKind,
        clientIp: req.ip ?? null,
        userAgent: req.headers['user-agent']?.slice(0, 300) ?? null,
        cols: input.cols,
        rows: input.rows,
      })
      .returning();
    rememberPending(row!.id, { target, principal, cols: input.cols, rows: input.rows, expiresAt: ticket.expiresAt.getTime() });
    void audit(
      app.db,
      user.id,
      'terminal.session.create',
      target.label,
      { sessionId: row!.id, targetKind: target.kind, targetLabel: target.label, serverId: target.serverId },
      { ip: req.ip, userAgent: req.headers['user-agent'] },
    );
    const body: TerminalSessionCreated = {
      session: toTerminalSession(row!, await emailOf(user.id)),
      ticket: ticket.ticket,
      ticketExpiresAt: ticket.expiresAt.toISOString(),
      attachPath: `/v1/terminals/${row!.id}/attach`,
    };
    return reply.status(201).send(body);
  });

  // ── settings (static paths before `/:id`) ─────────────────────────────────
  app.get('/settings', guard, async (): Promise<TerminalSettingsView> => terminalSettingsView(app.db));

  app.put('/settings', guard, async (req): Promise<TerminalSettingsView> => {
    const input = terminalSettings.parse(req.body ?? {});
    const user = req.user!;
    const current = await readTerminalSettings(app.db);
    if (input.hostTerminalEnabled === true && !current.hostTerminalEnabled) {
      if (user.viaApiToken) throw err(403, 'forbidden', 'Enabling host shells requires an interactive session, not an API token');
      const row = await app.db.query.users.findFirst({ where: eq(users.id, user.id) });
      if (!row) throw err(401, 'unauthorized', 'Unauthorized');
      await assertStepUp(app.db, req, row, input.password);
    }
    const changed: string[] = [];
    if (input.hostTerminalEnabled !== undefined && input.hostTerminalEnabled !== current.hostTerminalEnabled) {
      await setSetting(app.db, TERMINAL_SETTING_KEYS.hostTerminalEnabled, input.hostTerminalEnabled);
      changed.push('hostTerminalEnabled');
    }
    for (const key of ['idleTimeoutMinutes', 'maxSessionMinutes', 'maxConcurrent', 'retentionDays'] as const) {
      const value = input[key];
      if (value !== undefined && value !== current[key]) {
        await setSettingJson(app.db, TERMINAL_SETTING_KEYS[key], value);
        changed.push(key);
      }
    }
    if (input.hostTerminalEnabled === false && current.hostTerminalEnabled) revokeLiveHostSessions('host shells were disabled');
    void audit(app.db, user.id, 'terminal.settings.update', 'terminals', {
      changed,
      ...(changed.includes('hostTerminalEnabled') ? { hostTerminalEnabled: input.hostTerminalEnabled } : {}),
    }, { ip: req.ip, userAgent: req.headers['user-agent'] });
    return terminalSettingsView(app.db);
  });

  // ── history ───────────────────────────────────────────────────────────────
  app.get('/', guard, async (req): Promise<TerminalSessionList> => {
    const q = terminalSessionListQuery.parse(req.query ?? {});
    const where = [
      q.status ? eq(terminalSessions.status, q.status) : undefined,
      q.userId ? eq(terminalSessions.userId, q.userId) : undefined,
      q.targetKind ? eq(terminalSessions.targetKind, q.targetKind) : undefined,
      q.before ? lt(terminalSessions.id, q.before) : undefined,
    ].filter((c) => c !== undefined);
    const rows = await app.db
      .select()
      .from(terminalSessions)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(terminalSessions.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const ids = [...new Set(page.map((r) => r.userId).filter((v): v is number => v != null))];
    const emails = new Map<number, string>();
    if (ids.length) {
      for (const u of await app.db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, ids))) {
        emails.set(u.id, u.email);
      }
    }
    return {
      items: page.map((r) => toTerminalSession(r, r.userId != null ? (emails.get(r.userId) ?? null) : null)),
      nextBefore: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  });

  app.get('/:id', guard, async (req) => {
    const id = parseId((req.params as { id: string }).id);
    const row = await app.db.query.terminalSessions.findFirst({ where: eq(terminalSessions.id, id) });
    if (!row) throw notFound('Terminal session not found');
    return toTerminalSession(row, await emailOf(row.userId ?? null));
  });

  // ── terminate ─────────────────────────────────────────────────────────────
  app.delete('/:id', guard, async (req): Promise<TerminalTerminateResult> => {
    const id = parseId((req.params as { id: string }).id);
    const user = req.user!;
    const row = await app.db.query.terminalSessions.findFirst({ where: eq(terminalSessions.id, id) });
    if (!row) throw notFound('Terminal session not found');
    let wasLive = terminateLive(id, user.id);
    if (!wasLive) {
      if (row.status !== 'pending' && row.status !== 'active') {
        throw err(409, 'not_live', `Terminal session ${id} has already ended (${row.status}).`);
      }
      // A pending ticket (or a row this process does not run): close it here.
      forgetPending(id);
      await app.db
        .update(terminalSessions)
        .set({
          status: row.status === 'pending' ? 'expired' : 'ended',
          ticketHash: null,
          endReason: 'terminated',
          endedAt: new Date(),
          terminatedByUserId: user.id,
        })
        .where(eq(terminalSessions.id, id));
      wasLive = false;
    }
    void audit(
      app.db,
      user.id,
      'terminal.session.terminate',
      row.targetLabel,
      { sessionId: id, targetKind: row.targetKind, serverId: row.serverId ?? null, wasLive, terminatedByUserId: user.id },
      { ip: req.ip, userAgent: req.headers['user-agent'] },
    );
    return { ok: true, wasLive };
  });

  // ── attach (WebSocket, protocol v1) ───────────────────────────────────────
  // No HTTP auth hook: the single-use ticket is the credential (DESIGN §1.2),
  // created by the operator-only POST above. The Origin check stops another
  // site's page from using a ticket it somehow obtained.
  app.get('/:id/attach', { websocket: true }, async (socket, req) => {
    const close = (code: number, reason: string) => {
      try {
        socket.close(code, reason);
      } catch {
        /* already closed */
      }
    };
    if (!originAllowed(req.headers.origin, panelAllowedOrigins())) return close(TERMINAL_CLOSE.forbidden, 'origin not allowed');
    const { protocol, ticket } = attachHandshake(req.headers['sec-websocket-protocol']);
    const rawId = (req.params as { id: string }).id;
    const id = /^[1-9]\d{0,15}$/.test(rawId) ? Number(rawId) : null;
    if (!protocol || !ticket || id === null) return close(TERMINAL_CLOSE.badTicket, 'invalid ticket');

    const row = await consumeTicket(app.db, id, ticket).catch(() => null);
    if (!row) return close(TERMINAL_CLOSE.badTicket, 'invalid or expired ticket');
    const ctx = { ip: row.clientIp ?? undefined, userAgent: row.userAgent ?? undefined };
    const recorder = new TerminalSessionRecorder(app.db, {
      id: row.id,
      userId: row.userId ?? null,
      targetKind: row.targetKind,
      targetLabel: row.targetLabel,
      serverId: row.serverId ?? null,
      startedAt: row.startedAt ?? new Date(),
      ctx,
    });
    const fail = async (code: number, reason: string, endReason: string, message: string) => {
      try {
        if (socket.readyState === 1) socket.send(JSON.stringify({ t: 'notice', message }));
      } catch {
        /* closed */
      }
      close(code, reason);
      await recorder.end(endReason, { failed: true, error: message });
    };

    const ctxPending = takePending(row.id);
    if (!ctxPending || row.userId == null) {
      return fail(TERMINAL_CLOSE.badTicket, 'session context lost', 'context_lost', 'This session can no longer be attached; open a new one.');
    }
    const host = ctxPending.target.kind === 'host';
    const settings = await readTerminalSettings(app.db);
    // Caps: checked and reserved with no await in between.
    if (liveTerminalCount() >= settings.maxConcurrent || liveTerminalCountForUser(row.userId) >= TERMINAL_PER_USER_MAX) {
      return fail(
        TERMINAL_CLOSE.tooManySessions,
        'too many sessions',
        'too_many_sessions',
        `Too many open terminals (at most ${settings.maxConcurrent} on this panel and ${TERMINAL_PER_USER_MAX} per user).`,
      );
    }
    const slot = reserveLive({ id: row.id, userId: row.userId, targetKind: row.targetKind, legacy: false });
    const revalidate = () => revalidatePrincipal(app.db, ctxPending.principal, { host });
    const why = await revalidate().catch(() => 'session revoked');
    if (why) {
      slot.release();
      return fail(TERMINAL_CLOSE.forbidden, 'forbidden', 'revoked', why);
    }
    const maxMs = settings.maxSessionMinutes * 60_000;
    let tty: Awaited<ReturnType<typeof openTargetTty>>;
    try {
      tty =
        ctxPending.target.serverId !== null
          ? // 0.15 T2b: through the node's agent (sealed op + encrypted channel).
            await openNodeTerminalTty(app.db, ctxPending.target, { sessionId: row.id, cols: ctxPending.cols, rows: ctxPending.rows })
          : await openTargetTty(dockerTransport(), ctxPending.target, { sessionId: row.id, cols: ctxPending.cols, rows: ctxPending.rows, maxMs });
    } catch (e) {
      slot.release();
      const detail = e instanceof DockerEngineError || e instanceof Error ? e.message : String(e);
      return fail(TERMINAL_CLOSE.targetUnreachable, 'target unreachable', 'target_unreachable', `Could not open the terminal: ${detail}`);
    }
    // The client may have left while Docker was starting the shell.
    if (socket.readyState !== 1) {
      slot.release();
      await tty.kill();
      await recorder.end('client_closed');
      return;
    }
    try {
      socket.send(
        JSON.stringify({ t: 'ready', sessionId: row.id, target: { kind: row.targetKind, label: row.targetLabel, serverId: row.serverId ?? null } }),
      );
    } catch {
      /* closed: the bridge sees it */
    }
    void audit(app.db, row.userId, 'terminal.session.start', row.targetLabel, {
      sessionId: row.id,
      targetKind: row.targetKind,
      serverId: row.serverId ?? null,
    }, ctx);
    if (host) {
      // O1: every host shell start reaches the notification fan-out.
      void audit(app.db, row.userId, 'security.host_terminal', row.targetLabel, {
        sessionId: row.id,
        serverId: row.serverId ?? null,
      }, ctx);
    }
    const run = runTerminalSession({
      socket: socket as unknown as TerminalSocket,
      tty,
      recorder,
      protocol: 'v1',
      idleMs: settings.idleTimeoutMinutes * 60_000,
      maxMs,
      revalidate,
      liveKey: slot.key,
    });
    slot.attach(run.live);
    await run.done;
  });
};
