import type { FastifyPluginAsync } from 'fastify';
import { and, inArray, isNotNull, eq } from 'drizzle-orm';
import { serviceTargets, services } from '@ninedeploy/db';
import { containerFileWrite, containerPathCreate } from '@ninedeploy/schemas';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';
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

export const containerRoutes: FastifyPluginAsync = async (app) => {
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

  // ── Get detailed inspect metadata and Traefik tags ────────────────────────
  // Admin-only: the inspect payload includes the container's full env (injected
  // DATABASE_URL/REDIS_URL credentials) — same power as the exec terminal.
  app.get('/:container/inspect', { preHandler: [app.requireAdmin] }, async (req) => {
    const container = await guardLocalContainer((req.params as { container: string }).container);
    return inspectContainer(container);
  });

  // ── Get runtime generated Docker Compose YAML manifest ───────────────────
  // Admin-only: the manifest renders every env var of the container.
  app.get('/:container/compose', { preHandler: [app.requireAdmin] }, async (req) => {
    const container = await guardLocalContainer((req.params as { container: string }).container);
    return getContainerComposeManifest(container);
  });

  // ── List directory contents inside container ──────────────────────────────
  app.get('/:container/files', { preHandler: [app.requireAdmin] }, async (req) => {
    const container = await guardLocalContainer((req.params as { container: string }).container);
    const target = guardPath((req.query as { path?: string }).path);
    const entries = await listContainerDir(container, target);
    return { path: target, entries };
  });

  // ── Read file content (base64) ───────────────────────────────────────────
  app.get('/:container/files/content', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const container = await guardLocalContainer((req.params as { container: string }).container);
    const target = guardPath((req.query as { path?: string }).path);
    if (target === '/') throw badRequest('invalid file path');
    void audit(app.db, req.user!.id, 'container.file.read', `${container}:${target}`);
    const file = await readContainerFile(container, target);
    reply.header('content-type', 'application/json');
    return file;
  });

  // ── Write / overwrite file (base64) ──────────────────────────────────────
  app.put('/:container/files', { preHandler: [app.requireAdmin] }, async (req) => {
    const container = await guardLocalContainer((req.params as { container: string }).container);
    const input = containerFileWrite.parse(req.body);
    const target = guardPath(input.path);
    if (target === '/') throw badRequest('invalid file path');
    void audit(app.db, req.user!.id, 'container.file.write', `${container}:${target}`);
    await writeContainerFile(container, target, input.contentBase64, (line) => req.log.info(line));
    return { ok: true };
  });

  // ── Create directory (mkdir -p) ──────────────────────────────────────────
  app.post('/:container/files/dir', { preHandler: [app.requireAdmin] }, async (req) => {
    const container = await guardLocalContainer((req.params as { container: string }).container);
    const input = containerPathCreate.parse(req.body);
    const target = guardPath(input.path);
    if (target === '/') throw badRequest('invalid directory path');
    void audit(app.db, req.user!.id, 'container.file.mkdir', `${container}:${target}`);
    await makeContainerDir(container, target);
    return { ok: true };
  });

  // ── Delete file or directory (rm -rf) ────────────────────────────────────
  app.delete('/:container/files', { preHandler: [app.requireAdmin] }, async (req) => {
    const container = await guardLocalContainer((req.params as { container: string }).container);
    const target = guardPath((req.query as { path?: string }).path);
    if (target === '/') throw badRequest('cannot delete root directory');
    void audit(app.db, req.user!.id, 'container.file.delete', `${container}:${target}`);
    await deleteContainerPath(container, target, (line) => req.log.info(line));
    return { ok: true };
  });
};
