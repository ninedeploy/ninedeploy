/**
 * r181 — env key search against a real migrated SQLite: the LIKE escape and
 * the visibility rules are SQL behaviour a fake db cannot reproduce.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, envVars, serviceWorkspaces, services, users, workspaceMembers, workspaces, type DB } from '@ninedeploy/db';
import { envSearchRoutes } from '../src/modules/env.js';
import { asUser, buildTestApp } from './helpers.js';

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));

let db: DB;
let close: () => void;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-envsearch-'));
  const created = createDb({ url: `file:${path.join(dir, 't.db').split(path.sep).join('/')}` });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

afterEach(() => {
  close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows file lock */
  }
});

async function seed() {
  const [owner] = await db.insert(users).values({ email: 'owner@x', passwordHash: 'h' }).returning();
  const [mate] = await db.insert(users).values({ email: 'mate@x', passwordHash: 'h' }).returning();
  const [stranger] = await db.insert(users).values({ email: 'stranger@x', passwordHash: 'h' }).returning();
  const [ws] = await db.insert(workspaces).values({ name: 'Team', slug: 'team', ownerId: owner!.id }).returning();
  await db.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: mate!.id, role: 'member' });
  const [svc] = await db.insert(services).values({ name: 'api', slug: 'api', ownerUserId: owner!.id }).returning();
  await db.insert(serviceWorkspaces).values({ serviceId: svc!.id, workspaceId: ws!.id });
  await db.insert(envVars).values([
    { serviceId: svc!.id, scope: 'service', scopeKey: svc!.id, key: 'DATABASE_URL', valueEncrypted: 'x', isSecret: true },
    { serviceId: svc!.id, scope: 'service', scopeKey: svc!.id, key: 'DATABASEXURL', valueEncrypted: 'x', isSecret: false },
  ]);
  return { owner: owner!, mate: mate!, stranger: stranger! };
}

async function search(userHeaders: Record<string, string>, q: string) {
  const app = await buildTestApp({ db });
  await app.register(envSearchRoutes, { prefix: '/env' });
  const res = await app.inject({ method: 'GET', url: `/env/search?q=${encodeURIComponent(q)}`, headers: userHeaders });
  await app.close();
  return res.json().results as Array<{ key: string }>;
}

describe('r181: env key search', () => {
  it('finds keys containing `_`, and `_` is literal (no single-char wildcard)', async () => {
    await seed();
    const hits = await search(asUser({ id: 1, isOperator: true }), 'DATABASE_URL');
    expect(hits.map((h) => h.key)).toEqual(['DATABASE_URL']);
  });

  it('shows a workspace teammate the shared service, and a stranger nothing', async () => {
    const { mate, stranger } = await seed();
    expect((await search(asUser({ id: mate.id, isOperator: false }), 'DATABASE')).length).toBe(2);
    expect(await search(asUser({ id: stranger.id, isOperator: false }), 'DATABASE')).toEqual([]);
  });
});
