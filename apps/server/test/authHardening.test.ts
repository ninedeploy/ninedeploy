import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { sessions, users, workspaceMembers, workspaces } from '@ninedeploy/db';
import { buildApp } from '../src/app.js';
import { issueSessionTokens } from '../src/lib/sessions.js';
import { verifyJwt } from '../src/lib/jwt.js';

// The real traefik plugin recreates the HOST's `ninedeploy-traefik` container
// on ready; the worker/collector/backup schedulers would start real timers and
// docker calls. Same stubs as app.test.ts / oidc.test.ts.
vi.mock('../src/plugins/traefik.js', () => ({ default: vi.fn(async () => undefined) }));
vi.mock('../src/plugins/worker.js', () => ({ default: vi.fn(async () => undefined) }));
vi.mock('../src/plugins/collector.js', () => ({ default: vi.fn(async () => undefined) }));
vi.mock('../src/plugins/backupScheduler.js', () => ({ default: vi.fn(async () => undefined) }));

/**
 * 0.10.36 auth hardening, asserted through the REAL app (real auth plugin,
 * real routes, real database) — the seam where these fixes are wired, not
 * just the units behind them.
 */
describe('auth hardening through the mounted app', () => {
  let app: FastifyInstance;
  let userId: number;

  beforeAll(async () => {
    app = await buildApp();
    await app.db.delete(workspaceMembers);
    await app.db.delete(workspaces);
    await app.db.delete(users);
    const [u] = await app.db
      .insert(users)
      .values({ email: 'harden@auth.test', passwordHash: 'not-a-real-hash', name: 'Harden', isInstanceOperator: true })
      .returning();
    userId = u!.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const me = (token: string) =>
    app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${token}` } });

  // r503: DELETE /auth/sessions/:id only stopped the refresh token; the access
  // token of the revoked device kept working for up to 15 minutes.
  it('r503: revoking a session ends its access token on the next request', async () => {
    const laptop = await issueSessionTokens(app.db, { id: userId, tokenVersion: 0 });
    const phone = await issueSessionTokens(app.db, { id: userId, tokenVersion: 0 });
    expect((await me(laptop.accessToken)).statusCode).toBe(200);
    expect((await me(phone.accessToken)).statusCode).toBe(200);

    const phoneJti = (await verifyJwt(phone.accessToken)).jti!;
    const row = await app.db.query.sessions.findFirst({ where: eq(sessions.jti, phoneJti) });
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/v1/auth/sessions/${row!.id}`,
      headers: { authorization: `Bearer ${laptop.accessToken}` },
    });
    expect(revoke.statusCode).toBe(200);

    // The revoked device is out immediately; the other session is untouched.
    expect((await me(phone.accessToken)).statusCode).toBe(401);
    expect((await me(laptop.accessToken)).statusCode).toBe(200);
  });

  it('r503: an access token whose session row was deleted is refused', async () => {
    const pair = await issueSessionTokens(app.db, { id: userId, tokenVersion: 0 });
    const jti = (await verifyJwt(pair.accessToken)).jti!;
    await app.db.delete(sessions).where(eq(sessions.jti, jti));
    expect((await me(pair.accessToken)).statusCode).toBe(401);
  });
});
