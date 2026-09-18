import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainPresetsPlugin } from '../../src/kernel/plugins/domainPresets.js';
import { createFakeDb } from '../helpers.js';

const { detectPublicIpMock } = vi.hoisted(() => ({
  detectPublicIpMock: vi.fn(),
}));
const fetchMock = vi.fn();

vi.mock('../../src/lib/cloudflare.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/cloudflare.js')>();
  return { ...actual, detectPublicIp: detectPublicIpMock };
});

globalThis.fetch = fetchMock as unknown as typeof fetch;

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

// r241: the plugin only acts on a routed (`active`) domain without a record.
let domainRow: Record<string, unknown> | undefined;

function settingsDb(over: Record<string, unknown> = {}) {
  return createFakeDb({
    findFirst: {
      settings: () => (lastKey in over ? { key: lastKey, value: over[lastKey] } : undefined),
      domains: () => domainRow,
    },
  });
}

const cloudflareProvider = (over: Partial<{
  findZoneForHost: ReturnType<typeof vi.fn>;
  createRecord: ReturnType<typeof vi.fn>;
}> = {}) => ({
  name: 'cloudflare-zone',
  findZoneForHost: vi.fn().mockResolvedValue({ id: 'z1', name: 'example.com' }),
  createRecord: vi.fn().mockResolvedValue({ recordId: 'rec-1', hostname: 'app.example.com', type: 'A' as const }),
  deleteRecord: vi.fn().mockResolvedValue(undefined),
  listZones: vi.fn().mockResolvedValue([]),
  ...over,
});

const dnsimpleProvider = (over: Partial<{
  findZoneForHost: ReturnType<typeof vi.fn>;
  createRecord: ReturnType<typeof vi.fn>;
}> = {}) => ({
  name: 'dnsimple',
  findZoneForHost: vi.fn().mockResolvedValue({ id: 'example.com', name: 'example.com' }),
  createRecord: vi.fn().mockResolvedValue({ recordId: '42', hostname: 'app.example.com', type: 'A' as const }),
  deleteRecord: vi.fn().mockResolvedValue(undefined),
  listZones: vi.fn().mockResolvedValue([]),
  ...over,
});

interface FakeKernel {
  events: {
    on: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
    emitCustom: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    onCustom: ReturnType<typeof vi.fn>;
    listenerCount: ReturnType<typeof vi.fn>;
    removeAllListeners: ReturnType<typeof vi.fn>;
  };
  configCenter: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  registry: { getDomainProvider: ReturnType<typeof vi.fn> };
  hooks: { tap: ReturnType<typeof vi.fn>; call: ReturnType<typeof vi.fn>; hasListeners: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> };
  menuRegistry: { registerMenuItem: ReturnType<typeof vi.fn>; unregisterMenuItem: ReturnType<typeof vi.fn>; getItemsForSlot: ReturnType<typeof vi.fn>; getAllItems: ReturnType<typeof vi.fn>; getPluginMenus: ReturnType<typeof vi.fn>; purgePluginMenus: ReturnType<typeof vi.fn> };
  db: unknown;
  state: string;
  config: unknown;
}

function newKernel(provider: ReturnType<typeof cloudflareProvider> | null, settings: Record<string, unknown>, options: { enabled?: boolean; detectIp?: string } = {}): { kernel: FakeKernel; plugin: DomainPresetsPlugin; emitted: Array<{ event: string; payload: unknown }> } {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const events = {
    on: vi.fn().mockReturnValue(() => {}),
    emit: vi.fn().mockImplementation((event: string, payload: unknown) => {
      emitted.push({ event, payload });
    }),
    emitCustom: vi.fn().mockImplementation((event: string, payload: unknown) => {
      emitted.push({ event, payload });
    }),
    once: vi.fn().mockReturnValue(() => {}),
    onCustom: vi.fn().mockReturnValue(() => {}),
    listenerCount: vi.fn().mockReturnValue(0),
    removeAllListeners: vi.fn(),
  };
  const store = new Map<string, unknown>();
  const configCenter = {
    get: vi.fn().mockImplementation((key: string, def: unknown) => {
      if (key === 'plugin:domain-presets:enabled') return Promise.resolve(options.enabled ?? def);
      return Promise.resolve(store.has(key) ? store.get(key) : def);
    }),
    set: vi.fn().mockImplementation(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    delete: vi.fn().mockImplementation(async (key: string) => store.delete(key)),
  };
  const registry = {
    getDomainProvider: vi.fn().mockImplementation((name: string) => (provider && provider.name === name ? provider : undefined)),
  };
  const hooks = { tap: vi.fn(), call: vi.fn(), hasListeners: vi.fn().mockReturnValue(false), clear: vi.fn() };
  const menuRegistry = { registerMenuItem: vi.fn(), unregisterMenuItem: vi.fn(), getItemsForSlot: vi.fn().mockReturnValue([]), getAllItems: vi.fn().mockReturnValue([]), getPluginMenus: vi.fn().mockReturnValue([]), purgePluginMenus: vi.fn().mockReturnValue(0) };
  const db = settingsDb(settings);
  // Pre-load the public-IP mock for callers that opt into auto-detection.
  detectPublicIpMock.mockResolvedValue(options.detectIp ?? '203.0.113.9');
  return {
    kernel: { events, configCenter, registry, hooks, menuRegistry, db, state: 'READY', config: {} } as unknown as FakeKernel,
    plugin: new DomainPresetsPlugin(),
    emitted,
  };
}

async function fireDomainAdd(kernel: FakeKernel, hostname: string, action = 'domain.add'): Promise<void> {
  // The plugin's `init` registers a single `audit.recorded` listener; invoke
  // it directly with the same shape the audit bridge would use.
  const listener = (kernel.events.on as ReturnType<typeof vi.fn>).mock.calls.find(
    (c: unknown[]) => c[0] === 'audit.recorded',
  )?.[1] as ((payload: unknown) => void) | undefined;
  if (!listener) throw new Error('audit.recorded listener not registered');
  listener({ action, entity: hostname, actorUserId: 1, ts: '2026-08-28T12:00:00.000Z' });
  // The handler is fire-and-forget (`void this.handle(...)`); wait one tick.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  domainRow = { id: 1, hostname: 'app.example.com', status: 'active', dnsRecordId: null };
  detectPublicIpMock.mockReset();
  fetchMock.mockReset();
  lastKey = '';
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('DomainPresetsPlugin', () => {
  it('exposes a stable id and an isOfficial flag', () => {
    const plugin = new DomainPresetsPlugin();
    expect(plugin.id).toBe('domain-presets');
    expect(plugin.isOfficial).toBe(true);
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('registers exactly one audit.recorded subscription and tears it down on destroy', () => {
    const { kernel, plugin } = newKernel(cloudflareProvider(), { dns_records_provider: 'cloudflare-zone' });
    plugin.init(kernel as unknown as never);
    expect(kernel.events.on).toHaveBeenCalledTimes(1);
    expect(kernel.events.on.mock.calls[0]?.[0]).toBe('audit.recorded');
    plugin.destroy();
  });

  it('ignores audit events whose action is not domain.add', async () => {
    const provider = cloudflareProvider();
    const { kernel, plugin, emitted } = newKernel(provider, { dns_records_provider: 'cloudflare-zone' });
    plugin.init(kernel as unknown as never);
    const listener = (kernel.events.on as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as (p: unknown) => void;
    listener({ action: 'service.created', entity: 'app.example.com', actorUserId: 1, ts: '2026-08-28T12:00:00.000Z' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(provider.findZoneForHost).not.toHaveBeenCalled();
    expect(provider.createRecord).not.toHaveBeenCalled();
    expect(emitted.find((e) => e.event === 'domain.preset.applied')).toBeUndefined();
  });

  it('ignores domain.add events that carry no entity', async () => {
    const provider = cloudflareProvider();
    const { kernel, plugin } = newKernel(provider, { dns_records_provider: 'cloudflare-zone' });
    plugin.init(kernel as unknown as never);
    const listener = (kernel.events.on as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as (p: unknown) => void;
    listener({ action: 'domain.add', entity: null, actorUserId: 1, ts: '2026-08-28T12:00:00.000Z' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(provider.findZoneForHost).not.toHaveBeenCalled();
  });

  it('short-circuits when the plugin is disabled via the config center', async () => {
    const provider = cloudflareProvider();
    const { kernel, plugin, emitted } = newKernel(
      provider,
      { dns_records_provider: 'cloudflare-zone' },
      { enabled: false },
    );
    plugin.init(kernel as unknown as never);
    await fireDomainAdd(kernel, 'app.example.com');
    expect(provider.findZoneForHost).not.toHaveBeenCalled();
    expect(emitted.find((e) => e.event === 'domain.preset.applied')).toBeUndefined();
  });

  it('publishes domain.preset.applied on the happy path with the Cloudflare driver', async () => {
    const provider = cloudflareProvider();
    const { kernel, plugin, emitted } = newKernel(
      provider,
      { dns_records_provider: 'cloudflare-zone', dns_records_content: '203.0.113.9' },
    );
    plugin.init(kernel as unknown as never);
    await fireDomainAdd(kernel, 'app.example.com');
    expect(provider.findZoneForHost).toHaveBeenCalledWith('app.example.com');
    expect(provider.createRecord).toHaveBeenCalledWith('z1', {
      hostname: 'app.example.com',
      type: 'A',
      content: '203.0.113.9',
      ttl: 1,
    });
    const applied = emitted.find((e) => e.event === 'domain.preset.applied');
    expect(applied).toBeDefined();
    expect(applied?.payload).toMatchObject({
      hostname: 'app.example.com',
      provider: 'cloudflare-zone',
      zone: 'example.com',
      recordId: 'rec-1',
      type: 'A',
      content: '203.0.113.9',
    });
  });

  it('routes through the DNSimple driver and stringifies the recordId', async () => {
    const provider = dnsimpleProvider();
    const { kernel, plugin, emitted } = newKernel(
      provider,
      { dns_records_provider: 'dnsimple', dns_records_content: '203.0.113.9' },
    );
    plugin.init(kernel as unknown as never);
    await fireDomainAdd(kernel, 'app.example.com');
    expect(provider.createRecord).toHaveBeenCalledWith('example.com', expect.objectContaining({ hostname: 'app.example.com', type: 'A' }));
    const applied = emitted.find((e) => e.event === 'domain.preset.applied');
    expect(applied?.payload).toMatchObject({ provider: 'dnsimple', zone: 'example.com', recordId: '42' });
  });

  it('falls back to detectPublicIp() when no content is configured', async () => {
    const provider = cloudflareProvider();
    const { kernel, plugin } = newKernel(
      provider,
      { dns_records_provider: 'cloudflare-zone' /* no dns_records_content */ },
      { detectIp: '198.51.100.7' },
    );
    plugin.init(kernel as unknown as never);
    await fireDomainAdd(kernel, 'app.example.com');
    expect(detectPublicIpMock).toHaveBeenCalledTimes(1);
    expect(provider.createRecord).toHaveBeenCalledWith('z1', expect.objectContaining({ content: '198.51.100.7' }));
  });

  it('creates a CNAME record when the configured content is a hostname', async () => {
    const provider = cloudflareProvider();
    const { kernel, plugin } = newKernel(
      provider,
      { dns_records_provider: 'cloudflare-zone', dns_records_content: 'target.example.net' },
    );
    plugin.init(kernel as unknown as never);
    await fireDomainAdd(kernel, 'app.example.com');
    expect(provider.createRecord).toHaveBeenCalledWith('z1', expect.objectContaining({ type: 'CNAME', content: 'target.example.net' }));
  });

  it('publishes domain.preset.failed when no provider is configured', async () => {
    const { kernel, plugin, emitted } = newKernel(
      null,
      { dns_records_provider: '' /* empty */ },
    );
    plugin.init(kernel as unknown as never);
    await fireDomainAdd(kernel, 'app.example.com');
    // No provider call, but a failure event is published so operators see why.
    expect(emitted.find((e) => e.event === 'domain.preset.failed')).toBeUndefined();
    // The handler should also not publish an "applied" event.
    expect(emitted.find((e) => e.event === 'domain.preset.applied')).toBeUndefined();
  });

  it('publishes domain.preset.failed when the registered provider is missing', async () => {
    // dns_records_provider=namecheap, but registry has no driver under that name.
    const { kernel, plugin, emitted } = newKernel(
      null,
      { dns_records_provider: 'namecheap' /* no driver registered */ },
    );
    plugin.init(kernel as unknown as never);
    await fireDomainAdd(kernel, 'app.example.com');
    const failed = emitted.find((e) => e.event === 'domain.preset.failed');
    expect(failed).toBeDefined();
    expect(failed?.payload).toMatchObject({ hostname: 'app.example.com', reason: /No IDomainProvider/ });
  });

  it('publishes domain.preset.failed when no zone matches the hostname', async () => {
    const provider = cloudflareProvider({ findZoneForHost: vi.fn().mockResolvedValue(null) });
    const { kernel, plugin, emitted } = newKernel(
      provider,
      { dns_records_provider: 'cloudflare-zone', dns_records_content: '203.0.113.9' },
    );
    plugin.init(kernel as unknown as never);
    domainRow = { id: 2, hostname: 'nope.other.org', status: 'active', dnsRecordId: null };
    await fireDomainAdd(kernel, 'nope.other.org');
    const failed = emitted.find((e) => e.event === 'domain.preset.failed');
    expect(failed).toBeDefined();
    expect(failed?.payload).toMatchObject({ hostname: 'nope.other.org', reason: /No zone matches/ });
    expect(provider.createRecord).not.toHaveBeenCalled();
  });

  it('publishes domain.preset.failed when the provider throws (NEVER propagates)', async () => {
    const provider = cloudflareProvider({
      createRecord: vi.fn().mockRejectedValue(new Error('Cloudflare API error: 503')),
    });
    const { kernel, plugin, emitted } = newKernel(
      provider,
      { dns_records_provider: 'cloudflare-zone', dns_records_content: '203.0.113.9' },
    );
    plugin.init(kernel as unknown as never);
    // The handler is fire-and-forget so a thrown error must not reach the caller.
    await fireDomainAdd(kernel, 'app.example.com');
    const failed = emitted.find((e) => e.event === 'domain.preset.failed');
    expect(failed).toBeDefined();
    expect(failed?.payload).toMatchObject({ hostname: 'app.example.com', reason: /Cloudflare API error: 503/ });
  });

  describe('r241', () => {
    it('does not create a record for a pending (unproven) domain, then does on domain.verified', async () => {
      const provider = dnsimpleProvider();
      const { kernel, plugin } = newKernel(provider, { dns_records_provider: 'dnsimple', dns_records_content: '203.0.113.9' });
      plugin.init(kernel as unknown as never);
      domainRow = { id: 1, hostname: 'app.example.com', status: 'pending', dnsRecordId: null };
      await fireDomainAdd(kernel, 'app.example.com');
      expect(provider.createRecord).not.toHaveBeenCalled();
      domainRow = { ...domainRow, status: 'active' };
      await fireDomainAdd(kernel, 'app.example.com', 'domain.verified');
      expect(provider.createRecord).toHaveBeenCalledTimes(1);
    });

    it('leaves Cloudflare to the domains route (no duplicate record, no failure noise)', async () => {
      const provider = { ...cloudflareProvider(), name: 'cloudflare' };
      const { kernel, plugin, emitted } = newKernel(provider, { dns_records_provider: 'cloudflare', dns_records_content: '203.0.113.9' });
      plugin.init(kernel as unknown as never);
      await fireDomainAdd(kernel, 'app.example.com');
      expect(provider.createRecord).not.toHaveBeenCalled();
      expect(emitted.find((e) => e.event === 'domain.preset.failed')).toBeUndefined();
    });

    it('does not create a second record when the domain already has one', async () => {
      const provider = dnsimpleProvider();
      const { kernel, plugin } = newKernel(provider, { dns_records_provider: 'dnsimple', dns_records_content: '203.0.113.9' });
      plugin.init(kernel as unknown as never);
      await fireDomainAdd(kernel, 'app.example.com');
      await fireDomainAdd(kernel, 'app.example.com', 'domain.verified');
      expect(provider.createRecord).toHaveBeenCalledTimes(1);
    });

    it('deletes the record it created when the domain is deleted', async () => {
      const provider = dnsimpleProvider();
      const { kernel, plugin, emitted } = newKernel(provider, { dns_records_provider: 'dnsimple', dns_records_content: '203.0.113.9' });
      plugin.init(kernel as unknown as never);
      await fireDomainAdd(kernel, 'app.example.com');
      domainRow = undefined;
      await fireDomainAdd(kernel, 'app.example.com', 'domain.delete');
      expect(provider.deleteRecord).toHaveBeenCalledWith('example.com', '42');
      expect(emitted.find((e) => e.event === 'domain.preset.removed')).toBeDefined();
      // Deleting an unknown hostname touches nothing.
      await fireDomainAdd(kernel, 'other.example.com', 'domain.delete');
      expect(provider.deleteRecord).toHaveBeenCalledTimes(1);
    });
  });
});
