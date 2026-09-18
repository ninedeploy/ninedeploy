import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asUser, buildTestApp } from '../helpers.js';
import { traefikRoutes } from '../../src/modules/traefik.js';
import * as exec from '../../src/lib/exec.js';

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  copyFileSync: vi.fn(() => {}),
}));

const proxyMocks = vi.hoisted(() => ({
  ensureNetwork: vi.fn(async () => undefined),
  ensureTraefik: vi.fn(async () => undefined),
  getAcmeEmail: vi.fn(async () => 'ops@example.com'),
  getDnsConfig: vi.fn(async () => null),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: fsMocks.existsSync,
    readFileSync: fsMocks.readFileSync,
    copyFileSync: fsMocks.copyFileSync,
  };
});

vi.mock('../../src/lib/exec.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/exec.js')>('../../src/lib/exec.js');
  return {
    ...actual,
    capture: vi.fn(),
    run: vi.fn(),
  };
});

vi.mock('../../src/engine/proxy.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/engine/proxy.js')>('../../src/engine/proxy.js');
  return {
    ...actual,
    ...proxyMocks,
    readCertificates: vi.fn(() => [
      { domain: 'app.example.com', expiresAt: new Date(Date.now() + 86400000 * 30), issuer: "Let's Encrypt" },
      { domain: 'noexpire.example.com', expiresAt: null, issuer: "Let's Encrypt" },
    ]),
  };
});

describe('traefik module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.readFileSync.mockReturnValue('');
    fsMocks.copyFileSync.mockReturnValue(undefined);
  });

  async function makeTraefikApp() {
    const app = await buildTestApp();
    await app.register(traefikRoutes);
    return app;
  }

  it('GET /traefik returns combined status, certs, routers, services, middlewares', async () => {
    const app = await makeTraefikApp();
    vi.mocked(exec.capture).mockImplementation(async (_cmd, args) => {
      if (args[0] === 'search') return '3.2.0\n3.1.0\n2.11.0\n';
      if (args[0] === 'inspect') return JSON.stringify({ Running: true, StartedAt: new Date(Date.now() - 3600000).toISOString() });
      if (args[0] === 'exec') return 'Version:      3.1.0\nCodename:     test';
      return '';
    });

    const res = await app.inject({
      method: 'GET',
      url: '/traefik',
      headers: asUser(),
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.status.running).toBe(true);
    expect(body.status.version).toBe('3.1.0');
    expect(body.status.versionLatest).toBe('3.2.0');
    expect(body.status.outdated).toBe(true);
    expect(body.certificates).toHaveLength(2);
    expect(body.certificates[0].domain).toBe('app.example.com');
    expect(body.certificates[0].daysUntilExpiry).toBe(30);
  });

  it('GET /traefik/status handles running container uptime and stopped container gracefully', async () => {
    const app = await makeTraefikApp();

    // 5 seconds uptime
    vi.mocked(exec.capture).mockImplementation(async (_cmd, args) => {
      if (args[0] === 'inspect') return JSON.stringify({ Running: true, StartedAt: new Date(Date.now() - 5000).toISOString() });
      if (args[0] === 'exec') return 'version v3.2.0';
      return '3.2.0\n';
    });
    const resSec = await app.inject({ method: 'GET', url: '/traefik/status', headers: asUser() });
    expect(resSec.statusCode).toBe(200);
    expect(resSec.json().uptime).toMatch(/^\d+s$/);

    // 2 minutes uptime
    vi.mocked(exec.capture).mockImplementation(async (_cmd, args) => {
      if (args[0] === 'inspect') return JSON.stringify({ Running: true, StartedAt: new Date(Date.now() - 120000).toISOString() });
      if (args[0] === 'exec') return 'version v3.2.0';
      return '3.2.0\n';
    });
    const resMin = await app.inject({ method: 'GET', url: '/traefik/status', headers: asUser() });
    expect(resMin.json().uptime).toMatch(/^\d+m$/);

    // 2 days uptime
    vi.mocked(exec.capture).mockImplementation(async (_cmd, args) => {
      if (args[0] === 'inspect') return JSON.stringify({ Running: true, StartedAt: new Date(Date.now() - 86400000 * 2).toISOString() });
      if (args[0] === 'exec') return 'version v3.2.0';
      return '3.2.0\n';
    });
    const resDays = await app.inject({ method: 'GET', url: '/traefik/status', headers: asUser() });
    expect(resDays.json().uptime).toMatch(/^\d+d \d+h$/);

    // A failed version probe is metadata-only and must not turn a running
    // container into a false "stopped" status.
    vi.mocked(exec.capture).mockImplementation(async (_cmd, args) => {
      if (args[0] === 'inspect') return JSON.stringify({ Running: true, StartedAt: new Date(Date.now() - 5000).toISOString() });
      if (args[0] === 'exec') throw new Error('binary not found');
      return '3.2.0\n';
    });
    const resNoVersion = await app.inject({ method: 'GET', url: '/traefik/status', headers: asUser() });
    expect(resNoVersion.json()).toMatchObject({ running: true, version: null });

    // Stopped container
    vi.mocked(exec.capture).mockRejectedValue(new Error('no such container'));
    const res = await app.inject({
      method: 'GET',
      url: '/traefik/status',
      headers: asUser(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.running).toBe(false);
    expect(body.version).toBeNull();
  });

  it('GET /traefik/certificates returns parsed certificate list', async () => {
    const app = await makeTraefikApp();

    const res = await app.inject({
      method: 'GET',
      url: '/traefik/certificates',
      headers: asUser(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(2);
    expect(body[0].domain).toBe('app.example.com');
  });

  it('GET /traefik/logs returns sliced log lines', async () => {
    const app = await makeTraefikApp();
    vi.mocked(exec.capture).mockResolvedValue('line 1\nline 2\nline 3\nline 4\n');

    const res = await app.inject({
      method: 'GET',
      url: '/traefik/logs?lines=2',
      headers: asUser(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.logs).toEqual(['line 3', 'line 4']);
  });

  it('GET /traefik/logs handles docker log errors gracefully', async () => {
    const app = await makeTraefikApp();
    vi.mocked(exec.capture).mockRejectedValue(new Error('docker dead'));

    const res = await app.inject({
      method: 'GET',
      url: '/traefik/logs',
      headers: asUser(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().logs).toEqual([]);
  });

  it('GET /traefik/config returns empty lists when dynamic.yml does not exist', async () => {
    const app = await makeTraefikApp();
    const res = await app.inject({
      method: 'GET',
      url: '/traefik/config',
      headers: asUser(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ routers: [], services: [], middlewares: [] });
  });

  it('GET /traefik/config parses dynamic YAML when present', async () => {
    const app = await makeTraefikApp();
    const sampleYaml = `
http:
  routers:
    middlewares:
    app_1:
      rule: "Host(\`app.example.com\`)"
      service: svc_app_1
      entryPoints:
        - websecure
      tls: {}
      middlewares:
        - mw_gzip
  services:
    svc_app_1:
      loadBalancer:
        servers:
          - url: "http://app-container:3000"
  middlewares:
    mw_gzip:
      compress: {}
`;
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(sampleYaml);

    const res = await app.inject({
      method: 'GET',
      url: '/traefik/config',
      headers: asUser(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.routers).toHaveLength(1);
    expect(body.routers[0].name).toBe('app_1');
    expect(body.routers[0].rule).toBe('Host(`app.example.com`)');
    expect(body.services).toHaveLength(1);
    expect(body.services[0].url).toBe('http://app-container:3000');
    expect(body.middlewares).toHaveLength(1);
    expect(body.middlewares[0].name).toBe('mw_gzip');
  });

  it('GET /traefik/version handles all comparison branches and semver tags', async () => {
    const app = await makeTraefikApp();
    // Major diff older / newer
    vi.mocked(exec.capture).mockImplementation(async (_cmd, args) => {
      if (args[0] === 'search') return '3.2.1\n3.2.0\n3.1.0\n';
      if (args[0] === 'inspect') return JSON.stringify({ Running: true, StartedAt: new Date(Date.now() - 86400000 * 2).toISOString() });
      if (args[0] === 'exec') return 'version v2.9.0';
      return '';
    });
    const res1 = await app.inject({ method: 'GET', url: '/traefik/version', headers: asUser() });
    expect(res1.json().outdated).toBe(true);

    // Current major is higher
    vi.mocked(exec.capture).mockImplementation(async (_cmd, args) => {
      if (args[0] === 'search') return '3.2.1\n';
      if (args[0] === 'inspect') return JSON.stringify({ Running: true, StartedAt: new Date(Date.now() - 120000).toISOString() });
      if (args[0] === 'exec') return 'version v4.0.0';
      return '';
    });
    const resMajorHigher = await app.inject({ method: 'GET', url: '/traefik/version', headers: asUser() });
    expect(resMajorHigher.json().outdated).toBe(false);

    // Current minor is higher
    vi.mocked(exec.capture).mockImplementation(async (_cmd, args) => {
      if (args[0] === 'search') return '3.1.0\n';
      if (args[0] === 'inspect') return JSON.stringify({ Running: true, StartedAt: new Date(Date.now() - 120000).toISOString() });
      if (args[0] === 'exec') return 'version v3.3.0';
      return '';
    });
    const resMinorHigher = await app.inject({ method: 'GET', url: '/traefik/version', headers: asUser() });
    expect(resMinorHigher.json().outdated).toBe(false);

    // Current patch is higher
    vi.mocked(exec.capture).mockImplementation(async (_cmd, args) => {
      if (args[0] === 'search') return '3.2.0\n';
      if (args[0] === 'inspect') return JSON.stringify({ Running: true, StartedAt: new Date(Date.now() - 120000).toISOString() });
      if (args[0] === 'exec') return 'version v3.2.1';
      return '';
    });
    const resPatchHigher = await app.inject({ method: 'GET', url: '/traefik/version', headers: asUser() });
    expect(resPatchHigher.json().outdated).toBe(false);

    // Search returns tags but none are v3
    vi.mocked(exec.capture).mockImplementation(async (_cmd, args) => {
      if (args[0] === 'search') return '2.11.0\n1.7.0\n';
      if (args[0] === 'inspect') return JSON.stringify({ Running: true, StartedAt: new Date().toISOString() });
      if (args[0] === 'exec') return 'version v3.2.0';
      return '';
    });
    const resNoV3 = await app.inject({ method: 'GET', url: '/traefik/version', headers: asUser() });
    expect(resNoV3.json().latest).toBeNull();
    expect(resNoV3.json().outdated).toBe(false);

    // Equal versions (3.2.0 vs 3.2.0)
    vi.mocked(exec.capture).mockImplementation(async (_cmd, args) => {
      if (args[0] === 'search') return '3.2.0\n';
      if (args[0] === 'inspect') return JSON.stringify({ Running: true, StartedAt: new Date(Date.now() - 3600000).toISOString() });
      if (args[0] === 'exec') return 'version v3.2.0';
      return '';
    });
    const resEqual = await app.inject({ method: 'GET', url: '/traefik/version', headers: asUser() });
    expect(resEqual.json().outdated).toBe(false);
    expect(resEqual.json().latest).toBe('3.2.0');

    // Search failure & null versions
    vi.mocked(exec.capture).mockImplementation(async (_cmd, args) => {
      if (args[0] === 'search') throw new Error('network down');
      if (args[0] === 'inspect') return JSON.stringify({ Running: false });
      return '';
    });
    const res4 = await app.inject({ method: 'GET', url: '/traefik/version', headers: asUser() });
    expect(res4.json().latest).toBeNull();
    expect(res4.json().outdated).toBe(false);
  });

  it('GET /traefik/config parses multiple items and handles read error', async () => {
    const app = await makeTraefikApp();
    const multiYaml = `
http:
  routers:
    app_1:
      rule: "Host(\`app1.example.com\`)"
      service: svc_app_1
    app_2:
      rule: "Host(\`app2.example.com\`)"
      service: svc_app_2
  services:
    svc_app_1:
      loadBalancer:
        servers:
          - url: "http://app1:3000"
    svc_app_2:
      loadBalancer:
        servers:
          - url: "http://app2:3000"
  middlewares:
    mw_1:
      compress: {}
    mw_2:
      compress: {}
`;
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(multiYaml);

    const res = await app.inject({ method: 'GET', url: '/traefik/config', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.routers).toHaveLength(2);
    expect(body.services).toHaveLength(2);
    expect(body.middlewares).toHaveLength(2);

    // Catch branch
    fsMocks.readFileSync.mockImplementation(() => { throw new Error('corrupt file'); });
    const resError = await app.inject({ method: 'GET', url: '/traefik/config', headers: asUser() });
    expect(resError.json()).toEqual({ routers: [], services: [], middlewares: [] });

    // Single section: routers only with http entrypoint and unknown property line
    const routersOnlyYaml = `
http:
  routers:
    only_router:
      rule: "Host(\`only.example.com\`)"
      service: svc_only
      entryPoints:
        - http
      priority: 50
`;
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(routersOnlyYaml);
    const resRoutersOnly = await app.inject({ method: 'GET', url: '/traefik/config', headers: asUser() });
    expect(resRoutersOnly.json().routers).toHaveLength(1);
    expect(resRoutersOnly.json().routers[0].entryPoints).toEqual(['http']);
    expect(resRoutersOnly.json().services).toHaveLength(0);
    expect(resRoutersOnly.json().middlewares).toHaveLength(0);

    // Single section: services only with custom property
    const servicesOnlyYaml = `
http:
  services:
    only_svc:
      passHostHeader: true
      loadBalancer:
        servers:
          - url: "http://only:8080"
`;
    fsMocks.readFileSync.mockReturnValue(servicesOnlyYaml);
    const resSvcOnly = await app.inject({ method: 'GET', url: '/traefik/config', headers: asUser() });
    expect(resSvcOnly.json().services).toHaveLength(1);
    expect(resSvcOnly.json().services[0].url).toBe('http://only:8080');

    // Single section: middlewares only followed by top-level tls and tcp section
    const mwOnlyYaml = `
http:
  middlewares:
    only_mw:
      compress: {}
  tls:
    options:
      default: {}
tls:
  certificates:
    - certResolver: letsencrypt
tcp:
  routers: {}
`;
    fsMocks.readFileSync.mockReturnValue(mwOnlyYaml);
    const resMwOnly = await app.inject({ method: 'GET', url: '/traefik/config', headers: asUser() });
    expect(resMwOnly.json().middlewares).toHaveLength(1);
  });

  it('K3: Traefik GET routes reject anonymous requests', async () => {
    const app = await makeTraefikApp();
    for (const url of ['/traefik', '/traefik/status', '/traefik/certificates', '/traefik/logs', '/traefik/config', '/traefik/version']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, `GET ${url} without auth must not be 200`).toBe(401);
    }
  });

  it('K3: only the scoped overview answers members; inventory routes are admin-only', async () => {
    const app = await makeTraefikApp();
    vi.mocked(exec.capture).mockRejectedValue(new Error('no such container'));

    const member = asUser({ id: 7, isOperator: false });
    // The shared UI page stays reachable, but must not carry the routing
    // tables or the certificate (domain) list — those map out every tenant
    // on the instance (same L-12 rule as /traefik/config).
    const overview = await app.inject({ method: 'GET', url: '/traefik', headers: member });
    expect(overview.statusCode).toBe(200);
    const body = overview.json();
    expect(body.status).toBeDefined();
    expect(body.routers).toEqual([]);
    expect(body.services).toEqual([]);
    expect(body.middlewares).toEqual([]);
    expect(body.certificates).toEqual([]);

    for (const url of [
      '/traefik/status',
      '/traefik/certificates',
      '/traefik/certificates/inventory',
      '/traefik/certificates/expiring',
      '/traefik/version',
      '/traefik/logs',
      '/traefik/config',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: member });
      expect(res.statusCode, `GET ${url} as member must be admin-only`).toBe(403);
    }
  });

  it('POST /traefik/restart restarts Traefik container', async () => {
    const app = await makeTraefikApp();
    vi.mocked(exec.capture).mockResolvedValue('ninedeploy-traefik\n');

    const res = await app.inject({
      method: 'POST',
      url: '/traefik/restart',
      headers: asUser(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, message: 'Traefik restarted' });
    expect(exec.capture).toHaveBeenCalledWith('docker', ['restart', 'ninedeploy-traefik']);
  });

  it('POST /traefik/restart throws error on failure', async () => {
    const app = await makeTraefikApp();
    vi.mocked(exec.capture).mockRejectedValue(new Error('restart failed'));

    const res = await app.inject({
      method: 'POST',
      url: '/traefik/restart',
      headers: asUser(),
    });

    expect(res.statusCode).toBe(500);
  });

  it('POST /traefik/backup-certs copies acme.json file', async () => {
    const app = await makeTraefikApp();
    fsMocks.copyFileSync.mockReturnValue(undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/traefik/backup-certs',
      headers: asUser(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().backupPath).toContain('acme-backup-');
  });

  it('POST /traefik/backup-certs throws 500 when copy fails', async () => {
    const app = await makeTraefikApp();
    fsMocks.copyFileSync.mockImplementation(() => {
      throw new Error('disk error');
    });

    const res = await app.inject({
      method: 'POST',
      url: '/traefik/backup-certs',
      headers: asUser(),
    });

    expect(res.statusCode).toBe(500);
  });

  it('POST /traefik/update pulls image and restarts container', async () => {
    const app = await makeTraefikApp();
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.copyFileSync.mockReturnValue(undefined);
    vi.mocked(exec.run).mockImplementation(async (_cmd, _args, _opts, onLog) => {
      onLog?.('pull step');
    });
    vi.mocked(exec.capture).mockResolvedValue('3.3.0\n');

    const res = await app.inject({
      method: 'POST',
      url: '/traefik/update',
      headers: asUser(),
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ok: true, newVersion: '3.3.0' });
    expect(exec.run).toHaveBeenCalledWith(
      'docker',
      ['pull', 'traefik:3'],
      { heartbeatMs: 20_000, heartbeatLabel: 'Pulling application image traefik:3' },
      expect.any(Function),
    );
    expect(exec.run).toHaveBeenCalledWith('docker', ['rm', '-f', 'ninedeploy-traefik'], {}, expect.any(Function));
    expect(proxyMocks.ensureNetwork).toHaveBeenCalled();
    expect(proxyMocks.ensureTraefik).toHaveBeenCalledWith(expect.any(Function), 'ops@example.com', null);

    // Update without existing acme.json
    fsMocks.existsSync.mockReturnValue(false);
    const resNoAcme = await app.inject({
      method: 'POST',
      url: '/traefik/update',
      headers: asUser(),
    });
    expect(resNoAcme.statusCode).toBe(200);
  });
});
