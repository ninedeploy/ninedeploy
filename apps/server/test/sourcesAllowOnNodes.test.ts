import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, runMigrations, sources, users } from '@ninedeploy/db';

/**
 * Multi-node T3 (design §3.2/§3.3, owner decision O5): `PATCH /v1/sources/:id`
 * `allowOnNodes`. Off for every existing source; turning it ON sends a
 * long-lived PAT or deploy key to nodes, so it needs an interactive session
 * and a password re-check (step-up) and is audited `source.allow_on_nodes`
 * with the previous value. Turning it off needs neither. The response and the
 * listing carry `allowOnNodes` (additive).
 */

const h = vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ef'.repeat(32);
  return { audit: vi.fn(async (..._args: unknown[]) => undefined) };
});
vi.mock('../src/lib/audit.js', () => ({ audit: h.audit }));

const { sourcesRoutes } = await import('../src/modules/sources.js');
const { encrypt, hashPassword } = await import('../src/lib/crypto.js');
const { asUser, buildTestApp } = await import('./helpers.js');

const PASSWORD = 'correct horse battery staple';
let db: DB;
let patId: number;
let registryId: number;

beforeEach(async () => {
  h.audit.mockClear();
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values({ id: 1, email: 'op@example.com', passwordHash: await hashPassword(PASSWORD), isInstanceOperator: true });
  patId = (await db.insert(sources).values({ type: 'github', name: 'pat', tokenEncrypted: encrypt('ghp_x') }).returning())[0]!.id;
  registryId = (await db.insert(sources).values({ type: 'registry', name: 'reg', tokenEncrypted: encrypt('pw') }).returning())[0]!.id;
});

async function app() {
  const a = await buildTestApp({ db });
  await a.register(sourcesRoutes, { prefix: '/sources' });
  return a;
}
const patch = async (id: number, body: Record<string, unknown>, headers: Record<string, string> = asUser()) =>
  (await app()).inject({ method: 'PATCH', url: `/sources/${id}`, headers, payload: body });
const allowed = async (id: number) => (await db.query.sources.findFirst({ where: (s, { eq }) => eq(s.id, id) }))!.allowOnNodes;
const allowAudits = () => h.audit.mock.calls.filter((c) => c[2] === 'source.allow_on_nodes');

describe('allowOnNodes on a source', () => {
  it('is off for every existing source and listed as such', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/sources', headers: asUser() });
    expect(res.json().map((s: { allowOnNodes: boolean }) => s.allowOnNodes)).toEqual([false, false]);
  });

  it('turning it on needs the password (step-up); wrong or missing changes nothing', async () => {
    const missing = await patch(patId, { allowOnNodes: true });
    expect([missing.statusCode, missing.json().error.code]).toEqual([403, 'reauth_required']);
    const wrong = await patch(patId, { allowOnNodes: true, password: 'nope' });
    expect([wrong.statusCode, wrong.json().error.code]).toEqual([403, 'invalid_password']);
    expect(await allowed(patId)).toBe(false);
    expect(allowAudits()).toEqual([]);

    const ok = await patch(patId, { allowOnNodes: true, password: PASSWORD });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: patId, allowOnNodes: true });
    expect(ok.json()).not.toHaveProperty('password');
    expect(await allowed(patId)).toBe(true);
    expect(allowAudits()).toHaveLength(1);
    expect(allowAudits()[0]!.slice(1, 5)).toEqual([1, 'source.allow_on_nodes', 'pat', { sourceId: patId, previous: false, allowOnNodes: true }]);
  });

  it('an API token cannot turn it on, even with the password', async () => {
    const res = await patch(patId, { allowOnNodes: true, password: PASSWORD }, { ...asUser(), 'x-test-token-scopes': 'operator' });
    expect([res.statusCode, res.json().error.code]).toEqual([403, 'forbidden']);
    expect(await allowed(patId)).toBe(false);
  });

  it('turning it off needs no step-up and is audited; an unchanged value is not', async () => {
    await db.update(sources).set({ allowOnNodes: true });
    const off = await patch(patId, { allowOnNodes: false });
    expect(off.statusCode).toBe(200);
    expect(await allowed(patId)).toBe(false);
    expect(allowAudits()[0]![4]).toEqual({ sourceId: patId, previous: true, allowOnNodes: false });
    h.audit.mockClear();
    expect((await patch(patId, { allowOnNodes: false })).statusCode).toBe(200);
    expect(allowAudits()).toEqual([]);
  });

  it('a registry source has nothing to clone: refused before the step-up', async () => {
    const res = await patch(registryId, { allowOnNodes: true, password: PASSWORD });
    expect([res.statusCode, res.json().error.code]).toEqual([400, 'allow_on_nodes_unsupported']);
    expect(await allowed(registryId)).toBe(false);
  });

  it('only operators reach the route (sources are operator-only)', async () => {
    const res = await patch(patId, { allowOnNodes: true, password: PASSWORD }, asUser({ isOperator: false }));
    expect(res.statusCode).toBe(403);
  });
});
