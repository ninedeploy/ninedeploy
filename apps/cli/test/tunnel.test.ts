import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NineDeployClient } from '../src/client.js';
import { pipeConnection, tunnelDb, tunnelService, type TunnelSocket } from '../src/commands/tunnel.js';

/** A fake tunnel WebSocket: what the CLI sends, and a handle to answer as the panel. */
class FakeSocket extends EventEmitter {
  readyState = 0;
  sent: Buffer[] = [];
  closedWith: number | undefined;
  constructor(
    readonly url = '',
    readonly protocols: string[] = [],
  ) {
    super();
  }
  send(data: Uint8Array) {
    this.sent.push(Buffer.from(data));
  }
  close(code?: number) {
    this.closedWith = code;
  }
  accept() {
    this.readyState = 1;
    this.emit('open');
  }
}
const asTunnel = (s: FakeSocket) => s as unknown as TunnelSocket;

const servers: net.Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  vi.restoreAllMocks();
  process.exitCode = 0;
});

async function connectedPair(): Promise<[net.Socket, net.Socket]> {
  const server = net.createServer();
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const accepted = once(server, 'connection');
  const client = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1');
  const [local] = (await accepted) as [net.Socket];
  return [client, local];
}

describe('pipeConnection', () => {
  it('holds bytes until the tunnel opens, splits large writes, and carries the answer back', async () => {
    const [client, local] = await connectedPair();
    const ws = new FakeSocket();
    pipeConnection(local, asTunnel(ws), () => undefined);
    client.write('early');
    await vi.waitFor(() => expect(local.bytesRead).toBe(5));
    expect(ws.sent).toEqual([]);
    ws.accept();
    expect(Buffer.concat(ws.sent).toString()).toBe('early');

    const big = Buffer.alloc(200 * 1024, 1);
    client.write(big);
    await vi.waitFor(() => expect(Buffer.concat(ws.sent).length).toBe(5 + big.length));
    expect(Math.max(...ws.sent.map((b) => b.length))).toBeLessThanOrEqual(64 * 1024);

    const answer = once(client, 'data');
    ws.emit('message', Buffer.from('pong'), true);
    expect(String((await answer)[0])).toBe('pong');
    client.destroy();
  });

  it('reports a refusal and ends the local connection; a local close ends the tunnel', async () => {
    const [client, local] = await connectedPair();
    const ws = new FakeSocket();
    const refused = vi.fn();
    pipeConnection(local, asTunnel(ws), refused);
    const ended = once(client, 'close');
    ws.emit('close', 1008, Buffer.from('not found or not allowed'));
    await ended;
    expect(refused).toHaveBeenCalledWith('not found or not allowed');

    const [client2, local2] = await connectedPair();
    const ws2 = new FakeSocket();
    pipeConnection(local2, asTunnel(ws2), refused);
    client2.destroy();
    await vi.waitFor(() => expect(ws2.closedWith).toBe(1000));
    expect(refused).toHaveBeenCalledTimes(1);
  });
});

describe('ninedeploy tunnel db', () => {
  const client = (detail: Record<string, unknown>) =>
    ({ databases: { get: vi.fn(async () => ({ name: 'pg', engine: 'postgres', port: null, ...detail })) } }) as unknown as NineDeployClient;

  it('listens locally and opens one authenticated tunnel per local connection', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sockets: FakeSocket[] = [];
    let listening: { host: string; port: number } | undefined;
    await tunnelDb(client({}), '7', { port: '0' }, {
      credentials: async () => ({ url: (p) => `wss://panel.example.com${p}`, token: 'tok' }),
      socketFactory: (url, protocols) => {
        const s = new FakeSocket(url, protocols);
        sockets.push(s);
        return asTunnel(s);
      },
      onListening: (address, server) => {
        listening = address;
        servers.push(server);
      },
    });
    expect(listening?.host).toBe('127.0.0.1');
    const c1 = net.connect(listening!.port, '127.0.0.1');
    const c2 = net.connect(listening!.port, '127.0.0.1');
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    expect(sockets[0]!.url).toBe('wss://panel.example.com/v1/databases/7/tunnel');
    expect(sockets[0]!.protocols).toEqual(['ninedeploy.tunnel.v1', 'ninedeploy.bearer.tok']);
    c1.destroy();
    c2.destroy();
  });

  it('refuses a bad id or port, and a database on a node', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await tunnelDb(client({}), 'x');
    await tunnelDb(client({}), '7', { port: '70000' });
    await tunnelDb(client({ serverId: 3 }), '7', {}, { credentials: async () => ({ url: (p) => p, token: '' }) });
    const text = errors.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('Usage: ninedeploy tunnel db <id>');
    expect(text).toContain('--port must be 0-65535');
    expect(text).toContain('runs on a node');
  });
});

describe('ninedeploy tunnel service', () => {
  const client = (detail: Record<string, unknown>) =>
    ({ services: { get: vi.fn(async () => ({ name: 'api', port: 3000, serverId: null, ...detail })) } }) as unknown as NineDeployClient;

  it('tunnels to the chosen container port and replica', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sockets: FakeSocket[] = [];
    let listening: { host: string; port: number } | undefined;
    await tunnelService(client({}), '5', { port: '0', target: '9229', replica: '2' }, {
      credentials: async () => ({ url: (p) => `wss://panel.example.com${p}`, token: 'tok' }),
      socketFactory: (url, protocols) => {
        const s = new FakeSocket(url, protocols);
        sockets.push(s);
        return asTunnel(s);
      },
      onListening: (address, server) => {
        listening = address;
        servers.push(server);
      },
    });
    const c1 = net.connect(listening!.port, '127.0.0.1');
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0]!.url).toBe('wss://panel.example.com/v1/services/5/tunnel?port=9229&replica=2');
    c1.destroy();
  });

  it('refuses a bad target or replica and a service with no port', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const creds = { credentials: async () => ({ url: (p: string) => p, token: '' }) };
    await tunnelService(client({}), '5', { target: '0' });
    await tunnelService(client({}), '5', { replica: '0' });
    await tunnelService(client({ port: null }), '5', {}, creds);
    const text = errors.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('--target must be a container port');
    expect(text).toContain('--replica must be 1 or more');
    expect(text).toContain('--target <port>');
  });
});
