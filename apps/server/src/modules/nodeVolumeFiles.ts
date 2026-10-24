import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { volumeFileWrite, volumePathCreate } from '@ninedeploy/schemas';
import { isManagedVolume } from '../agentOps/operands.js';
import { safeRelPath } from '../engine/volumeFiles.js';
import { nodeVolumeFileTool } from '../lib/nodeVolumeFiles.js';
import { badRequest, forbidden, HttpError, parseId } from '../lib/errors.js';
import { audit } from '../lib/audit.js';

const query = z.object({ path: z.string().max(2048).optional() }).strict();
export const nodeVolumeFileRoutes: FastifyPluginAsync = async app => {
  app.addHook('onRequest', app.authenticate);
  app.addHook('preHandler', app.requireAdmin);
  const target = (req: FastifyRequest, fromQuery = true) => {
    if (!req.user?.isOperator) throw forbidden('Only instance operators may use node volume tools');
    const { serverId, name } = req.params as { serverId: string; name: string };
    if (!isManagedVolume(name)) throw badRequest('not a managed volume');
    const parsed = (fromQuery ? query : z.object({}).strict()).parse(req.query);
    const rel = safeRelPath('path' in parsed ? String(parsed.path ?? '') : '');
    if (rel === null || rel.includes('\r')) throw badRequest('invalid path');
    return { serverId: parseId(serverId, 'Invalid node id'), name, rel };
  };
  app.get('/:name/files', async req => {
    const { serverId, name, rel } = target(req);
    return { path: rel, entries: await nodeVolumeFileTool(app.db, serverId, name, 'list', { path: rel }) };
  });
  app.get('/:name/files/content', async (req, reply) => {
    const { serverId, name, rel } = target(req);
    if (!rel) throw badRequest('a file path is required');
    void audit(app.db, req.user!.id, 'volume.file.read', `node #${serverId} ${name}:${rel}`); reply.header('Cache-Control', 'no-store');
    return nodeVolumeFileTool(app.db, serverId, name, 'read', { path: rel });
  });
  app.put('/:name/files', { bodyLimit: 2 * 1024 * 1024 }, async req => {
    const { serverId, name } = target(req, false), input = volumeFileWrite.parse(req.body), rel = safeRelPath(input.path);
    if (!rel || rel.includes('\r')) throw badRequest('a path inside the volume is required');
    const contentBase64 = input.contentBase64.replace(/\s/g, '');
    if (Buffer.byteLength(contentBase64, 'base64') > 1024 * 1024) throw new HttpError(413, 'file_too_large', 'File exceeds the 1 MiB editor limit');
    void audit(app.db, req.user!.id, 'volume.file.write', `node #${serverId} ${name}:${rel}`);
    return nodeVolumeFileTool(app.db, serverId, name, 'write', { path: rel, contentBase64 });
  });
  app.post('/:name/files/dir', async req => {
    const { serverId, name } = target(req, false), input = volumePathCreate.parse(req.body), rel = safeRelPath(input.path);
    if (!rel || rel.includes('\r')) throw badRequest('a path inside the volume is required');
    void audit(app.db, req.user!.id, 'volume.file.mkdir', `node #${serverId} ${name}:${rel}`);
    return nodeVolumeFileTool(app.db, serverId, name, 'mkdir', { path: rel });
  });
  app.delete('/:name/files', async req => {
    const { serverId, name, rel } = target(req);
    if (!rel) throw badRequest('a path inside the volume is required');
    void audit(app.db, req.user!.id, 'volume.file.delete', `node #${serverId} ${name}:${rel}`);
    return nodeVolumeFileTool(app.db, serverId, name, 'delete', { path: rel });
  });
};
