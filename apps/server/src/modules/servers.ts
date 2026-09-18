import { and, eq } from 'drizzle-orm';
import { servers, services, type ServerRow } from '@ninedeploy/db';
import { serverAnnounce, serverCreate, serverSshBootstrap, serverSshTest } from '@ninedeploy/schemas';
import type { FastifyPluginAsync } from 'fastify';
import { audit } from '../lib/audit.js';
import { decrypt, encrypt, secretEquals } from '../lib/crypto.js';
import { badRequest, notFound, parseId, unauthorized } from '../lib/errors.js';
import { agentPing, generateAgentToken } from '../lib/agentClient.js';
import { ENROLMENT_HEADER, assertEnrolmentAllowed } from '../lib/enrolment.js';
import { bootstrapServer, getBootstrapLogs, testSshConnection } from '../engine/serverProvisioner.js';
import { agentDockerRunCommand } from '@ninedeploy/schemas';
import { VERSION } from '../version.js';

function serialize(s: ServerRow) {
  return {
    id: s.id,
    name: s.name,
    host: s.host,
    port: s.port,
    status: s.status,
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
    const host = providedHost || (req.ip === '::1' || req.ip === '127.0.0.1' ? '127.0.0.1' : req.ip.replace(/^::ffff:/, ''));

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
      return rows.map(serialize);
    });

    authed.post('/', async (req) => {
      const { name, host, port } = serverCreate.parse(req.body ?? {});
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

      const hostedServices = await authed.db.query.services.findMany({
        where: eq(services.serverId, id),
      });
      const force = (req.query as { force?: string }).force === 'true';
      if (hostedServices.length > 0 && !force) {
        const names = hostedServices.map((s) => s.name).join(', ');
        throw badRequest(
          `Cannot delete server "${row.name}": It is locked and actively hosting ${hostedServices.length} service(s) (${names}). Reassign or delete these services first or pass ?force=true.`,
        );
      }

      await authed.db.delete(servers).where(eq(servers.id, id));
      void audit(authed.db, req.user!.id, 'server.delete', `#${id}`);
      return { ok: true };
    });

    // Connectivity + auth probe; on success the server is marked online.
    authed.post('/:id/test', async (req) => {
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
      void audit(authed.db, req.user!.id, 'server.test', row.name);
      return { ok: true, status: 'online' };
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
      return testSshConnection(input);
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

