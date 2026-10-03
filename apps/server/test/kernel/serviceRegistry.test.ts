import { describe, expect, it } from 'vitest';
import { ServiceRegistry } from '../../src/kernel/serviceRegistry.js';

describe('ServiceRegistry', () => {
  it('registers, checks, and retrieves services and typed drivers', () => {
    const registry = new ServiceRegistry();
    const mockCompute = { name: 'docker', pullImage: async () => {}, runContainer: async () => {}, stopContainer: async () => {}, removeContainer: async () => {}, inspectContainer: async () => ({ status: 'ok' }), getLogs: async () => [] };
    const mockProxy = { name: 'traefik', syncConfiguration: async () => {}, reload: async () => {}, getCertificateStatus: async () => [] };
    const mockStorage = { name: 's3', upload: async () => {}, download: async () => {}, delete: async () => {} };
    const mockDomain = {
      name: 'cloudflare-zone',
      listZones: async () => [],
      findZoneForHost: async () => null,
      createRecord: async () => ({ recordId: 'r', hostname: 'h', type: 'A' as const }),
      deleteRecord: async () => {},
    };

    registry.register('custom.svc', { id: 1 });
    expect(registry.has('custom.svc')).toBe(true);
    expect(registry.get('custom.svc')).toEqual({ id: 1 });
    expect(registry.getOptional('custom.svc')).toEqual({ id: 1 });

    registry.registerCompute(mockCompute);
    registry.registerProxy(mockProxy);
    registry.registerStorage(mockStorage);
    registry.registerDomainProvider(mockDomain);

    expect(registry.getCompute('docker')).toBe(mockCompute);
    expect(registry.getCompute('missing')).toBeUndefined();
    expect(registry.getProxy('traefik')).toBe(mockProxy);
    expect(registry.getProxy('missing')).toBeUndefined();
    expect(registry.getStorage('s3')).toBe(mockStorage);
    expect(registry.getStorage('missing')).toBeUndefined();
    expect(registry.getDomainProvider('cloudflare-zone')).toBe(mockDomain);
    expect(registry.getDomainProvider('missing')).toBeUndefined();
    expect(registry.listDomainProviders()).toEqual([mockDomain]);
  });

  it('refuses a duplicate domain provider name', () => {
    const registry = new ServiceRegistry();
    const a = { name: 'cf', listZones: async () => [], findZoneForHost: async () => null, createRecord: async () => ({ recordId: 'r', hostname: 'h', type: 'A' as const }), deleteRecord: async () => {} };
    const b = { ...a };
    registry.registerDomainProvider(a);
    expect(() => registry.registerDomainProvider(b)).toThrow(
      'Domain provider "cf" is already registered',
    );
  });

  it('returns an empty list when no domain providers are registered', () => {
    const registry = new ServiceRegistry();
    expect(registry.listDomainProviders()).toEqual([]);
    expect(registry.getDomainProvider('anything')).toBeUndefined();
  });

  it('keeps the domain provider array independent of `clear()` (mirrors services Map)', () => {
    // The typed drivers and the generic `services` map both reset on
    // `clear()`; the domain-provider index is a parallel list intentionally
    // — this test pins that contract so a future refactor cannot quietly
    // start leaking stale drivers after a `clear()`.
    const registry = new ServiceRegistry();
    const a = { name: 'cf', listZones: async () => [], findZoneForHost: async () => null, createRecord: async () => ({ recordId: 'r', hostname: 'h', type: 'A' as const }), deleteRecord: async () => {} };
    registry.registerDomainProvider(a);
    expect(registry.listDomainProviders()).toHaveLength(1);
    registry.clear();
    // Generic map is empty, typed driver accessor is empty too.
    expect(registry.getOptional('domain:cf')).toBeUndefined();
    expect(registry.getDomainProvider('cf')).toBeUndefined();
    // Re-registering after a clear must still throw on duplicates inside
    // the parallel index.
    registry.registerDomainProvider(a);
    expect(() => registry.registerDomainProvider({ ...a })).toThrow(
      'Domain provider "cf" is already registered',
    );
  });

  it('throws on duplicate registrations or missing services', () => {
    const registry = new ServiceRegistry();
    registry.register('proxy', { name: 'traefik' });

    expect(() => registry.register('proxy', { name: 'traefik2' })).toThrow(
      'Service "proxy" is already registered',
    );

    expect(() => registry.get('nonexistent')).toThrow(
      'Service "nonexistent" is not registered in the kernel registry',
    );
    expect(registry.getOptional('nonexistent')).toBeUndefined();
  });

  it('unregisters services and clears the registry', () => {
    const registry = new ServiceRegistry();
    registry.register('s1', 1);
    registry.register('s2', 2);

    expect(registry.unregister('s1')).toBe(true);
    expect(registry.unregister('s1')).toBe(false);
    expect(registry.has('s1')).toBe(false);

    registry.clear();
    expect(registry.has('s2')).toBe(false);
  });
});
