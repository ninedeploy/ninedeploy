import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ spawn: vi.fn(), capture: vi.fn(), reply: '{"ID":"service"}', status: 201, mode: 'normal', request: '' }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: h.spawn }));
vi.mock('../src/lib/exec.js', async original => ({ ...await original<typeof import('../src/lib/exec.js')>(), capture: h.capture }));
const { dockerEngineRequest } = await import('../src/lib/dockerEngineApi.js');
beforeEach(() => {
  h.capture.mockReset().mockResolvedValue('1.51'); h.reply = '{"ID":"service"}'; h.status = 201; h.mode = 'normal'; h.request = '';
  h.spawn.mockReset().mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
    let sent = false;
    child.stdin.on('data', (data: Buffer) => {
      h.request += data.toString('utf8');
      const split = h.request.indexOf('\r\n\r\n');
      const length = Number(/content-length:\s*(\d+)/i.exec(h.request.slice(0, split))?.[1] ?? 0);
      if (sent || split < 0 || Buffer.byteLength(h.request.slice(split + 4)) < length || h.mode === 'timeout') return;
      sent = true;
      if (h.mode === 'error') { queueMicrotask(() => child.emit('error', Error('fixture transport failure'))); return; }
      const body = Buffer.from(h.reply);
      if (h.mode === 'chunked') child.stdout.end(`HTTP/1.1 ${h.status} OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${body.length.toString(16)}\r\n${h.reply}\r\n0\r\n\r\n`);
      else child.stdout.end(Buffer.concat([Buffer.from(`HTTP/1.1 ${h.status} OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`), body]));
    });
    return child;
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
describe('bounded Docker Engine stdio requests', () => {
  it.each(['normal', 'chunked'])('parses a real HTTP %s response and keeps secrets out of argv and inherited env', async mode => {
    h.mode = mode; vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'master-fixture-only');
    const result = await dockerEngineRequest('POST', '/services/create', { Name: 'service', Env: ['SECRET=fixture-only'] }, { username: 'user', password: 'registry-fixture-only', server: 'registry.test' });
    expect(result).toEqual({ status: 201, body: { ID: 'service' } });
    expect(h.spawn.mock.calls[0]?.slice(0, 2)).toEqual(['docker', ['system', 'dial-stdio']]);
    expect(h.spawn.mock.calls[0]?.[2].env).not.toHaveProperty('NINEDEPLOY_MASTER_KEY');
    expect(h.request).toContain('POST /v1.51/services/create HTTP/1.1');
    expect(h.request).toContain(JSON.stringify({ Name: 'service', Env: ['SECRET=fixture-only'] }));
    const auth = /x-registry-auth:\s*([^\r\n]+)/i.exec(h.request)?.[1];
    expect(JSON.parse(Buffer.from(auth!, 'base64').toString())).toEqual({ username: 'user', password: 'registry-fixture-only', serveraddress: 'registry.test' });
  });
  it('returns revision conflicts without retrying the mutation', async () => {
    h.status = 400; h.reply = '{"message":"update out of sequence"}';
    expect((await dockerEngineRequest('POST', '/services/service/update?version=7', {})).status).toBe(400);
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });
  it('accepts an empty response body', async () => {
    h.status = 200; h.reply = '';
    expect(await dockerEngineRequest('GET', '/services/service')).toEqual({ status: 200, body: null });
  });
  it.each(['/containers/create', '/services/name\r\nX-Injected: yes', '/services/../../secret'])('refuses an out-of-scope or injected path: %s', async path => {
    await expect(dockerEngineRequest('GET', path)).rejects.toThrow('Invalid managed Swarm API path');
    expect(h.spawn).not.toHaveBeenCalled(); expect(h.capture).not.toHaveBeenCalled();
  });
  it('refuses an unconfirmed API version before connecting', async () => {
    h.capture.mockResolvedValue('unreadable');
    await expect(dockerEngineRequest('GET', '/services')).rejects.toThrow('version is unconfirmed');
    expect(h.spawn).not.toHaveBeenCalled();
  });
  it('does not expose an unreadable daemon response', async () => {
    h.reply = 'fixture response with secret values';
    await expect(dockerEngineRequest('GET', '/services')).rejects.toThrow('response is unreadable');
  });
  it('bounds a request before starting a process', async () => {
    await expect(dockerEngineRequest('POST', '/services/create', { value: 'x'.repeat(16 * 1024 * 1024) })).rejects.toThrow('supported request size');
    expect(h.spawn).not.toHaveBeenCalled();
  });
  it('bounds a daemon response', async () => {
    h.reply = 'x'.repeat(16 * 1024 * 1024 + 1);
    await expect(dockerEngineRequest('GET', '/services')).rejects.toThrow('supported size');
  });
  it('rejects a failed child without leaking its output', async () => {
    h.mode = 'error';
    await expect(dockerEngineRequest('GET', '/services')).rejects.toThrow('transport could not be started');
  });
  it('bounds a silent daemon and tears down the child', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); h.mode = 'timeout';
    const operation = expect(dockerEngineRequest('GET', '/services')).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(30_001); await operation;
    expect(h.spawn.mock.results[0]?.value.kill).toHaveBeenCalled();
  });
});
