import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, runMigrations, sources, users } from '@ninedeploy/db';

/**
 * 0.15.8: `PATCH /v1/sources/:id` `pinHostKeys` / `resetHostKeys`. Off for
 * every existing source (today's per-job accept-new policy). Switching pinning
 * ON only tightens, so it needs nothing extra. Switching it OFF or resetting
 * the pinned keys lets a changed host key through, so both take an interactive
 * session and a password re-check (step-up). Both are audited, and the
 * listing shows fingerprints, never the raw keys.
 */

const h = vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'ef'.repeat(32);
  return { audit: vi.fn(async (..._args: unknown[]) => undefined) };
});
vi.mock('../src/lib/audit.js', () => ({ audit: h.audit }));

const { sourcesRoutes } = await import('../src/modules/sources.js');
const { encrypt, hashPassword } = await import('../src/lib/crypto.js');
const { asUser, buildTestApp } = await import('./helpers.js');

const eq_ = (id: number) => eq(sources.id, id);
const PASSWORD = 'correct horse battery staple';
// GitHub's published ed25519 host key and its published fingerprint.
const GITHUB_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const GITHUB_FP = 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU';
let db: DB;
let keyId: number;
let registryId: number;
let appId: number;

beforeEach(async () => {
  h.audit.mockClear();
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values({ id: 1, email: 'op@example.com', passwordHash: await hashPassword(PASSWORD), isInstanceOperator: true });
  keyId = (await db.insert(sources).values({ type: 'github', name: 'key', deployKeyEncrypted: encrypt('k') }).returning())[0]!.id;
  registryId = (await db.insert(sources).values({ type: 'registry', name: 'reg', tokenEncrypted: encrypt('pw') }).returning())[0]!.id;
  appId = (await db.insert(sources).values({ type: 'github_app', name: 'app' }).returning())[0]!.id;
});

async function app() {
  const a = await buildTestApp({ db });
  await a.register(sourcesRoutes, { prefix: '/sources' });
  return a;
}
const patch = async (id: number, body: Record<string, unknown>, headers: Record<string, string> = asUser()) =>
  (await app()).inject({ method: 'PATCH', url: `/sources/${id}`, headers, payload: body });
const row = async (id: number) => (await db.query.sources.findFirst({ where: (s, { eq }) => eq(s.id, id) }))!;
const audits = (action: string) => h.audit.mock.calls.filter((c) => c[2] === action);

describe('host key pinning on a source', () => {
  it('is off for every existing source and listed as such', async () => {
    const res = await (await app()).inject({ method: 'GET', url: '/sources', headers: asUser() });
    expect(res.json().map((s: { pinHostKeys: boolean; pinnedHostKeys: unknown[] }) => [s.pinHostKeys, s.pinnedHostKeys])).toEqual([
      [false, []],
      [false, []],
      [false, []],
    ]);
  });

  it('switching it on needs nothing extra and is audited with the previous value', async () => {
    const res = await patch(keyId, { pinHostKeys: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: keyId, pinHostKeys: true, pinnedHostKeys: [] });
    expect((await row(keyId)).pinHostKeys).toBe(true);
    expect(audits('source.pin_host_keys')[0]!.slice(1, 5)).toEqual([1, 'source.pin_host_keys', 'key', { sourceId: keyId, previous: false, pinHostKeys: true }]);
    h.audit.mockClear();
    expect((await patch(keyId, { pinHostKeys: true })).statusCode).toBe(200);
    expect(audits('source.pin_host_keys')).toEqual([]);
  });

  it('lists fingerprints of what was learnt, never the keys themselves', async () => {
    await db.update(sources).set({ pinHostKeys: true, hostKeys: `github.com ${GITHUB_KEY}\n[git.example.com]:2222 ssh-rsa not-base64!\n` }).where(eq_(keyId));
    const body = (await (await app()).inject({ method: 'GET', url: '/sources', headers: asUser() })).json();
    const listed = body.find((s: { id: number }) => s.id === keyId);
    expect(listed.pinnedHostKeys).toEqual([
      { host: 'github.com', type: 'ssh-ed25519', fingerprint: GITHUB_FP },
      { host: '[git.example.com]:2222', type: 'ssh-rsa', fingerprint: null },
    ]);
    expect(JSON.stringify(body)).not.toContain('AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl');
  });

  it('switching it off or resetting needs the password (step-up); wrong or missing changes nothing', async () => {
    await db.update(sources).set({ pinHostKeys: true, hostKeys: `github.com ${GITHUB_KEY}\n` }).where(eq_(keyId));
    for (const body of [{ pinHostKeys: false }, { resetHostKeys: true }]) {
      const missing = await patch(keyId, body);
      expect([missing.statusCode, missing.json().error.code]).toEqual([403, 'reauth_required']);
      const wrong = await patch(keyId, { ...body, password: 'nope' });
      expect([wrong.statusCode, wrong.json().error.code]).toEqual([403, 'invalid_password']);
    }
    const kept = await row(keyId);
    expect([kept.pinHostKeys, kept.hostKeys]).toEqual([true, `github.com ${GITHUB_KEY}\n`]);
    expect(audits('source.pin_host_keys')).toEqual([]);
    expect(audits('source.reset_host_keys')).toEqual([]);
  });

  it('an API token can do neither, even with the password', async () => {
    await db.update(sources).set({ pinHostKeys: true, hostKeys: 'h ssh-ed25519 AAAA\n' }).where(eq_(keyId));
    const headers = { ...asUser(), 'x-test-token-scopes': 'operator' };
    for (const body of [{ pinHostKeys: false, password: PASSWORD }, { resetHostKeys: true, password: PASSWORD }]) {
      const res = await patch(keyId, body, headers);
      expect([res.statusCode, res.json().error.code]).toEqual([403, 'forbidden']);
    }
    expect((await row(keyId)).hostKeys).toBe('h ssh-ed25519 AAAA\n');
  });

  it('a reset forgets the keys, keeps pinning on and is audited with the count', async () => {
    await db.update(sources).set({ pinHostKeys: true, hostKeys: `github.com ${GITHUB_KEY}\ngitlab.com ssh-ed25519 AAAA\n` }).where(eq_(keyId));
    const res = await patch(keyId, { resetHostKeys: true, password: PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ pinHostKeys: true, pinnedHostKeys: [] });
    const after = await row(keyId);
    expect([after.pinHostKeys, after.hostKeys]).toEqual([true, null]);
    expect(audits('source.reset_host_keys')[0]!.slice(1, 5)).toEqual([1, 'source.reset_host_keys', 'key', { sourceId: keyId, forgotten: 2 }]);
  });

  it('switching it off forgets the keys too, so turning it on again starts from scratch', async () => {
    await db.update(sources).set({ pinHostKeys: true, hostKeys: `github.com ${GITHUB_KEY}\n` }).where(eq_(keyId));
    const res = await patch(keyId, { pinHostKeys: false, password: PASSWORD });
    expect(res.statusCode).toBe(200);
    const after = await row(keyId);
    expect([after.pinHostKeys, after.hostKeys]).toEqual([false, null]);
    expect(audits('source.pin_host_keys')[0]![4]).toEqual({ sourceId: keyId, previous: true, pinHostKeys: false });
  });

  it('a registry or GitHub App source has no SSH host to pin', async () => {
    for (const id of [registryId, appId]) {
      const res = await patch(id, { pinHostKeys: true });
      expect([res.statusCode, res.json().error.code]).toEqual([400, 'host_key_pinning_unsupported']);
      expect((await row(id)).pinHostKeys).toBe(false);
    }
  });

  it('only operators reach the route (sources are operator-only)', async () => {
    expect((await patch(keyId, { pinHostKeys: true }, asUser({ isOperator: false }))).statusCode).toBe(403);
  });
});
