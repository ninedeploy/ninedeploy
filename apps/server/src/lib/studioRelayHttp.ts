import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { StudioRelayChannel } from './studioRelayChannel.js';
import { decodeStudioRequest, encodeStudioRequest, studioRequestHeaders, type StudioRelayRequest } from './studioRelayProtocol.js';

/** Internal target derived from the verified Studio container's private bridge.
 * Never populate this from a browser request, database host or redirect URL. */
export interface StudioHttpTarget { address: string; port: number; verify?: () => Promise<void> }

/**
 * Agent-side HTTP adapter. Identity/capability validation belongs immediately
 * before this call. Only a literal confirmed IP and fixed container port are
 * accepted; HTTP redirects are returned, never followed by the agent.
 */
export async function bridgeStudioHttp(
  channel: StudioRelayChannel, target: StudioHttpTarget, input: StudioRelayRequest,
): Promise<void> {
  if (!isIP(target.address) || !Number.isInteger(target.port) || target.port < 1024 || target.port > 65535) throw new Error('Invalid confirmed Studio target');
  const spec = decodeStudioRequest(encodeStudioRequest(input));
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of studioRequestHeaders(spec.headers)) {
    const existing = headers[name];
    headers[name] = existing === undefined ? value : ([] as string[]).concat(existing as string | string[], value);
  }
  headers.host = `${isIP(target.address) === 6 ? `[${target.address}]` : target.address}:${target.port}`;
  headers['content-length'] = spec.bodyBytes;
  let connection: Socket | undefined;
  const upstream = httpRequest({
    host: target.address, port: target.port, path: spec.path, method: spec.method, headers,
    // Supplying an async createConnection without an Agent prevents HTTP
    // headers/body from being written until the connected identity is checked.
    createConnection: (_options, oncreate) => {
      const socket = connect({ host: target.address, port: target.port }); connection = socket;
      let settled = false;
      const timer = setTimeout(() => socket.destroy(new Error('Studio connection confirmation timed out')), 10_000); timer.unref();
      const reject = () => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        oncreate(new Error('Node Studio connection could not be confirmed'), socket);
      };
      socket.once('error', reject); socket.once('close', reject);
      socket.once('connect', () => {
        void Promise.resolve().then(() => target.verify?.()).then(() => {
          if (settled || socket.destroyed) return;
          settled = true; clearTimeout(timer); oncreate(null, socket);
        }, () => socket.destroy(new Error('Node Studio identity changed')));
      });
      return undefined;
    },
  });
  upstream.setTimeout(60_000, () => upstream.destroy(new Error('Studio upstream idle')));
  let receivedResponse = false;
  const response = new Promise<void>((resolve, reject) => {
    const rejectResponse = () => reject(new Error('Node Studio upstream unreachable'));
    upstream.once('error', rejectResponse);
    upstream.once('close', () => { if (!receivedResponse) rejectResponse(); });
    upstream.once('upgrade', (_response, socket) => { socket.destroy(); rejectResponse(); });
    upstream.once('response', (message: IncomingMessage) => {
      receivedResponse = true;
      const pairs: [string, string][] = [];
      for (let i = 0; i < message.rawHeaders.length; i += 2) pairs.push([message.rawHeaders[i]!, message.rawHeaders[i + 1] ?? '']);
      try { channel.sendHead({ status: message.statusCode ?? 502, headers: pairs }); }
      catch { message.destroy(); rejectResponse(); return; }
      void pipeline(message, channel.writable).then(resolve, rejectResponse);
    });
  });
  // A disconnected browser, failed cipher or channel timeout also closes the
  // actual HTTP socket, including a request waiting for its first response.
  const close = () => { connection?.destroy(); upstream.destroy(); };
  void channel.done.then(close, close);
  let seen = 0;
  const requestLength = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > spec.bodyBytes) callback(new Error('Studio request body exceeds declared bytes'));
      else callback(null, chunk);
    },
    flush(callback) { callback(seen === spec.bodyBytes ? undefined : new Error('Studio request body ended early')); },
  });
  try {
    await Promise.all([pipeline(channel.readable, requestLength, upstream), response]);
  } catch {
    upstream.destroy(); channel.abort();
    throw new Error('Node Studio upstream unreachable');
  }
}
