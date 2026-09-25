import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb, dbRow, svcRow } from './helpers.js';

const mocks = vi.hoisted(() => ({
  templates: [] as Array<Record<string, unknown>>,
  community: [] as Array<Record<string, unknown>>,
  startDatabase: vi.fn(async () => undefined),
  adoptRetainedVolume: vi.fn(async () => ({ action: 'fresh' as const })),
}));

vi.mock('../src/templates/registry.js', () => ({
  getTemplates: vi.fn(async () => mocks.templates),
}));
// r330: community-imported templates are part of the installable catalog.
vi.mock('../src/lib/communityTemplates.js', () => ({
  listCommunityTemplates: vi.fn(async () => ({
    entries: mocks.community.map((template) => ({ id: template.id, template })),
    errors: [],
    totalBytes: 0,
  })),
}));
vi.mock('../src/engine/database.js', async (importOriginal) => {
  // The real module is imported for its pure helpers (needsVolumeAdoption);
  // everything that touches docker or the DB driver is stubbed below.
  const actual = await importOriginal<typeof import('../src/engine/database.js')>();
  return {
    ...actual,
    startDatabase: mocks.startDatabase,
    adoptRetainedVolume: mocks.adoptRetainedVolume,
    attachDatabaseToServiceBridges: vi.fn(async () => undefined),
    defaultPort: vi.fn((engine: string) => engine === 'redis' ? 6379 : 3306),
    ENGINES: {
      mysql: { username: () => 'root', dbName: () => 'app' },
      redis: { username: () => null, dbName: () => null },
    },
  };
});

const { reconcileTemplateDependencies } = await import('../src/engine/templateDependencies.js');

const mysqlTemplate = {
  id: 'wordpress',
  name: 'WordPress',
  dbEngine: 'mysql',
  databaseEnv: { WORDPRESS_DB_HOST: 'hostPort' },
};

const service = (over: Record<string, unknown> = {}) => svcRow({
  id: 7,
  ownerUserId: 1,
  name: 'WordPress',
  slug: 'wordpress',
  templateId: 'wordpress',
  ...over,
}) as never;

/**
 * Services link to projects through `service_projects` now, so the managed
 * database this template provisions inherits the service's *first* linked
 * project rather than a `services.projectId` column.
 */
const linkedToProject2 = { serviceProjects: [{ serviceId: 7, projectId: 2 }] };

describe('vanished template resilience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.templates = [];
    mocks.community = [];
  });

  it('redeploys compose stacks (no databaseEnv) even when the template left the registry', async () => {
    await expect(
      reconcileTemplateDependencies(createFakeDb(), service({ templateId: 'coolify-gone', templateDatabaseEnv: null }), vi.fn()),
    ).resolves.toBeNull();
  });

  it('still fails loudly for managed-database services whose mapping disappeared', async () => {
    await expect(
      reconcileTemplateDependencies(createFakeDb(), service({ templateDatabaseEnv: { APP_DB: 'host' } }), vi.fn()),
    ).rejects.toThrow('no longer available');
  });
});

describe('template dependency recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.templates = [mysqlTemplate];
    mocks.community = [];
  });

  it('r330: resolves the managed-database contract of a community-imported template', async () => {
    mocks.templates = [];
    mocks.community = [{ ...mysqlTemplate, id: 'community-wp' }];
    const db = createFakeDb({
      insert: {
        databases: (value) => [dbRow({ ...(value as Record<string, unknown>), id: 9 })],
        database_attachments: (value) => [value as Record<string, unknown>],
      },
      update: { databases: (value) => [value as Record<string, unknown>] },
    });
    // Before r330 this threw "Hub template 'community-wp' is no longer available".
    await expect(
      reconcileTemplateDependencies(db, service({ templateId: 'community-wp', templateDatabaseEnv: { WORDPRESS_DB_HOST: 'hostPort' } }), vi.fn()),
    ).resolves.toMatchObject({ database: { id: 9 }, alreadyAttached: false });
  });

  it('skips ordinary services and templates without a database', async () => {
    await expect(reconcileTemplateDependencies(createFakeDb(), service({ templateId: null }), vi.fn())).resolves.toBeNull();
    mocks.templates = [{ id: 'n8n', name: 'n8n' }];
    await expect(reconcileTemplateDependencies(createFakeDb(), service({ templateId: 'n8n' }), vi.fn())).resolves.toBeNull();
  });

  it('rejects missing and invalid durable template contracts', async () => {
    mocks.templates = [];
    // Real managed-database services carry the mapping on the row; compose
    // stacks (templateDatabaseEnv: null) take the tolerant path instead.
    await expect(
      reconcileTemplateDependencies(createFakeDb(), service({ templateDatabaseEnv: { WORDPRESS_DB_HOST: 'host' } }), vi.fn()),
    ).rejects.toThrow('no longer available');
    mocks.templates = [{ ...mysqlTemplate, databaseEnv: undefined }];
    await expect(
      reconcileTemplateDependencies(createFakeDb(), service({ templateDatabaseEnv: { WORDPRESS_DB_HOST: 'host' } }), vi.fn()),
    ).rejects.toThrow('invalid database contract');
  });

  it('creates, starts and attaches a missing managed database', async () => {
    let insertedDb: Record<string, unknown> | undefined;
    let attachment: Record<string, unknown> | undefined;
    const updates: Array<Record<string, unknown>> = [];
    const db = createFakeDb({
      insert: {
        databases: (value) => {
          insertedDb = value as Record<string, unknown>;
          return [dbRow({ ...(value as Record<string, unknown>), id: 9 })];
        },
        database_attachments: (value) => {
          attachment = value as Record<string, unknown>;
          return [value as Record<string, unknown>];
        },
      },
      update: { databases: (value) => { updates.push(value as Record<string, unknown>); return [value as Record<string, unknown>]; } },
      findMany: linkedToProject2,
    });
    const log = vi.fn();

    const result = await reconcileTemplateDependencies(db, service(), log);

    expect(insertedDb).toMatchObject({ slug: 'wordpress-db', engine: 'mysql', ownerUserId: 1, projectId: 2 });
    expect(attachment).toMatchObject({ serviceId: 7, databaseId: 9, envAlias: 'DATABASE_URL' });
    expect(updates).toContainEqual(expect.objectContaining({ status: 'running', internalPort: 3306 }));
    expect(result).toMatchObject({ database: { id: 9, status: 'running' }, alreadyAttached: false });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('wordpress-db'));
    // A brand-new row must pass through retained-volume adoption before start.
    expect(mocks.adoptRetainedVolume).toHaveBeenCalledWith(expect.objectContaining({ id: 9 }), log);
  });

  it('restarts an owned attached database without duplicating its attachment', async () => {
    const existing = dbRow({ id: 11, ownerUserId: 1, projectId: 2, engine: 'mysql' });
    const db = createFakeDb({
      findMany: { database_attachments: [{ serviceId: 7, databaseId: 11 }], ...linkedToProject2 },
      findFirst: { databases: existing },
      insert: { database_attachments: () => { throw new Error('must not duplicate'); } },
    });
    await expect(reconcileTemplateDependencies(db, service(), vi.fn())).resolves.toMatchObject({ alreadyAttached: true });
    expect(mocks.startDatabase).toHaveBeenCalledWith(existing, expect.any(Function), { labels: { 'ninedeploy.template': 'wordpress' } });
  });

  it('rejects a cross-resource attachment', async () => {
    const db = createFakeDb({
      findMany: { database_attachments: [{ serviceId: 7, databaseId: 11 }] },
      findFirst: { databases: dbRow({ id: 11, ownerUserId: 99, projectId: 2, engine: 'mysql' }) },
    });
    await expect(reconcileTemplateDependencies(db, service(), vi.fn())).rejects.toThrow('another resource');
  });

  it('reuses a retained owned database when no matching attachment exists', async () => {
    const retained = dbRow({ id: 12, slug: 'wordpress-db', ownerUserId: 1, projectId: 2, engine: 'mysql' });
    let calls = 0;
    const db = createFakeDb({
      findMany: { database_attachments: [{ serviceId: 7, databaseId: 99 }], ...linkedToProject2 },
      findFirst: { databases: () => (++calls === 1 ? dbRow({ id: 99, engine: 'postgres' }) : retained) },
    });
    await expect(reconcileTemplateDependencies(db, service(), vi.fn())).resolves.toMatchObject({
      database: { id: 12 },
      alreadyAttached: false,
    });
    // The retained row already owns its volume and password — never re-key it.
    expect(mocks.adoptRetainedVolume).not.toHaveBeenCalled();
  });

  it('re-runs adoption when reusing a retained row left in error by a failed first attempt', async () => {
    // The row flipped to 'error' after a failed start, so its marker is still
    // NULL and the volume may hold the previous installation's credentials —
    // the RETRY must go through the adoption gate again, not skip it.
    const retained = dbRow({ id: 12, slug: 'wordpress-db', ownerUserId: 1, projectId: 2, engine: 'mysql', status: 'error' });
    let calls = 0;
    const db = createFakeDb({
      findMany: { database_attachments: [{ serviceId: 7, databaseId: 99 }], ...linkedToProject2 },
      findFirst: { databases: () => (++calls === 1 ? dbRow({ id: 99, engine: 'postgres' }) : retained) },
    });
    await expect(reconcileTemplateDependencies(db, service(), vi.fn())).resolves.toMatchObject({
      database: { id: 12 },
      alreadyAttached: false,
    });
    expect(mocks.adoptRetainedVolume).toHaveBeenCalledTimes(1);
    expect(mocks.adoptRetainedVolume).toHaveBeenCalledWith(retained, expect.any(Function));
  });

  it('rejects a retained slug owned by another resource', async () => {
    const db = createFakeDb({
      findFirst: { databases: dbRow({ slug: 'wordpress-db', ownerUserId: 1, projectId: 2, engine: 'redis' }) },
    });
    await expect(reconcileTemplateDependencies(db, service(), vi.fn())).rejects.toThrow("Database slug 'wordpress-db'");
  });

  it('fails cleanly when the database row cannot be created', async () => {
    const db = createFakeDb({ insert: { databases: [] } });
    await expect(reconcileTemplateDependencies(db, service(), vi.fn())).rejects.toThrow('Could not create template database');
  });

  it('marks resources errored when Docker startup fails, including non-Error failures', async () => {
    mocks.startDatabase.mockRejectedValueOnce('daemon unavailable');
    const updates: Array<{ table: string; value: Record<string, unknown> }> = [];
    const db = createFakeDb({
      insert: { databases: (value) => [dbRow({ ...(value as Record<string, unknown>), id: 13 })] },
      update: {
        databases: (value) => { updates.push({ table: 'databases', value: value as Record<string, unknown> }); return []; },
        services: (value) => { updates.push({ table: 'services', value: value as Record<string, unknown> }); return []; },
      },
    });
    await expect(reconcileTemplateDependencies(db, service(), vi.fn())).rejects.toThrow('daemon unavailable');
    expect(updates).toEqual(expect.arrayContaining([
      { table: 'databases', value: { status: 'error' } },
      { table: 'services', value: { status: 'error' } },
    ]));
    mocks.startDatabase.mockRejectedValueOnce(new Error('container exited'));
    await expect(reconcileTemplateDependencies(db, service(), vi.fn())).rejects.toThrow('container exited');
  });

  it('uses the Redis attachment alias', async () => {
    mocks.templates = [{ id: 'redis-app', name: 'Redis App', dbEngine: 'redis', databaseEnv: { REDIS_URL: 'url' } }];
    let attachment: Record<string, unknown> | undefined;
    const db = createFakeDb({
      insert: {
        databases: (value) => [dbRow({ ...(value as Record<string, unknown>), id: 14, engine: 'redis' })],
        database_attachments: (value) => { attachment = value as Record<string, unknown>; return [value as Record<string, unknown>]; },
      },
    });
    await reconcileTemplateDependencies(db, service({ templateId: 'redis-app' }), vi.fn());
    expect(attachment).toMatchObject({ envAlias: 'REDIS_URL' });
  });
});
