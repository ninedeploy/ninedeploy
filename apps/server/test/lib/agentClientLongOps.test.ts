import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  _resetSealedSupportCache,
  AGENT_LONG_OP_TIMEOUT_MS,
  agentChildTimeoutMs,
  agentOp,
  agentRequestTimeoutMs,
} from '../../src/lib/agentClient.js';
import { open as openSealed, seal } from '../../src/lib/agentSeal.js';
import { createFakeDb } from '../helpers.js';

const cryptoReal = await import('../../src/lib/crypto.js');
const SHARED = cryptoReal.sha256('raw-token');

/**
 * r526: build/bring-up ops used to share the 595 s agent / 600 s panel budget
 * every op has, while the same build on the panel host may run 30 minutes —
 * and Node's fetch could not wait even that long (its dispatcher aborts a
 * response whose headers take over 300 s, and the agent answers only when the
 * op is done). Long ops now travel over node:http with the long budget; the
 * agent arms its child to match. A REAL loopback agent stands in here: the
 * point is the transport, which a fetch stub cannot exercise.
 */

/** What the fake agent answers for the next exec, per op. */
let reply: (op: string) => { status?: number; headers?: Record<string, string>; result?: { exitCode: number; lines: string[] } } =
  () => ({ result: { exitCode: 0, lines: [] } });
const seen: string[] = [];

let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/agent/ping') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, agent: true, sealed: true }));
      return;
    }
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString('utf8');
    });
    req.on('end', () => {
      const request = openSealed<{ op: string; nonce: string }>(SHARED, (JSON.parse(body) as { sealed: unknown }).sealed);
      seen.push(request.op);
      const r = reply(request.op);
      res.statusCode = r.status ?? 200;
      for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
      res.setHeader('content-type', 'application/json');
      res.end(r.result ? JSON.stringify({ sealed: seal(SHARED, { ...r.result, nonce: request.nonce }) }) : '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  seen.length = 0;
  reply = () => ({ result: { exitCode: 0, lines: [] } });
  _resetSealedSupportCache();
  vi.restoreAllMocks();
});

const db = () =>
  createFakeDb({
    findFirst: {
      servers: { id: 1, name: 'edge', host: '127.0.0.1', port, status: 'online', tokenEncrypted: cryptoReal.encrypt('raw-token') },
    },
  });

describe('r526: long agent operations', () => {
  it('budgets build/bring-up ops like the panel host does, on both sides', () => {
    for (const op of ['docker.build', 'docker.composeUp', 'docker.composePull']) {
      expect(agentChildTimeoutMs(op)).toBe(30 * 60 * 1000);
      expect(agentRequestTimeoutMs(op)).toBeGreaterThan(AGENT_LONG_OP_TIMEOUT_MS);
    }
    // r417: a node pull stays a fast-failing short op.
    expect(agentChildTimeoutMs('docker.pull')).toBeUndefined();
    expect(agentRequestTimeoutMs('docker.stop')).toBe(600_000);
  });

  it('sends a long op over node:http (no fetch header cap) and a short one over fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    reply = () => ({ result: { exitCode: 0, lines: ['built'] } });
    const lines: string[] = [];
    await expect(agentOp(db(), 1, 'docker.build', { tag: 'a:1' }, (l) => lines.push(l))).resolves.toEqual({
      exitCode: 0,
      lines: ['built'],
    });
    expect(lines).toEqual(['built']);
    expect(seen).toEqual(['docker.build']);
    const execViaFetch = () => fetchSpy.mock.calls.filter((c) => String(c[0]).endsWith('/agent/exec'));
    expect(execViaFetch()).toHaveLength(0);

    await agentOp(db(), 1, 'docker.stop', { name: 'x' }, () => undefined);
    expect(execViaFetch()).toHaveLength(1);
    // r526: an agent endpoint never redirects — following one would re-send
    // the op (or, on the opt-in cleartext path, the token) elsewhere.
    expect((execViaFetch()[0]![1] as RequestInit).redirect).toBe('error');
  });

  it('never follows a redirect on the long-op transport either', async () => {
    reply = () => ({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    await expect(agentOp(db(), 1, 'docker.build', {}, () => undefined)).rejects.toThrow(/agent docker.build failed \(302\)/);
    expect(seen).toEqual(['docker.build']);
  });

  it("names the node agent's per-operation timeout instead of a bare exit 124", async () => {
    reply = () => ({ result: { exitCode: 124, lines: ['Step 7/9', 'Operation timed out after 595000ms — killed'] } });
    await expect(agentOp(db(), 1, 'docker.build', {}, () => undefined)).rejects.toThrow(
      /stopped by the node agent's per-operation timeout \(exit 124\).*upgrade the node agent/,
    );
    // A command that merely exits 124 on its own is still reported as such.
    reply = () => ({ result: { exitCode: 124, lines: ['boom'] } });
    await expect(agentOp(db(), 1, 'docker.build', {}, () => undefined)).rejects.toThrow('agent docker.build exited with 124');
  });
});
