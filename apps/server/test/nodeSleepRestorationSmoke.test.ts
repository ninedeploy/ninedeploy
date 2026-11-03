import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it } from 'vitest';
import { open, seal } from '../src/lib/agentSeal.js';
import { createSealedRoutingFault } from '../../../scripts/lib/smoke-sealed-routing-fault.mjs';
import { manualWakeSampler } from '../../../scripts/lib/smoke-node-manual-wake.mjs';

const handles: Server[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
});
async function listen(server: Server) {
  handles.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}
async function fixture({ wrongNonce = false, wrongHash = false } = {}) {
  const secret = 'owned-test-agent-secret', content = 'http: { services: {} }';
  const digest = createHash('sha256').update(content).digest('hex');
  const requests: Buffer[] = [], responses: Buffer[] = [], errors: string[] = [], mutations: string[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks); requests.push(bytes);
    const command = open<{ nonce: string }>(secret, JSON.parse(bytes.toString()).sealed);
    const bytesOut = Buffer.from(JSON.stringify({ sealed: seal(secret, { nonce: wrongNonce ? 'foreign' : command.nonce,
      exitCode: 0, lines: [`ND-PROXY-ROUTING ${wrongHash ? '0'.repeat(64) : digest}`] }) }));
    responses.push(bytesOut); res.writeHead(200, { 'content-type': 'application/json' }); res.end(bytesOut);
  });
  const fault = createSealedRoutingFault({ server: { host: '127.0.0.1', port: await listen(upstream) },
    decode: (envelope: unknown) => open(secret, envelope), onError: (error: string) => errors.push(error), onMutation: (op: string) => mutations.push(op) });
  const port = await listen(fault.server);
  const bytes = JSON.stringify({ sealed: seal(secret, { nonce: 'owned-nonce', op: 'proxy.confirmRouting', params: { content } }) });
  const send = (body = bytes) => fetch(`http://127.0.0.1:${port}/agent/exec`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(3000),
  });
  return { fault, send, requests, responses, errors, mutations, bytes, digest, secret };
}

it('forwards sealed bytes unchanged, drops one verified routing reply and permits restoration replies', async () => {
  const f = await fixture();
  expect(await (await f.send()).text()).toBe(f.responses[0]!.toString());
  expect(f.requests[0]!.toString()).toBe(f.bytes); expect(f.fault.receipt().dropped).toBe(false);
  f.fault.arm();
  await expect(f.send()).rejects.toThrow();
  expect(f.fault.receipt()).toEqual({ dropped: true, routingHash: f.digest });
  expect(await (await f.send()).text()).toBe(f.responses[2]!.toString());
  expect(f.requests).toHaveLength(3); expect(f.errors).toEqual([]); expect(f.mutations).toEqual([]);
  const mutation = JSON.stringify({ sealed: seal(f.secret, { nonce: 'mutation', op: 'docker.stopSet', params: {} }) });
  await f.send(mutation);
  expect(f.mutations).toEqual(['docker.stopSet']); expect(f.requests[3]!.toString()).toBe(mutation);
});

it.each([{ wrongNonce: true }, { wrongHash: true }])('does not claim a loaded routing fault for an invalid receipt: %j', async options => {
  const f = await fixture(options); f.fault.arm();
  await expect(f.send()).rejects.toThrow();
  expect(f.fault.receipt().dropped).toBe(false); expect(f.errors).toEqual(['response-verification']);
});

it('keeps the traffic observer silent during genuine idle and starts it only on admission handshake', async () => {
  let receive!: (req: { url: string }, res: { end: (body: string) => void }) => Promise<void>, requests = 0;
  const http = {
    createServer: (callback: typeof receive) => { receive = callback; return { listen() {} }; },
    get: (_options: unknown, callback: (response: EventEmitter & { statusCode: number; headers: object; setEncoding: () => void }) => void) => {
      requests++;
      const request = Object.assign(new EventEmitter(), { destroy() {} });
      queueMicrotask(() => {
        const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, setEncoding() {} });
        callback(response); response.emit('data', 'old'); response.emit('end');
      });
      return request;
    },
  };
  runInNewContext(manualWakeSampler('app.test', { paused: true }), {
    require: () => http, setTimeout: () => 1, clearTimeout() {},
  });
  const response = { body: '', end(body: string) { this.body = body; } };
  await receive({ url: '/snapshot' }, response);
  expect(requests).toBe(0); expect(JSON.parse(response.body)).toEqual([]);
  await receive({ url: '/start' }, response);
  await receive({ url: '/start' }, response);
  await receive({ url: '/finish' }, response);
  expect(requests).toBe(1); expect(JSON.parse(response.body)).toEqual([expect.objectContaining({ status: 200, application: true, waking: false })]);
});
