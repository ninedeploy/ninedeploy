/**
 * D6 (0.15, owner decision O6): the `@fastify/websocket` options app.ts mounts.
 *
 * - A frame over 1 MiB closes the socket (ws: 1009) and never reaches the
 *   handler (it used to be 100 MiB, buffered before anyone was authenticated).
 * - A non-credential subprotocol is preferred over `ninedeploy.bearer.*` /
 *   `ninedeploy.ticket.*` in the 101 response.
 * - The existing client contract is unchanged: a client offering ONLY the
 *   bearer (the web app, the CLI) still connects and gets the same echo it
 *   got from 0.14 — RFC 6455 clients fail a handshake that offered protocols
 *   and selected none.
 *
 * Exercised against a real `ws` server through @fastify/websocket, the way
 * app.ts registers it.
 */
import { once } from 'node:events';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CREDENTIAL_PROTOCOL_PREFIXES,
  selectWebsocketProtocol,
  WEBSOCKET_MAX_PAYLOAD,
  websocketServerOptions,
} from '../../src/lib/websocketOptions.js';

describe('selectWebsocketProtocol', () => {
  it('prefers the first non-credential protocol', () => {
    expect(selectWebsocketProtocol(new Set(['ninedeploy.bearer.tok', 'ninedeploy']))).toBe('ninedeploy');
    expect(selectWebsocketProtocol(new Set(['ninedeploy.terminal.v1', 'ninedeploy.ticket.abc']))).toBe('ninedeploy.terminal.v1');
    expect(selectWebsocketProtocol(new Set(['ninedeploy.ticket.abc', 'ninedeploy.terminal.v1']))).toBe('ninedeploy.terminal.v1');
  });

  it('falls back to the first offered protocol when every one carries a credential (0.14 behaviour)', () => {
    expect(selectWebsocketProtocol(new Set(['ninedeploy.bearer.tok']))).toBe('ninedeploy.bearer.tok');
    expect(selectWebsocketProtocol(new Set(['ninedeploy.ticket.a', 'ninedeploy.bearer.b']))).toBe('ninedeploy.ticket.a');
  });

  it('selects nothing when nothing was offered', () => {
    expect(selectWebsocketProtocol(new Set())).toBe(false);
  });

  it('pins the cap and the credential prefixes', () => {
    expect(WEBSOCKET_MAX_PAYLOAD).toBe(1_048_576);
    expect(CREDENTIAL_PROTOCOL_PREFIXES).toEqual(['ninedeploy.bearer.', 'ninedeploy.ticket.']);
    expect(websocketServerOptions.maxPayload).toBe(WEBSOCKET_MAX_PAYLOAD);
  });
});

describe('the mounted WebSocket server (D6)', () => {
  let app: FastifyInstance;
  let port: number;
  const received: number[] = [];

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(websocket, { options: websocketServerOptions });
    app.register(async (scope) => {
      scope.get('/echo', { websocket: true }, (socket) => {
        socket.on('message', (data: Buffer) => {
          received.push(data.length);
          socket.send(`got ${data.length}`);
        });
      });
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await app.close();
  });

  const open = async (protocols: string[]) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/echo`, protocols);
    await once(ws, 'open');
    return ws;
  };

  it('a bearer-only client (web app, CLI) still connects and gets the 0.14 echo', async () => {
    const ws = await open(['ninedeploy.bearer.tok-1']);
    expect(ws.protocol).toBe('ninedeploy.bearer.tok-1');
    ws.close();
  });

  it('a client offering a plain protocol too gets that one, not the credential', async () => {
    const ws = await open(['ninedeploy.bearer.tok-1', 'ninedeploy']);
    expect(ws.protocol).toBe('ninedeploy');
    ws.close();
    const term = await open(['ninedeploy.terminal.v1', 'ninedeploy.ticket.abc']);
    expect(term.protocol).toBe('ninedeploy.terminal.v1');
    term.close();
  });

  it('accepts a 1 MiB frame', async () => {
    const ws = await open(['ninedeploy']);
    const reply = once(ws, 'message');
    ws.send(new Uint8Array(WEBSOCKET_MAX_PAYLOAD));
    const [event] = (await reply) as [MessageEvent];
    expect(event.data).toBe(`got ${WEBSOCKET_MAX_PAYLOAD}`);
    ws.close();
  });

  it('closes the socket on a frame over 1 MiB, before any handler sees it', async () => {
    const before = received.length;
    const ws = await open(['ninedeploy']);
    const closed = once(ws, 'close');
    ws.send(new Uint8Array(WEBSOCKET_MAX_PAYLOAD + 1));
    const [event] = (await closed) as [CloseEvent];
    // ws answers 1009 (message too big) and drops the TCP stream while the
    // client is still mid-send, so the client may only observe 1006.
    expect([1006, 1009]).toContain(event.code);
    expect(received.length).toBe(before);
  });
});
