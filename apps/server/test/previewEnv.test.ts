/**
 * 0.12 preview-only env routes (`/services/:id/env/preview`), against a real
 * migrated SQLite: the set is stored apart from `env_vars`, so no production
 * env route sees it, and every mutation is audited by key only.
 * Authorization per role is pinned by test/authzMatrix.test.ts.
 */
import { fileURLToPath } from 'node:url';
import type { Client } from '@libsql/client';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB } from '@ninedeploy/db';

const auditMock = vi.hoisted(() => ({ audit: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMock);

const { encrypt, decrypt } = await import('../src/lib/crypto.js');
const { envRoutes } = await import('../src/modules/env.js');
const { asUser, buildTestApp } = await import('./helpers.js');

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));

let db: DB;
let client: Client;
let app: FastifyInstance;

beforeEach(async () => {
  auditMock.audit.mockClear();
  const made = createDb({ url: ':memory:' });
  db = made.db;
  client = made.client!;
  await migrate(db, { migrationsFolder });
  await client.execute('PRAGMA foreign_keys = ON');
  await client.execute(
    `INSERT INTO services (id, name, slug, type, repo_url, branch, preview_deployments_enabled)
     VALUES (1, 'web', 'web', 'docker', 'https://github.com/acme/web.git', 'main', 1)`,
  );
  await client.execute(
    `INSERT INTO services (id, name, slug, type, is_ephemeral_preview, preview_parent_service_id, pr_number)
     VALUES (2, 'web (PR #7)', 'web-pr-7', 'docker', 1, 1, 7)`,
  );
  await client.execute({
    sql: `INSERT INTO env_vars (service_id, scope, scope_key, key, value_encrypted, is_secret) VALUES (1, 'service', 1, 'STRIPE_KEY', ?, 1), (1, 'service', 1, 'API_URL', ?, 0)`,
    args: [encrypt('sk_live_production'), encrypt('https://api.example.com')],
  });
  app = await buildTestApp({ db: db as never });
  await app.register(envRoutes);
});

afterEach(async () => {
  await app.close();
});

const post = (url: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url, headers: asUser(), payload });

describe('preview-only env routes (0.12)', () => {
  it('stores a preview value apart from production — even under a production key', async () => {
    const res = await post('/1/env/preview', { key: 'STRIPE_KEY', value: 'sk_test_preview', isSecret: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ key: 'STRIPE_KEY', value: '', isSecret: true });

    // Production env routes return exactly what they returned before.
    const prod = await app.inject({ method: 'GET', url: '/1/env', headers: asUser() });
    expect(prod.json()).toEqual([
      expect.objectContaining({ key: 'API_URL', value: 'https://api.example.com', isSecret: false }),
      expect.objectContaining({ key: 'STRIPE_KEY', value: '', isSecret: true }),
    ]);
    const exported = await app.inject({ method: 'GET', url: '/1/env/export', headers: asUser() });
    expect(exported.json().content).not.toContain('sk_test_preview');
    const prodRows = (await client.execute('SELECT key, value_encrypted FROM env_vars WHERE service_id = 1 ORDER BY key')).rows;
    expect(prodRows.map((r) => decrypt(String(r['value_encrypted'])))).toEqual(['https://api.example.com', 'sk_live_production']);

    // Encrypted at rest, masked on read.
    const stored = (await client.execute('SELECT * FROM preview_env_vars')).rows;
    expect(stored).toHaveLength(1);
    expect(String(stored[0]!['value_encrypted'])).not.toContain('sk_test_preview');
    expect(decrypt(String(stored[0]!['value_encrypted']))).toBe('sk_test_preview');
    const list = await app.inject({ method: 'GET', url: '/1/env/preview', headers: asUser() });
    expect(list.json()).toEqual([{ id: Number(stored[0]!['id']), key: 'STRIPE_KEY', value: '', isSecret: true }]);

    expect(auditMock.audit).toHaveBeenCalledWith(expect.anything(), 1, 'env.preview.create', 'web/STRIPE_KEY');
    expect(JSON.stringify(auditMock.audit.mock.calls.map((c) => c.slice(1)))).not.toContain('sk_test_preview');
  });

  it('upserts, updates and deletes, auditing each by key only', async () => {
    const created = (await post('/1/env/preview', { key: 'API_URL', value: 'https://staging.example.com' })).json() as { id: number };
    expect((await post('/1/env/preview', { key: 'API_URL', value: 'x' })).statusCode).toBe(400);

    const over = await post('/1/env/preview', { key: 'API_URL', value: 'https://pr.example.com', overwriteExisting: true });
    expect(over.json()).toMatchObject({ id: created.id, value: 'https://pr.example.com', isSecret: false });

    const patched = await app.inject({
      method: 'PATCH',
      url: `/1/env/preview/${created.id}`,
      headers: asUser(),
      payload: { key: 'API_URL', value: 'https://patched.example.com' },
    });
    expect(patched.json()).toMatchObject({ id: created.id, value: 'https://patched.example.com' });

    // Another service's id (or a production variable id) is a 404, not a write.
    const prodId = Number((await client.execute(`SELECT id FROM env_vars WHERE key = 'API_URL'`)).rows[0]!['id']);
    const wrong = await app.inject({ method: 'DELETE', url: `/1/env/preview/${prodId + 100}`, headers: asUser() });
    expect(wrong.statusCode).toBe(404);

    const gone = await app.inject({ method: 'DELETE', url: `/1/env/preview/${created.id}`, headers: asUser() });
    expect(gone.json()).toEqual({ ok: true });
    expect((await client.execute('SELECT COUNT(*) AS n FROM preview_env_vars')).rows[0]!['n']).toBe(0);
    // The production row of the same key is untouched.
    expect((await client.execute(`SELECT COUNT(*) AS n FROM env_vars WHERE key = 'API_URL'`)).rows[0]!['n']).toBe(1);

    expect(auditMock.audit.mock.calls.map((c) => c[2])).toEqual(['env.preview.create', 'env.preview.update', 'env.preview.update', 'env.preview.delete']);
    expect(JSON.stringify(auditMock.audit.mock.calls.map((c) => c.slice(1)))).not.toContain('example.com');
  });

  it('refuses a vault reference and a write on a preview service', async () => {
    const vaultRef = await post('/1/env/preview', { key: 'STRIPE_KEY', value: ['$', '{{doppler:STRIPE_KEY}}'].join('') });
    expect(vaultRef.statusCode).toBe(400);
    expect(vaultRef.body).toMatch(/Vault references/);

    const onPreview = await post('/2/env/preview', { key: 'API_URL', value: 'x' });
    expect(onPreview.statusCode).toBe(400);
    expect((await client.execute('SELECT COUNT(*) AS n FROM preview_env_vars')).rows[0]!['n']).toBe(0);
    expect(auditMock.audit).not.toHaveBeenCalled();
  });

  it('is removed with its service (ON DELETE CASCADE)', async () => {
    await post('/1/env/preview', { key: 'API_URL', value: 'https://staging.example.com' });
    await client.execute('DELETE FROM services WHERE id = 1');
    expect((await client.execute('SELECT COUNT(*) AS n FROM preview_env_vars')).rows[0]!['n']).toBe(0);
  });
});
