/**
 * 0.13 upgrade compatibility for migration 0069 (`github_app`).
 *
 * A self-updating panel applies 0069 to a populated database. The migration
 * creates four tables and adds one nullable column (`sources.base_url`); every
 * existing source, service, webhook and preview must read back exactly as 0.12
 * left it:
 *   1. apply every migration BEFORE 0069 to a scratch SQLite,
 *   2. insert a PAT source, a deploy-key source, a service with an active
 *      webhook and a PR preview the way 0.12 wrote them (raw SQL against the
 *      0.12 columns),
 *   3. apply 0069,
 *   4. assert the `sources` rows are byte-identical apart from the new NULL
 *      `base_url`, every other pre-existing table is untouched, and the clone
 *      credentials the pipeline builds are the same strings as before,
 *   5. assert the 0069 SQL is purely additive.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  createDb,
  type DB,
  githubAppInstallations,
  githubApps,
  githubPrComments,
  serviceGithubLinks,
  sources,
} from '@ninedeploy/db';

const scratch = mkdtempSync(path.join(os.tmpdir(), 'nd-0069-'));
vi.stubEnv('NINEDEPLOY_DATA_DIR', scratch);
vi.stubEnv('DOCKER_HOST', 'tcp://127.0.0.1:9');
vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'ab'.repeat(32));

const { encrypt, decrypt } = await import('../src/lib/crypto.js');
const { rotateSecrets } = await import('../src/lib/keyRotation.js');

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const TAG = '0069_github_app';
const NEW_TABLES = ['github_apps', 'github_app_installations', 'service_github_links', 'github_pr_comments'];

const PAT = 'ghp_0p12PersonalAccessToken';
const DEPLOY_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n-----END OPENSSH PRIVATE KEY-----';

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

function folderBefore0069(): string {
  const dir = path.join(scratch, `m-${Math.random().toString(36).slice(2)}`);
  cpSync(migrationsFolder, dir, { recursive: true });
  const journalPath = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
  const at = journal.entries.findIndex((e) => e.tag === TAG);
  expect(at).toBeGreaterThan(0);
  expect(journal.entries[at - 1]!.tag).toBe('0068_preview_env_vars');
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

/**
 * A 0.12 database:
 *   source #1 — GitHub PAT, source #2 — GitLab deploy key,
 *   service #1 — cloned with the PAT, active push webhook #1, previews on,
 *   service #2 — its PR #7 preview (inherits the source),
 *   service #3 — cloned with the deploy key.
 */
async function populated012(): Promise<{ db: DB; client: Client }> {
  const { db, client } = createDb({ url: ':memory:' });
  await migrate(db, { migrationsFolder: folderBefore0069() });
  for (const t of NEW_TABLES) {
    expect((await client!.execute({ sql: `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, args: [t] })).rows).toHaveLength(0);
  }
  const srcCols = (await client!.execute('PRAGMA table_info(sources)')).rows.map((r) => r['name']);
  expect(srcCols).not.toContain('base_url');

  await client!.execute({
    sql: `INSERT INTO sources (id, type, name, token_encrypted, default_branch, created_at, updated_at)
          VALUES (1, 'github', 'gh-pat', ?, 'main', 1790000000, 1790000100)`,
    args: [encrypt(PAT)],
  });
  await client!.execute({
    sql: `INSERT INTO sources (id, type, name, deploy_key_encrypted, default_branch, created_at, updated_at)
          VALUES (2, 'gitlab', 'gl-key', ?, 'develop', 1790000200, 1790000300)`,
    args: [encrypt(DEPLOY_KEY)],
  });
  await client!.execute(
    `INSERT INTO services (id, name, slug, type, repo_url, branch, source_id, preview_deployments_enabled)
     VALUES (1, 'web', 'web', 'docker', 'https://github.com/acme/web.git', 'main', 1, 1)`,
  );
  await client!.execute(
    `INSERT INTO services (id, name, slug, type, repo_url, branch, source_id, is_ephemeral_preview, preview_parent_service_id, pr_number)
     VALUES (2, 'web (PR #7)', 'web-pr-7', 'docker', 'https://github.com/acme/web.git', 'feature', 1, 1, 1, 7)`,
  );
  await client!.execute(
    `INSERT INTO services (id, name, slug, type, repo_url, branch, source_id)
     VALUES (3, 'api', 'api', 'docker', 'git@gitlab.com:acme/api.git', 'develop', 2)`,
  );
  await client!.execute({
    sql: `INSERT INTO webhooks (id, source_id, service_id, branch, secret_encrypted, active) VALUES (1, 1, 1, 'main', ?, 1)`,
    args: [encrypt('whsec_012')],
  });
  return { db, client: client! };
}

/** The credential block of `engine/pipeline.ts` (git clone path), verbatim in shape. */
function credsFor(src: { type: string; tokenEncrypted: string | null; deployKeyEncrypted: string | null }) {
  return {
    type: src.type,
    token: src.tokenEncrypted ? decrypt(src.tokenEncrypted) : undefined,
    deployKey: src.deployKeyEncrypted ? decrypt(src.deployKeyEncrypted) : undefined,
  };
}

const UNTOUCHED_TABLES = ['services', 'webhooks', 'env_vars', 'preview_env_vars', 'deployments', 'users'];

describe('migration 0069 upgrade compatibility', () => {
  it('is purely additive: four CREATE TABLEs, their indexes and one ADD COLUMN', () => {
    const sqlText = readFileSync(path.join(migrationsFolder, `${TAG}.sql`), 'utf8');
    expect(sqlText).not.toMatch(/__new_|\bDROP\b|\bRENAME\b|INSERT INTO|^\s*UPDATE |DELETE FROM/im);
    const statements = sqlText
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const s of statements) {
      expect(s, s).toMatch(/^(CREATE TABLE `|CREATE (UNIQUE )?INDEX `|ALTER TABLE `sources` ADD `base_url` text;?$)/);
    }
    expect(statements.filter((s) => s.startsWith('CREATE TABLE')).map((s) => /^CREATE TABLE `([a-z_]+)`/.exec(s)![1]).sort()).toEqual(
      [...NEW_TABLES].sort(),
    );
    const alters = statements.filter((s) => s.startsWith('ALTER TABLE'));
    // Nullable, no default, no FK: SQLite adds it in place and old rows read NULL.
    expect(alters).toEqual(['ALTER TABLE `sources` ADD `base_url` text;']);
  });

  it('keeps every 0.12 source byte-identical (base_url NULL) and the clone credentials unchanged', async () => {
    const { db, client } = await populated012();
    const sourcesBefore = (await client.execute('SELECT * FROM sources ORDER BY id')).rows;
    const before: Record<string, unknown[]> = {};
    for (const t of UNTOUCHED_TABLES) before[t] = (await client.execute(`SELECT * FROM ${t} ORDER BY rowid`)).rows;
    const credsBefore = sourcesBefore.map((r) =>
      credsFor({
        type: String(r['type']),
        tokenEncrypted: (r['token_encrypted'] as string | null) ?? null,
        deployKeyEncrypted: (r['deploy_key_encrypted'] as string | null) ?? null,
      }),
    );

    await migrate(db, { migrationsFolder });

    const sourcesAfter = (await client.execute('SELECT * FROM sources ORDER BY id')).rows;
    expect(sourcesAfter).toHaveLength(2);
    for (const [i, row] of sourcesAfter.entries()) {
      const { base_url: baseUrl, ...rest } = row as Record<string, unknown>;
      expect(baseUrl).toBeNull();
      // Same columns, same order, same values — including the ciphertexts.
      expect(rest).toEqual({ ...(sourcesBefore[i] as Record<string, unknown>) });
      expect(Object.keys(rest)).toEqual(Object.keys(sourcesBefore[i] as Record<string, unknown>));
    }
    for (const t of UNTOUCHED_TABLES) {
      expect((await client.execute(`SELECT * FROM ${t} ORDER BY rowid`)).rows, t).toEqual(before[t]);
    }
    for (const t of NEW_TABLES) {
      expect((await client.execute(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0]!['n'], t).toBe(0);
    }

    // The 0.13 schema reads the migrated rows and the pipeline's credential
    // block yields exactly the 0.12 strings.
    const rows = await db.select().from(sources).orderBy(sources.id);
    expect(rows.map((r) => r.baseUrl)).toEqual([null, null]);
    expect(rows.map(credsFor)).toEqual(credsBefore);
    expect(credsBefore).toEqual([
      { type: 'github', token: PAT, deployKey: undefined },
      { type: 'gitlab', token: undefined, deployKey: DEPLOY_KEY },
    ]);

    // The webhook is still active and still opens with its 0.12 secret.
    const hook = await db.query.webhooks.findFirst();
    expect(hook).toMatchObject({ serviceId: 1, sourceId: 1, branch: 'main', active: true });
    expect(decrypt(hook!.secretEncrypted)).toBe('whsec_012');
  });

  it('accepts App rows with the declared defaults, rotates their secrets, and cascades / nulls like the schema says', async () => {
    const { db, client } = await populated012();
    await migrate(db, { migrationsFolder });
    await client.execute('PRAGMA foreign_keys = ON');

    const [app] = await db
      .insert(githubApps)
      .values({
        name: 'NineDeploy',
        appId: 42,
        privateKeyEncrypted: encrypt('pem'),
        webhookSecretEncrypted: encrypt('whs'),
        hookKey: 'a'.repeat(32),
      })
      .returning();
    expect(app).toMatchObject({ webBaseUrl: 'https://github.com', apiBaseUrl: 'https://api.github.com', clientSecretEncrypted: null });

    const [appSource] = await db.insert(sources).values({ type: 'github_app', name: 'gh-app:acme' }).returning();
    expect(appSource).toMatchObject({ tokenEncrypted: null, deployKeyEncrypted: null, baseUrl: null });
    const [inst] = await db
      .insert(githubAppInstallations)
      .values({ githubAppId: app!.id, installationId: 9001, accountLogin: 'acme', sourceId: appSource!.id })
      .returning();
    expect(inst).toMatchObject({ repositorySelection: 'selected', suspendedAt: null, removedAt: null });
    const [link] = await db
      .insert(serviceGithubLinks)
      .values({ serviceId: 1, installationRowId: inst!.id, repoId: 1296269, repoFullName: 'acme/web', previousSourceId: 1 })
      .returning();
    expect(link).toMatchObject({ enabled: true, tokenScope: 'repository', reportStatus: false, prComment: false });
    await db.insert(githubPrComments).values({ serviceId: 1, prNumber: 7, commentId: 123 });

    // Uniques the routes rely on.
    await expect(
      db.insert(githubApps).values({ name: 'dup', appId: 42, privateKeyEncrypted: 'x', webhookSecretEncrypted: 'y', hookKey: 'b'.repeat(32) }),
    ).rejects.toThrow();
    await expect(db.insert(serviceGithubLinks).values({ serviceId: 1, installationRowId: inst!.id, repoId: 1, repoFullName: 'a/b' })).rejects.toThrow();

    // Key rotation reaches the new encrypted columns (and skips the null client secret).
    expect(await rotateSecrets(db)).toBeGreaterThan(0);
    const rotated = await db.query.githubApps.findFirst({ where: eq(githubApps.id, app!.id) });
    expect(decrypt(rotated!.privateKeyEncrypted)).toBe('pem');
    expect(decrypt(rotated!.webhookSecretEncrypted)).toBe('whs');
    expect(rotated!.clientSecretEncrypted).toBeNull();

    // Deleting the PAT source nulls the link's memory of it; deleting the App
    // cascades installations and links, and leaves the generated source.
    await client.execute('DELETE FROM sources WHERE id = 1');
    expect((await db.query.serviceGithubLinks.findFirst())!.previousSourceId).toBeNull();
    await client.execute(`DELETE FROM github_apps WHERE id = ${app!.id}`);
    expect((await client.execute('SELECT COUNT(*) AS n FROM github_app_installations')).rows[0]!['n']).toBe(0);
    expect((await client.execute('SELECT COUNT(*) AS n FROM service_github_links')).rows[0]!['n']).toBe(0);
    expect((await client.execute(`SELECT COUNT(*) AS n FROM sources WHERE id = ${appSource!.id}`)).rows[0]!['n']).toBe(1);
    // Deleting the service cascades its PR comment row.
    await client.execute('DELETE FROM services WHERE id = 2');
    await client.execute('DELETE FROM services WHERE id = 1');
    expect((await client.execute('SELECT COUNT(*) AS n FROM github_pr_comments')).rows[0]!['n']).toBe(0);
  });
});
