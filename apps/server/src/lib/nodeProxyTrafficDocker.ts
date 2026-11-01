import http from 'node:http';
import { createHash } from 'node:crypto';
import type { ProxyTrafficOpen, ServingTrafficOpen } from '@ninedeploy/schemas';
import { dockerTransport, engineRequest, type EngineTransport } from './dockerTty.js';
import { PROXY_TRAFFIC_BYTE_LIMIT, PROXY_TRAFFIC_LINE_LIMIT, proxyTrafficUnavailable } from './proxyTrafficCounter.js';
import { capture } from './exec.js';
import { routingProbeArgs, routingReplyIsApplied } from './proxyRoutingAck.js';
import { servingTrafficRoutesMatch } from './servingTrafficRouting.js';

export interface NodeProxyTrafficIO<Input = ProxyTrafficOpen> {
  inspect(input: Input): Promise<{ proxyId: string; sourceId: string }>;
  connect(proxyId: string, onLine: (line: string) => void, onFailure: () => void): { ready: Promise<void>; close(): void };
  heartbeat(proxyId: string, path: string): Promise<void>;
}

const transport = (): EngineTransport => {
  const context = (process.env.DOCKER_CONTEXT ?? '').trim();
  if (context && context !== 'default') throw proxyTrafficUnavailable('a direct Docker Engine transport is required');
  const value = dockerTransport();
  if (value.kind === 'cli') throw proxyTrafficUnavailable('a direct Docker Engine transport is required');
  return value;
};
const json = async (t: EngineTransport, method: string, path: string, body?: unknown): Promise<any> => {
  const res = await engineRequest(t, method, path, body, 2500);
  if (res.status < 200 || res.status >= 300 || res.body.length > 256 * 1024) throw proxyTrafficUnavailable('Docker identity was not confirmed');
  try { return res.body ? JSON.parse(res.body) : null; } catch { throw proxyTrafficUnavailable('Docker identity was not confirmed'); }
};

/** Fixed proxy logs/loopback probe only. No caller-supplied path, command or daemon. */
export function nodeProxyTrafficDocker(): NodeProxyTrafficIO<ProxyTrafficOpen | ServingTrafficOpen> {
  return {
    async inspect(input) {
      try {
        if ('serving' in input && !servingTrafficRoutesMatch(input)) throw proxyTrafficUnavailable('selected serving leaves are not routed');
        const t = transport();
        const proxy = await json(t, 'GET', '/containers/ninedeploy-proxy/json');
        if (!/^[a-f0-9]{64}$/.test(proxy?.Id) || proxy.Name !== '/ninedeploy-proxy' || !proxy.State?.Running ||
          typeof proxy.State.StartedAt !== 'string' || !Number.isFinite(Date.parse(proxy.State.StartedAt)) ||
          !Number.isSafeInteger(proxy.RestartCount) || proxy.RestartCount < 0 || proxy.Config?.Tty !== false ||
          !['json-file', 'local'].includes(proxy.HostConfig?.LogConfig?.Type)) throw proxyTrafficUnavailable('proxy log source is unsupported');
        const targets = 'serving' in input ? input.serving : [...input.stable, ...input.canary];
        const filter = encodeURIComponent(JSON.stringify({ id: targets.map(target => target.id) }));
        const rows = await json(t, 'GET', `/containers/json?all=1&filters=${filter}`);
        if (!Array.isArray(rows) || rows.length !== targets.length) throw proxyTrafficUnavailable('runtime identities changed');
        for (const target of targets) {
          const row = rows.find(value => value?.Id === target.id);
          if (!row || row.State !== 'running' || !Array.isArray(row.Names) || !row.Names.includes('/' + target.name) ||
            row.Labels?.['ninedeploy.managed'] !== 'service' || row.Labels?.['ninedeploy.service'] !== String(input.serviceId) ||
            ('serving' in input && row.Labels?.['ninedeploy.deployment'] !== String(input.deploymentId))) throw proxyTrafficUnavailable('runtime identities changed');
        }
        for (const tls of [false, true]) {
          const raw = await capture('docker', routingProbeArgs(proxy.Id, tls), { timeoutMs: 2500, maxOutputBytes: 4 * 1024 * 1024 });
          if (!routingReplyIsApplied(input.routingConfig, raw)) throw proxyTrafficUnavailable('loaded routing generation changed');
        }
        const after = await json(t, 'GET', '/containers/ninedeploy-proxy/json');
        if (after?.Id !== proxy.Id || !after.State?.Running || after.State.StartedAt !== proxy.State.StartedAt || after.RestartCount !== proxy.RestartCount) {
          throw proxyTrafficUnavailable('proxy restarted during routing confirmation');
        }
        return { proxyId: proxy.Id, sourceId: createHash('sha256').update(JSON.stringify([t, proxy.Id, proxy.Image, proxy.State.StartedAt, proxy.RestartCount, proxy.HostConfig.LogConfig])).digest('hex') };
      } catch { throw proxyTrafficUnavailable('proxy or selected runtimes were not confirmed'); }
    },
    connect(proxyId, onLine, onFailure) {
      if (!/^[a-f0-9]{64}$/.test(proxyId)) throw proxyTrafficUnavailable('invalid proxy identity');
      const t = transport();
      let intentional = false, failed = false, bytes = 0, frame: Buffer = Buffer.alloc(0), line: Buffer = Buffer.alloc(0);
      let response: http.IncomingMessage | undefined;
      let resolve!: () => void, reject!: (error: Error) => void;
      const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      void ready.catch(() => undefined);
      const fail = () => {
        if (intentional || failed) return;
        failed = true; clearTimeout(timer); reject(proxyTrafficUnavailable('log stream ended or was invalid')); onFailure(); req.destroy(); response?.destroy();
      };
      const req = http.request({ ...(t.kind === 'socket' ? { socketPath: t.socketPath } : { host: t.host, port: t.port }),
        method: 'GET', path: `/containers/${proxyId}/logs?follow=1&stdout=1&stderr=1&tail=0`, headers: { Host: 'docker' } }, res => {
        response = res; clearTimeout(timer);
        if (res.statusCode !== 200) { res.resume(); fail(); return; }
        resolve();
        res.on('data', (chunk: Buffer) => {
          try {
            bytes += chunk.length;
            if (bytes > PROXY_TRAFFIC_BYTE_LIMIT) throw new Error();
            frame = frame.length ? Buffer.concat([frame, chunk]) : chunk;
            while (frame.length >= 8) {
              const length = frame.readUInt32BE(4), stream = frame[0];
              if ((stream !== 1 && stream !== 2) || frame[1] || frame[2] || frame[3] || length > 1024 * 1024) throw new Error();
              if (frame.length < 8 + length) break;
              if (stream === 1) {
                const payload = frame.subarray(8, 8 + length);
                const data = line.length ? Buffer.concat([line, payload]) : payload;
                let begin = 0, newline = data.indexOf(10);
                while (newline >= 0) {
                  if (newline - begin > PROXY_TRAFFIC_LINE_LIMIT) throw new Error();
                  onLine(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(begin, newline)));
                  begin = newline + 1; newline = data.indexOf(10, begin);
                }
                line = Buffer.from(data.subarray(begin));
                if (line.length > PROXY_TRAFFIC_LINE_LIMIT) throw new Error();
              }
              frame = Buffer.from(frame.subarray(8 + length));
            }
          } catch { fail(); }
        });
        res.on('end', fail); res.on('error', fail); res.on('close', fail);
      });
      const timer = setTimeout(fail, 5000); timer.unref();
      req.on('error', fail); req.end();
      return { ready, close: () => { intentional = true; clearTimeout(timer); req.destroy(); response?.destroy(); reject(proxyTrafficUnavailable('window closed')); } };
    },
    async heartbeat(proxyId, path) {
      if (!/^[a-f0-9]{64}$/.test(proxyId) || !/^\/__ninedeploy_traffic_[a-f0-9]{32}_(start|end)$/.test(path)) throw proxyTrafficUnavailable('invalid observation marker');
      try {
        const t = transport();
        const exec = await json(t, 'POST', `/containers/${proxyId}/exec`, {
          AttachStdout: false, AttachStderr: false, Tty: false,
          Cmd: ['wget', '-Y', 'off', '-T', '2', '-q', '-O', '/dev/null', '--header', 'Host: nd-traffic.invalid', 'http://127.0.0.1' + path],
        });
        if (!/^[a-f0-9]{64}$/.test(exec?.Id)) throw new Error();
        await json(t, 'POST', `/exec/${exec.Id}/start`, { Detach: true, Tty: false });
      } catch { throw proxyTrafficUnavailable('observation marker could not be sent'); }
    },
  };
}
