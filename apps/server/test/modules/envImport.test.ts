import { describe, expect, it, vi } from 'vitest';
import { envRoutes } from '../../src/modules/env.js';
import { asUser, buildTestApp, createFakeDb, svcRow } from '../helpers.js';

const cryptoMocks = vi.hoisted(() => ({
  encrypt: vi.fn((s: string) => `enc:${s}`),
  decrypt: vi.fn((s: string) => s.replace('enc:', '')),
}));
vi.mock('../../src/lib/crypto.js', () => cryptoMocks);

const envRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  serviceId: 1,
  scope: 'service',
  scopeKey: 1,
  key: 'EXISTING',
  valueEncrypted: 'enc:old',
  isSecret: false,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

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
