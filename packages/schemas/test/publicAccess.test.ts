import { describe, expect, it } from 'vitest';
import {
  PUBLIC_ACCESS_ALLOWLIST_MAX,
  PUBLIC_ACCESS_PORT_MAX,
  PUBLIC_ACCESS_PORT_MIN,
  databasePublicAccessSummary,
  publicAccessEngines,
  publicAccessPut,
  publicAccessStatus,
  publicAccessTlsMode,
} from '../src/publicAccess.js';

const base = { enabled: true as const, port: 15432, ipAllowlist: ['203.0.113.0/24'] };

describe('publicAccessPut (0.14)', () => {
  it('defaults tlsMode to none and trims entries', () => {
    expect(publicAccessPut.parse({ ...base, ipAllowlist: [' 203.0.113.0/24 ', '2001:db8::/48'] })).toEqual({
      enabled: true,
      port: 15432,
      ipAllowlist: ['203.0.113.0/24', '2001:db8::/48'],
      tlsMode: 'none',
    });
  });

  it('keeps terminate mode and a hostname', () => {
    expect(publicAccessPut.parse({ ...base, tlsMode: 'terminate', tlsHostname: ' db.example.com ' })).toMatchObject({
      tlsMode: 'terminate',
      tlsHostname: 'db.example.com',
    });
  });

  it('pins enabled to true (disable is DELETE)', () => {
    expect(publicAccessPut.safeParse({ ...base, enabled: false }).success).toBe(false);
    const { enabled: _enabled, ...noEnabled } = base;
    expect(publicAccessPut.safeParse(noEnabled).success).toBe(false);
  });

  it('bounds the port to 1024–65535 integers', () => {
    expect(publicAccessPut.safeParse({ ...base, port: PUBLIC_ACCESS_PORT_MIN }).success).toBe(true);
    expect(publicAccessPut.safeParse({ ...base, port: PUBLIC_ACCESS_PORT_MAX }).success).toBe(true);
    expect(publicAccessPut.safeParse({ ...base, port: 443 }).success).toBe(false);
    expect(publicAccessPut.safeParse({ ...base, port: 65536 }).success).toBe(false);
    expect(publicAccessPut.safeParse({ ...base, port: 15432.5 }).success).toBe(false);
  });

  it('requires 1–100 non-empty allow-list entries', () => {
    expect(publicAccessPut.safeParse({ ...base, ipAllowlist: [] }).success).toBe(false);
    expect(publicAccessPut.safeParse({ ...base, ipAllowlist: ['  '] }).success).toBe(false);
    expect(publicAccessPut.safeParse({ ...base, ipAllowlist: ['x'.repeat(65)] }).success).toBe(false);
    const max = Array.from({ length: PUBLIC_ACCESS_ALLOWLIST_MAX }, (_, i) => `198.51.100.${i}`);
    expect(publicAccessPut.safeParse({ ...base, ipAllowlist: max }).success).toBe(true);
    expect(publicAccessPut.safeParse({ ...base, ipAllowlist: [...max, '192.0.2.1'] }).success).toBe(false);
  });

  it('refuses unknown TLS modes and malformed hostnames', () => {
    expect(publicAccessPut.safeParse({ ...base, tlsMode: 'passthrough' }).success).toBe(false);
    for (const h of ['-db.example.com', 'db..example.com', 'db_example.com', 'db.example.com.', '']) {
      expect(publicAccessPut.safeParse({ ...base, tlsHostname: h }).success, h).toBe(false);
    }
  });
});

describe('public access views', () => {
  it('describes an unconfigured database', () => {
    const view = {
      supported: true,
      configured: false,
      enabled: false,
      port: null,
      tlsMode: 'none',
      tlsHostname: null,
      ipAllowlist: [],
      status: 'off',
      lastError: null,
      appliedAt: null,
      publicHost: 'panel.example.com',
    };
    expect(publicAccessStatus.parse(view)).toEqual(view);
    expect(publicAccessStatus.safeParse({ ...view, status: 'starting' }).success).toBe(false);
  });

  it('summarises the database serializer field', () => {
    expect(databasePublicAccessSummary.parse(null)).toBeNull();
    expect(databasePublicAccessSummary.parse({ enabled: true, port: 15432 })).toEqual({ enabled: true, port: 15432 });
  });

  it('lists the TCP engines and both TLS modes', () => {
    expect(publicAccessEngines).toEqual(['postgres', 'mysql', 'mariadb', 'redis', 'valkey', 'mongo']);
    expect(publicAccessTlsMode.options).toEqual(['none', 'terminate']);
  });
});
