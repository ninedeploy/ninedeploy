import { z } from 'zod';
import { eq, servers, type DB } from '@ninedeploy/db';
import { volumeFileEntry } from '@ninedeploy/schemas';
import { assertNodeCapability } from './agentCapabilities.js';
import { agentOp, type AgentOpResult } from './agentClient.js';
import { HttpError, notFound } from './errors.js';

const ok = z.object({ ok: z.literal(true) });
const results = { list: z.array(volumeFileEntry).max(10000), read: z.object({ content: z.string().max(2 * 1024 * 1024), encoding: z.literal('base64') }), write: ok, mkdir: ok, delete: ok };
export type NodeVolumeFileAction = keyof typeof results;
export type NodeVolumeFileResult<A extends NodeVolumeFileAction> = z.output<(typeof results)[A]>;
const unconfirmed = () => new HttpError(502, 'node_volume_files_unconfirmed', 'Node volume response is unconfirmed; no local fallback was attempted');
export async function nodeVolumeFileTool<A extends NodeVolumeFileAction>(db: DB, serverId: number, volume: string, action: A, operands: { path?: string; contentBase64?: string } = {}): Promise<NodeVolumeFileResult<A>> {
  if (!await db.query.servers.findFirst({ where: eq(servers.id, serverId), columns: { id: true } })) throw notFound('Node not found');
  await assertNodeCapability(db, serverId, { cap: 'volume.files', feature: 'browse and edit volume files', sealedRequired: true });
  let reply: AgentOpResult;
  try { reply = await agentOp(db, serverId, 'volume.fileTool', { volume, action, ...operands }, () => undefined, { tolerateExit: true }); }
  catch { throw unconfirmed(); }
  const lines = reply.lines.filter(l => l.trim());
  if (lines.length !== 1 || Buffer.byteLength(lines[0]!) > 2 * 1024 * 1024) throw unconfirmed();
  let body: { ok?: unknown; result?: unknown; error?: unknown };
  try { body = JSON.parse(lines[0]!); } catch { throw unconfirmed(); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw unconfirmed();
  if (reply.exitCode !== 0) {
    const error = z.object({ status: z.union([z.literal(400), z.literal(404), z.literal(409), z.literal(413), z.literal(422), z.literal(502), z.literal(504)]), code: z.string().regex(/^[a-z_]{1,80}$/), message: z.string().max(1000) }).safeParse(body.error);
    if (body.ok === false && error.success) throw new HttpError(error.data.status, error.data.code, error.data.message);
    throw unconfirmed();
  }
  if (body.ok !== true) throw unconfirmed();
  const result = results[action].safeParse(body.result);
  if (!result.success) throw unconfirmed();
  if (action === 'read') {
    const content = (result.data as NodeVolumeFileResult<'read'>).content.replace(/\s/g, '');
    if (content.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content) || Buffer.byteLength(content, 'base64') > 1024 * 1024) throw unconfirmed();
  }
  return result.data as NodeVolumeFileResult<A>;
}
