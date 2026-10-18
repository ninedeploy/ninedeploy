import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load } from 'js-yaml';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 0.16.1 allow-listed port mappings (lib/portProxy.ts): a TCP port with
 * `allowFrom` is published by a Traefik sidecar on the service's bridge,
 * behind an ipAllowList, never by the service container; routes follow the
 * containers through the watched file; only a changed port list recreates it.
 */

const h = vi.hoisted(() => ({
  config: { paths: { dataDir: '' } },
  capture: vi.fn(async (..._a: unknown[]): Promise<string> => ''),
  run: vi.fn(async (..._a: unknown[]): Promise<void> => undefined),
}));
vi.mock('../src/config.js', () => ({ config: h.config }));
vi.mock('../src/lib/exec.js', () => ({ capture: h.capture, run: h.run }));
vi.mock('../src/lib/dockerPull.js', () => ({ ensureDockerImage: vi.fn(async () => undefined) }));
vi.mock('../src/lib/hostPath.js', () => ({ hostPathFor: vi.fn(async (p: string) => `/host${p}`) }));

const base = mkdtempSync(path.join(os.tmpdir(), 'nd-portproxy-'));
h.config.paths.dataDir = base;
afterAll(() => rmSync(base, { recursive: true, force: true }));

const proxy = await import('../src/lib/portProxy.js');
const { portMappingArgs, publishedByContainer, renderRuntimeCompose } = await import('../src/engine/builders/docker.js');

const pg = { hostIp: null, hostPort: 5432, hostPortEnd: null, containerPort: 5432, protocol: 'tcp' as const, allowFrom: ['10.0.0.0/8', '203.0.113.4/32'] };
const mqtt = { hostIp: '203.0.113.7', hostPort: 8883, hostPortEnd: null, containerPort: 8883, protocol: 'tcp' as const, allowFrom: ['198.51.100.0/24'] };
const open = { hostIp: null, hostPort: 27015, hostPortEnd: 27030, containerPort: 27015, protocol: 'udp' as const };

beforeEach(() => {
  vi.clearAllMocks();
  h.capture.mockResolvedValue('');
  rmSync(path.join(base, 'portproxy'), { recursive: true, force: true });
});

describe('rendering', () => {
  it('only allow-listed mappings go through the proxy; the container publishes the rest', () => {
    expect(proxy.restrictedMappings([pg, open, mqtt])).toEqual([pg, mqtt]);
    expect(publishedByContainer([pg, open, mqtt])).toEqual([open]);
    expect(portMappingArgs([pg, open])).toEqual(['-p', '27015-27030:27015-27030/udp']);
    const base = { name: 'db-1', image: 'img', restart: 'unless-stopped', bridge: 'nd-svc-db', cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0, dataVolume: null, dataMount: null, attachments: [], publishedPort: null, containerPort: null, dockerSocket: false, cmd: null, envFile: null };
    expect(renderRuntimeCompose({ ...base, portMappings: [pg] })).not.toContain('ports:');
  });

  it('a static entrypoint per mapping, and an ipAllowList router per entrypoint to every container', () => {
    const st = load(proxy.renderPortProxyStatic(2)) as { entryPoints: Record<string, { address: string }>; providers: unknown };
    expect(st.entryPoints).toEqual({ p0: { address: ':7100' }, p1: { address: ':7101' } });
    expect(st.providers).toEqual({ file: { directory: '/etc/traefik/dynamic', watch: true } });

    const dyn = load(proxy.renderPortProxyDynamic([pg, mqtt], ['db-5', 'db-5-r2'])) as {
      tcp: { routers: Record<string, unknown>; middlewares: Record<string, unknown>; services: Record<string, unknown> };
    };
    expect(dyn.tcp.routers['p1']).toEqual({ entryPoints: ['p1'], rule: 'HostSNI(`*`)', service: 's1', middlewares: ['a1'] });
    expect(dyn.tcp.middlewares['a0']).toEqual({ ipAllowList: { sourceRange: ['10.0.0.0/8', '203.0.113.4/32'] } });
    expect(dyn.tcp.services['s0']).toEqual({ loadBalancer: { servers: [{ address: 'db-5:5432' }, { address: 'db-5-r2:5432' }] } });
  });

  it('publishes each host side onto its entrypoint, locked down, on the service bridge', () => {
    expect(proxy.portProxyPublish(pg, 0)).toBe('5432:7100/tcp');
    expect(proxy.portProxyPublish(mqtt, 1)).toBe('203.0.113.7:8883:7101/tcp');
    expect(proxy.portProxyPublish({ ...mqtt, hostIp: '2001:db8::7' }, 1)).toBe('[2001:db8::7]:8883:7101/tcp');
    const argv = proxy.portProxyRunArgs({ slug: 'db', serviceId: 3, mappings: [pg, mqtt], fingerprint: 'f', hostDir: '/host/x', user: '1000:1000' });
    expect(argv).toEqual([
      'run', '-d', '--name', 'nd-portproxy-db', '--network', 'nd-svc-db', '--restart', 'unless-stopped',
      '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.5', '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL',
      '--user', '1000:1000', '--label', 'ninedeploy.portproxy.service=3', '--label', 'ninedeploy.portproxy.config=f',
      '-p', '5432:7100/tcp', '-p', '203.0.113.7:8883:7101/tcp', '-v', '/host/x:/etc/traefik:ro', expect.stringMatching(/^traefik:/),
    ]);
  });

  it('the fingerprint changes with the port list, not with the allow list (that is a watched route)', () => {
    const f = proxy.portProxyFingerprint([pg]);
    expect(proxy.portProxyFingerprint([{ ...pg, allowFrom: ['192.0.2.0/24'] }])).toBe(f);
    expect(proxy.portProxyFingerprint([{ ...pg, hostPort: 5433 }])).not.toBe(f);
    expect(proxy.portProxyFingerprint([pg, mqtt])).not.toBe(f);
  });

  it('refuses a slug that could leave the data directory', () => {
    expect(() => proxy.portProxyDir('../x')).toThrow(/invalid service slug/);
  });
});

describe('syncPortProxy', () => {
  const runArgv = () => h.run.mock.calls.map((c) => c[1] as string[]).find((a) => a[0] === 'run');

  it('writes the config and starts the sidecar the first time', async () => {
    h.capture.mockRejectedValue(new Error('No such container'));
    const logs: string[] = [];
    await proxy.syncPortProxy({ id: 3, slug: 'db', portMappings: [pg, open] }, ['db-5'], (l) => logs.push(l));
    const dir = path.join(base, 'portproxy', 'db');
    expect(readFileSync(path.join(dir, 'traefik.yml'), 'utf8')).toBe(proxy.renderPortProxyStatic(1));
    expect(readFileSync(path.join(dir, 'dynamic', 'routes.yml'), 'utf8')).toBe(proxy.renderPortProxyDynamic([pg], ['db-5']));
    expect(runArgv()).toContain('5432:7100/tcp');
    expect(logs).toContain('Port proxy nd-portproxy-db publishes 5432/tcp for the allowed addresses only');
  });

  it('a running sidecar with the same port list only gets new routes', async () => {
    h.capture.mockResolvedValue(`true ${proxy.portProxyFingerprint([pg])}\n`);
    await proxy.syncPortProxy({ id: 3, slug: 'db', portMappings: [pg] }, ['db-6'], () => undefined);
    expect(h.run).not.toHaveBeenCalled();
    expect(readFileSync(path.join(base, 'portproxy', 'db', 'dynamic', 'routes.yml'), 'utf8')).toContain('db-6:5432');
  });

  it('a changed port list, or a stopped sidecar, recreates it', async () => {
    h.capture.mockResolvedValue(`true ${proxy.portProxyFingerprint([pg])}\n`);
    await proxy.syncPortProxy({ id: 3, slug: 'db', portMappings: [pg, mqtt] }, ['db-6'], () => undefined);
    expect(h.run.mock.calls.map((c) => c[1] as string[])[0]).toEqual(['rm', '-f', 'nd-portproxy-db']);
    expect(runArgv()).toContain('203.0.113.7:8883:7101/tcp');

    h.run.mockClear();
    h.capture.mockResolvedValue(`false ${proxy.portProxyFingerprint([pg])}\n`);
    await proxy.syncPortProxy({ id: 3, slug: 'db', portMappings: [pg] }, ['db-6'], () => undefined);
    expect(runArgv()).toBeDefined();
  });

  it('no allow-listed mapping left: the sidecar and its directory are removed', async () => {
    h.capture.mockRejectedValue(new Error('No such container'));
    await proxy.syncPortProxy({ id: 3, slug: 'db', portMappings: [pg] }, ['db-5'], () => undefined);
    h.run.mockClear();
    h.capture.mockResolvedValue('true x\n');
    const logs: string[] = [];
    await proxy.syncPortProxy({ id: 3, slug: 'db', portMappings: [open] }, ['db-6'], (l) => logs.push(l));
    expect(h.run.mock.calls.map((c) => c[1])).toEqual([['rm', '-f', 'nd-portproxy-db']]);
    expect(existsSync(path.join(base, 'portproxy', 'db'))).toBe(false);
    expect(logs).toEqual(['Removed port proxy nd-portproxy-db']);
    // Nothing there: nothing to remove.
    h.run.mockClear();
    h.capture.mockRejectedValue(new Error('No such container'));
    await proxy.removePortProxy('db');
    expect(h.run).not.toHaveBeenCalled();
  });
});
