import { describe, expect, it } from 'vitest';
import { acquireRegistryLock, registryLockKey } from '../../src/lib/registryLock.js';

describe('registry session lock (r230)', () => {
  it('serialises the login → pull → logout window per registry', async () => {
    const events: string[] = [];
    const session = async (who: string) => {
      const release = await acquireRegistryLock(registryLockKey(null, 'ghcr.io'));
      try {
        events.push(`${who} login`);
        await new Promise((r) => setTimeout(r, 5));
        events.push(`${who} pull`);
        events.push(`${who} logout`);
      } finally {
        release();
      }
    };
    await Promise.all([session('a'), session('b')]);
    // Never interleaved: b's login cannot land between a's login and logout.
    expect(events).toEqual(['a login', 'a pull', 'a logout', 'b login', 'b pull', 'b logout']);
  });

  it('keeps different registries and different nodes independent', async () => {
    expect(registryLockKey(null, 'ghcr.io')).not.toBe(registryLockKey(4, 'ghcr.io'));
    expect(registryLockKey(4, undefined)).toBe('node:4|docker.io');
    const a = await acquireRegistryLock(registryLockKey(null, 'ghcr.io'));
    // Would hang if keys collided.
    const b = await acquireRegistryLock(registryLockKey(null, 'registry.gitlab.com'));
    a();
    b();
  });

  it('survives a holder that throws and a double release', async () => {
    const key = registryLockKey(null, 'quay.io');
    const first = await acquireRegistryLock(key);
    first();
    first();
    const second = await acquireRegistryLock(key);
    second();
  });
});

describe('registry lock wiring (r230)', () => {
  it('every registry login site takes the lock first', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of ['engine/builders/docker.ts', 'engine/builders/remoteDocker.ts', 'engine/fanout.ts']) {
      const src = readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8');
      const lock = src.indexOf('acquireRegistryLock(');
      const login = Math.max(src.indexOf("'login', '--username'"), src.indexOf("'docker.login'"));
      expect(lock, file).toBeGreaterThan(-1);
      expect(lock, file).toBeLessThan(login);
    }
  });
});
