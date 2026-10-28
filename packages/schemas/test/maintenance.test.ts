import { describe, expect, it } from 'vitest';
import { ERROR_PAGE_MAX_BYTES, errorPagesInput, maintenanceConfig, maintenanceInput } from '../src/maintenance.js';
import { BACKUP_REPLICAS_MAX, backupReplicasInput } from '../src/backupPolicy.js';
import { INLINE_DOCKERFILE_MAX_BYTES, inlineDockerfileInput } from '../src/inlineDockerfile.js';

describe('maintenance configuration', () => {
  it('uses defaults, trims addresses and accepts IPv4 and IPv6 CIDRs', () => {
    expect(maintenanceConfig.parse({ bypass: [' 192.0.2.1 ', '192.0.2.0/24', '2001:db8::1', '2001:db8::/64', '2001:db8:0:0:0:0:0:1'] })).toMatchObject({
      title: 'Down for maintenance', retryAfterSeconds: 300,
      bypass: ['192.0.2.1', '192.0.2.0/24', '2001:db8::1', '2001:db8::/64', '2001:db8:0:0:0:0:0:1'],
    });
    expect(maintenanceInput.parse({ maintenance: null })).toEqual({ maintenance: null });
  });

  it.each(['256.1.2.3', '192.0.2.1/33', '2001:db8::/129', '2001::db8::1', `${'1'.repeat(46)}:`, '192.0.2.1/no', '/24', '192.0.2.1/24/1', 'not-an-ip'])(
    'rejects invalid bypass address %s', address => {
      expect(maintenanceConfig.safeParse({ bypass: [address] }).success).toBe(false);
    },
  );
  it('bounds bypass entries and retry time', () => {
    expect(maintenanceConfig.safeParse({ bypass: Array(21).fill('192.0.2.1') }).success).toBe(false);
    expect(maintenanceConfig.safeParse({ retryAfterSeconds: 4 }).success).toBe(false);
  });
});

it('validates an inline Dockerfile or resets it to the repository version', () => {
  expect(inlineDockerfileInput.parse({ content: null })).toEqual({ content: null });
  expect(inlineDockerfileInput.safeParse({ content: '# base\nARG VERSION=1\nFROM example:$VERSION' }).success).toBe(true);
  expect(inlineDockerfileInput.safeParse({ content: 'RUN echo missing base' }).success).toBe(false);
  expect(inlineDockerfileInput.safeParse({ content: `FROM x\n${'a'.repeat(INLINE_DOCKERFILE_MAX_BYTES)}` }).success).toBe(false);
});

describe('custom error pages', () => {
  it('accepts an empty set and HTML at the UTF-8 byte limit', () => {
    expect(errorPagesInput.parse({ pages: {} })).toEqual({ pages: {} });
    expect(errorPagesInput.safeParse({ pages: { 502: '😀'.repeat(ERROR_PAGE_MAX_BYTES / 4) } }).success).toBe(true);
  });
  it('rejects unknown status codes and multi-byte HTML above the byte limit', () => {
    expect(errorPagesInput.safeParse({ pages: { 500: 'error' } }).success).toBe(false);
    expect(errorPagesInput.safeParse({ pages: { 503: `${'😀'.repeat(ERROR_PAGE_MAX_BYTES / 4)}é` } }).success).toBe(false);
    expect(errorPagesInput.safeParse({ pages: { 504: 'a'.repeat(ERROR_PAGE_MAX_BYTES + 1) } }).success).toBe(false);
  });
  it('accepts valid one, two, three and four-byte text', () => {
    expect(errorPagesInput.parse({ pages: { 503: 'aé中😀' } }).pages['503']).toBe('aé中😀');
  });
});

describe('backup replica destinations', () => {
  it('accepts distinct destinations and an empty list', () => {
    expect(backupReplicasInput.parse({ replicas: [] })).toEqual({ replicas: [] });
    expect(backupReplicasInput.parse({ replicas: [{ destinationId: 1, retainCount: 7 }, { destinationId: 2, retainCount: 1 }] }).replicas).toHaveLength(2);
  });
  it('rejects duplicate, invalid and too many destinations', () => {
    const replica = { destinationId: 1, retainCount: 7 };
    expect(backupReplicasInput.safeParse({ replicas: [replica, replica] }).success).toBe(false);
    expect(backupReplicasInput.safeParse({ replicas: [{ ...replica, retainCount: 0 }] }).success).toBe(false);
    expect(backupReplicasInput.safeParse({ replicas: Array.from({ length: BACKUP_REPLICAS_MAX + 1 }, (_, i) => ({ ...replica, destinationId: i + 1 })) }).success).toBe(false);
  });
});
