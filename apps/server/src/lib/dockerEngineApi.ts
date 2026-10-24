import { spawn } from 'node:child_process';
import { Agent, request } from 'node:http';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { buildEnv, capture } from './exec.js';

const MAX_BYTES = 16 * 1024 * 1024;
/** One request through the operator's Docker context. Never logs bodies, registry auth or daemon replies. */
export async function dockerEngineRequest(method: 'GET' | 'POST', path: string, body?: unknown, registryAuth?: { username: string; password: string; server?: string }): Promise<{ status: number; body: unknown }> {
  if (!/^\/services(?:\/[a-z0-9_-]+(?:\/update)?)?(?:\?[a-zA-Z0-9_=&%-]+)?$/.test(path)) throw new Error('Invalid managed Swarm API path');
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  if (payload && payload.length > MAX_BYTES) throw new Error('Swarm service spec exceeds the supported request size');
  const version = (await capture('docker', ['version', '--format', '{{.Server.APIVersion}}'], { timeoutMs: 10_000, maxOutputBytes: 128 })).trim();
  if (!/^1\.\d{2,3}$/.test(version)) throw new Error('Docker Engine API version is unconfirmed');
  return new Promise((resolve, reject) => {
    let settled = false, bytes = 0;
    const chunks: Buffer[] = [];
    const child = spawn('docker', ['system', 'dial-stdio'], { env: buildEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    const socket = new Duplex({
      read() { child.stdout.resume(); },
      write(chunk, encoding, callback) { child.stdin.write(chunk, encoding, callback); },
      final(callback) { child.stdin.end(callback); },
      destroy(error, callback) { child.stdin.destroy(); child.stdout.destroy(); callback(error); },
    });
    child.stdout.on('data', (chunk: Buffer) => { if (!socket.push(chunk)) child.stdout.pause(); });
    child.stdout.on('end', () => socket.push(null));
    child.stdout.on('error', () => socket.destroy(new Error('Docker Engine stream failed')));
    child.stdin.on('error', () => socket.destroy(new Error('Docker Engine stream failed')));
    const agent = new Agent({ keepAlive: false });
    agent.createConnection = () => socket as Socket;
    const finish = (error?: Error, value?: { status: number; body: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      agent.destroy();
      socket.destroy();
      child.kill();
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error('Docker Engine request timed out; service state must be reconciled')), 30_000);
    const req = request({ host: 'docker', path: `/v${version}${path}`, method, agent,
      headers: { Connection: 'close', Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...(registryAuth ? { 'X-Registry-Auth': Buffer.from(JSON.stringify({ username: registryAuth.username, password: registryAuth.password, serveraddress: registryAuth.server ?? '' })).toString('base64') } : {}) },
    }, response => {
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) { finish(new Error('Docker Engine response exceeds the supported size')); return; }
        chunks.push(chunk);
      });
      response.on('error', () => finish(new Error('Docker Engine response was interrupted; service state is unconfirmed')));
      response.on('end', () => {
        if (settled) return;
        let value: unknown;
        try { const text = Buffer.concat(chunks).toString('utf8'); value = text.trim() ? JSON.parse(text) : null; }
        catch { finish(new Error('Docker Engine response is unreadable')); return; }
        finish(undefined, { status: response.statusCode ?? 0, body: value });
      });
    });
    req.on('error', () => finish(new Error('Docker Engine transport unavailable; service state is unconfirmed')));
    child.on('error', () => finish(new Error('Docker Engine transport could not be started')));
    child.on('exit', code => { if (code !== 0) finish(new Error('Docker Engine transport ended before confirmation')); });
    req.end(payload);
  });
}
