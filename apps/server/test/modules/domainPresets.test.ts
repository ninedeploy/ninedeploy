import { beforeEach, describe, expect, it, vi } from 'vitest';
import { domainPresetsRoutes } from '../../src/modules/domainPresets.js';
import { asUser, buildTestApp, createFakeDb } from '../helpers.js';

const cfMocks = vi.hoisted(() => ({
  detectPublicIp: vi.fn(async () => '198.51.100.7'),
}));
vi.mock('../../src/lib/cloudflare.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/cloudflare.js')>();
  return { ...actual, detectPublicIp: cfMocks.detectPublicIp };
});

let lastKey = '';
vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: (col: unknown, value: unknown) => {
      if (col && (col as { name?: string }).name === 'key') lastKey = String(value);
      return actual.eq(col, value);
    },
  };
});

function settingsDb(over: Record<string, unknown> = {}) {
  return createFakeDb({
    findFirst: {
      settings: () => (lastKey in over ? { key: lastKey, value: over[lastKey] } : undefined),
    },
  });
}

function fakeProvider(name = 'cloudflare-zone', over: Partial<{
  findZoneForHost: ReturnType<typeof vi.fn>;
  createRecord: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    name,
    listZones: vi.fn().mockResolvedValue([]),
    findZoneForHost: vi.fn().mockResolvedValue({ id: 'z1', name: 'example.com' }),
    createRecord: vi.fn().mockResolvedValue({ recordId: 'rec-1', hostname: 'app.example.com', type: 'A' as const }),
    deleteRecord: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

async function appWith(kernel: { registry: { listDomainProviders: () => unknown[]; getDomainProvider: (name: string) => unknown } }, db = createFakeDb()) {
  const a = await buildTestApp({ db });
  // `buildTestApp` already decorates `app.kernel` with a real `NineDeployKernel`
  // instance; we register the fake provider on its registry rather than
  // re-decorating the symbol (Fastify refuses duplicate `decorate()` calls).
  if (kernel.registry.listDomainProviders) {
    for (const provider of kernel.registry.listDomainProviders()) {
      a.kernel.registry.registerDomainProvider(provider as never);
    }
  }
  await a.register(domainPresetsRoutes);
  return a;
}

beforeEach(() => {
  cfMocks.detectPublicIp.mockClear();
  lastKey = '';
});

describe('Domain Presets routes (G-07 PR-D)', () => {
  it('GET / lists the registered IDomainProvider names', async () => {
    const kernel = {
      registry: {
        listDomainProviders: () => [fakeProvider('cloudflare-zone'), fakeProvider('dnsimple')],
        getDomainProvider: () => undefined,
      },
    };
    const res = await (await appWith(kernel)).inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ providers: ['cloudflare-zone', 'dnsimple'] });
  });

  it('GET / returns an empty list when no driver is registered', async () => {
    const kernel = { registry: { listDomainProviders: () => [], getDomainProvider: () => undefined } };
    const res = await (await appWith(kernel)).inject({ method: 'GET', url: '/', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ providers: [] });
  });

  it('POST /apply creates an A record on the happy path and emits an audit event', async () => {
    const provider = fakeProvider('cloudflare-zone', {
      createRecord: vi.fn().mockResolvedValue({ recordId: 'rec-1', hostname: 'app.example.com', type: 'A' }),
    });
    const kernel = {
      registry: {
        listDomainProviders: () => [provider],
        getDomainProvider: (name: string) => (name === 'cloudflare-zone' ? provider : undefined),
      },
    };
    const db = settingsDb({ dns_records_provider: 'cloudflare-zone', dns_records_content: '203.0.113.9' });
    const res = await (await appWith(kernel, db)).inject({
      method: 'POST',
      url: '/apply',
      headers: asUser(),
      payload: { hostname: 'app.example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      hostname: 'app.example.com',
      provider: 'cloudflare-zone',
      zone: 'example.com',
      recordId: 'rec-1',
      type: 'A',
      content: '203.0.113.9',
    });
    expect(provider.findZoneForHost).toHaveBeenCalledWith('app.example.com');
    expect(provider.createRecord).toHaveBeenCalledWith('z1', {
      hostname: 'app.example.com',
      type: 'A',
      content: '203.0.113.9',
      ttl: 1,
    });
  });

  it('POST /apply accepts an explicit --content override and skips the settings lookup', async () => {
    const provider = fakeProvider('cloudflare-zone');
    const kernel = {
      registry: {
        listDomainProviders: () => [provider],
        getDomainProvider: () => provider,
      },
    };
    const db = settingsDb({ dns_records_provider: 'cloudflare-zone' });
    const res = await (await appWith(kernel, db)).inject({
      method: 'POST',
      url: '/apply',
      headers: asUser(),
      payload: { hostname: 'app.example.com', content: 'target.example.net' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ type: 'CNAME', content: 'target.example.net' });
    expect(provider.createRecord).toHaveBeenCalledWith(
      'z1',
      expect.objectContaining({ type: 'CNAME', content: 'target.example.net' }),
    );
  });

  it('POST /apply falls back to detectPublicIp() when no content is configured anywhere', async () => {
    const provider = fakeProvider('cloudflare-zone');
    const kernel = {
      registry: {
        listDomainProviders: () => [provider],
        getDomainProvider: () => provider,
      },
    };
    const db = settingsDb({ dns_records_provider: 'cloudflare-zone' /* no dns_records_content */ });
    const res = await (await appWith(kernel, db)).inject({
      method: 'POST',
      url: '/apply',
      headers: asUser(),
      payload: { hostname: 'app.example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(cfMocks.detectPublicIp).toHaveBeenCalledTimes(1);
    expect(res.json()).toMatchObject({ type: 'A', content: '198.51.100.7' });
  });

  it('POST /apply returns 400 when no DNS provider is configured', async () => {
    const kernel = { registry: { listDomainProviders: () => [], getDomainProvider: () => undefined } };
    const db = settingsDb({ dns_records_provider: '' });
    const res = await (await appWith(kernel, db)).inject({
      method: 'POST',
      url: '/apply',
      headers: asUser(),
      payload: { hostname: 'app.example.com' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/No DNS provider configured/);
  });

  it('POST /apply is operator-gated — a member cannot write DNS with the operator token', async () => {
    // The provider token is configured operator-only (settings PUT /dns is
    // requireAdmin); this route spends it. A plain member (or a write-scoped
    // CI token) must not be able to create records in the operator's zones.
    const provider = fakeProvider('cloudflare-zone', {
      createRecord: vi.fn().mockResolvedValue({ recordId: 'rec-1', hostname: 'app.example.com', type: 'A' }),
    });
    const kernel = {
      registry: {
        listDomainProviders: () => [provider],
        getDomainProvider: (name: string) => (name === 'cloudflare-zone' ? provider : undefined),
      },
    };
    const db = settingsDb({ dns_records_provider: 'cloudflare-zone', dns_records_content: '203.0.113.9' });
    const res = await (await appWith(kernel, db)).inject({
      method: 'POST',
      url: '/apply',
      headers: asUser({ id: 7, isOperator: false }),
      payload: { hostname: 'app.example.com' },
    });
    expect(res.statusCode).toBe(403);
    expect(provider.createRecord).not.toHaveBeenCalled();
  });

  it('POST /apply returns 400 when the named provider is not registered on the kernel', async () => {
    const kernel = {
      registry: {
        listDomainProviders: () => [],
        getDomainProvider: () => undefined,
      },
    };
    const db = settingsDb({ dns_records_provider: 'cloudflare-zone' });
    const res = await (await appWith(kernel, db)).inject({
      method: 'POST',
      url: '/apply',
      headers: asUser(),
      payload: { hostname: 'app.example.com' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/No IDomainProvider registered/);
  });

  it('POST /apply returns 404 when no zone matches the hostname', async () => {
    const provider = fakeProvider('cloudflare-zone', {
      findZoneForHost: vi.fn().mockResolvedValue(null),
    });
    const kernel = {
      registry: {
        listDomainProviders: () => [provider],
        getDomainProvider: () => provider,
      },
    };
    const db = settingsDb({ dns_records_provider: 'cloudflare-zone' });
    const res = await (await appWith(kernel, db)).inject({
      method: 'POST',
      url: '/apply',
      headers: asUser(),
      payload: { hostname: 'nope.other.org' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toMatch(/No zone matches/);
    expect(provider.createRecord).not.toHaveBeenCalled();
  });

  it('POST /apply rejects an empty hostname with a Zod 400', async () => {
    const kernel = { registry: { listDomainProviders: () => [], getDomainProvider: () => undefined } };
    const res = await (await appWith(kernel)).inject({
      method: 'POST',
      url: '/apply',
      headers: asUser(),
      payload: { hostname: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /apply requires authentication', async () => {
    const kernel = { registry: { listDomainProviders: () => [], getDomainProvider: () => undefined } };
    const res = await (await appWith(kernel)).inject({ method: 'POST', url: '/apply', payload: { hostname: 'app.example.com' } });
    expect(res.statusCode).toBe(401);
  });
});
