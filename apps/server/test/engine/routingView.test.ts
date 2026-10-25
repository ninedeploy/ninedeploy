import { describe, expect, it } from 'vitest';
import { buildRoutingView, type ContainerFacts, type RoutingFacts } from '../../src/engine/routingView.js';

const service = {
  slug: 'sip', type: 'docker' as const, runtimeId: 'sip-12', port: 8080, status: 'running' as const, asleepAt: null,
  publishedPort: null, runtimeReplicas: 1, replicas: 1,
  portMappings: [
    { hostPort: 5060, containerPort: 5060, protocol: 'udp' as const },
    { hostPort: 5060, containerPort: 5060, protocol: 'tcp' as const, hostIp: '203.0.113.7' },
    { hostPort: 10000, hostPortEnd: 10002, containerPort: 10000, protocol: 'udp' as const },
  ],
};
const domain = { id: 3, hostname: 'sip.example.com', path: null, ssl: true, status: 'active' as const };

const running = (ports: ContainerFacts['ports']): ContainerFacts => ({ state: 'running', health: null, ip: '172.18.0.5', ports });
const dynamicTo = (url: string) => ({
  http: { routers: { sip_3: { rule: 'Host(`sip.example.com`)', service: 'svc_sip_3' } }, services: { svc_sip_3: { loadBalancer: { servers: [{ url }] } } } },
});
const facts = (over: Partial<RoutingFacts> = {}): RoutingFacts => ({
  dynamic: dynamicTo('http://sip-12:8080'),
  container: running({
    '5060/udp': [{ HostIp: '0.0.0.0', HostPort: '5060' }],
    '5060/tcp': [{ HostIp: '203.0.113.7', HostPort: '5060' }],
    '10000/udp': [{ HostIp: '0.0.0.0', HostPort: '10000' }],
    '10001/udp': [{ HostIp: '0.0.0.0', HostPort: '10001' }],
    '10002/udp': [{ HostIp: '0.0.0.0', HostPort: '10002' }],
  }),
  portProxy: null,
  live: true,
  ...over,
});

describe('buildRoutingView', () => {
  it('shows a SIP service whose every hop is bound, with the source-IP note', () => {
    const view = buildRoutingView(service, [domain], facts());
    expect(view.container).toEqual({ name: 'sip-12', state: 'running', health: null, ip: '172.18.0.5' });
    expect(view.http).toEqual([expect.objectContaining({ router: 'sip_3', upstreams: ['http://sip-12:8080'], verdict: 'ok' })]);
    expect(view.ports.map((p) => p.verdict)).toEqual(['ok', 'ok', 'ok']);
    expect(view.ports[0]).toMatchObject({ via: 'docker', bound: ['0.0.0.0:5060/udp'], note: expect.stringContaining('source IP') });
    expect(view.ports[1]!.bound).toEqual(['203.0.113.7:5060/tcp']);
    expect(view.ports[2]!.bound).toHaveLength(3);
  });

  it('names the unbound ports of a range and a binding on the wrong address', () => {
    const f = facts();
    delete f.container!.ports['10001/udp'];
    f.container!.ports['5060/tcp'] = [{ HostIp: '0.0.0.0', HostPort: '5060' }];
    const view = buildRoutingView(service, [domain], f);
    expect(view.ports[1]).toMatchObject({ verdict: 'error', note: expect.stringContaining('1 of 1') });
    expect(view.ports[2]).toMatchObject({ verdict: 'error', note: expect.stringContaining('1 of 3') });
  });

  it('flags a router that still points at an old container', () => {
    const view = buildRoutingView(service, [domain], facts({ dynamic: dynamicTo('http://sip-11:8080') }));
    expect(view.http[0]).toMatchObject({ verdict: 'error', upstreams: ['http://sip-11:8080'], note: expect.stringContaining('sip-11') });
  });

  it('flags a domain Traefik has no router for, and one whose container is down', () => {
    expect(buildRoutingView(service, [domain], facts({ dynamic: { http: {} } })).http[0]).toMatchObject({ verdict: 'error', router: null });
    const down = buildRoutingView(service, [domain], facts({ container: { ...running({}), state: 'exited' } }));
    expect(down.http[0]).toMatchObject({ verdict: 'error', note: expect.stringContaining('502') });
    expect(down.ports.every((p) => p.verdict === 'error')).toBe(true);
  });

  it('follows a canary split to both leaves', () => {
    const dynamic = { http: {
      routers: { sip_3: { rule: 'Host(`sip.example.com`)', service: 'svc_sip_3' } },
      services: {
        svc_sip_3: { weighted: { services: [{ name: 'svc_sip_3_stable' }, { name: 'svc_sip_3_canary' }] } },
        svc_sip_3_stable: { loadBalancer: { servers: [{ url: 'http://sip-12:8080' }] } },
        svc_sip_3_canary: { loadBalancer: { servers: [{ url: 'http://sip-13:8080' }] } },
      },
    } };
    expect(buildRoutingView(service, [domain], facts({ dynamic })).http[0]).toMatchObject({
      verdict: 'ok', upstreams: ['http://sip-12:8080', 'http://sip-13:8080'],
    });
  });

  it('checks an allow-listed port on the proxy sidecar, not on the service container', () => {
    const svc = { ...service, portMappings: [{ hostPort: 2222, containerPort: 22, protocol: 'tcp' as const, allowFrom: ['198.51.100.0/24'] }] };
    const view = buildRoutingView(svc, [], facts({ portProxy: running({ '7100/tcp': [{ HostIp: '0.0.0.0', HostPort: '2222' }] }) }));
    expect(view.ports[0]).toMatchObject({ via: 'portproxy', verdict: 'ok', note: expect.stringContaining('proxy') });
    expect(buildRoutingView(svc, [], facts()).ports[0]).toMatchObject({ verdict: 'error', note: expect.stringContaining('port proxy') });
  });

  it('shows only the configuration for a service on a node', () => {
    const view = buildRoutingView(service, [domain], { dynamic: null, container: null, portProxy: null, live: false });
    expect(view.live).toBe(false);
    expect(view.http[0]).toMatchObject({ verdict: 'unknown', upstreams: ['http://sip-12:8080'] });
    expect(view.ports.every((p) => p.verdict === 'unknown' && p.bound === null)).toBe(true);
  });

  it('reports a pending domain and a service that never deployed', () => {
    expect(buildRoutingView(service, [{ ...domain, status: 'pending' as never }], facts()).http[0]!.verdict).toBe('warn');
    expect(buildRoutingView({ ...service, runtimeId: null }, [domain], facts()).http[0]).toMatchObject({ verdict: 'error', note: expect.stringContaining('No running container') });
  });
});
