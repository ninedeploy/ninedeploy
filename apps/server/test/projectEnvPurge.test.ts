/**
 * r541 — a deleted project's shared env vars (secrets included) must go with
 * it. `env_vars` rows with scope='project' reference the project only through
 * `scope_key` (no foreign key), so neither `DELETE /v1/projects/:id` nor the
 * workspace cascade removed them: the encrypted values stayed in the database
 * — and in every backup — forever. Real migrated SQLite, real routes.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type DB, envVars, projects, services, users, workspaces } from '@ninedeploy/db';
import { projectRoutes } from '../src/modules/projects.js';
import { workspaceRoutes } from '../src/modules/workspaces.js';
import { asUser, buildTestApp } from './helpers.js';

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));

let db: DB;
let close: () => void;
let dir: string;
let app: FastifyInstance;
let operatorId: number;
let workspaceId: number;
let doomed: number;
let kept: number;
let serviceId: number;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-projenv-'));
  const created = createDb({ url: `file:${path.join(dir, 'test.db').split(path.sep).join('/')}` });
  db = created.db;
  close = () => created.client?.close();
  await created.ready;
  await migrate(db, { migrationsFolder: MIGRATIONS });
  const [op] = await db.insert(users).values({ email: 'op@example.com', passwordHash: 'x', isInstanceOperator: true }).returning();
  operatorId = op!.id;
  const [ws] = await db.insert(workspaces).values({ name: 'W', slug: 'w', ownerId: operatorId }).returning();
  workspaceId = ws!.id;
  const [a] = await db.insert(projects).values({ workspaceId, name: 'A', slug: 'a' }).returning();
  const [b] = await db.insert(projects).values({ name: 'B', slug: 'b' }).returning();
  doomed = a!.id;
  kept = b!.id;
  const [svc] = await db.insert(services).values({ name: 'api', slug: 'api' }).returning();
  serviceId = svc!.id;
  await db.insert(envVars).values([
    { scope: 'project', scopeKey: doomed, key: 'DB_PASSWORD', valueEncrypted: 'v1:secret-a' },
    { scope: 'project', scopeKey: kept, key: 'DB_PASSWORD', valueEncrypted: 'v1:secret-b' },
    // A service-scoped row whose scope_key happens to equal the doomed
    // project's id must be left alone.
    { scope: 'service', serviceId, scopeKey: doomed, key: 'PORT', valueEncrypted: 'v1:port' },
  ]);
  app = await buildTestApp({ db });
  await app.register(projectRoutes, { prefix: '/projects' });
  await app.register(workspaceRoutes, { prefix: '/workspaces' });
});

afterEach(() => {
  close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows file lock */
  }
});

const headers = () => ({ ...asUser(), 'x-test-user': String(operatorId) });
const remaining = async () =>
  (await db.select().from(envVars)).map((r) => `${r.scope}:${r.scopeKey}:${r.key}`).sort();

describe('r541: project env vars die with their project', () => {
  it('DELETE /projects/:id removes that project’s shared env vars and nothing else', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/projects/${doomed}`, headers: headers() });
    expect(res.statusCode).toBe(200);
    expect(await remaining()).toEqual([`project:${kept}:DB_PASSWORD`, `service:${doomed}:PORT`]);
  });

  it('DELETE /workspaces/:id removes the env vars of every project its cascade deletes', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/workspaces/${workspaceId}`, headers: headers() });
    expect(res.statusCode).toBe(200);
    expect(await db.select().from(projects).where(eq(projects.id, doomed))).toHaveLength(0);
    expect(await remaining()).toEqual([`project:${kept}:DB_PASSWORD`, `service:${doomed}:PORT`]);
  });
});
