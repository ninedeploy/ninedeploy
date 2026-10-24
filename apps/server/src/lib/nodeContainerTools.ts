import { z } from 'zod';
import { eq, servers, type DB } from '@ninedeploy/db';
import { volumeFileEntry } from '@ninedeploy/schemas';
import { assertNodeCapability } from './agentCapabilities.js';
import { agentOp, type AgentOpResult } from './agentClient.js';
import { HttpError, notFound } from './errors.js';

const inspect = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), name: z.string(), image: z.string(),
  state: z.object({ status: z.string(), running: z.boolean(), startedAt: z.string(), finishedAt: z.string(), exitCode: z.number().int(), error: z.string() }),
  labels: z.record(z.string(), z.string()), traefikTags: z.record(z.string(), z.string()), env: z.array(z.string()), ports: z.record(z.string(), z.unknown()),
  mounts: z.array(z.object({ source: z.string(), destination: z.string(), mode: z.string(), rw: z.boolean() })), networks: z.array(z.string()),
  resources: z.object({ memoryLimitBytes: z.number(), memorySwapBytes: z.number(), cpuShares: z.number(), nanoCpus: z.number(), restartPolicy: z.string() }), raw: z.record(z.string(), z.unknown()),
});
const ok = z.object({ ok: z.literal(true) });
const results = {
  inspect, compose: z.object({ yaml: z.string(), inspect }), list: z.array(volumeFileEntry).max(10000),
  read: z.object({ content: z.string().max(2 * 1024 * 1024), encoding: z.literal('base64') }), write: ok, mkdir: ok, delete: ok,
};
export type NodeContainerAction = keyof typeof results;
export type NodeContainerResult<K extends NodeContainerAction> = z.output<(typeof results)[K]>;
const failed = () => new HttpError(502, 'node_container_unconfirmed', 'Node container response is unconfirmed; no local fallback was attempted');

/** Explicit node identity and sealed, negotiated operation; never falls back to the panel daemon. */
export async function nodeContainerTool<K extends NodeContainerAction>(db: DB, serverId: number, container: string, action: K, operands: { path?: string; contentBase64?: string } = {}): Promise<NodeContainerResult<K>> {
  const node = await db.query.servers.findFirst({ where: eq(servers.id, serverId), columns: { id: true } });
  if (!node) throw notFound('Node not found');
  await assertNodeCapability(db, serverId, { cap: 'docker.containerTools', feature: 'inspect containers and manage their files', sealedRequired: true });
  let response: AgentOpResult;
  try { response = await agentOp(db, serverId, 'docker.containerTool', { action, container, ...operands }, () => undefined, { tolerateExit: true }); }
  catch { throw failed(); }
  const lines = response.lines.filter(line => line.trim());
  if (lines.length !== 1 || Buffer.byteLength(lines[0]!) > 2 * 1024 * 1024) throw failed();
  let body: { ok?: unknown; result?: unknown; error?: unknown };
  try { body = JSON.parse(lines[0]!); } catch { throw failed(); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw failed();
  if (response.exitCode !== 0) {
    const error = z.object({ status: z.union([z.literal(400), z.literal(404), z.literal(409), z.literal(413), z.literal(422), z.literal(502), z.literal(504)]), code: z.string().regex(/^[a-z_]{1,80}$/), message: z.string().max(1000) }).safeParse(body.error);
    if (body.ok === false && error.success) throw new HttpError(error.data.status, error.data.code, error.data.message);
    throw failed();
  }
  if (body.ok !== true) throw failed();
  const result = results[action].safeParse(body.result);
  if (!result.success) throw failed();
  if (action === 'read') {
    const content = (result.data as NodeContainerResult<'read'>).content.replace(/\s/g, '');
    if (content.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content) || Buffer.byteLength(content, 'base64') > 1024 * 1024) throw failed();
  }
  return result.data as NodeContainerResult<K>;
}
