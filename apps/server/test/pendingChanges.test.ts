import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, runMigrations, services, users } from '@ninedeploy/db';

/**
 * G5.2 pending changes tray (`/v1/services/:id/pending`) on a real migrated
 * SQLite, with the real service PATCH route behind `apply`.
 */

vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

const { servicesRoutes } = await import('../src/modules/services.js');
const { pendingChangeRoutes, pendingForwardHeaders } = await import('../src/modules/pendingChanges.js');
const { asUser, buildTestApp } = await import('./helpers.js');

// The test app authenticates by its own headers; apply must forward them as it forwards a bearer.
pendingForwardHeaders.push('x-test-user', 'x-test-role', 'x-test-operator');

let db: DB;
let app: Awaited<ReturnType<typeof buildTestApp>>;
const OWNER = asUser({ id: 2, isOperator: false });
const OTHER = asUser({ id: 3, isOperator: false });
const deploys = vi.fn();

beforeEach(async () => {
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values([
    { id: 2, email: 'owner@example.com', name: 'Owner', passwordHash: 'x' },
    { id: 3, email: 'other@example.com', passwordHash: 'x' },
  ]);
  await db.insert(services).values({ id: 5, name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 2, port: 3000, healthPath: '/' } as never);
  app = await buildTestApp({ db });
  await app.register(servicesRoutes, { prefix: '/v1/services' });
  await app.register(pendingChangeRoutes, { prefix: '/v1/services' });
  deploys.mockReset();
  // Stands in for the deploy route: records who asked.
  app.post('/v1/services/:id/deploys', async (req) => {
    deploys(req.headers['x-test-user']);
    return { deploymentId: 77 };
  });
});
afterEach(async () => {
  await app.close();
});

const row = async () => db.query.services.findFirst({ where: (s, { eq }) => eq(s.id, 5) });
/** The tray's version as the caller sees it (apply needs it). */
const version = async (headers = OWNER) => (await call('GET', '/pending', undefined, headers)).json().version as string | null;
const call = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown, headers = OWNER) =>
  app.inject({ method, url: `/v1/services/5${url}`, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

describe('pending changes', () => {
  it('stage edits as a diff without touching the service, then apply them together and deploy', async () => {
    expect((await call('PUT', '/pending/staging', { staging: true })).json()).toMatchObject({ staging: true, changes: [] });
    await call('PUT', '/pending', { port: 8080 });
    const view = (await call('PUT', '/pending', { healthPath: '/healthz', branch: 'main' })).json();
    // `branch` is unchanged, so it is not a change.
    expect(view.changes).toEqual([
      { field: 'port', current: 3000, next: 8080, masked: false, stagedByUserId: 2, stagedBy: 'Owner' },
      { field: 'healthPath', current: '/', next: '/healthz', masked: false, stagedByUserId: 2, stagedBy: 'Owner' },
    ]);
    expect(view.updatedBy).toBe('Owner');
    expect(await row()).toMatchObject({ port: 3000, healthPath: '/' });

    const applied = await call('POST', '/pending/apply', { deploy: true, version: view.version });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toEqual({ applied: ['port', 'healthPath'], deploymentId: 77 });
    expect(await row()).toMatchObject({ port: 8080, healthPath: '/healthz' });
    expect(deploys).toHaveBeenCalledWith('2'); // as the caller, not as the panel
    // The tray is empty; staging stays on.
    expect((await call('GET', '/pending')).json()).toMatchObject({ staging: true, changes: [] });
  });

  it('drops a field set back to its current value', async () => {
    await call('PUT', '/pending', { port: 8080 });
    expect((await call('PUT', '/pending', { port: 3000 })).json().changes).toEqual([]);
  });

  it('refuses invalid edits and tag fields when staging, and keeps the tray when PATCH refuses', async () => {
    expect((await call('PUT', '/pending', { port: 'x' })).statusCode).toBe(400);
    expect((await call('PUT', '/pending', { tagLabelIds: [1] })).json().error.code).toBe('tags_via_put');
    // Valid for the schema, refused by the route: an operator-only field.
    await call('PUT', '/pending', { runtimeOptions: { shmSizeMb: 512 } });
    const res = await call('POST', '/pending/apply', { version: await version() });
    expect(res.statusCode).toBe(403);
    expect((await call('GET', '/pending')).json().changes).toHaveLength(1);
    expect((await call('DELETE', '/pending')).json().changes).toEqual([]);
    expect((await call('POST', '/pending/apply', { version: null })).statusCode).toBe(409);
  });

  it('security review: applies only the tray version that was reviewed, and keeps what was staged meanwhile', async () => {
    await call('PUT', '/pending', { port: 8080 });
    const reviewed = await version();
    // Someone stages more after the review.
    await new Promise((r) => setTimeout(r, 5));
    await call('PUT', '/pending', { healthPath: '/late' });
    const stale = await call('POST', '/pending/apply', { version: reviewed });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('pending_changed');
    expect(await row()).toMatchObject({ port: 3000, healthPath: '/' });
  });

  it('rejects a reviewed version after another edit in the same clock millisecond', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T10:00:00.000Z'));
    try {
      expect((await call('PUT', '/pending', { port: 8080 })).statusCode).toBe(200);
      const reviewed = await version();
      const timestampOnly = await call('POST', '/pending/apply', { version: '2026-10-29T10:00:00.000Z' });
      expect(timestampOnly.statusCode).toBe(409);
      expect(timestampOnly.json().error.code).toBe('pending_changed');
      expect((await call('PUT', '/pending', { healthPath: '/late' })).statusCode).toBe(200);
      const stale = await call('POST', '/pending/apply', { version: reviewed });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.code).toBe('pending_changed');
      expect(await row()).toMatchObject({ port: 3000, healthPath: '/' });
      const current = (await call('GET', '/pending')).json();
      expect(current.version).not.toBe(reviewed);
      expect(current.updatedAt).toBe('2026-10-29T10:00:00.000Z');
      expect((await call('POST', '/pending/apply', { version: current.version })).statusCode).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accepts an existing legacy tray using its stored timestamp', async () => {
    const { setSettingJson } = await import('../src/lib/settings.js');
    const updatedAt = '2026-10-28T10:00:00.000Z';
    await setSettingJson(db, 'pending_changes:5', { staging: true, patch: { port: 8080 }, stagedBy: { port: 2 }, updatedAt, updatedByUserId: 2 });
    expect(await version()).toBe(updatedAt);
    expect((await call('POST', '/pending/apply', { version: updatedAt })).statusCode).toBe(200);
    expect(await row()).toMatchObject({ port: 8080 });
  });

  it('security review: a caller sees in the tray only what GET shows them (the stack YAML is operator-only)', async () => {
    await db.update(services).set({ type: 'compose', composeContent: ['services:', '  web:', '    image: nginx', ''].join('\n') } as never);
    const OPERATOR = asUser({ id: 2, isOperator: true });
    const yaml = ['services:', '  web:', '    image: nginx', '    environment:', '      PASSWORD: hunter2', ''].join('\n');
    await call('PUT', '/pending', { composeContent: yaml }, OPERATOR);
    const member = (await call('GET', '/pending')).json().changes[0];
    expect(member).toMatchObject({ field: 'composeContent', masked: true, current: null, next: null });
    expect(JSON.stringify(member)).not.toContain('hunter2');
    const op = (await call('GET', '/pending', undefined, OPERATOR)).json().changes[0];
    expect(op).toMatchObject({ field: 'composeContent', masked: false });
    expect(String(op.next)).toContain('hunter2');
  });

  it("security review: someone else's staged change is applied only with includeOthers, under the applier's own checks", async () => {
    // A member seat for user 3 on the owner's service.
    const { workspaces, workspaceMembers, serviceWorkspaces } = await import('@ninedeploy/db');
    await db.insert(workspaces).values({ id: 1, name: 'Acme', slug: 'acme', ownerId: 2 });
    await db.insert(workspaceMembers).values({ workspaceId: 1, userId: 3, role: 'member' } as never);
    await db.insert(serviceWorkspaces).values({ serviceId: 5, workspaceId: 1 });
    const OPERATOR = asUser({ id: 2, isOperator: true });
    // The member stages an operator-only field and a harmless one.
    expect((await call('PUT', '/pending', { runtimeOptions: { shmSizeMb: 512 }, port: 8081 }, OTHER)).statusCode).toBe(200);
    const view = (await call('GET', '/pending', undefined, OPERATOR)).json();
    expect(view.changes.map((c: { field: string; stagedByUserId: number }) => [c.field, c.stagedByUserId])).toEqual([
      ['runtimeOptions', 3],
      ['port', 3],
    ]);
    // An operator pressing Apply without reviewing someone else's changes is refused.
    const v = await version(OPERATOR);
    const blind = await call('POST', '/pending/apply', { version: v }, OPERATOR);
    expect(blind.statusCode).toBe(409);
    expect(blind.json().error.code).toBe('others_changes');
    expect(await row()).toMatchObject({ port: 3000 });
    // The member cannot apply its own operator-only change: PATCH refuses it for them.
    expect((await call('POST', '/pending/apply', { version: v }, OTHER)).statusCode).toBe(403);
    // With includeOthers the operator vouches for them.
    expect((await call('POST', '/pending/apply', { includeOthers: true, version: v }, OPERATOR)).statusCode).toBe(200);
    expect(await row()).toMatchObject({ port: 8081 });
  });

  it('is for members of the service', async () => {
    expect((await call('GET', '/pending', undefined, OTHER)).statusCode).toBe(404);
    expect((await call('PUT', '/pending', { port: 1 }, OTHER)).statusCode).toBe(404);
  });
});
