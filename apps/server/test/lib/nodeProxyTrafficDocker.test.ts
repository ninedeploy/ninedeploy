import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import { setImmediate as turn } from 'node:timers/promises';
import { nodeProxyTrafficDocker } from '../../src/lib/nodeProxyTrafficDocker.js';
import type { ProxyTrafficOpen, ServingTrafficOpen } from '@ninedeploy/schemas';
import { load } from 'js-yaml';
import { withRoutingAck, routingProbeArgs } from '../../src/lib/proxyRoutingAck.js';

const boundary = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('../../src/lib/exec.js', () => ({ capture: boundary.capture }));

const input: ProxyTrafficOpen = { requestId: '1'.repeat(32), nodeId: 2, serviceId: 3, deploymentId: 4, step: 1, slug: 'web', durationMs: 1000,
  routingConfig: 'http:\n  services:\n    fixture:\n      weighted:\n        services:\n          - name: old\n            weight: 50\n          - name: new\n            weight: 50\n',
  stable: [{ name: 'old', id: 'a'.repeat(64), port: 80 }], canary: [{ name: 'new', id: 'b'.repeat(64), port: 80 }] };
let server: http.Server, proxy: any, rows: any[], stream: http.ServerResponse | undefined, logStatus: number, stall: boolean, routedConfig: string;
let calls: Array<{ url: string; body?: any }>;
const connections: Array<{ close(): void }> = [];
const frame = (value: Buffer | string, type = 1) => {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value), header = Buffer.alloc(8);
  header[0] = type; header.writeUInt32BE(body.length, 4); return Buffer.concat([header, body]);
};
const start = () => { const lines: string[] = [], fail = vi.fn(); const connection = nodeProxyTrafficDocker().connect('f'.repeat(64), line => lines.push(line), fail); connections.push(connection); return { ...connection, lines, fail }; };

beforeEach(async () => {
  calls = []; stream = undefined; logStatus = 200; stall = false; routedConfig = input.routingConfig;
  proxy = { Id: 'f'.repeat(64), Name: '/ninedeploy-proxy', Image: 'sha256:' + '9'.repeat(64), RestartCount: 0,
    State: { Running: true, StartedAt: '2026-10-24T00:00:00Z' }, Config: { Tty: false, Env: ['PRIVATE_TOKEN=fixture'] }, HostConfig: { LogConfig: { Type: 'json-file', Config: {} } } };
  rows = input.stable.concat(input.canary).map(target => ({ Id: target.id, Names: ['/' + target.name], State: 'running', Labels: { 'ninedeploy.managed': 'service', 'ninedeploy.service': '3' } }));
  boundary.capture.mockReset().mockImplementation(async () => {
    const config = (load(withRoutingAck(routedConfig)) as { http: Record<string, Record<string, unknown>> }).http;
    const actual = Object.fromEntries(['routers', 'services', 'middlewares'].map(kind => [kind, Object.fromEntries(Object.entries(config[kind] ?? {}).map(([name, value]) => [name + '@file', { ...(value as object), status: 'enabled' }]))]));
    const generation = (actual.middlewares!['nd_routing_generation@file'] as any).headers.customResponseHeaders['X-NineDeploy-Generation'];
    return `HTTP/1.1 200 OK\nX-NineDeploy-Generation: ${generation}\n\n${JSON.stringify(actual)}`;
  });
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    calls.push({ url: req.url!, body });
    if (req.url!.includes('/logs?')) {
      stream = res; if (stall) return;
      res.writeHead(logStatus, { 'Content-Type': 'application/vnd.docker.raw-stream' }); res.flushHeaders();
      if (logStatus !== 200) res.end('private diagnostic');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/containers/ninedeploy-proxy/json') res.end(JSON.stringify(proxy));
    else if (req.url!.startsWith('/containers/json?')) res.end(JSON.stringify(rows));
    else if (req.url!.endsWith('/exec')) res.end(JSON.stringify({ Id: 'c'.repeat(64) }));
    else res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  vi.stubEnv('DOCKER_HOST', 'tcp://127.0.0.1:' + (server.address() as { port: number }).port);
  vi.stubEnv('DOCKER_TLS_VERIFY', ''); vi.stubEnv('DOCKER_CERT_PATH', ''); vi.stubEnv('DOCKER_CONTEXT', 'default');
});
afterEach(async () => {
  for (const connection of connections.splice(0)) connection.close();
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  vi.unstubAllEnvs(); vi.useRealTimers();
});

describe('fixed Docker proxy source', () => {
  function ordinary() {
    const serving = [{ name: 'web-4', id: 'a'.repeat(64), port: 80 }, { name: 'web-4-r2', id: 'b'.repeat(64), port: 80 }];
    const config = { http: { routers: { web_1: { rule: 'Host(`web.invalid`)', service: 'app', entryPoints: ['web'] } },
      services: { app: { loadBalancer: { servers: serving.map(target => ({ url: `http://${target.name}:${target.port}` })) } } } } };
    routedConfig = JSON.stringify(config);
    rows = serving.map(target => ({ Id: target.id, Names: ['/' + target.name], State: 'running',
      Labels: { 'ninedeploy.managed': 'service', 'ninedeploy.service': '3', 'ninedeploy.deployment': '4' } }));
    const request: ServingTrafficOpen = { purpose: 'autoscale', requestId: input.requestId, nodeId: input.nodeId, serviceId: input.serviceId,
      deploymentId: input.deploymentId, slug: input.slug, durationMs: input.durationMs, routingConfig: routedConfig, serving };
    return { config, request };
  }

  it.each(['deployment-label', 'no-router', 'wrong-upstream', 'missing-replica', 'weighted-canary'])('refuses an ordinary generation whose immutable routing binding is wrong: %s', async fault => {
    const { config, request } = ordinary();
    if (fault === 'deployment-label') rows[0].Labels['ninedeploy.deployment'] = '5';
    if (fault === 'no-router') config.http.routers = {} as typeof config.http.routers;
    if (fault === 'wrong-upstream') config.http.services.app.loadBalancer.servers[0]!.url = 'http://web-5:80';
    if (fault === 'missing-replica') config.http.services.app.loadBalancer.servers.pop();
    if (fault === 'weighted-canary') (config.http.services.app as any) = { weighted: { services: [{ name: 'other', weight: 100 }] } };
    request.routingConfig = routedConfig = JSON.stringify(config);
    await expect(nodeProxyTrafficDocker().inspect(request)).rejects.toThrow(/not confirmed/);
  });

  it('checks the ordinary serving generation without requiring canary targets', async () => {
    const { request } = ordinary();
    expect(await nodeProxyTrafficDocker().inspect(request)).toMatchObject({ proxyId: 'f'.repeat(64) });
    expect(JSON.parse(new URL('http://docker' + calls[1]!.url).searchParams.get('filters')!)).toEqual({ id: request.serving.map(target => target.id) });
    rows[0].Id = 'c'.repeat(64);
    await expect(nodeProxyTrafficDocker().inspect(request)).rejects.toThrow(/not confirmed/);
  });

  it('accepts an HTTP twin only when it points at the complete selected serving set', async () => {
    const { config, request } = ordinary();
    (config.http.routers as any).web_1_http = { ...config.http.routers.web_1 };
    request.routingConfig = routedConfig = JSON.stringify(config);
    expect(await nodeProxyTrafficDocker().inspect(request)).toMatchObject({ proxyId: 'f'.repeat(64) });
    (config.http.routers as any).web_1_bypass = { ...config.http.routers.web_1 };
    request.routingConfig = routedConfig = JSON.stringify(config);
    await expect(nodeProxyTrafficDocker().inspect(request)).rejects.toThrow(/not confirmed/);
  });

  it.each(['malformed', 'document-array', 'no-http', 'http-array', 'no-services', 'no-routers', 'router-not-object', 'router-service', 'missing-service', 'servers-not-array', 'duplicate-upstream', 'foreign-router', 'foreign-provider', 'extra-upstream'])('refuses an unbound serving route before Docker I/O: %s', async fault => {
    const { config, request } = ordinary();
    let value: any = config;
    if (fault === 'document-array') value = [];
    if (fault === 'no-http') value = {};
    if (fault === 'http-array') value.http = [];
    if (fault === 'no-services') delete value.http.services;
    if (fault === 'no-routers') delete value.http.routers;
    if (fault === 'router-not-object') value.http.routers.web_1 = null;
    if (fault === 'router-service') value.http.routers.web_1.service = 3;
    if (fault === 'missing-service') value.http.routers.web_1.service = 'missing';
    if (fault === 'servers-not-array') value.http.services.app.loadBalancer.servers = {};
    if (fault === 'duplicate-upstream') value.http.services.app.loadBalancer.servers[1] = value.http.services.app.loadBalancer.servers[0];
    if (fault === 'foreign-router') { value.http.routers.another_1 = value.http.routers.web_1; delete value.http.routers.web_1; }
    if (fault === 'foreign-provider') value.http.routers.web_1.service = 'app@docker';
    if (fault === 'extra-upstream') value.http.services.app.loadBalancer.servers.push({ url: 'http://web-5:80' });
    request.routingConfig = routedConfig = fault === 'malformed' ? 'http: [' : JSON.stringify(value);
    await expect(nodeProxyTrafficDocker().inspect(request)).rejects.toThrow(/not confirmed/);
    expect(calls).toEqual([]);
  });

  it('supports file-qualified serving references while ignoring another service with a similar slug', async () => {
    const { config, request } = ordinary();
    config.http.routers.web_1.service = 'app@file';
    (config.http.routers as any).web_other_99 = { ...config.http.routers.web_1 };
    request.routingConfig = routedConfig = JSON.stringify(config);
    expect(await nodeProxyTrafficDocker().inspect(request)).toMatchObject({ proxyId: 'f'.repeat(64) });
  });

  it('attests immutable proxy and service-labeled target identities without returning environment values', async () => {
    const value = await nodeProxyTrafficDocker().inspect(input);
    expect(value).toMatchObject({ proxyId: 'f'.repeat(64), sourceId: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(value)).not.toContain('PRIVATE');
    const query = new URL('http://docker' + calls[1]!.url);
    expect(JSON.parse(query.searchParams.get('filters')!)).toEqual({ id: ['a'.repeat(64), 'b'.repeat(64)] });
    expect(boundary.capture.mock.calls.map(args => args.slice(0, 2))).toEqual([['docker', routingProbeArgs('f'.repeat(64), false)], ['docker', routingProbeArgs('f'.repeat(64), true)]]);
  });

  it.each(['header', 'weighted-route', 'tls', 'malformed', 'restarted'])('refuses a different or unavailable loaded generation: %s', async fault => {
    const good = boundary.capture.getMockImplementation()!;
    boundary.capture.mockImplementation(async (...args) => {
      const raw = await good(...args);
      if (fault === 'header') return raw.replace(/X-NineDeploy-Generation: [a-f0-9]{64}/, 'X-NineDeploy-Generation: ' + '0'.repeat(64));
      if (fault === 'weighted-route') return raw.replace('"weight":50', '"weight":1');
      if (fault === 'tls' && String(args[1].at(-1)).includes('https:')) throw Error('Private node response');
      if (fault === 'malformed') return 'Private node response';
      if (fault === 'restarted') proxy.RestartCount++;
      return raw;
    });
    await expect(nodeProxyTrafficDocker().inspect(input)).rejects.toThrow(/not confirmed/);
  });

  it.each(['name', 'running', 'tty', 'driver', 'proxyId', 'startedAt', 'restart'])('refuses unsupported proxy metadata: %s', async field => {
    if (field === 'name') proxy.Name = '/another'; if (field === 'running') proxy.State.Running = false;
    if (field === 'tty') proxy.Config.Tty = true; if (field === 'driver') proxy.HostConfig.LogConfig.Type = 'none';
    if (field === 'proxyId') proxy.Id = 'bad'; if (field === 'startedAt') proxy.State.StartedAt = 'invalid'; if (field === 'restart') proxy.RestartCount = -1;
    await expect(nodeProxyTrafficDocker().inspect(input)).rejects.toThrow(/not confirmed/);
  });

  it.each(['missing', 'name', 'state', 'managed', 'service'])('refuses changed target ownership: %s', async field => {
    if (field === 'missing') rows.pop(); if (field === 'name') rows[0].Names = ['/other']; if (field === 'state') rows[0].State = 'exited';
    if (field === 'managed') rows[0].Labels['ninedeploy.managed'] = 'database'; if (field === 'service') rows[0].Labels['ninedeploy.service'] = '99';
    await expect(nodeProxyTrafficDocker().inspect(input)).rejects.toThrow(/not confirmed/);
  });

  it('decodes fragmented Docker frames and UTF-8 lines while excluding stderr', async () => {
    const connection = start(); await connection.ready;
    const body = frame('first €\nsecond\n'); stream!.write(body.subarray(0, 3)); await turn();
    stream!.write(body.subarray(3, 17)); await turn(); stream!.write(body.subarray(17));
    stream!.write(frame('private stderr\n', 2)); await turn(); await turn();
    expect(connection.lines).toEqual(['first €', 'second']); expect(connection.fail).not.toHaveBeenCalled();
    connection.close(); await turn(); expect(connection.fail).not.toHaveBeenCalled();
  });

  it.each(['reserved', 'type', 'length', 'line', 'utf8'])('refuses invalid or oversized stream data: %s', async fault => {
    const connection = start(); await connection.ready;
    const failed = new Promise<void>(resolve => connection.fail.mockImplementation(() => resolve()));
    let data = frame('line\n');
    if (fault === 'reserved') data[1] = 1; if (fault === 'type') data[0] = 0;
    if (fault === 'length') data.writeUInt32BE(1024 * 1024 + 1, 4);
    if (fault === 'line') data = frame('x'.repeat(16_385));
    if (fault === 'utf8') data = frame(Buffer.from([0xff, 10]));
    stream!.write(data); await failed; expect(connection.fail).toHaveBeenCalledOnce();
    expect(connection.lines).toEqual([]);
  });

  it('refuses HTTP errors and early EOF without forwarding private daemon bodies', async () => {
    logStatus = 500; const bad = start(); await expect(bad.ready).rejects.toThrow(/stream/); expect(bad.lines).toEqual([]);
    logStatus = 200; const ended = start(); await ended.ready;
    const failed = new Promise<void>(resolve => ended.fail.mockImplementation(() => resolve())); stream!.end(); await failed;
    expect(ended.fail).toHaveBeenCalledOnce();
  });

  it('bounds log subscription headers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); stall = true;
    const arrived = once(server, 'request'); const connection = start(); const failure = expect(connection.ready).rejects.toThrow(/stream/);
    await arrived; await vi.advanceTimersByTimeAsync(5001); await failure; expect(connection.fail).toHaveBeenCalledOnce();
  });

  it('uses a fixed loopback GET with proxies disabled and no response body capture', async () => {
    const marker = '/__ninedeploy_traffic_' + 'd'.repeat(32) + '_start';
    await nodeProxyTrafficDocker().heartbeat('f'.repeat(64), marker);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toMatchObject({ AttachStdout: false, AttachStderr: false, Tty: false,
      Cmd: ['wget', '-Y', 'off', '-T', '2', '-q', '-O', '/dev/null', '--header', 'Host: nd-traffic.invalid', 'http://127.0.0.1' + marker] });
    expect(calls[1]!.body).toEqual({ Detach: true, Tty: false });
    await expect(nodeProxyTrafficDocker().heartbeat('f'.repeat(64), '/../../private')).rejects.toThrow(/invalid observation/);
    expect(calls).toHaveLength(2);
  });

  it('refuses unsupported Docker contexts before contacting another source', async () => {
    vi.stubEnv('DOCKER_CONTEXT', 'remote-ssh');
    await expect(nodeProxyTrafficDocker().inspect(input)).rejects.toThrow(/not confirmed/);
    expect(() => start()).toThrow(/direct Docker/); expect(calls).toEqual([]);
  });
});
