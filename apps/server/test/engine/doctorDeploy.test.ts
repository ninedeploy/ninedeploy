import { describe, expect, it } from 'vitest';
import {
  USERLAND_PROXY_PORT_THRESHOLD,
  deployLeftoverFindings,
  hostPortFindings,
  parseDockerLabels,
  userlandProxyFinding,
} from '../../src/engine/doctorDeploy.js';

const labels = (dep: number, svc: number) => ({ 'ninedeploy.managed': 'service', 'ninedeploy.deployment': String(dep), 'ninedeploy.service': String(svc) });
const svc = (over: Record<string, unknown> = {}) => ({
  id: 1, name: 'PBX', type: 'docker', status: 'running', serverId: null, runtimeId: 'pbx-10', port: 5060,
  publishedPort: null, portMappings: null, healthCheck: null, orchestrator: null, ...over,
});
const sip = [
  { hostIp: '10.0.0.5', hostPort: 5060, containerPort: 5060, protocol: 'udp' as const },
  { hostIp: '10.0.0.5', hostPort: 10000, hostPortEnd: 10199, containerPort: 10000, protocol: 'udp' as const },
];

describe('parseDockerLabels', () => {
  it('reads the docker ps label list', () => {
    expect(parseDockerLabels('ninedeploy.deployment=12,ninedeploy.service=3,a=b=c')).toEqual({
      'ninedeploy.deployment': '12', 'ninedeploy.service': '3', a: 'b=c',
    });
    expect(parseDockerLabels(undefined)).toEqual({});
  });
});

describe('deploy leftover containers', () => {
  it('reports a failed candidate that is still running (it holds the host ports)', () => {
    const f = deployLeftoverFindings(
      [{ name: 'pbx-11', state: 'running', labels: labels(11, 1) }],
      [svc()], [{ id: 11, status: 'failed' }], new Set(),
    );
    expect(f).toEqual([expect.objectContaining({ id: 'deploy_leftover_container:pbx-11', severity: 'warn', action: 'remove_deploy_leftover' })]);
  });

  it('reports the container of a deploy removed from history, and of a deleted service', () => {
    const f = deployLeftoverFindings(
      [{ name: 'pbx-7', state: 'exited', labels: labels(7, 1) }, { name: 'gone-3', state: 'exited', labels: labels(3, 99) }],
      [svc()], [], new Set(),
    );
    expect(f.map((x) => [x.target.name, x.severity])).toEqual([['pbx-7', 'info'], ['gone-3', 'info']]);
    expect(f[1]!.detail).toMatch(/service was deleted/);
  });

  it('never reports the live generation, its replicas, an in-flight deploy or a pending transition', () => {
    const f = deployLeftoverFindings(
      [
        { name: 'pbx-10', state: 'exited', labels: labels(10, 1) },    // live (stopped by a host-port deploy)
        { name: 'pbx-10-r2', state: 'running', labels: labels(10, 1) }, // its replica
        { name: 'pbx-12', state: 'running', labels: labels(12, 1) },    // the deploy in flight
        { name: 'web-5', state: 'running', labels: labels(5, 2) },      // routing transition pending
        { name: 'foreign', state: 'exited', labels: {} },               // not ours
      ],
      [svc(), svc({ id: 2, name: 'Web', runtimeId: 'web-4' })],
      [{ id: 12, status: 'building' }, { id: 5, status: 'failed' }],
      new Set([2]),
    );
    expect(f).toEqual([]);
  });
});

describe('host-port / NAT setups', () => {
  it('flags an HTTP domain on a UDP-only port (the 502) and an HTTP probe that can never pass', () => {
    const f = hostPortFindings([svc({ portMappings: sip })], new Set([1]), ['10.0.0.5']);
    expect(f.map((x) => x.kind).sort()).toEqual(['domain_on_udp_port', 'healthcheck_unpassable']);
    expect(f.find((x) => x.kind === 'healthcheck_unpassable')!.action).toBe('set_healthcheck_running');
  });

  it('is quiet for a UDP service with the running check and no domain', () => {
    expect(hostPortFindings([svc({ portMappings: sip, healthCheck: 'running' })], new Set(), ['10.0.0.5'])).toEqual([]);
  });

  it('control: a port also published as TCP is not UDP-only', () => {
    const both = [...sip, { hostIp: '10.0.0.5', hostPort: 5060, containerPort: 5060, protocol: 'tcp' as const }];
    expect(hostPortFindings([svc({ portMappings: both })], new Set([1]), ['10.0.0.5'])).toEqual([]);
  });

  it('flags a host IP this host does not have (a public NAT address bound directly)', () => {
    const f = hostPortFindings([svc({ portMappings: sip.map((m) => ({ ...m, hostIp: '203.0.113.9' })), healthCheck: 'running' })], new Set(), ['10.0.0.5']);
    expect(f.map((x) => x.kind)).toEqual(['port_host_ip_missing', 'port_host_ip_missing']);
    expect(f[0]!.severity).toBe('critical');
    expect(f[0]!.detail).toMatch(/PRIVATE address the router forwards to/);
    // Unknown host addresses: no guess.
    expect(hostPortFindings([svc({ portMappings: sip.map((m) => ({ ...m, hostIp: '203.0.113.9' })), healthCheck: 'running' })], new Set(), null)).toEqual([]);
  });

  it('flags two services publishing the same host socket, not different addresses', () => {
    const a = svc({ healthCheck: 'running', portMappings: sip });
    const b = svc({ id: 2, name: 'PBX2', runtimeId: 'pbx2-1', healthCheck: 'running', portMappings: [{ hostIp: null, hostPort: 5060, containerPort: 5060, protocol: 'udp' }] });
    const c = svc({ id: 3, name: 'Other', runtimeId: 'o-1', healthCheck: 'running', portMappings: [{ hostIp: '10.0.0.6', hostPort: 5060, containerPort: 5060, protocol: 'udp' }] });
    const f = hostPortFindings([a, b, c], new Set(), ['10.0.0.5', '10.0.0.6']);
    expect(f.map((x) => x.id)).toEqual(['host_port_conflict:1:2', 'host_port_conflict:2:3']);
  });
});

describe('userland proxy', () => {
  const many = [svc({ portMappings: [{ hostPort: 10000, hostPortEnd: 10000 + USERLAND_PROXY_PORT_THRESHOLD, containerPort: 10000, protocol: 'udp' }] })];
  it('warns on a large published range with the default daemon config', () => {
    expect(userlandProxyFinding(many, null)).toMatchObject({ kind: 'userland_proxy_ports', severity: 'warn' });
    expect(userlandProxyFinding(many, '{"log-driver":"json-file"}')).not.toBeNull();
  });
  it('is quiet when the proxy is off, the config is invisible, or few ports are published', () => {
    expect(userlandProxyFinding(many, '{"userland-proxy": false}')).toBeNull();
    expect(userlandProxyFinding(many, undefined)).toBeNull();
    expect(userlandProxyFinding([svc({ portMappings: [sip[0]] })], null)).toBeNull();
  });
});
