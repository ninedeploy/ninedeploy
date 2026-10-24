import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AgentOpContext, AgentOpModule } from './index.js';
import { HttpError } from '../lib/errors.js';
import { assertNodeStudioEnabled, nodeStudioIdentity, nodeStudioStartInput, nodeStudioClearInput, startNodeStudio, stopNodeStudio, clearNodeStudio, resolveNodeStudioHttpTarget, type NodeStudioIdentity } from '../lib/nodeStudioRuntime.js';
import { StudioRelayChannel } from '../lib/studioRelayChannel.js';
import { bridgeStudioHttp } from '../lib/studioRelayHttp.js';
import { deriveFrameKey, FRAME_SALT_BYTES } from '../lib/agentFrameCipher.js';
import { STUDIO_RELAY_HKDF_INFO, STUDIO_RELAY_PROTOCOL_PREFIX, encodeStudioRequest, studioRelayRequest, type StudioRelayRequest } from '../lib/studioRelayProtocol.js';

const CAP = 'db.studio' as const;
const MAX_CHANNELS = 16;
interface Reservation {
  id: string; salt: Buffer; identity: NodeStudioIdentity; request: StudioRelayRequest;
  timer: NodeJS.Timeout; channel: StudioRelayChannel | null;
}
const channels = new Map<string, Reservation>();
let opening = 0;
export const studioChannelCount = () => channels.size;
function release(reservation: Reservation) {
  clearTimeout(reservation.timer);
  channels.delete(reservation.id);
}
export function closeAllStudioChannels(): void {
  for (const reservation of [...channels.values()]) { reservation.channel?.abort(); release(reservation); }
}
function sealed(ctx: AgentOpContext): void {
  if (!ctx.sealed) throw new HttpError(422, 'node_studio_unsealed', 'Node Web Studio requires sealed transport');
  assertNodeStudioEnabled();
}
async function reply(onLine: (line: string) => void, action: () => Promise<unknown>): Promise<number> {
  try { onLine(`ND-STUDIO ${JSON.stringify(await action())}`); return 0; }
  catch (error) {
    const failure = error instanceof HttpError ? error : error instanceof z.ZodError
      ? new HttpError(400, 'node_studio_params', 'Invalid node Web Studio request')
      : new HttpError(502, 'node_studio_unconfirmed', 'Node Web Studio operation could not be confirmed');
    onLine(`ND-STUDIO ${JSON.stringify({ error: { status: failure.statusCode, code: failure.code, message: failure.message } })}`); return 1;
  }
}
export const studioOps: AgentOpModule = {
  name: 'agentOps/studios.ts', caps: [CAP],
  ops: {
    'db.studio.start': { cap: CAP, sealedOnly: true, async run(params, onLine, ctx) {
      return reply(onLine, async () => { sealed(ctx); return startNodeStudio(nodeStudioStartInput.parse(params)); });
    } },
    'db.studio.stop': { cap: CAP, sealedOnly: true, async run(params, onLine, ctx) {
      return reply(onLine, async () => {
        sealed(ctx); const identity = nodeStudioIdentity.parse(params);
        await stopNodeStudio(identity); return { stopped: identity.containerId };
      });
    } },
    'db.studio.clear': { cap: CAP, sealedOnly: true, async run(params, onLine, ctx) {
      return reply(onLine, async () => { sealed(ctx); return { stopped: await clearNodeStudio(nodeStudioClearInput.parse(params)) }; });
    } },
    'db.studio.open': { cap: CAP, sealedOnly: true, async run(params, onLine, ctx) {
      return reply(onLine, async () => {
        sealed(ctx);
        const input = z.object({ identity: nodeStudioIdentity, request: studioRelayRequest }).strict().parse(params);
        try { encodeStudioRequest(input.request); }
        catch { throw new HttpError(413, 'node_studio_headers_too_large', 'Studio HTTP metadata exceeds its size limit'); }
        if (channels.size + opening >= MAX_CHANNELS) throw new HttpError(429, 'node_studio_capacity', 'The node has reached its concurrent Studio request limit; retry shortly');
        opening++;
        try {
          await resolveNodeStudioHttpTarget(input.identity);
          const id = randomBytes(16).toString('hex'), salt = randomBytes(FRAME_SALT_BYTES);
          const reservation: Reservation = { id, salt, identity: input.identity, request: input.request, channel: null,
            timer: setTimeout(() => release(reservation), 30_000) };
          reservation.timer.unref(); channels.set(id, reservation);
          return { channel: id, salt: salt.toString('base64') };
        } finally { opening--; }
      });
    } },
  },
};
export interface AgentStudioSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(bytes: Buffer): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (bytes: unknown, binary: boolean) => void): unknown;
  on(event: 'close' | 'error', listener: () => void): unknown;
}
/** A reservation is single-use, and no HTTP opens until the first valid encrypted frame. */
export function attachStudioChannel(socket: AgentStudioSocket, protocols: string | string[] | undefined, tokenHash: string): void {
  const offered = (Array.isArray(protocols) ? protocols.join(',') : protocols ?? '').split(',').map(p => p.trim());
  const id = offered.find(p => p.startsWith(STUDIO_RELAY_PROTOCOL_PREFIX))?.slice(STUDIO_RELAY_PROTOCOL_PREFIX.length) ?? '';
  const reservation = /^[a-f0-9]{32}$/.test(id) ? channels.get(id) : undefined;
  if (!reservation || reservation.channel) { socket.close(1008, 'Unknown Studio channel'); return; }
  try { assertNodeStudioEnabled(); }
  catch { release(reservation); socket.close(1008, 'Studio disabled'); return; }
  clearTimeout(reservation.timer);
  let channel: StudioRelayChannel;
  try {
    channel = new StudioRelayChannel('agent', deriveFrameKey(tokenHash, reservation.salt, STUDIO_RELAY_HKDF_INFO), {
      get bufferedAmount() { return socket.bufferedAmount; },
      send(bytes) { if (socket.readyState !== 1) throw new Error('Studio socket closed'); socket.send(bytes); },
      close: (code, reason) => { if (socket.readyState === 1) socket.close(code, reason); },
    }, { expectedIncomingBytes: reservation.request.bodyBytes, onAuthenticated: async () => {
      const target = await resolveNodeStudioHttpTarget(reservation.identity);
      await bridgeStudioHttp(channel, target, reservation.request);
    } });
  } catch { release(reservation); socket.close(1008, 'Studio channel unavailable'); return; }
  reservation.channel = channel;
  socket.on('message', (bytes, binary) => { if (!binary || !Buffer.isBuffer(bytes)) channel.abort(); else channel.receive(bytes); });
  socket.on('close', () => channel.socketClosed()); socket.on('error', () => channel.abort());
  void channel.done.then(() => release(reservation), () => release(reservation));
}
