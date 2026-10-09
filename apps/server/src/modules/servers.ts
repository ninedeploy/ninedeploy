import { and, eq } from 'drizzle-orm';
import { servers, serviceTargets, services, type DB, type ServerRow } from '@ninedeploy/db';
import { serverAnnounce, serverCreate, serverSshBootstrap, serverSshTest } from '@ninedeploy/schemas';
import type { FastifyPluginAsync } from 'fastify';
import { audit } from '../lib/audit.js';
import { decrypt, encrypt, secretEquals } from '../lib/crypto.js';
import { badRequest, conflict, HttpError, notFound, parseId, unauthorized } from '../lib/errors.js';
import { agentOp, agentPing, agentPingLines, generateAgentToken } from '../lib/agentClient.js';
import {
  nodeAgentInfo,
  nodeTerminalCapability,
  parseAgentCapabilities,
  refreshNodeCapabilities,
  serverFeatures,
} from '../lib/agentCapabilities.js';
import { ENROLMENT_HEADER, assertEnrolmentAllowed } from '../lib/enrolment.js';
import { bootstrapServer, getBootstrapLogs, testSshConnection } from '../engine/serverProvisioner.js';
import { agentDockerRunCommand } from '@ninedeploy/schemas';
import { VERSION } from '../version.js';
import { serverDeleteBlockers } from '../lib/serverDependents.js';
import { databasesPerServer } from '../lib/nodeDatabase.js';

/** r421: an endpoint's identity is (host, port) — but the announce/create
 *  schema accepts `host:port` spellings and DNS-vs-IP aliases. Strip a
 *  trailing `:port` from the host so `10.0.0.5:4600` + port 4600 does not
 *  fork a second row for one endpoint (r399's exact failure mode, returning
 *  through a spelling difference) or build `http://host:4600:4600/` URLs. */
/** Parse human sizes like "12.34MiB" into bytes (same rules as lib/stats.ts). */
function parseHumanBytes(input: string): number {
  const m = /^([\d.]+)\s*([A-Za-z]+)?$/.exec(input.trim());
  if (!m) return 0;
  const n = Number(m[1]);
  const u = (m[2] ?? 'b').toLowerCase();
  const mult =
    u === 'kb' || u === 'kib' ? 1024
    : u === 'mb' || u === 'mib' ? 1024 ** 2
    : u === 'gb' || u === 'gib' ? 1024 ** 3
    : u === 'tb' || u === 'tib' ? 1024 ** 4
    : 1;
  return n * mult;
}

function normalizeHost(raw: string): string {
  return raw.replace(/:\d+$/, '');
}

/** F204/F205: everything placed on a node — services whose PRIMARY placement
 *  it is (services.server_id, ON DELETE SET NULL: they would silently re-read
 *  as panel-host services) and the services it runs as a fan-out target
 *  (service_targets, ON DELETE CASCADE: the panel's only record of that
 *  container would vanish). Every route that deletes a server row must ask. */
async function hostedOn(db: DB, serverId: number) {
  const primary = await db.query.services.findMany({ where: eq(services.serverId, serverId) });
  const targetRows = await db.query.serviceTargets.findMany({ where: eq(serviceTargets.serverId, serverId) });
  const targets = [];
  for (const t of targetRows) {
    const svc = await db.query.services.findFirst({ where: eq(services.id, t.serviceId) });
    if (svc) targets.push(svc);
  }
  return { primary, targets, all: [...primary, ...targets] };
}

function serialize(s: ServerRow) {
  // r421 honesty: `online` was written by the LAST contact (boot announce,
  // manual test/approve) and nothing ever flipped it back — a node that died
  // kept its green badge forever. Report staleness at read time; the row's
  // own status stays untouched.
  const STALE_AFTER_MS = 5 * 60 * 1000;
  const stale = s.status === 'online' && (!s.lastSeenAt || Date.now() - s.lastSeenAt.getTime() > STALE_AFTER_MS);
  return {
    id: s.id,
    name: s.name,
    host: s.host,
    port: s.port,
    status: stale ? 'offline' : s.status,
    lastSeenAt: s.lastSeenAt ? s.lastSeenAt.toISOString() : null,
    createdAt: s.createdAt.toISOString(),
  };
}

/**
 * Remote server registry. Supports both manual registration by admin and
 * zero-touch auto-discovery announcements from edge agents.
 */
export const serverRoutes: FastifyPluginAsync = async (app) => {
  // Public announce route for self-registering edge agents.
  // When an agent starts with NINEDEPLOY_MASTER_URL, it announces its presence.
  // It is placed in 'pending' status until the admin clicks "Approve & Connect".
  app.post('/announce', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    // M-6: the one unauthenticated write in the product. It now requires the
    // admin-issued enrolment secret, checked BEFORE the body is parsed so an
    // anonymous caller learns nothing about the schema, and before any row is
    // read so it is not an existence oracle for host:port either.
    await assertEnrolmentAllowed(app.db, req.headers[ENROLMENT_HEADER] as string | undefined);
    const { name, host: providedHost, port, token } = serverAnnounce.parse(req.body ?? {});
    const host = normalizeHost(
      providedHost || (req.ip === '::1' || req.ip === '127.0.0.1' ? '127.0.0.1' : req.ip.replace(/^::ffff:/, '')),
    );

    const existing = await app.db.query.servers.findFirst({
      where: and(eq(servers.host, host), eq(servers.port, port)),
    });

    if (existing) {
      // Token takeover guard: the announce route is public, so an existing
      // (possibly approved) server's stored token may only be touched by an
      // announce presenting the SAME token. A different token never overwrites
      // the registry — that would break every subsequent agentOp deploy.
      const storedToken = existing.tokenEncrypted ? decrypt(existing.tokenEncrypted) : '';
      // Constant-time: `!==` on a secret leaks its prefix through response
      // timing, and this route is public. `secretEquals` hashes both sides so
      // the comparison is length-independent too.
      if (!secretEquals(storedToken, token)) {
        throw unauthorized(`A server is already registered at ${host}:${port}; token mismatch`);
      }
      await app.db
        .update(servers)
        .set({
          name,
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(servers.id, existing.id));
      return {
        ok: true,
        id: existing.id,
        status: existing.status,
        message: existing.status === 'online'
          ? 'Server already active and connected'
          : 'Server re-announced. Pending admin approval.',
      };
    }

    const [row] = await app.db
      .insert(servers)
      .values({
        name,
        host,
        port,
        tokenEncrypted: encrypt(token),
        status: 'pending',
      })
      .returning();

    if (!row) throw badRequest('Could not register announced server');

    return {
      ok: true,
      id: row.id,
      status: 'pending',
      message: 'Node announced successfully. Waiting for admin approval in the NineDeploy panel.',
    };
  });

  // Authenticated admin endpoints
  await app.register(async (authed) => {
    authed.addHook('onRequest', authed.authenticate);
    authed.addHook('preHandler', authed.requireAdmin);

    authed.get('/', async () => {
      const rows = await authed.db.query.servers.findMany();
      // ── 0.16 T6 node databases ── `databases` (additive): how many managed databases each node hosts.
      const hostedDatabases = await databasesPerServer(authed.db);
      // ── end 0.16 T6 ──
      // 0.15 (T2b): `terminal` (additive) says what the node's agent offers
      // terminals — from its last sealed `agent.ping`, refreshed at most every
      // 5 minutes and only for an online node. `host` is the node's own
      // switch; the panel's host-shell setting applies on top of it.
      // Multi-node (design §1.3, additive): `agent` is the capability cache
      // (version, capabilities, when it was checked; null until a sealed ping
      // answered) and `features` what the node can do, with the "update the
      // node agent" hint. Same refresh as `terminal` (which also persists it).
      return Promise.all(
        rows.map(async (row) => {
          const base = serialize(row);
          const terminal = await nodeTerminalCapability(authed.db, row.id, { online: base.status === 'online' });
          const agent = nodeAgentInfo(row);
          // ── 0.16 T4 build placement ── the build-server role (additive; PATCH /:id in serverRoles.ts)
          const roles = { isBuildServer: row.isBuildServer === true, buildConcurrency: row.buildConcurrency ?? 1 };
          // ── end 0.16 T4 ──
          // ── 0.16 T8 surfaces ── Swarm membership as recorded on join (additive; null = not in the swarm).
          const swarm = { swarmNodeId: row.swarmNodeId ?? null, swarmRole: row.swarmRole ?? null };
          // ── end 0.16 T8 ──
          return { ...base, terminal, agent, features: serverFeatures(agent), ...roles, databases: hostedDatabases.get(row.id) ?? 0, ...swarm };
        }),
      );
    });

    authed.post('/', async (req) => {
      const { name, host: rawHost, port } = serverCreate.parse(req.body ?? {});
      const host = normalizeHost(rawHost);
      // r399: (host, port) is unique — a second row for the same endpoint
      // would fight the first over which token the agent actually holds.
      const existing = await authed.db.query.servers.findFirst({ where: and(eq(servers.host, host), eq(servers.port, port)) });
      if (existing) {
        throw conflict(`Node "${existing.name}" is already registered at ${host}:${port} — re-run its bootstrap or delete it first`);
      }
      const token = generateAgentToken();
      const [row] = await authed.db
        .insert(servers)
        .values({ name, host, port, tokenEncrypted: encrypt(token), status: 'offline' })
        .returning();
      if (!row) throw badRequest('Could not register server');
      void audit(authed.db, req.user!.id, 'server.register', name);
      const { createHash } = await import('node:crypto');
      const tokenSha256 = createHash('sha256').update(token).digest('hex');
      // r175: the shared builder — see @ninedeploy/schemas agentCommand.
      const agentCommand = agentDockerRunCommand({ hostPort: port, imageTag: `v${VERSION}`, tokenSha256 });
      return {
        ...serialize(row),
        token,
        tokenSha256,
        agentCommand,
      };
    });

    authed.delete('/:id', async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const row = await authed.db.query.servers.findFirst({ where: eq(servers.id, id) });
      if (!row) throw notFound('Server not found');

      // ── 0.16 T6 server delete guard (M7) ──
      // Dependents a delete must never orphan, even with ?force=true (node
      // databases, design §5.7; a Swarm member, T7). The T1 stub reported none, so the route
      // behaves exactly as before.
      const blockers = await serverDeleteBlockers(authed.db, id);
      if (blockers.length > 0) {
        throw new HttpError(409, blockers[0]!.code, blockers.map((b) => b.message).join(' '));
      }
      // ── end 0.16 T6 ──

      const hosted = await hostedOn(authed.db, id);
      const hostedServices = hosted.primary;
      const force = (req.query as { force?: string }).force === 'true';
      if (hosted.all.length > 0 && !force) {
        const names = hosted.all.map((s) => s.name).join(', ');
        throw badRequest(
          `Cannot delete server "${row.name}": It is locked and actively hosting ${hosted.all.length} service(s) (${names}). Reassign or delete these services first or pass ?force=true.`,
        );
      }

      await authed.db.delete(servers).where(eq(servers.id, id));
      void audit(authed.db, req.user!.id, 'server.delete', `#${id}`);
      // r399: with ?force=true the hosted services survive as orphans — their
      // containers live on the removed node while the panel now believes they
      // are local. Name them so the operator knows what was left behind.
      return {
        ok: true,
        ...(force && hostedServices.length > 0
          ? {
              orphanedServices: hostedServices.map((s) => ({ id: s.id, name: s.name, slug: s.slug })),
              note: `${hostedServices.length} service(s) were hosted on this node; their containers remain on the removed host and the services now read as local — delete or reassign them.`,
            }
          : {}),
        // F205: fan-out targets on the removed node — their target rows are
        // gone (cascade) but the containers still run there.
        ...(force && hosted.targets.length > 0
          ? { orphanedTargets: hosted.targets.map((s) => ({ id: s.id, name: s.name, slug: s.slug })) }
          : {}),
      };
    });

    // Connectivity + auth probe; on success the server is marked online.
    authed.post('/:id/test', async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const row = await authed.db.query.servers.findFirst({ where: eq(servers.id, id) });
      if (!row) throw notFound('Server not found');
      let ping: Awaited<ReturnType<typeof agentPingLines>>;
      try {
        ping = await agentPingLines(row.host, row.port, decrypt(row.tokenEncrypted));
      } catch (err) {
        await authed.db.update(servers).set({ status: 'error' }).where(eq(servers.id, id));
        throw badRequest(`Agent unreachable: ${err instanceof Error ? err.message : err}`);
      }
      await authed.db.update(servers).set({ status: 'online', lastSeenAt: new Date() }).where(eq(servers.id, id));
      // Multi-node (design §1.3): a successful sealed ping refreshes the cache —
      // the in-memory answer too, so an agent upgrade shows at once instead of
      // after the 5-minute TTL. A failed ping (above) keeps the last answer.
      if (ping?.lines) await refreshNodeCapabilities(authed.db, id, parseAgentCapabilities(ping.lines));
      void audit(authed.db, req.user!.id, 'server.test', row.name);
      return { ok: true, status: 'online' };
    });

    // r467: live node telemetry for the Monitoring page. The agent reports
    // host os stats (one ND-HOST JSON line), per-container docker stats and
    // one ND-DF line; the panel joins container names to the service rows
    // pinned to this node, exactly like /v1/stats does for the panel host.
    authed.get('/:id/stats', async (req) => {
      const id = parseId((req.params as { id: string }).id);
      let res: Awaited<ReturnType<typeof agentOp>>;
      try {
        // tolerateExit (r470): agent.stats' exit code IS its result — docker
        // stats failing on the node is a different failure from the node being
        // unreachable, and agentOp's throw would collapse both into the
        // "unreachable" message below.
        res = await agentOp(authed.db, id, 'agent.stats', {}, () => undefined, { tolerateExit: true });
      } catch (err) {
        throw badRequest(`Node agent unreachable: ${err instanceof Error ? err.message : err}`);
      }
      if (res.exitCode !== 0) {
        throw badRequest(`Node agent failed to collect stats (exit ${res.exitCode})`);
      }
      const MB = 1024 * 1024;
      let host: { cpuCores: number; load1: number; memTotalBytes: number; memUsedBytes: number } | null = null;
      let disk: { totalBytes: number; usedBytes: number } = { totalBytes: 0, usedBytes: 0 };
      const containers = new Map<string, { cpuPct: number; memBytes: number }>();
      for (const line of res.lines) {
        if (line.startsWith('ND-HOST ')) {
          try {
            host = JSON.parse(line.slice('ND-HOST '.length)) as typeof host;
          } catch { /* keep null — the cards degrade to placeholders */ }
        } else if (line.startsWith('ND-DF ')) {
          // df -kP (POSIX, one line per fs): blocks are 1K; cols: fs total used ...
          const parts = line.slice('ND-DF '.length).trim().split(/\s+/);
          if (parts.length >= 3) {
            disk = { totalBytes: Number(parts[1]) * 1024, usedBytes: Number(parts[2]) * 1024 };
          }
        } else {
          const [name, cpu, mem] = line.split('|');
          const clean = (name ?? '').trim().replace(/^\//, '');
          if (!clean || cpu === undefined) continue;
          const used = String(mem ?? ' / ').split('/')[0]!;
          containers.set(clean, {
            cpuPct: Number(cpu!.replace('%', '').trim()) || 0,
            memBytes: parseHumanBytes(used),
          });
        }
      }
      const nodeServices = await authed.db.query.services.findMany({
        where: eq(services.serverId, id),
      });
      const out = [];
      for (const s of nodeServices) {
        if (!s.runtimeId) continue;
        const st = containers.get(s.runtimeId);
        if (!st) continue;
        out.push({
          name: s.runtimeId,
          kind: 'service' as const,
          refId: s.id,
          refName: s.name,
          cpuPct: st.cpuPct,
          memMb: +(st.memBytes / MB).toFixed(1),
          memLimitMb: s.memLimitMb ?? 0,
        });
      }
      return { host, disk, containers: out };
    });

    // Approve a discovered / pending server node.
    authed.post('/:id/approve', async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const row = await authed.db.query.servers.findFirst({ where: eq(servers.id, id) });
      if (!row) throw notFound('Server not found');
      try {
        await agentPing(row.host, row.port, decrypt(row.tokenEncrypted));
      } catch (err) {
        await authed.db.update(servers).set({ status: 'error' }).where(eq(servers.id, id));
        throw badRequest(`Agent unreachable: ${err instanceof Error ? err.message : err}`);
      }
      await authed.db.update(servers).set({ status: 'online', lastSeenAt: new Date() }).where(eq(servers.id, id));
      void audit(authed.db, req.user!.id, 'server.approve', row.name);
      authed.kernel?.events.emit('server.approved', {
        serverId: row.id,
        approvedByUserId: req.user!.id,
      });
      return { ok: true, status: 'online' };
    });

    // Reject a discovered / pending server node.
    authed.post('/:id/reject', async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const row = await authed.db.query.servers.findFirst({ where: eq(servers.id, id) });
      if (!row) throw notFound('Server not found');
      // F204: reject discards a node that announced itself and was never
      // approved. It used to delete ANY row with no hosted-services guard, so
      // rejecting an approved node (a stale pending card, a direct API call)
      // silently moved its services to the panel host. Anything else goes
      // through DELETE and its guard.
      if (row.status !== 'pending') {
        throw conflict(`Server "${row.name}" is not pending approval — delete it instead`);
      }
      const hosted = await hostedOn(authed.db, id);
      if (hosted.all.length > 0) {
        throw conflict(`Server "${row.name}" hosts ${hosted.all.length} service(s) — reassign them, then delete it instead`);
      }
      await authed.db.delete(servers).where(eq(servers.id, id));
      void audit(authed.db, req.user!.id, 'server.reject', row.name);
      authed.kernel?.events.emit('server.rejected', {
        serverId: row.id,
      });
      return { ok: true };
    });

    // Zero-Touch SSH Connection Pre-Flight Test
    authed.post('/ssh-test', async (req) => {
      const input = serverSshTest.parse(req.body ?? {});
      // r661: records / checks the host key against the settings table.
      return testSshConnection(input, authed.db);
    });

    // Zero-Touch SSH Automated Server Bootstrap
    authed.post('/ssh-bootstrap', async (req) => {
      const input = serverSshBootstrap.parse(req.body ?? {});
      const result = await bootstrapServer(authed.db, input);
      if (!result.ok) {
        throw badRequest(result.error || 'Server bootstrap failed');
      }
      void audit(authed.db, req.user!.id, 'server.ssh_bootstrap', input.name);
      return result;
    });

    // Retrieve Bootstrap Logs for a server
    authed.get('/:id/bootstrap-logs', async (req) => {
      const id = parseId((req.params as { id: string }).id);
      const logs = getBootstrapLogs(id);
      return { logs };
    });
  });
};

