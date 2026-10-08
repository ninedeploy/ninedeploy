/**
 * 0.14 upgrade safety for the secret-manager reference syntax (DESIGN §4.2).
 *
 * Broadening `hasVaultRef` reaches strings that already exist on running
 * installs: before 0.14 `${{vault:a#b}}` and `${{aws:x}}` were plain text and
 * reached the container literally. On a panel with NO vault/aws provider
 * configured — every install right after the upgrade — they must still deploy
 * byte-identically (left literal, with a deploy-log warning naming env keys
 * only), for every owner, without an r510 allowlist entry and without any
 * outbound call:
 *   1. apply every migration BEFORE 0070 to a scratch SQLite,
 *   2. insert services and env the way 0.13 stored them (raw SQL),
 *   3. apply 0070,
 *   4. assemble the runtime env with the 0.14 code.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, services } from '@ninedeploy/db';

// The pipeline module is imported for its env assembly only — nothing here
// may reach Docker, PM2, git, the proxy, the notifier or the network.
vi.mock('../src/engine/builders/docker.js', () => ({ dockerBuilder: {}, railpackUnavailableReason: vi.fn(async () => null) }));
vi.mock('../src/engine/builders/pm2.js', () => ({ pm2Builder: {} }));
vi.mock('../src/engine/builders/compose.js', () => ({ composeBuilder: {} }));
vi.mock('../src/engine/proxy.js', () => ({ writeDynamicConfig: vi.fn(), getAcmeEmail: vi.fn(async () => null) }));
vi.mock('../src/lib/agentClient.js', () => ({ agentOp: vi.fn() }));
vi.mock('../src/lib/git.js', () => ({ checkoutCommit: vi.fn() }));
vi.mock('../src/lib/exec.js', () => ({ sleep: vi.fn(async () => undefined), run: vi.fn() }));
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
const egress = vi.hoisted(() => ({ guardedFetch: vi.fn(async () => new Response('{}')) }));
vi.mock('../src/lib/egressGuard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/egressGuard.js')>()),
  guardedFetch: egress.guardedFetch,
}));

const scratch = mkdtempSync(path.join(os.tmpdir(), 'nd-0070-refs-'));
vi.stubEnv('NINEDEPLOY_DATA_DIR', scratch);
vi.stubEnv('DOCKER_HOST', 'tcp://127.0.0.1:9');
vi.stubEnv('NINEDEPLOY_MASTER_KEY', 'ef'.repeat(32));
const fetchMock = vi.fn(async () => {
  throw new Error('network disabled');
});
vi.stubGlobal('fetch', fetchMock);

const { encrypt } = await import('../src/lib/crypto.js');
const { loadRuntimeEnv } = await import('../src/engine/pipeline.js');
const vault = await import('../src/lib/vault.js');

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url));
const TAG = '0070_network_data_access';
const ref = (body: string) => ['$', '{{', body, '}}'].join('');

/** In key order — the order the env assembly reads rows in. */
const VALUES = {
  AWS_KEY_REF: `postgres://u:${ref('aws:arn:aws:secretsmanager:eu-west-1:123456789012:secret:prod/db-AbCdEf#password')}@db/app`,
  AWS_REF: ref('aws:prod/db'),
  PLAIN: 'https://api.example.com',
  VAULT_REF: ref('vault:team/app#db_password'),
};

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  egress.guardedFetch.mockClear();
  fetchMock.mockClear();
});

function folderBefore0070(): string {
  const dir = path.join(scratch, `m-${Math.random().toString(36).slice(2)}`);
  cpSync(migrationsFolder, dir, { recursive: true });
  const journalPath = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ tag: string }> };
  const at = journal.entries.findIndex((e) => e.tag === TAG);
  expect(at).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

/**
 * A 0.13 database: a member (#2, not an operator) owns service #1, which is
 * on no workspace and so on no r510 allowlist; its PR #4 preview is #3.
 */
async function populated013(): Promise<{ db: DB; client: Client }> {
  const { db, client } = createDb({ url: ':memory:' });
  await migrate(db, { migrationsFolder: folderBefore0070() });
  const c = client!;
  await c.execute(`INSERT INTO users (id, email, password_hash, is_instance_operator) VALUES (1, 'op@x', 'h', 1), (2, 'mem@x', 'h', 0)`);
  await c.execute(`INSERT INTO services (id, name, slug, type, owner_user_id) VALUES (1, 'web', 'web', 'docker', 2)`);
  await c.execute(
    `INSERT INTO services (id, name, slug, type, owner_user_id, is_ephemeral_preview, preview_parent_service_id, pr_number)
     VALUES (3, 'web (PR #4)', 'web-pr-4', 'docker', 2, 1, 1, 4)`,
  );
  let id = 0;
  for (const serviceId of [1, 3]) {
    for (const [key, value] of Object.entries(VALUES)) {
      await c.execute({
        sql: `INSERT INTO env_vars (id, service_id, scope, scope_key, key, value_encrypted, is_secret) VALUES (?, ?, 'service', ?, ?, ?, 1)`,
        args: [++id, serviceId, serviceId, key, encrypt(value)],
      });
    }
  }
  return { db, client: c };
}

const serviceRow = async (db: DB, id: number) => (await db.query.services.findFirst({ where: eq(services.id, id) }))!;

describe('0.14 secret references on a provider-less install', () => {
  it('a 0.13 env holding vault:/aws: text deploys byte-identically, with a warning and no outbound call', async () => {
    const { db, client } = await populated013();
    const envRowsBefore = (await client.execute('SELECT * FROM env_vars ORDER BY id')).rows;
    await migrate(db, { migrationsFolder });
    expect((await client.execute('SELECT * FROM env_vars ORDER BY id')).rows).toEqual(envRowsBefore);
    expect((await client.execute('SELECT COUNT(*) AS n FROM secret_providers')).rows[0]!['n']).toBe(0);

    const log = vi.fn();
    const env = await loadRuntimeEnv(db, await serviceRow(db, 1), undefined, log);
    // 0.13 left every one of these strings untouched: same keys, same bytes.
    expect(JSON.stringify(env.values)).toBe(JSON.stringify(VALUES));
    expect(env.withheldFromPreview).toEqual([]);
    expect(egress.guardedFetch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    const lines = log.mock.calls.map(([l]) => String(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/Vault references in VAULT_REF were left as literal text: no vault secret manager is configured/);
    expect(lines[1]).toMatch(/AWS Secrets Manager references in AWS_KEY_REF, AWS_REF were left as literal text/);
    // Names only, never the path or the secret id.
    expect(lines.join('\n')).not.toMatch(/team\/app|prod\/db|123456789012/);

    // Without a log sink (the pre-stop hook path) the result is the same.
    expect(JSON.stringify((await loadRuntimeEnv(db, await serviceRow(db, 1))).values)).toBe(JSON.stringify(VALUES));
  });

  it('a disabled or undecryptable provider row is "not configured": still literal, never an error', async () => {
    const { db, client } = await populated013();
    await migrate(db, { migrationsFolder });
    await client.execute({
      sql: `INSERT INTO secret_providers (kind, enabled, config_json, credential_encrypted) VALUES ('vault', 0, ?, ?), ('aws', 1, ?, 'v7:garbage')`,
      args: [
        JSON.stringify({ address: 'https://vault.example.com', mount: 'secret', authMethod: 'token', approleMount: 'approle' }),
        encrypt(JSON.stringify({ token: 'hvs.x' })),
        JSON.stringify({ region: 'eu-west-1', roleSessionName: 'ninedeploy' }),
      ],
    });
    const env = await loadRuntimeEnv(db, await serviceRow(db, 1), undefined, () => undefined);
    expect(JSON.stringify(env.values)).toBe(JSON.stringify(VALUES));
    expect(egress.guardedFetch).not.toHaveBeenCalled();
  });

  it('a PR preview withholds the references (fail-safe), as it does Infisical / Doppler ones', async () => {
    const { db } = await populated013();
    await migrate(db, { migrationsFolder });
    const env = await loadRuntimeEnv(db, await serviceRow(db, 3), undefined, () => undefined);
    expect(env.values).toEqual({ PLAIN: VALUES.PLAIN });
    expect(env.withheldFromPreview).toEqual(['vault reference AWS_KEY_REF', 'vault reference AWS_REF', 'vault reference VAULT_REF']);
  });

  it('the r510 upgrade seed grandfathers only references that resolved before (Infisical / Doppler)', async () => {
    const { db, client } = await populated013();
    await migrate(db, { migrationsFolder });
    await client.execute(`DELETE FROM settings WHERE key = '${vault.VAULT_ALLOWLIST_KEY}'`);
    expect(await vault.ensureVaultAllowlistInitialised(db)).toEqual({ workspaceIds: [], serviceIds: [] });
    await client.execute(`DELETE FROM settings WHERE key = '${vault.VAULT_ALLOWLIST_KEY}'`);
    await client.execute({
      sql: `INSERT INTO env_vars (service_id, scope, scope_key, key, value_encrypted, is_secret) VALUES (1, 'service', 1, 'LEGACY', ?, 1)`,
      args: [encrypt(ref('infisical:API_KEY'))],
    });
    expect(await vault.ensureVaultAllowlistInitialised(db)).toEqual({ workspaceIds: [], serviceIds: [1] });
  });
});
