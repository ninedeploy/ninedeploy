/**
 * r508 — the AI spend gate against a real migrated SQLite. r161 accepted "a
 * member seat in any workspace", and any account can create a workspace it
 * owns, so the gate held nobody back. A seat now counts only in a workspace an
 * instance operator owns.
 */
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, deployments, services, serviceWorkspaces, users, workspaceMembers, workspaces, type DB } from '@ninedeploy/db';
import { aiRoutes } from '../src/modules/ai.js';
import { config } from '../src/config.js';
import { encrypt } from '../src/lib/crypto.js';
import { setSettingJson, setSettingString } from '../src/lib/settings.js';
import { asUser, buildTestApp } from './helpers.js';

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const DESCRIPTION = 'A Node 20 Express API listening on port 3000 with a Postgres database';

let db: DB;
let close: () => void;
let dir: string;
let app: FastifyInstance;
const ids = { operator: 0, member: 0, viewer: 0, selfMade: 0, teamSvc: 0, selfSvc: 0, teamDep: 0, selfDep: 0 };

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-ai-gate-'));
  const created = createDb({ url: `file:${path.join(dir, 't.db').split(path.sep).join('/')}` });
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });

  const mk = async (email: string, isInstanceOperator = false) =>
    (await db.insert(users).values({ email, passwordHash: 'h', isInstanceOperator }).returning())[0]!.id;
  ids.operator = await mk('op@x.test', true);
  ids.member = await mk('member@x.test');
  ids.viewer = await mk('viewer@x.test');
  ids.selfMade = await mk('selfmade@x.test');

  const [team] = await db.insert(workspaces).values({ name: 'Team', slug: 'team', ownerId: ids.operator }).returning();
  const [own] = await db.insert(workspaces).values({ name: 'Mine', slug: 'mine', ownerId: ids.selfMade }).returning();
  await db.insert(workspaceMembers).values([
    { workspaceId: team!.id, userId: ids.operator, role: 'owner' },
    { workspaceId: team!.id, userId: ids.member, role: 'member' },
    { workspaceId: team!.id, userId: ids.viewer, role: 'viewer' },
    // The bypass: an account that made itself the owner of its own workspace.
    { workspaceId: own!.id, userId: ids.selfMade, role: 'owner' },
  ]);
  const [teamSvc] = await db.insert(services).values({ name: 'team-api', slug: 'team-api', ownerUserId: ids.operator }).returning();
  const [selfSvc] = await db.insert(services).values({ name: 'side', slug: 'side', ownerUserId: ids.selfMade }).returning();
  ids.teamSvc = teamSvc!.id;
  ids.selfSvc = selfSvc!.id;
  await db.insert(serviceWorkspaces).values([
    { serviceId: teamSvc!.id, workspaceId: team!.id },
    { serviceId: selfSvc!.id, workspaceId: own!.id },
  ]);
  ids.teamDep = (await db.insert(deployments).values({ serviceId: teamSvc!.id, status: 'failed' }).returning())[0]!.id;
  ids.selfDep = (await db.insert(deployments).values({ serviceId: selfSvc!.id, status: 'failed' }).returning())[0]!.id;
  for (const dep of [ids.teamDep, ids.selfDep]) appendFileSync(path.join(config.paths.logsDir, `${dep}.log`), 'npm error exit code 1');

  await setSettingJson(db, 'ai_diagnosis_config', { baseUrl: 'https://ai.example.com/v1', model: 'gpt-test' });
  await setSettingString(db, 'ai_diagnosis_key_encrypted', encrypt(['sk', 'test', 'key'].join('-')));
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ version: '1', run: { port: 3000 } }) } }] }),
    }),
  );

  app = await buildTestApp({ db });
  await app.register(aiRoutes, { prefix: '/ai' });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
  close();
  for (const dep of [ids.teamDep, ids.selfDep]) rmSync(path.join(config.paths.logsDir, `${dep}.log`), { force: true });
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows file lock */
  }
});

const as = (id: number, isOperator = false) => asUser({ id, isOperator });
const suggest = (headers: Record<string, string>) =>
  app.inject({ method: 'POST', url: '/ai/suggest-manifest', headers, payload: { description: DESCRIPTION } });
const diagnose = (headers: Record<string, string>, svc: number, dep: number) =>
  app.inject({ method: 'POST', url: `/ai/services/${svc}/deploys/${dep}/diagnose`, headers });

describe('r508: AI spend gate', () => {
  it('an owner seat in a self-created workspace no longer unlocks manifest suggestions', async () => {
    const res = await suggest(as(ids.selfMade));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain('workspace an operator owns');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('…nor diagnosis of a failed deploy in that workspace', async () => {
    const res = await diagnose(as(ids.selfMade), ids.selfSvc, ids.selfDep);
    expect(res.statusCode).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a member of an operator's workspace keeps both", async () => {
    expect((await suggest(as(ids.member))).statusCode).toBe(200);
    expect((await diagnose(as(ids.member), ids.teamSvc, ids.teamDep)).statusCode).toBe(200);
  });

  it('a viewer seat still does not count (r161)', async () => {
    expect((await suggest(as(ids.viewer))).statusCode).toBe(403);
  });

  it('operators keep unconditional access (the upgrade default)', async () => {
    expect((await suggest(as(ids.operator, true))).statusCode).toBe(200);
    expect((await diagnose(as(ids.operator, true), ids.selfSvc, ids.selfDep)).statusCode).toBe(200);
  });
});
