import { randomUUID } from 'node:crypto';
import { isIPv6 } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { databases, servers, type Database, type DB } from '@ninedeploy/db';
import { z } from 'zod';
import { agentOp, agentTransportSealed } from './agentClient.js';
import { capabilityRefusal, nodeLabel, type AgentCaller } from './agentCapabilities.js';
import { decrypt, sha256 } from './crypto.js';
import { isRedisFamily } from './databaseCommands.js';
import { HttpError, notFound } from './errors.js';
import { withNodeDatabaseLifecycle } from './nodeDatabaseLifecycle.js';
import { nodeStudioIdentity, nodeStudioResource, type NodeStudioIdentity } from './nodeStudioRuntime.js';
import { StudioRelayChannel } from './studioRelayChannel.js';
import { deriveFrameKey } from './agentFrameCipher.js';
import { STUDIO_RELAY_HKDF_INFO, STUDIO_RELAY_PATH, STUDIO_RELAY_PROTOCOL_PREFIX, studioRequestHeaders, type StudioRelayRequest } from './studioRelayProtocol.js';

const resourceShape = nodeStudioResource.shape;
const pending = z.object({ phase: z.literal('preparing'), ...resourceShape, attemptId: z.string().uuid(), previous: nodeStudioIdentity.optional() }).strict();
const ready = z.object({ phase: z.literal('ready'), identity: nodeStudioIdentity }).strict();
export const nodeStudioRecord = z.discriminatedUnion('phase', [pending, ready]);
export type NodeStudioRecord = z.infer<typeof nodeStudioRecord>;
const failed = () => new HttpError(502, 'node_studio_unconfirmed', 'The node Web Studio operation could not be confirmed');
const changed = () => new HttpError(409, 'node_studio_identity_changed', 'The recorded Web Studio target changed; reopen it from the database page');

export function storedNodeStudio(d: Database): NodeStudioRecord | null {
  if (!d.nodeStudioIdentity) return null;
  let record: NodeStudioRecord;
  try { record = nodeStudioRecord.parse(JSON.parse(d.nodeStudioIdentity)); } catch { throw changed(); }
  const resource = record.phase === 'ready' ? record.identity : record;
  if (resource.databaseId !== d.id || resource.slug !== d.slug || resource.engine !== d.engine) throw changed();
  if (record.phase === 'preparing' && record.previous && (record.previous.databaseId !== d.id || record.previous.slug !== d.slug || record.previous.engine !== d.engine)) throw changed();
  return record;
}
export function nodeStudioState(d: Database): 'preparing' | 'ready' | 'cleanup_pending' | null {
  if (d.serverId == null || !d.nodeStudioIdentity && !d.webGuiEnabled) return null;
  try {
    const record = storedNodeStudio(d);
    if (record?.phase === 'preparing') return 'preparing';
    return record?.phase === 'ready' && d.webGuiEnabled ? 'ready' : 'cleanup_pending';
  } catch { return 'cleanup_pending'; }
}
function nodeOf(d: Database): number {
  if (d.serverId == null || !Number.isSafeInteger(d.serverId) || d.serverId < 1) throw changed();
  return d.serverId;
}
function resourceOf(d: Database) {
  const parsed = nodeStudioResource.safeParse({ databaseId: d.id, slug: d.slug, engine: d.engine });
  if (!parsed.success) throw new HttpError(422, 'studio_engine_unsupported', 'Web Studio is not available for this database engine');
  return parsed.data;
}
export async function assertNodeStudioSupport(db: DB, serverId: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const caller: AgentCaller = (op, params, sink) => agentOp(db, serverId, op, params, sink, { timeoutMs: 15_000, signal });
  const refusal = await capabilityRefusal(caller, await nodeLabel(db, serverId), await agentTransportSealed(db, serverId), {
    cap: ['db.manage', 'db.studio'], feature: 'open database Web Studio', sealedRequired: true, persist: { db, serverId },
  });
  signal?.throwIfAborted();
  if (refusal) throw new HttpError(refusal.status, refusal.code, refusal.message);
}
async function operation(db: DB, serverId: number, op: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  let reply: Awaited<ReturnType<typeof agentOp>>;
  try { reply = await agentOp(db, serverId, op, params, () => undefined, { tolerateExit: true, signal }); }
  catch { signal?.throwIfAborted(); await assertNodeStudioSupport(db, serverId, signal); throw failed(); }
  if (reply.lines.length !== 1 || !reply.lines[0]!.startsWith('ND-STUDIO ')) throw failed();
  let value: unknown;
  try { value = JSON.parse(reply.lines[0]!.slice('ND-STUDIO '.length)); } catch { throw failed(); }
  if (reply.exitCode !== 0) {
    const error = z.object({ error: z.object({ status: z.number().int().min(400).max(599), code: z.string().regex(/^[a-z][a-z0-9_]{0,80}$/), message: z.string().min(1).max(256) }).strict() }).strict().safeParse(value);
    if (!error.success) throw failed();
    throw new HttpError(error.data.error.status, error.data.error.code, error.data.error.message);
  }
  return value;
}
async function load(db: DB, id: number): Promise<Database> {
  const d = await db.query.databases.findFirst({ where: eq(databases.id, id) });
  if (!d) throw notFound('Database not found'); nodeOf(d); return d;
}
async function store(db: DB, d: Database, record: NodeStudioRecord | null, enabled: boolean): Promise<void> {
  const value = record ? JSON.stringify(record) : null;
  // A late reply belongs only to the target admitted before remote IO.
  // Checking after an unconditional write would already overwrite a moved row.
  await db.update(databases).set({ nodeStudioIdentity: value, webGuiEnabled: enabled, webGuiPort: null })
    .where(and(eq(databases.id, d.id), eq(databases.serverId, nodeOf(d)), eq(databases.slug, d.slug), eq(databases.engine, d.engine)));
  const current = await load(db, d.id);
  if (current.serverId !== d.serverId || current.slug !== d.slug || current.engine !== d.engine || current.nodeStudioIdentity !== value || current.webGuiEnabled !== enabled || current.webGuiPort !== null) throw changed();
}
/** Keep the resource lock until the node has answered, including after browser
 * cancellation. A durable preparing receipt survives a lost reply/restart. */
export async function startNodeStudioForDatabase(db: DB, databaseId: number, signal?: AbortSignal): Promise<NodeStudioIdentity> {
  return withNodeDatabaseLifecycle(databaseId, async () => {
    const d = await load(db, databaseId), serverId = nodeOf(d), resource = resourceOf(d), record = storedNodeStudio(d);
    const previous = record?.phase === 'ready' ? record.identity : record?.previous;
    const preparing: NodeStudioRecord = { phase: 'preparing', ...resource, attemptId: randomUUID(), ...(previous ? { previous } : {}) };
    await assertNodeStudioSupport(db, serverId, signal);
    signal?.throwIfAborted();
    await store(db, d, preparing, d.webGuiEnabled && previous !== undefined);
    let candidate: NodeStudioIdentity | undefined;
    try {
      const value = await operation(db, serverId, 'db.studio.start', { ...resource,
        ...(isRedisFamily(d.engine) ? { password: decrypt(d.passwordEncrypted) } : {}), ...(previous ? { previous } : {}),
      });
      const parsed = nodeStudioIdentity.safeParse(value);
      if (!parsed.success || parsed.data.databaseId !== d.id || parsed.data.slug !== d.slug || parsed.data.engine !== d.engine) throw failed();
      candidate = parsed.data;
      signal?.throwIfAborted();
      await store(db, d, { phase: 'ready', identity: candidate }, true);
      signal?.throwIfAborted();
      return candidate;
    } catch (error) {
      if (candidate && candidate.containerId !== previous?.containerId) {
        try {
          const stopped = z.object({ stopped: z.literal(candidate.containerId) }).strict().safeParse(await operation(db, serverId, 'db.studio.stop', candidate));
          if (!stopped.success) throw failed();
        } catch { await store(db, d, preparing, false).catch(() => undefined); throw failed(); }
      }
      const restored = candidate?.containerId === previous?.containerId && previous ? { phase: 'ready' as const, identity: previous } : preparing;
      await store(db, d, restored, restored.phase === 'ready' && d.webGuiEnabled).catch(() => undefined);
      throw error;
    }
  });
}
/** Caller must hold withNodeDatabaseLifecycle when combining this with a
 * database stop/delete/recreate. Keep the receipt on any unconfirmed cleanup. */
export async function clearNodeStudioForMutation(db: DB, d: Database): Promise<void> {
  const record = storedNodeStudio(d);
  if (!record && !d.webGuiEnabled) return;
  const serverId = nodeOf(d), resource = resourceOf(d);
  await assertNodeStudioSupport(db, serverId);
  await store(db, d, record, false);
  const reply = z.object({ stopped: z.union([z.string().regex(/^[a-f0-9]{64}$/), z.null()]) }).strict().safeParse(await operation(db, serverId, 'db.studio.clear', {
    ...resource, ...(record?.phase === 'ready' ? { previous: record.identity } : {}),
  }));
  if (!reply.success || record?.phase === 'ready' && reply.data.stopped !== null && reply.data.stopped !== record.identity.containerId) throw failed();
  await store(db, d, null, false);
}
export async function stopNodeStudioForDatabase(db: DB, databaseId: number): Promise<void> {
  return withNodeDatabaseLifecycle(databaseId, async () => clearNodeStudioForMutation(db, await load(db, databaseId)));
}

export async function openNodeStudioRelay(db: DB, d: Database, input: StudioRelayRequest, signal?: AbortSignal): Promise<StudioRelayChannel> {
  const serverId = nodeOf(d), record = storedNodeStudio(d);
  const identity = record?.phase === 'ready' ? record.identity : record?.previous;
  if (!d.webGuiEnabled || !identity) throw notFound('Web Studio is not running');
  // The sealed open operation enforces current owner switches itself, again
  // at attachment and HTTP connect. A separate ping for every asset doubles
  // RPC traffic and exhausts the agent budget during a normal Studio load.
  // Refused/unknown operations still negotiate a fresh actionable diagnosis.
  signal?.throwIfAborted();
  const reply = z.object({ channel: z.string().regex(/^[a-f0-9]{32}$/), salt: z.string() }).strict()
    .safeParse(await operation(db, serverId, 'db.studio.open', { identity, request: { ...input, headers: studioRequestHeaders(input.headers) } }, signal));
  if (!reply.success) throw failed();
  const salt = Buffer.from(reply.data.salt, 'base64'); if (salt.length !== 32) throw failed();
  const server = await db.query.servers.findFirst({ where: eq(servers.id, serverId) });
  if (!server) throw failed(); signal?.throwIfAborted();
  const host = isIPv6(server.host) ? `[${server.host}]` : server.host;
  // Resolve credentials before allocating a socket: invalid stored secrets
  // must not leave a connecting WebSocket with no owner or error handler.
  let key: Buffer;
  try { key = deriveFrameKey(sha256(decrypt(server.tokenEncrypted)), salt, STUDIO_RELAY_HKDF_INFO); }
  catch { throw failed(); }
  let socket: WebSocket;
  try { socket = new WebSocket(`ws://${host}:${server.port}${STUDIO_RELAY_PATH}`, [STUDIO_RELAY_PROTOCOL_PREFIX + reply.data.channel]); }
  catch { throw failed(); }
  socket.binaryType = 'arraybuffer';
  const closeSocket = () => { try { socket.close(); } catch { /* already closing */ } };
  const channel = new StudioRelayChannel('panel', key, {
    get bufferedAmount() { return socket.bufferedAmount; },
    send(bytes) { if (socket.readyState !== 1) throw new Error('Studio socket closed'); socket.send(bytes); },
    close: closeSocket,
  }, { expectedOutgoingBytes: input.bodyBytes });
  const aborted = () => channel.abort(); signal?.addEventListener('abort', aborted, { once: true });
  socket.addEventListener('open', () => { if (signal?.aborted) channel.abort(); else channel.start(); });
  socket.addEventListener('message', ({ data }) => { if (typeof data === 'string') channel.abort(); else channel.receive(Buffer.from(data as ArrayBuffer)); });
  socket.addEventListener('close', () => channel.socketClosed()); socket.addEventListener('error', () => channel.abort());
  const clean = () => { signal?.removeEventListener('abort', aborted); closeSocket(); };
  void channel.done.then(clean, clean);
  if (signal?.aborted) channel.abort();
  return channel;
}
