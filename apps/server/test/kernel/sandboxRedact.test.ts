import { describe, expect, it } from 'vitest';
import { REDACTED, redactForSandbox } from '../../src/kernel/sandbox/redact.js';

describe('r533 — redactForSandbox', () => {
  it('redacts the secret columns the hook payloads actually carry', () => {
    const payload = {
      database: { id: 1, name: 'pg', username: 'app', passwordEncrypted: 'v1:cipher', engine: 'postgres' },
      domains: [
        { hostname: 'a.example.com', basicAuth: '["u:$apr1$hash"]', verificationToken: 'tok-1', ssl: true },
        { hostname: 'b.example.com', basicAuth: null, verificationToken: '' },
      ],
      token: 'enrol-token',
      name: 'node-1',
      port: 7443,
    };
    const { value, redactedCount } = redactForSandbox(payload);
    expect(value).toEqual({
      database: { id: 1, name: 'pg', username: 'app', passwordEncrypted: REDACTED, engine: 'postgres' },
      domains: [
        { hostname: 'a.example.com', basicAuth: REDACTED, verificationToken: REDACTED, ssl: true },
        // Absent values tell the plugin nothing — left as they are.
        { hostname: 'b.example.com', basicAuth: null, verificationToken: '' },
      ],
      token: REDACTED,
      name: 'node-1',
      port: 7443,
    });
    expect(redactedCount).toBe(4);
    // The input itself is never mutated.
    expect(payload.token).toBe('enrol-token');
  });

  it('keeps flags, counters, labels and non-secret structure intact', () => {
    const { value } = redactForSandbox({
      key: 'plugin:x:api_key',
      isSecret: true,
      tokenCount: 3,
      environment: 'production',
      env: { DATABASE_URL: 'postgres://u:p@db/x' },
      createdAt: new Date(0),
    });
    expect(value).toMatchObject({ key: 'plugin:x:api_key', isSecret: true, tokenCount: 3, environment: 'production', env: REDACTED });
    expect((value as { createdAt: unknown }).createdAt).toBeInstanceOf(Date);
  });

  it('strips URL userinfo anywhere, including a bare string payload', () => {
    expect(redactForSandbox({ repoUrl: 'https://user:pat@git.example.com/r.git' }).value).toEqual({
      repoUrl: `https://${REDACTED}@git.example.com/r.git`,
    });
    expect(redactForSandbox({ repoUrl: 'https://git.example.com/r.git' }).redactedCount).toBe(0);
    const bare = redactForSandbox('ssh://git:key@host/x');
    expect(bare.value).toBe(`ssh://${REDACTED}@host/x`);
    expect(bare.restore(bare.value)).toBe('ssh://git:key@host/x');
    expect(bare.restore('ssh://other@host/x')).toBe('ssh://other@host/x');
  });

  it('restore() puts originals back only where the placeholder survived', () => {
    const r = redactForSandbox({ service: { name: 'web', composeContent: 'secret: 1' }, token: 't', list: [{ password: 'p' }] });
    const echoed = JSON.parse(JSON.stringify(r.value));
    echoed.token = 'plugin-changed';
    const restored = r.restore(echoed) as typeof echoed;
    expect(restored.service.composeContent).toBe('secret: 1');
    expect(restored.list[0].password).toBe('p');
    expect(restored.token).toBe('plugin-changed');
    // A result that dropped the branch, or is not an object, passes through.
    expect(r.restore({ other: true })).toEqual({ other: true });
    expect(r.restore(undefined)).toBeUndefined();
    expect(r.restore({ service: 'flattened', list: [null] })).toEqual({ service: 'flattened', list: [null] });
    expect(redactForSandbox({ a: 1 }).restore('x')).toBe('x');
  });

  it('stops descending past the depth ceiling instead of walking forever', () => {
    let deep: Record<string, unknown> = { password: 'bottom' };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(() => redactForSandbox(deep)).not.toThrow();
  });
});
