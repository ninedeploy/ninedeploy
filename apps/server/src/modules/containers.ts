import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { and, inArray, isNotNull, eq } from 'drizzle-orm';
import { serviceTargets, services } from '@ninedeploy/db';
import { containerFileWrite, containerPathCreate } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden, HttpError, parseId } from '../lib/errors.js';
import { nodeContainerTool } from '../lib/nodeContainerTools.js';
import {
  deleteContainerPath,
  getContainerComposeManifest,
  inspectContainer,
  isManagedContainer,
  listContainerDir,
  makeContainerDir,
  readContainerFile,
  safeContainerPath,
  writeContainerFile,
} from '../engine/containerFiles.js';

export const containerRoutes: FastifyPluginAsync<{ nodeRoute?: boolean }> = async (app, options) => {
  app.addHook('onRequest', app.authenticate);

  const guardContainer = (container: string): string => {
    if (!isManagedContainer(container)) throw badRequest('invalid container');
    return container;
  };

  /**
   * r665: every route here runs the PANEL host's docker CLI. A service pinned
   * to a remote node runs its containers on that node, so they answered "No
   * such container" — or reached a same-named local container instead. Refuse
   * them up front with the reason (replicas `<runtimeId>-rN` and fan-out
   * target generations included).
   */
  const guardLocalContainer = async (raw: string): Promise<string> => {
    const container = guardContainer(raw);
    const primary = container.replace(/-r\d+$/, '');
    const svc = await app.db.query.services.findFirst({
      where: and(inArray(services.runtimeId, [container, primary]), isNotNull(services.serverId)),
    });
    const target = svc ? undefined : await app.db.query.serviceTargets.findFirst({ where: eq(serviceTargets.runtimeId, container) });
    const serverId = svc?.serverId ?? target?.serverId;
    if (serverId != null) {
      throw badRequest(
        `Container ${container} runs on remote node #${serverId} — inspect, compose and file access only reach containers on the panel host. Use docker on the node itself.`,
        'remote_container',
      );
    }
    return container;
  };

  const guardPath = (raw: unknown): string => {
    const safe = safeContainerPath(String(raw ?? '/'));
    if (safe === null) throw badRequest('invalid path');
    return safe;
  };

  const resolveContainer = async (req: FastifyRequest) => {
    const query = req.query as Record<string, unknown>;
    // A separate URI for node tools fails closed on older panels. Never let an
    // ignored host query silently turn a node operation into a local one.
    if (Object.keys(query).some(key => key !== 'path')) throw badRequest('Use the node container endpoint for an explicit node; unknown query parameter');
    const params = req.params as { container: string; serverId?: string };
    if (options.nodeRoute) {
      if (!req.user?.isOperator) throw forbidden('Only instance operators may use node container tools');
      return { container: guardContainer(params.container), serverId: parseId(params.serverId!, 'Invalid node id') };
    }
    return { container: await guardLocalContainer(params.container), serverId: undefined };
  };
  const auditIdentity = (container: string, serverId: number | undefined) => serverId == null ? container : `node #${serverId} ${container}`;

  // ── Get detailed inspect metadata and Traefik tags ────────────────────────
  // Admin-only: the inspect payload includes the container's full env (injected
  // DATABASE_URL/REDIS_URL credentials) — same power as the exec terminal.
  app.get('/:container/inspect', { preHandler: [app.requireAdmin] }, async (req) => {
    const { container, serverId } = await resolveContainer(req);
    return serverId == null ? inspectContainer(container) : nodeContainerTool(app.db, serverId, container, 'inspect');
  });

  // ── Get runtime generated Docker Compose YAML manifest ───────────────────
  // Admin-only: the manifest renders every env var of the container.
  app.get('/:container/compose', { preHandler: [app.requireAdmin] }, async (req) => {
    const { container, serverId } = await resolveContainer(req);
    return serverId == null ? getContainerComposeManifest(container) : nodeContainerTool(app.db, serverId, container, 'compose');
  });

  // ── List directory contents inside container ──────────────────────────────
  app.get('/:container/files', { preHandler: [app.requireAdmin] }, async (req) => {
    const { container, serverId } = await resolveContainer(req);
    const target = guardPath((req.query as { path?: string }).path);
    const entries = serverId == null ? await listContainerDir(container, target) : await nodeContainerTool(app.db, serverId, container, 'list', { path: target });
    return { path: target, entries };
  });

  // ── Read file content (base64) ───────────────────────────────────────────
  app.get('/:container/files/content', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const { container, serverId } = await resolveContainer(req);
    const target = guardPath((req.query as { path?: string }).path);
    if (target === '/') throw badRequest('invalid file path');
    void audit(app.db, req.user!.id, 'container.file.read', `${auditIdentity(container, serverId)}:${target}`);
    const file = serverId == null ? await readContainerFile(container, target) : await nodeContainerTool(app.db, serverId, container, 'read', { path: target });
    reply.header('content-type', 'application/json');
    return file;
  });

  // ── Write / overwrite file (base64) ──────────────────────────────────────
  app.put('/:container/files', { preHandler: [app.requireAdmin], bodyLimit: 2 * 1024 * 1024 }, async (req) => {
    const { container, serverId } = await resolveContainer(req);
    const input = containerFileWrite.parse(req.body);
    const target = guardPath(input.path);
    if (target === '/') throw badRequest('invalid file path');
    const nodeContentBase64 = input.contentBase64.replace(/\s/g, '');
    if (serverId != null && Buffer.byteLength(nodeContentBase64, 'base64') > 1024 * 1024) {
      throw new HttpError(413, 'file_too_large', 'Node file writes are limited to 1 MiB; no file was changed');
    }
    void audit(app.db, req.user!.id, 'container.file.write', `${auditIdentity(container, serverId)}:${target}`);
    if (serverId == null) await writeContainerFile(container, target, input.contentBase64, (line) => req.log.info(line));
    else await nodeContainerTool(app.db, serverId, container, 'write', { path: target, contentBase64: nodeContentBase64 });
    return { ok: true };
  });

  // ── Create directory (mkdir -p) ──────────────────────────────────────────
  app.post('/:container/files/dir', { preHandler: [app.requireAdmin] }, async (req) => {
    const { container, serverId } = await resolveContainer(req);
    const input = containerPathCreate.parse(req.body);
    const target = guardPath(input.path);
    if (target === '/') throw badRequest('invalid directory path');
    void audit(app.db, req.user!.id, 'container.file.mkdir', `${auditIdentity(container, serverId)}:${target}`);
    if (serverId == null) await makeContainerDir(container, target);
    else await nodeContainerTool(app.db, serverId, container, 'mkdir', { path: target });
    return { ok: true };
  });

  // ── Delete file or directory (rm -rf) ────────────────────────────────────
  app.delete('/:container/files', { preHandler: [app.requireAdmin] }, async (req) => {
    const { container, serverId } = await resolveContainer(req);
    const target = guardPath((req.query as { path?: string }).path);
    if (target === '/') throw badRequest('cannot delete root directory');
    void audit(app.db, req.user!.id, 'container.file.delete', `${auditIdentity(container, serverId)}:${target}`);
    if (serverId == null) await deleteContainerPath(container, target, (line) => req.log.info(line));
    else await nodeContainerTool(app.db, serverId, container, 'delete', { path: target });
    return { ok: true };
  });
};
