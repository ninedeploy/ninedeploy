/**
 * F1020 — two concurrent webhook deliveries for the same new PR: both pass the
 * "is there a preview yet" read, `services_slug_unique` lets one insert win,
 * and the loser must refresh the winner's preview like a redelivery. It used to
 * re-run the create-only provisioning against the winner's service: the env var
 * copy tripped `env_vars_service_key_idx` (a 500, so the provider redelivered)
 * and the build config was written twice. Real migrated SQLite: the unique
 * index is the whole race, a fake db cannot model it. The loser's stale read is
 * forced with a gate, not a sleep.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { count, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildConfigs, createDb, deployments, envVars, services, type DB } from '@ninedeploy/db';
import { handlePullRequest } from '../src/lib/webhookDispatch.js';

// Teardown and runtime stops touch the host (docker, pm2, the proxy config); a create never reaches them,
// but the module graph imports them, so they are stubbed as in hooks.test.ts.
vi.mock('../src/engine/logs.js', () => ({ deleteLog: vi.fn(() => true) }));
vi.mock('../src/lib/serviceBridge.js', () => ({ removeServiceBridgeIfEmpty: vi.fn(async () => undefined) }));
vi.mock('../src/engine/builders/docker.js', () => ({ dockerBuilder: { stop: vi.fn(async () => undefined) } }));
vi.mock('../src/engine/builders/pm2.js', () => ({ pm2Builder: { stop: vi.fn(async () => undefined) } }));
vi.mock('../src/engine/builders/compose.js', () => ({ composeBuilder: { stop: vi.fn(async () => undefined) } }));
vi.mock('../src/engine/proxy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/engine/proxy.js')>()),
  writeDynamicConfig: vi.fn(async () => undefined),
}));

const MIGRATIONS = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as FastifyBaseLogger;

let db: DB;
let close: () => void;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'nd-preview-race-'));
  const created = createDb({ url: `file:${path.join(dir, 't.db').split(path.sep).join('/')}` });
  await created.ready;
  db = created.db;
  close = () => created.client?.close();
  await migrate(db, { migrationsFolder: MIGRATIONS });
});

afterAll(() => {
  try {
    close();
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows may hold the file a moment longer */
  }
});

const pr = (n: number, sha: string, branch: string) => ({ action: 'opened' as const, prNumber: n, branch, sha, title: 't', author: 'a' });

/** `real`, except that the FIRST `services.findFirst` returns only after `release` (a stale read). */
function withStaleFirstServiceRead(real: DB, release: Promise<void>, looked: () => void): DB {
  let first = true;
  const wrap = <T extends object>(o: T, over: (k: string | symbol, v: unknown) => unknown): T =>
    new Proxy(o, {
      get(t, k) {
        const v = Reflect.get(t, k, t);
        const replaced = over(k, v);
        return replaced !== undefined ? replaced : typeof v === 'function' ? v.bind(t) : v;
      },
    });
  return wrap(real, (k, query) =>
    k === 'query'
      ? wrap(query as object, (qk, table) =>
          qk === 'services'
            ? wrap(table as object, (fk, fn) =>
                fk === 'findFirst'
                  ? async (...args: unknown[]) => {
                      const found = await (fn as (...a: unknown[]) => Promise<unknown>).apply(table, args);
                      if (first) {
                        first = false;
                        looked();
                        await release;
                      }
                      return found;
                    }
                  : undefined,
              )
            : undefined,
        )
      : undefined,
  );
}

describe('preview create race (F1020)', () => {
  it('the loser refreshes the winner’s preview and provisions nothing twice', async () => {
    const [parent] = await db
      .insert(services)
      .values({ name: 'App', slug: 'app', type: 'docker', image: 'nginx', repoUrl: 'https://github.com/acme/app.git', branch: 'main', previewDeploymentsEnabled: true, previewMaxActive: 5 })
      .returning();
    await db.insert(buildConfigs).values({ serviceId: parent!.id, buildPack: 'auto' });
    await db.insert(envVars).values({ serviceId: parent!.id, scope: 'service', scopeKey: parent!.id, key: 'PUBLIC_URL', valueEncrypted: 'x', isSecret: false });

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let looked!: () => void;
    const lookedUp = new Promise<void>((r) => (looked = r));

    const loser = handlePullRequest(withStaleFirstServiceRead(db, gate, looked), parent!, pr(7, 'loser-sha', 'loser-branch'), 'github', log);
    await lookedUp; // the loser has read "no preview yet" …
    const winner = await handlePullRequest(db, parent!, pr(7, 'winner-sha', 'winner-branch'), 'github', log); // … the winner finishes …
    release(); // … and only then does the loser continue.
    const lost = await loser;

    expect(winner['action']).toBe('preview_deployment_queued');
    expect(lost['action']).toBe('preview_deployment_queued');
    const preview = (await db.query.services.findFirst({ where: eq(services.slug, 'app-pr-7') }))!;
    expect(lost['previewServiceId']).toBe(preview.id);
    expect(preview.branch).toBe('loser-branch');
    expect(preview.commitSha).toBe('loser-sha');
    const rows = async (table: typeof buildConfigs | typeof envVars | typeof deployments) =>
      (await db.select({ c: count() }).from(table).where(eq(table.serviceId, preview.id)))[0]!.c;
    expect(await rows(buildConfigs)).toBe(1);
    expect(await rows(envVars)).toBe(1);
    expect(await rows(deployments)).toBe(2);
  });

  it('0.16.1: the preview inherits the parent’s static output dir, SPA flag and build-argument names', async () => {
    const [parent] = await db
      .insert(services)
      .values({ name: 'Site', slug: 'site', type: 'docker', repoUrl: 'https://github.com/acme/site.git', branch: 'main', previewDeploymentsEnabled: true, previewMaxActive: 5 })
      .returning();
    await db.insert(buildConfigs).values({ serviceId: parent!.id, buildPack: 'static', outputDir: 'build', staticSpa: false, buildArgs: ['PUBLIC_API'] });
    const res = await handlePullRequest(db, parent!, pr(3, 'sha-3', 'feature'), 'github', log);
    expect(res['action']).toBe('preview_deployment_queued');
    const preview = (await db.query.services.findFirst({ where: eq(services.slug, 'site-pr-3') }))!;
    const build = await db.query.buildConfigs.findFirst({ where: eq(buildConfigs.serviceId, preview.id) });
    expect(build).toMatchObject({ buildPack: 'static', outputDir: 'build', staticSpa: false, buildArgs: ['PUBLIC_API'] });
  });

  it('0.16.1: the preview keeps the parent’s healthcheck timeout but not its container options', async () => {
    const [parent] = await db
      .insert(services)
      .values({ name: 'Llm', slug: 'llm', type: 'docker', repoUrl: 'https://github.com/acme/llm.git', branch: 'main', previewDeploymentsEnabled: true, previewMaxActive: 5, healthTimeoutSeconds: 1800, runtimeOptions: { gpus: 'all', capAdd: ['NET_ADMIN'] } })
      .returning();
    await db.insert(buildConfigs).values({ serviceId: parent!.id });
    await handlePullRequest(db, parent!, pr(4, 'sha-4', 'feature'), 'github', log);
    const preview = (await db.query.services.findFirst({ where: eq(services.slug, 'llm-pr-4') }))!;
    expect(preview.healthTimeoutSeconds).toBe(1800);
    expect(preview.runtimeOptions).toBeNull();
  });

  it('evicts enough oldest previews when the active cap was lowered', async () => {
    const [parent] = await db
      .insert(services)
      .values({
        name: 'Cap App',
        slug: 'cap-app',
        type: 'docker',
        image: 'nginx',
        repoUrl: 'https://github.com/acme/cap-app.git',
        branch: 'main',
        previewDeploymentsEnabled: true,
        previewMaxActive: 2,
      })
      .returning();
    const existing = await db
      .insert(services)
      .values(
        [1, 2, 3, 4].map((prNumber) => ({
          name: `Cap App (PR #${prNumber})`,
          slug: `cap-app-pr-${prNumber}`,
          type: 'docker' as const,
          image: 'nginx',
          repoUrl: parent!.repoUrl,
          branch: `pr-${prNumber}`,
          isEphemeralPreview: true,
          previewParentServiceId: parent!.id,
          prNumber,
        })),
      )
      .returning();

    const result = await handlePullRequest(db, parent!, pr(99, 'new-sha', 'new-branch'), 'github', log);

    expect(result['action']).toBe('preview_deployment_queued');
    const remaining = await db.query.services.findMany({ where: eq(services.previewParentServiceId, parent!.id) });
    expect(remaining.map((row) => row.prNumber).sort((a, b) => Number(a) - Number(b))).toEqual([4, 99]);
    expect(remaining).toHaveLength(parent!.previewMaxActive);
    const remainingIds = new Set(remaining.map((row) => row.id));
    for (const evicted of existing.slice(0, 3)) expect(remainingIds.has(evicted.id)).toBe(false);
    expect(remainingIds.has(existing[3]!.id)).toBe(true);
  });
});
