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
  config: { paths: { dataDir: '' }, acmeEmail: null, dnsProvider: '', dnsToken: null },
}));

const makeDb = (domainRows: unknown[], serviceRows: unknown[], settingRows: unknown[] = []) => ({
  select: vi.fn(() => ({
    from: vi.fn((t: unknown) => {
      const resolve = async () => {
        if (t === domains) return domainRows;
        if (t === services) return serviceRows;
        if (t === serviceTargets) return [];
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
