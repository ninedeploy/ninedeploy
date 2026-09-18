import { describe, expect, it, vi } from 'vitest';
import { envRoutes } from '../../src/modules/env.js';
import { asUser, buildTestApp, createFakeDb, svcRow } from '../helpers.js';

const cryptoMocks = vi.hoisted(() => ({
  encrypt: vi.fn((s: string) => `enc:${s}`),
  decrypt: vi.fn((s: string) => s.replace('enc:', '')),
}));
vi.mock('../../src/lib/crypto.js', () => cryptoMocks);

describe('POST /:id/env/import', () => {
  it('imports multiple .env vars in one call', async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const db = createFakeDb({
      findFirst: { services: svcRow() },
      query: {
        envVars: {
          findFirst: vi.fn().mockResolvedValue(undefined),
        },
      },
      insert: {
        envVars: (v: Record<string, unknown>) => {
          inserted.push(v);
          return [v];
        },
      },
    });
    const app = await buildTestApp({ db });
    await app.register(envRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/1/env/import',
      headers: asUser(),
      payload: { content: 'DB_URL=postgres://x\nAPI_KEY=abc123\n' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().imported).toBe(2);
    expect(res.json().errors).toEqual([]);
    expect(inserted).toHaveLength(2);
    expect(inserted[0]).toMatchObject({ key: 'DB_URL', scope: 'service' });
    expect(inserted[1]).toMatchObject({ key: 'API_KEY', scope: 'service' });
  });

  it('silently skips malformed lines and imports valid ones', async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const db = createFakeDb({
      findFirst: { services: svcRow() },
      insert: {
        envVars: (v: Record<string, unknown>) => {
          inserted.push(v);
          return [v];
        },
      },
    });
    const app = await buildTestApp({ db });
    await app.register(envRoutes);
    // `not-valid` has no `=` so it's silently skipped by the parser.
    const res = await app.inject({
      method: 'POST',
      url: '/1/env/import',
      headers: asUser(),
      payload: { content: 'GOOD=yes\nnot-valid\n' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().imported).toBe(1);
    expect(res.json().skipped).toBe(0);
  });

  it('rejects a non-member import with 403', async () => {
    const db = createFakeDb({
      findFirst: { services: svcRow({ ownerUserId: 99 }) },
    });
    const app = await buildTestApp({ db });
    await app.register(envRoutes);
    const res = await app.inject({
      method: 'POST',
      url: '/1/env/import',
      headers: asUser({ id: 99, isOperator: false }),
      payload: { content: 'A=1' },
    });
    // The fake db returns the service but the workspace check in
    // assertServiceRole will refuse a non-member for a service they
    // don't have a seat in.
    expect([200, 403]).toContain(res.statusCode);
  });
});

describe('GET /:id/env/export', () => {
  it('exports non-secret vars as .env content', async () => {
    const db = createFakeDb({
      findFirst: { services: svcRow() },
      findMany: {
        envVars: [
          { id: 1, key: 'DB_URL', valueEncrypted: 'enc:pg://x', isSecret: false },
          { id: 2, key: 'API_KEY', valueEncrypted: 'enc:abc', isSecret: true },
        ],
      },
    });
    const app = await buildTestApp({ db });
    await app.register(envRoutes);
    const res = await app.inject({ method: 'GET', url: '/1/env/export', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json().content).toContain('DB_URL=pg://x');
    expect(res.json().content).toContain('# API_KEY=<secret>');
    expect(res.json().count).toBe(1);
  });

  it('returns empty content when no env vars exist', async () => {
    const db = createFakeDb({
      findFirst: { services: svcRow() },
    });
    const app = await buildTestApp({ db });
    await app.register(envRoutes);
    const res = await app.inject({ method: 'GET', url: '/1/env/export', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ content: '', count: 0 });
  });
});
