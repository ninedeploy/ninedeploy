import { afterEach, describe, expect, it, vi } from 'vitest';
import yaml from 'js-yaml';
import { domains, serviceTargets, services, settings } from '@ninedeploy/db';
import { renderDynamicConfig } from '../../src/engine/proxy.js';
import { beginCanary, endCanary, resetCanaryState, setCanaryStep } from '../../src/engine/canaryState.js';

/**
 * 0.16.9: while a canary is in progress the domain's Traefik service is a
 * weighted split between the release the service row names (`_stable`) and
 * the new one (`_canary`); without one it renders exactly as before.
 */
vi.mock('../../src/config.js', () => ({
  config: { port: 3000, paths: { dataDir: '' }, acmeEmail: null, dnsProvider: '', dnsToken: null },
}));

const makeDb = (domainRows: unknown[], serviceRows: unknown[], settingRows: unknown[] = [], targetRows: unknown[] = []) => ({
  select: vi.fn(() => ({
    from: vi.fn((t: unknown) => {
      const resolve = async () => {
        if (t === domains) return domainRows;
        if (t === services) return serviceRows;
        if (t === serviceTargets) return targetRows;
        if (t === settings) return settingRows;
        return [];
      };
      const pending = Promise.resolve().then(resolve);
      return Object.assign(pending, { where: async () => resolve() });
    }),
  })),
  query: { settings: { findFirst: async () => settingRows[0] } },
});

const domainRow = { id: 4, serviceId: 1, hostname: 'app.example.com', path: '/', ssl: false, status: 'active' };
const svcRow = { id: 1, slug: 'web', port: 3000, runtimeId: 'web-old', type: 'docker', replicas: 1, runtimeReplicas: 1 };

type Doc = { http: { services: Record<string, any>; routers: Record<string, any> } };
const render = async (rows: unknown[] = [svcRow], settingRows: unknown[] = []) =>
  yaml.load(await renderDynamicConfig(makeDb([domainRow], rows, settingRows) as never, { serverId: null })) as Doc;

afterEach(() => resetCanaryState());

describe('renderDynamicConfig during a canary', () => {
  it('renders a node-scoped split only on its primary node with both health levels', async () => {
    beginCanary(1, 'web', 9, 1, true, true, { serverId: 9, stableRuntimeId: 'web-old' });
    setCanaryStep(1, 1, { runtimeId: 'web-new', replicas: 1, port: 8080, weight: 25 }, 0, 1);
    const row = { ...svcRow, serverId: 9, healthCheck: 'http-strict', healthPath: '/ready?db=1' };
    const db = makeDb([domainRow], [row], [], [{ serviceId: 1, serverId: 3, runtimeId: 'edge-old', status: 'running' }]);
    const primary = yaml.load(await renderDynamicConfig(db as never, { serverId: 9 })) as Doc;
    expect(primary.http.services['svc_web_4'].weighted.services.map((s: any) => s.weight)).toEqual([75, 25]);
    expect(primary.http.services['svc_web_4'].weighted.healthCheck).toEqual({});
    expect(primary.http.services['svc_web_4_canary'].loadBalancer.healthCheck.path).toBe('/ready?db=1');
    expect(primary.http.services['svc_web_4_stable'].loadBalancer.healthCheck.path).toBe('/ready?db=1');
    const target = yaml.load(await renderDynamicConfig(db as never, { serverId: 3 })) as Doc;
    expect(target.http.services['svc_web_4'].weighted).toBeUndefined();
    expect(target.http.services['svc_web_4'].loadBalancer.servers[0].url).toContain('edge-old');
    const panel = yaml.load(await renderDynamicConfig(db as never)) as Doc;
    expect(panel?.http?.services?.['svc_web_4']).toBeUndefined();
  });

  it('does not split a replaced stable runtime or a primary moved away from the scoped node', async () => {
    beginCanary(1, 'web', 9, 1, true, true, { serverId: 9, stableRuntimeId: 'web-old' });
    setCanaryStep(1, 1, { runtimeId: 'web-new', replicas: 1, port: 3000, weight: 25 }, 0, 1);
    for (const row of [{ ...svcRow, serverId: 9, runtimeId: 'replaced-old' }, { ...svcRow, serverId: 3 }]) {
      const doc = yaml.load(await renderDynamicConfig(makeDb([domainRow], [row]) as never, { serverId: row.serverId })) as Doc;
      expect(doc.http.services['svc_web_4'].weighted).toBeUndefined();
    }
  });

  it.each(['/ready?check=1&scope=db%2Fmain', '/health/encoded%20path?key=a=b', '/ready?fields[0]=ok'])('preserves the accepted health endpoint %s on both releases', async (healthPath) => {
    beginCanary(1, 'web', 9, 1, true);
    setCanaryStep(1, 1, { runtimeId: 'web-new', replicas: 1, port: null, weight: 50 }, 0, 1);
    const doc = await render([{ ...svcRow, healthCheck: 'http-strict', healthPath }]);
    expect(doc.http.services['svc_web_4_stable'].loadBalancer.healthCheck.path).toBe(healthPath);
    expect(doc.http.services['svc_web_4_canary'].loadBalancer.healthCheck.path).toBe(healthPath);
  });

  it('preserves the accepted health query on ordinary replica backends', async () => {
    const healthPath = '/ready?check=1&scope=db%2Fmain';
    const doc = await render([{ ...svcRow, runtimeReplicas: 2, healthPath }]);
    expect(doc.http.services['svc_web_4'].loadBalancer.healthCheck.path).toBe(healthPath);
  });

  it('retains legacy path sanitization for an invalid stored health endpoint', async () => {
    const doc = await render([{ ...svcRow, runtimeReplicas: 2, healthPath: '/ready"\ninjected: true' }]);
    expect(doc.http.services['svc_web_4'].loadBalancer.healthCheck.path).toBe('/readyinjectedtrue');
    expect(Object.keys(doc.http.services['svc_web_4'].loadBalancer)).toEqual(['servers', 'healthCheck']);
  });

  it('removes an unhealthy single-container release from the weighted split with explicit HTTP readiness', async () => {
    beginCanary(1, 'web', 9, 1, true);
    setCanaryStep(1, 1, { runtimeId: 'web-new', replicas: 1, port: 8080, weight: 50 }, 0, 1);
    const doc = await render([{ ...svcRow, healthCheck: 'http-strict', healthPath: '/ready' }]);
    expect(doc.http.services['svc_web_4'].weighted.healthCheck).toEqual({});
    for (const leaf of ['stable', 'canary']) {
      expect(doc.http.services[`svc_web_4_${leaf}`].loadBalancer.healthCheck).toEqual({
        path: '/ready', interval: '5s', timeout: '3s', followRedirects: false,
      });
    }
    expect(doc.http.services['svc_web_4_canary'].loadBalancer.servers[0].url).toBe('http://web-new:8080');
  });

  it('propagates existing replica health to the weighted parent when both releases have probes', async () => {
    beginCanary(1, 'web', 9, 1, true);
    setCanaryStep(1, 1, { runtimeId: 'web-new', replicas: 2, port: null, weight: 50 }, 0, 1);
    const doc = await render([{ ...svcRow, runtimeReplicas: 2 }]);
    expect(doc.http.services['svc_web_4'].weighted.healthCheck).toEqual({});
    expect(doc.http.services['svc_web_4_stable'].loadBalancer.healthCheck.path).toBe('/');
    expect(doc.http.services['svc_web_4_canary'].loadBalancer.healthCheck.path).toBe('/');
  });

  it('keeps the weighted parent unsubscribed when only one release has a replica probe', async () => {
    beginCanary(1, 'web', 9, 1, true);
    setCanaryStep(1, 1, { runtimeId: 'web-new', replicas: 1, port: null, weight: 50 }, 0, 1);
    const doc = await render([{ ...svcRow, runtimeReplicas: 2, healthCheck: 'tcp' }]);
    expect(doc.http.services['svc_web_4'].weighted.healthCheck).toBeUndefined();
    expect(doc.http.services['svc_web_4_stable'].loadBalancer.healthCheck.path).toBe('/');
    expect(doc.http.services['svc_web_4_canary'].loadBalancer.healthCheck).toBeUndefined();
  });

  it('keeps a single-container non-canary route unchanged with explicit HTTP readiness', async () => {
    const doc = await render([{ ...svcRow, healthCheck: 'http-strict', healthPath: '/ready' }]);
    expect(doc.http.services['svc_web_4']).toEqual({ loadBalancer: { servers: [{ url: 'http://web-old:3000' }] } });
  });

  it('does not copy a panel canary candidate into another node routing configuration', async () => {
    beginCanary(1, 'web', 9, 1, true);
    setCanaryStep(1, 1, { runtimeId: 'web-new', replicas: 1, port: null, weight: 50 }, 0, 1);
    const rendered = await renderDynamicConfig(makeDb([domainRow], [{ ...svcRow, serverId: 2, healthCheck: 'http-strict' }]) as never, { serverId: 2 });
    const doc = yaml.load(rendered) as Doc;
    expect(doc.http.services['svc_web_4']).toEqual({ loadBalancer: { servers: [{ url: 'http://web-old:3000' }] } });
    expect(rendered).not.toContain('web-new');
    expect(doc.http.services['svc_web_4_canary']).toBeUndefined();
  });

  it.each(['tcp', 'running', 'command', 'http', null, undefined])('does not invent HTTP readiness for %s single-container releases', async (healthCheck) => {
    beginCanary(1, 'web', 9, 1, true);
    setCanaryStep(1, 1, { runtimeId: 'web-new', replicas: 1, port: null, weight: 50 }, 0, 1);
    const doc = await render([{ ...svcRow, healthCheck }]);
    expect(doc.http.services['svc_web_4'].weighted.healthCheck).toBeUndefined();
    expect(doc.http.services['svc_web_4_stable'].loadBalancer.healthCheck).toBeUndefined();
    expect(doc.http.services['svc_web_4_canary'].loadBalancer.healthCheck).toBeUndefined();
  });

  it('keeps strict readiness probes while preserving both sticky cookie levels', async () => {
    beginCanary(1, 'web', 9, 1, true);
    setCanaryStep(1, 1, { runtimeId: 'web-new', replicas: 1, port: null, weight: 25 }, 0, 1);
    const doc = await render([{ ...svcRow, healthCheck: 'http-strict' }], [{ key: 'sticky_session:1:enabled', value: 'true' }]);
    expect(doc.http.services['svc_web_4'].weighted.healthCheck).toEqual({});
    expect(doc.http.services['svc_web_4'].weighted.sticky.cookie.name).toBe('ninedeploy_release');
    expect(doc.http.services['svc_web_4_canary'].loadBalancer.healthCheck.followRedirects).toBe(false);
    expect(doc.http.services['svc_web_4_canary'].loadBalancer.sticky.cookie.name).toBe('ninedeploy_sticky');
  });

  it('renders one load balancer when no canary runs', async () => {
    const doc = await render();
    expect(doc.http.services['svc_web_4']).toEqual({ loadBalancer: { servers: [{ url: 'http://web-old:3000' }] } });
    expect(doc.http.services['svc_web_4_canary']).toBeUndefined();
  });

  it('splits the traffic by the step weight, the router unchanged', async () => {
    beginCanary(1, 'web', 9, 2, true);
    setCanaryStep(1, 1, { runtimeId: 'web-new', replicas: 1, port: null, weight: 10 }, 0, 1);
    const doc = await render();
    expect(doc.http.routers['web_4'].service).toBe('svc_web_4');
    expect(doc.http.services['svc_web_4']).toEqual({
      weighted: {
        services: [
          { name: 'svc_web_4_stable', weight: 90 },
          { name: 'svc_web_4_canary', weight: 10 },
        ],
      },
    });
    expect(doc.http.services['svc_web_4_stable']).toEqual({ loadBalancer: { servers: [{ url: 'http://web-old:3000' }] } });
    expect(doc.http.services['svc_web_4_canary']).toEqual({ loadBalancer: { servers: [{ url: 'http://web-new:3000' }] } });
  });

  it('lists the new release on its own port and with its replicas', async () => {
    beginCanary(1, 'web', 9, 1, true);
    setCanaryStep(1, 1, { runtimeId: 'web-new', replicas: 2, port: 8080, weight: 50 }, 0, 1);
    const doc = await render();
    expect(doc.http.services['svc_web_4_canary'].loadBalancer.servers).toEqual([{ url: 'http://web-new:8080' }, { url: 'http://web-new-r2:8080' }]);
    expect(doc.http.services['svc_web_4_canary'].loadBalancer.healthCheck.path).toBe('/');
  });

  it('keeps a visitor on one release when sticky sessions are on', async () => {
    beginCanary(1, 'web', 9, 1, true);
    setCanaryStep(1, 1, { runtimeId: 'web-new', replicas: 1, port: null, weight: 25 }, 0, 1);
    const doc = await render([svcRow], [{ key: 'sticky_session:1:enabled', value: 'true' }]);
    expect(doc.http.services['svc_web_4'].weighted.sticky.cookie.name).toBe('ninedeploy_release');
    expect(doc.http.services['svc_web_4_stable'].loadBalancer.sticky.cookie.name).toBe('ninedeploy_sticky');
  });

  it('goes back to one load balancer once the canary ends', async () => {
    beginCanary(1, 'web', 9, 1, true);
    setCanaryStep(1, 1, { runtimeId: 'web-new', replicas: 1, port: null, weight: 25 }, 0, 1);
    endCanary(1);
    const doc = await render();
    expect(doc.http.services['svc_web_4'].loadBalancer).toBeDefined();
  });

  it('a canary that has not reached its first step routes nothing to it', async () => {
    beginCanary(1, 'web', 9, 1, true);
    const doc = await render();
    expect(doc.http.services['svc_web_4'].loadBalancer).toBeDefined();
  });
});

describe('0.16.11 a sleeping service', () => {
  it('routes its domains to the panel wake endpoint, after its own middlewares', async () => {
    const doc = await render([{ ...svcRow, asleepAt: new Date(0) }]);
    expect(doc.http.routers['web_4'].service).toBe('svc_ninedeploy_wake');
    expect(doc.http.routers['web_4'].middlewares.at(-1)).toBe('mw_ninedeploy_wake');
    expect((doc.http as Record<string, any>).middlewares['mw_ninedeploy_wake']).toEqual({ addPrefix: { prefix: '/_nd/wake' } });
    expect(doc.http.services['svc_ninedeploy_wake'].loadBalancer.servers[0].url).toBe('http://host.docker.internal:3000');
  });

  it('an awake one renders as before, with no wake service', async () => {
    const doc = await render();
    expect(doc.http.routers['web_4'].service).toBe('svc_web_4');
    expect(doc.http.services['svc_ninedeploy_wake']).toBeUndefined();
  });
});
