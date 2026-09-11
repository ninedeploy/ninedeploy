import { describe, expect, it, vi } from 'vitest';
import { domainsRoutes } from '../src/modules/domains.js';
import { asUser, buildTestApp, createFakeDb, domainRow, svcRow } from './helpers.js';

const proxyMocks = vi.hoisted(() => ({
  writeDynamicConfig: vi.fn(async () => undefined),
  // The real sanitizer (imported by the module under test from the same path).
  parseHeaders: (raw: string | null | undefined) => {
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((i): i is { name: string; value: string } =>
          typeof (i as { name?: unknown })?.name === 'string' && typeof (i as { value?: unknown })?.value === 'string')
        .map((h) => ({ name: h.name.replace(/[^A-Za-z0-9-]/g, ''), value: h.value.replace(/["\\\n\r]/g, '') }))
        .filter((h) => h.name.length > 0);
    } catch {
      return [];
    }
  },
}));
vi.mock('../src/engine/proxy.js', () => proxyMocks);

const cfMocks = vi.hoisted(() => ({
  getDnsRecordsConfig: vi.fn(async () => ({ enabled: false, token: null, content: null })),
  createDnsRecord: vi.fn(async () => 'rec-1'),
  deleteDnsRecord: vi.fn(async () => undefined),
  detectPublicIp: vi.fn(async () => '203.0.113.5'),
}));
vi.mock('../src/lib/cloudflare.js', () => cfMocks);

describe('domains routes (Cloudflare integration)', () => {
  const createPayload = { hostname: 'app.example.com', path: '/', ssl: true };

  it('creates the DNS record when the integration is enabled', async () => {
    cfMocks.getDnsRecordsConfig.mockResolvedValueOnce({ enabled: true, token: 'tok', content: null });
    const db = createFakeDb({
      findFirst: { services: svcRow() },
      insert: { domains: [domainRow({ hostname: 'app.example.com' })] },
      update: { domains: [domainRow({ dnsRecordId: 'rec-1' })] },
    });
    const app = await buildTestApp({ db });
    await app.register(domainsRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/domains', headers: asUser(), payload: createPayload });
    expect(res.statusCode).toBe(200);
    expect(res.json().dnsRecordId).toBe('rec-1');
    expect(res.json().dnsWarning).toBeNull();
    expect(cfMocks.detectPublicIp).toHaveBeenCalled();
    expect(cfMocks.createDnsRecord).toHaveBeenCalledWith('tok', 'app.example.com', '203.0.113.5');
  });

  it('uses the configured record content directly', async () => {
    cfMocks.getDnsRecordsConfig.mockResolvedValueOnce({ enabled: true, token: 'tok', content: ' cname.example.net ' });
    const db = createFakeDb({
      findFirst: { services: svcRow() },
      insert: { domains: [domainRow()] },
    });
    const app = await buildTestApp({ db });
    await app.register(domainsRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/domains', headers: asUser(), payload: createPayload });
    expect(res.statusCode).toBe(200);
    expect(cfMocks.createDnsRecord).toHaveBeenCalledWith('tok', 'app.example.com', ' cname.example.net ');
  });

  it('auto-detects the public IP when content is set but empty', async () => {
    cfMocks.getDnsRecordsConfig.mockResolvedValueOnce({ enabled: true, token: 'tok', content: '' });
    const db = createFakeDb({
      findFirst: { services: svcRow() },
      insert: { domains: [domainRow()] },
    });
    const app = await buildTestApp({ db });
    await app.register(domainsRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/domains', headers: asUser(), payload: createPayload });
    expect(res.statusCode).toBe(200);
    expect(cfMocks.detectPublicIp).toHaveBeenCalled();
    expect(cfMocks.createDnsRecord).toHaveBeenCalledWith('tok', 'app.example.com', '203.0.113.5');
  });

  it('skips record deletion when the integration is disabled', async () => {
    // Default cfMocks state: enabled false.
    const db = createFakeDb({ findFirst: { services: svcRow(), domains: domainRow({ dnsRecordId: 'rec-7' }) } });
    const app = await buildTestApp({ db });
    await app.register(domainsRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/1/domains/1', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(cfMocks.deleteDnsRecord).not.toHaveBeenCalled();
  });

  it('surfaces provider failures as a warning without failing the request', async () => {
    cfMocks.getDnsRecordsConfig.mockResolvedValueOnce({ enabled: true, token: 'tok', content: '1.2.3.4' });
    cfMocks.createDnsRecord.mockRejectedValueOnce(new Error('zone missing'));
    const db = createFakeDb({
      findFirst: { services: svcRow() },
      insert: { domains: [domainRow()] },
    });
    const app = await buildTestApp({ db });
    await app.register(domainsRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/domains', headers: asUser(), payload: createPayload });
    expect(res.statusCode).toBe(200);
    expect(res.json().dnsWarning).toBe('zone missing');
    expect(res.json().dnsRecordId).toBeNull();
  });

  it('stringifies non-Error provider rejections', async () => {
    cfMocks.getDnsRecordsConfig.mockResolvedValueOnce({ enabled: true, token: 'tok', content: '1.2.3.4' });
    cfMocks.createDnsRecord.mockRejectedValueOnce('plain failure');
    const db = createFakeDb({
      findFirst: { services: svcRow() },
      insert: { domains: [domainRow()] },
    });
    const app = await buildTestApp({ db });
    await app.register(domainsRoutes);
    const res = await app.inject({ method: 'POST', url: '/1/domains', headers: asUser(), payload: createPayload });
    expect(res.statusCode).toBe(200);
    expect(res.json().dnsWarning).toBe('plain failure');
  });

  it('deletes the DNS record alongside the domain', async () => {
    cfMocks.getDnsRecordsConfig.mockResolvedValueOnce({ enabled: true, token: 'tok', content: null });
    const db = createFakeDb({
      findFirst: { services: svcRow(), domains: domainRow({ dnsRecordId: 'rec-9', hostname: 'app.example.com' }) },
    });
    const app = await buildTestApp({ db });
    await app.register(domainsRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/1/domains/1', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(cfMocks.deleteDnsRecord).toHaveBeenCalledWith('tok', 'app.example.com', 'rec-9');
  });

  it('tolerates provider failures on delete', async () => {
    cfMocks.getDnsRecordsConfig.mockResolvedValueOnce({ enabled: true, token: 'tok', content: null });
    cfMocks.deleteDnsRecord.mockRejectedValueOnce(new Error('api down'));
    const db = createFakeDb({
      findFirst: { services: svcRow(), domains: domainRow({ dnsRecordId: 'rec-9' }) },
    });
    const app = await buildTestApp({ db });
    await app.register(domainsRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/1/domains/1', headers: asUser() });
    expect(res.statusCode).toBe(200);
  });
});

describe('domains routes', () => {
  it('lists domains for a service', async () => {
    const app = await buildTestApp({
      db: createFakeDb({ findFirst: { services: svcRow() }, findMany: { domains: [domainRow({ id: 2, hostname: 'a.example.com', ssl: true })] } }),
    });
    await app.register(domainsRoutes);
    const res = await app.inject({ method: 'GET', url: '/1/domains', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        id: 2,
        serviceId: 1,
        hostname: 'a.example.com',
        path: '/',
        ssl: true,
        redirectWww: false,
        headers: '[]',
        basicAuth: null,
        ipAllowlist: null,
        rateLimitAverage: null,
        rateLimitBurst: null,
        status: 'active',
        verifiedAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('creates a domain for an existing service', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow() },
        insert: { domains: [domainRow({ id: 3, hostname: 'new.example.com', ssl: true })] },
      }),
    });
    await app.register(domainsRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/1/domains',
      headers: asUser(),
      payload: { hostname: 'new.example.com', path: '/', ssl: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 3, hostname: 'new.example.com', ssl: true });
    expect(proxyMocks.writeDynamicConfig).toHaveBeenCalled();
  });

  // Users paste full URLs into the domain field; only the bare hostname may
  // reach Traefik, so normalisation is asserted on the stored row.
  describe.each([
    ['a pasted https URL with trailing slash', 'https://nextjs-test.ninedeploy.vm.oxog.net/', 'nextjs-test.ninedeploy.vm.oxog.net'],
    ['an http URL with a deep path and query', 'http://App.Example.com/deep/path?x=1#frag', 'app.example.com'],
    ['a scheme-less paste with a trailing slash', 'app.example.com/', 'app.example.com'],
    ['a host with an explicit port', 'app.example.com:8080', 'app.example.com'],
    ['credentials in the URL', 'https://user:pass@app.example.com:8443/p', 'app.example.com'],
    ['a mixed-case hostname (DNS is case-insensitive)', 'MiXeD.Example.COM.', 'mixed.example.com'],
  ])('normalises %s', (_label, input, expected) => {
    it(`stores ${expected}`, async () => {
      let stored: Record<string, unknown> | undefined;
      const app = await buildTestApp({
        db: createFakeDb({
          findFirst: { services: svcRow() },
          insert: {
            domains: (value) => {
              stored = value as Record<string, unknown>;
              return [domainRow({ ...(stored as object), id: 3 })];
            },
          },
        }),
      });
      await app.register(domainsRoutes);
      const res = await app.inject({
        method: 'POST',
        url: '/1/domains',
        headers: asUser(),
        payload: { hostname: input },
      });
      expect(res.statusCode).toBe(200);
      expect(stored?.hostname).toBe(expected);
      expect(res.json().hostname).toBe(expected);
    });
  });

  it('rejects a paste that leaves no hostname once stripped', async () => {
    const app = await buildTestApp({ db: createFakeDb({ findFirst: { services: svcRow() } }) });
    await app.register(domainsRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/1/domains',
      headers: asUser(),
      payload: { hostname: 'https://' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });

  it('returns 404 when the service is missing', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(domainsRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/99/domains',
      headers: asUser(),
      payload: { hostname: 'x.example.com' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when the host already exists', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow() },
        insert: { domains: () => { throw new Error('UNIQUE constraint failed: domains_host_path_idx'); } },
      }),
    });
    await app.register(domainsRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/1/domains',
      headers: asUser(),
      payload: { hostname: 'dup.example.com' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('conflict');
  });

  it('deletes a domain and regenerates the proxy config', async () => {
    const app = await buildTestApp({ db: createFakeDb({ findFirst: { services: svcRow() } }) });
    await app.register(domainsRoutes);
    const res = await app.inject({ method: 'DELETE', url: '/1/domains/3', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(proxyMocks.writeDynamicConfig).toHaveBeenCalled();
  });

  it('rejects an invalid create payload', async () => {
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(domainsRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/1/domains',
      headers: asUser(),
      payload: { hostname: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  // ── routing extras: ssl / www redirect / headers ─────────────────────────
  it('patches ssl, redirectWww and headers together', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow() },
        update: {
          domains: [domainRow({ id: 3, ssl: true, redirectWww: true, headers: '[{"name":"X-Frame-Options","value":"DENY"}]' })],
        },
      }),
    });
    await app.register(domainsRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/1/domains/3',
      headers: asUser(),
      payload: { ssl: true, redirectWww: true, headers: '[{"name":"X-Frame-Options","value":"DENY"}]' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 3, ssl: true, redirectWww: true });
    expect(JSON.parse(res.json().headers)).toEqual([{ name: 'X-Frame-Options', value: 'DENY' }]);
    expect(proxyMocks.writeDynamicConfig).toHaveBeenCalled();
  });

  it('patches basicAuth, ipAllowlist, and rateLimit', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow() },
        update: {
          domains: [
            domainRow({
              id: 4,
              basicAuth: '["admin:secret"]',
              ipAllowlist: '10.0.0.0/8',
              rateLimitAverage: 100,
              rateLimitBurst: 200,
            }),
          ],
        },
      }),
    });
    await app.register(domainsRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/1/domains/4',
      headers: asUser(),
      payload: {
        basicAuth: '["admin:secret"]',
        ipAllowlist: '10.0.0.0/8',
        rateLimitAverage: 100,
        rateLimitBurst: 200,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().basicAuth).toBe('["admin:secret"]');
    expect(res.json().ipAllowlist).toBe('10.0.0.0/8');
    expect(res.json().rateLimitAverage).toBe(100);
    expect(res.json().rateLimitBurst).toBe(200);
    expect(proxyMocks.writeDynamicConfig).toHaveBeenCalled();
  });

  it('creates domain with basicAuth, ipAllowlist, and rateLimit', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow() },
        insert: {
          domains: [
            domainRow({
              hostname: 'auth.example.com',
              basicAuth: '["user:pass"]',
              ipAllowlist: '127.0.0.1/32',
              rateLimitAverage: 10,
              rateLimitBurst: 20,
            }),
          ],
        },
      }),
    });
    await app.register(domainsRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/1/domains',
      headers: asUser(),
      payload: {
        hostname: 'auth.example.com',
        basicAuth: '["user:pass"]',
        ipAllowlist: '127.0.0.1/32',
        rateLimitAverage: 10,
        rateLimitBurst: 20,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hostname).toBe('auth.example.com');
    expect(res.json().basicAuth).toBe('["user:pass"]');
    expect(res.json().ipAllowlist).toBe('127.0.0.1/32');
    expect(res.json().rateLimitAverage).toBe(10);
    expect(res.json().rateLimitBurst).toBe(20);
    expect(proxyMocks.writeDynamicConfig).toHaveBeenCalled();
  });

  it('sanitizes a hostile headers payload on patch', async () => {
    const app = await buildTestApp({
      db: createFakeDb({
        findFirst: { services: svcRow() },
        update: { domains: [domainRow({ id: 3, headers: '[{"name":"BadName","value":"ok"}]' })] },
      }),
    });
    await app.register(domainsRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/1/domains/3',
      headers: asUser(),
      payload: { headers: '[{"name":"Bad\\"Name","value":"ok"}]' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.json().headers)).toEqual([{ name: 'BadName', value: 'ok' }]);
  });

  it('returns 404 when patching a missing domain', async () => {
    const app = await buildTestApp({ db: createFakeDb({ update: { domains: [] } }) });
    await app.register(domainsRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/1/domains/99',
      headers: asUser(),
      payload: { ssl: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it('accepts an empty patch body', async () => {
    const app = await buildTestApp({ db: createFakeDb({ findFirst: { services: svcRow() }, update: { domains: [domainRow({ id: 3 })] } }) });
    await app.register(domainsRoutes);
    const res = await app.inject({ method: 'PATCH', url: '/1/domains/3', headers: asUser() });
    expect(res.statusCode).toBe(200);
  });

  it('rejects an invalid patch payload', async () => {
    const app = await buildTestApp({ db: createFakeDb({ findFirst: { services: svcRow() } }) });
    await app.register(domainsRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: '/1/domains/3',
      headers: asUser(),
      payload: { ssl: 'yes' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });
});

// node:dns/promises is mocked so the DNS-status route needs no real
// resolution; classifyResolution stays pure and is exercised directly.
const dnsMocks = vi.hoisted(() => ({ resolve4: vi.fn(), resolve6: vi.fn(), resolveTxt: vi.fn() }));
vi.mock('node:dns/promises', () => dnsMocks);

describe('domains DNS status', () => {
  it('reports ok when the hostname resolves to the expected address', async () => {
    dnsMocks.resolve4.mockResolvedValue(['203.0.113.5']);
    dnsMocks.resolve6.mockResolvedValue([]);
    cfMocks.detectPublicIp.mockResolvedValue('203.0.113.5');
    const db = createFakeDb({
      findFirst: {
        services: svcRow(),
        domains: domainRow({ id: 9, hostname: 'app.example.com', status: 'active' }),
      },
    });
    const app = await buildTestApp({ db });
    await app.register(domainsRoutes);
    const res = await app.inject({ method: 'GET', url: '/1/domains/9/dns', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      hostname: 'app.example.com',
      status: 'ok',
      addresses: { a: ['203.0.113.5'], aaaa: [] },
      expected: ['203.0.113.5'],
    });
  });

  it('reports mismatch when the hostname resolves elsewhere', async () => {
    dnsMocks.resolve4.mockResolvedValue(['198.51.100.9']);
    dnsMocks.resolve6.mockResolvedValue([]);
    const db = createFakeDb({
      findFirst: {
        services: svcRow(),
        domains: domainRow({ id: 9, hostname: 'app.example.com', status: 'active' }),
      },
    });
    const app = await buildTestApp({ db });
    await app.register(domainsRoutes);
    const res = await app.inject({ method: 'GET', url: '/1/domains/9/dns', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('mismatch');
    expect(res.json().addresses.a).toEqual(['198.51.100.9']);
  });

  it('reports unresolved when no address records exist', async () => {
    dnsMocks.resolve4.mockRejectedValue(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    dnsMocks.resolve6.mockRejectedValue(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    const db = createFakeDb({
      findFirst: {
        services: svcRow(),
        domains: domainRow({ id: 9, hostname: 'app.example.com', status: 'pending' }),
      },
    });
    const app = await buildTestApp({ db });
    await app.register(domainsRoutes);
    const res = await app.inject({ method: 'GET', url: '/1/domains/9/dns', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('unresolved');
  });

  it('returns 404 for a domain of another service', async () => {
    const db = createFakeDb({
      findFirst: { services: svcRow(), domains: null },
    });
    const app = await buildTestApp({ db });
    await app.register(domainsRoutes);
    const res = await app.inject({ method: 'GET', url: '/1/domains/9/dns', headers: asUser() });
    expect(res.statusCode).toBe(404);
  });
});
