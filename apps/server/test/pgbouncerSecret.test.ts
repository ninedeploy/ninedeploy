import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt } from '../src/lib/crypto.js';
import { asUser, buildTestApp, createFakeDb } from './helpers.js';

/**
 * r643: GET /databases/:id/pgbouncer is `member`-readable, but the pooled
 * connection string it returned embedded the DECRYPTED password — the secret
 * `GET /:id/credentials` keeps at `admin`. Driven through the real
 * `pgbouncerStatusFor` (only docker is stubbed) so the masking is proven at the
 * route that serves it.
 */
const exec = vi.hoisted(() => ({
  capture: vi.fn(async (_cmd: string, args?: string[]) => {
    if (args?.[0] === 'inspect') return 'true\n';
    if (args?.[0] === 'exec') return 'pool_mode = transaction\n';
    return '';
  }),
}));
vi.mock('../src/lib/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/exec.js')>()),
  capture: exec.capture,
}));

const PASSWORD = 's3cret-pooled-pw';
const row = () => ({
  id: 4,
  name: 'shop',
  slug: 'shop',
  engine: 'postgres',
  ownerUserId: 1,
  projectId: 2,
  status: 'running',
  containerName: 'nd-db-shop',
  internalHost: 'nd-db-shop',
  internalPort: 5432,
  dbName: 'app',
  username: 'nine',
  passwordEncrypted: encrypt(PASSWORD),
  pgbouncerEnabled: true,
  pgbouncerContainerName: 'nd-pgb-shop',
  pgbouncerPort: 6432,
});

async function statusAs(userId: number, seatRole: 'member' | 'admin'): Promise<{ pooledConnectionString: string | null }> {
  const app = await buildTestApp({
    db: createFakeDb({
      findFirst: {
        databases: row(),
        projects: { id: 2, workspaceId: 5 },
        workspaceMembers: { id: 3, workspaceId: 5, userId, role: seatRole },
      },
    }),
  });
  await app.register((await import('../src/modules/pgbouncer.js')).pgbouncerRoutes);
  const res = await app.inject({ method: 'GET', url: '/4/pgbouncer', headers: asUser({ id: userId, isOperator: false }) });
  await app.close();
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe('pgbouncer status does not leak the database password below admin (r643)', () => {
  beforeEach(() => exec.capture.mockClear());

  it('masks the password for a workspace member', async () => {
    const body = await statusAs(8, 'member');
    expect(body.pooledConnectionString).toBe('postgres://nine:*@nd-pgb-shop:6432/app');
    expect(JSON.stringify(body)).not.toContain(PASSWORD);
  });

  it('still returns the usable URL to a database admin', async () => {
    const body = await statusAs(8, 'admin');
    expect(body.pooledConnectionString).toBe(`postgres://nine:${PASSWORD}@nd-pgb-shop:6432/app`);
  });
});
