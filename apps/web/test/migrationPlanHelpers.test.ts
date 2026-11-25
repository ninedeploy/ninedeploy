import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NineDeployError } from '@ninedeploy/sdk';
import { ENV_IMPORT_MAX_CHARS, type ImportPlan } from '@ninedeploy/schemas';
import { checkImportTarget } from '../src/lib/importTarget.js';
import { InvalidMigrationEnvironment, applyMigrationEnvironment } from '../src/lib/migrationEnvironment.js';
import { preparedImportTargets, prepareImportResources, type PreparedImportService } from '../src/lib/prepareImportResources.js';

type Service = ImportPlan['services'][number];
type Database = ImportPlan['databases'][number];
type Row = { id: number; slug: string; status: string; type?: string; engine?: string };

const operator = { id: 7, createdAt: '2026-11-01T00:00:00.000Z', email: 'operator@example.test' };
const service = (fields: Partial<Service> = {}): Service => ({
  ref: 'web', name: 'Web', kind: 'image', create: { type: 'docker', name: 'Web', image: 'nginx:1.27' }, domains: [], env: [], volumes: [], issues: [], ...fields,
});
const database = (fields: Partial<Database> = {}): Database => ({ ref: 'db', name: 'App DB', engine: 'postgres', image: 'postgres:16.1', issues: [], ...fields });
const plan = (services: Service[] = [service()], databases: Database[] = []): ImportPlan => ({
  planVersion: 1, generatedAt: '2026-11-24T10:00:00Z',
  source: { kind: 'coolify', url: 'https://source.example', version: null, scope: 'Application' }, services, databases, notes: [],
});

/** A panel that holds the given rows and creates whatever it is asked to. */
const panel = (services: Row[] = [], databases: Row[] = []) => ({
  services: { list: vi.fn(async () => services), create: vi.fn(async (_input: { name: string }) => ({ id: 41 })), update: vi.fn(async () => ({})) },
  databases: { list: vi.fn(async () => databases), createEmpty: vi.fn(async (_input: { name: string }) => ({ id: 9 })) },
});
const receipt = (): Record<string, { id: number; done: boolean } | null> =>
  JSON.parse(sessionStorage.getItem(sessionStorage.key(0)!) ?? '{}');
/** The outcomes of a preparation that went ahead. A plan refused as a duplicate fails the test. */
const preparedOutcomes = async (...args: Parameters<typeof prepareImportResources>) => {
  const result = await prepareImportResources(...args);
  if (result.duplicate) throw new Error('the plan was refused as a duplicate');
  return result.outcomes;
};

beforeEach(() => sessionStorage.clear());

describe('checkImportTarget', () => {
  it('names the field of a database whose settings the panel would refuse', () => {
    const [found] = checkImportTarget(plan([], [database({ name: '' })]), { services: [], databases: [] });
    expect(found).toEqual({ kind: 'database', ref: 'db', name: '', slug: 'service', problem: 'invalidSettings', fields: ['name'], problems: ['invalidSettings'] });
  });
});

describe('prepareImportResources', () => {
  it('refuses a plan that repeats a reference or a name, before it asks the panel for anything', async () => {
    const api = panel();
    expect(await prepareImportResources(plan([service(), service({ ref: 'again' })]), operator, api as never, () => true)).toEqual({ duplicate: true });
    expect(await prepareImportResources(plan([service(), service({ ref: 'other' })]), operator, api as never, () => true)).toEqual({ duplicate: true });
    expect(api.services.list).not.toHaveBeenCalled();
  });

  it('stops when the session is no longer the one that started', async () => {
    await expect(prepareImportResources(plan(), operator, panel() as never, () => false)).rejects.toThrow('Preparation session changed');
  });

  it('creates what the inventory does not hold, configures it and keeps a receipt for each item', async () => {
    const api = panel();
    const source = plan([service({ settings: { healthCheck: 'running' } })], [database()]);
    expect(await prepareImportResources(source, operator, api as never, () => true)).toEqual({
      duplicate: false,
      outcomes: [
        { kind: 'service', ref: 'web', name: 'Web', status: 'prepared' },
        { kind: 'database', ref: 'db', name: 'App DB', status: 'prepared' },
      ],
    });
    expect(api.services.create).toHaveBeenCalledWith(source.services[0]!.create);
    expect(api.services.update).toHaveBeenCalledWith(41, { healthCheck: 'running' });
    expect(api.databases.createEmpty).toHaveBeenCalledWith({ name: 'App DB', engine: 'postgres', version: '16.1' });
    expect(receipt()).toEqual({ 'service:web': { id: 41, done: true }, 'database:db': { id: 9, done: true } });
    expect(preparedImportTargets(source, operator).databases).toEqual([{ id: 9, name: 'App DB', slug: 'app-db', engine: 'postgres' }]);
  });

  it('skips a service without a source, reports an occupied name and does not take it', async () => {
    const api = panel([{ id: 5, slug: 'web', status: 'running' }]);
    const source = plan([service({ create: { type: 'docker', name: 'No source' } })]);
    expect(await prepareImportResources(source, operator, api as never, () => true)).toEqual({
      duplicate: false, outcomes: [{ kind: 'service', ref: 'web', name: 'No source', status: 'skipped' }],
    });
    expect(api.services.create).not.toHaveBeenCalled();
    expect(await prepareImportResources(plan(), operator, panel([{ id: 5, slug: 'web', status: 'running' }]) as never, () => true)).toEqual({
      duplicate: false, outcomes: [{ kind: 'service', ref: 'web', name: 'Web', status: 'occupied' }],
    });
  });

  it('resumes its own unfinished work, and reports a resource that changed under it', async () => {
    const failing = panel();
    failing.services.update.mockRejectedValue(new Error('refused'));
    const configured = plan([service({ settings: { healthCheck: 'running' } })]);
    expect(await preparedOutcomes(configured, operator, failing as never, () => true)).toEqual([
      { kind: 'service', ref: 'web', name: 'Web', status: 'failed' },
    ]);
    expect(receipt()).toEqual({ 'service:web': { id: 41, done: false } });
    // The service is there and idle: the configuration is finished, and nothing is created again.
    const resuming = panel([{ id: 41, slug: 'web', status: 'idle', type: 'docker' }]);
    expect(await preparedOutcomes(configured, operator, resuming as never, () => true)).toEqual([
      { kind: 'service', ref: 'web', name: 'Web', status: 'prepared' },
    ]);
    expect(resuming.services.create).not.toHaveBeenCalled();
    expect(resuming.services.update).toHaveBeenCalledWith(41, { healthCheck: 'running' });
    expect(receipt()).toEqual({ 'service:web': { id: 41, done: true } });
    // A finished item remains prepared if the live identity still matches.
    expect(await preparedOutcomes(configured, operator, panel([{ id: 41, slug: 'web', status: 'idle', type: 'docker' }]) as never, () => true)).toEqual([
      { kind: 'service', ref: 'web', name: 'Web', status: 'prepared' },
    ]);
    // Someone else's service under the same name, or one that is no longer idle, is not touched.
    expect(await preparedOutcomes(configured, operator, panel([{ id: 99, slug: 'web', status: 'idle', type: 'docker' }]) as never, () => true)).toEqual([
      { kind: 'service', ref: 'web', name: 'Web', status: 'changed' },
    ]);
    sessionStorage.clear();
    expect(await preparedOutcomes(configured, operator, failing as never, () => true)).toEqual([
      { kind: 'service', ref: 'web', name: 'Web', status: 'failed' },
    ]);
    const retyped = panel([{ id: 41, slug: 'web', status: 'idle', type: 'pm2' }]);
    expect(await preparedOutcomes(configured, operator, retyped as never, () => true)).toEqual([
      { kind: 'service', ref: 'web', name: 'Web', status: 'changed' },
    ]);
    expect(retyped.services.update).not.toHaveBeenCalled();
    const started = panel([{ id: 41, slug: 'web', status: 'running', type: 'docker' }]);
    expect(await preparedOutcomes(configured, operator, started as never, () => true)).toEqual([
      { kind: 'service', ref: 'web', name: 'Web', status: 'changed' },
    ]);
    expect(started.services.create).not.toHaveBeenCalled();
    expect(started.services.update).not.toHaveBeenCalled();
  });

  it('tells a retained volume from any other refusal, and starts over after either', async () => {
    const api = panel();
    api.services.create.mockRejectedValueOnce(new NineDeployError(409, 'fresh_volume_required', 'A volume is retained'));
    api.services.create.mockRejectedValueOnce(new Error('panel unreachable'));
    expect(await preparedOutcomes(plan(), operator, api as never, () => true)).toEqual([
      { kind: 'service', ref: 'web', name: 'Web', status: 'retainedVolume' },
    ]);
    expect(receipt()).toEqual({ 'service:web': null });
    expect(await preparedOutcomes(plan(), operator, api as never, () => true)).toEqual([
      { kind: 'service', ref: 'web', name: 'Web', status: 'failed' },
    ]);
    const dbApi = panel();
    dbApi.databases.createEmpty.mockRejectedValueOnce(new Error('no room'));
    expect(await preparedOutcomes(plan([], [database()]), operator, dbApi as never, () => true)).toEqual([
      { kind: 'database', ref: 'db', name: 'App DB', status: 'failed' },
    ]);
  });

  it('stops as soon as the session ends, and keeps what it had done', async () => {
    const tally = () => { let count = 0; return () => { count += 1; return count; }; };
    const first = tally();
    expect(await prepareImportResources(plan(), operator, panel() as never, () => first() === 1)).toEqual({ duplicate: false, outcomes: [] });
    const seen = tally();
    expect(await prepareImportResources(plan(), operator, panel() as never, () => seen() <= 2)).toEqual({ duplicate: false, outcomes: [] });
    expect(receipt()).toEqual({ 'service:web': { id: 41, done: true } });
  });

  it('reads the receipt back for what it may still be used for', async () => {
    const api = panel();
    api.services.create.mockImplementation(async (input: { name: string }) => ({ id: { Api: 41, Worker: 42 }[input.name] ?? 43 }));
    api.databases.createEmpty.mockImplementation(async (input: { name: string }) => ({ id: ({ 'App DB': 9, Cache: 10, Data: 11 })[input.name] ?? 0 }));
    const source = plan(
      [
        service({
          ref: 'api', name: 'Api', create: { type: 'docker', name: 'Api', image: 'nginx', volumeMount: '/data' },
          volumes: [{ mountPath: '/data', source: 'volume' }],
          domains: [
            { host: 'api.example.test', https: true }, { host: '*.example.test', https: true }, { host: 'shared.example.test', https: true },
            { host: 'twice.example.test', https: true }, { host: 'twice.example.test', https: false }, { host: 'only.example.test', https: true },
          ],
          attachments: [{ database: 'pg', envAlias: 'DATABASE_URL' }, { database: 'cache', envAlias: 'REDIS_URL' }],
          env: [{ key: 'DATABASE_URL' }, { key: 'TOKEN' }],
        }),
        service({
          ref: 'worker', name: 'Worker', create: { type: 'docker', name: 'Worker', image: 'nginx', volumeMount: '/etc' },
          volumes: [{ mountPath: '/etc', source: 'file' }],
          domains: [{ host: 'shared.example.test', https: false }, { host: 'api.example.test', https: false }],
        }),
        service({ ref: 'kept', name: 'Kept', create: { type: 'docker', name: 'Kept', image: 'nginx' }, domains: [{ host: 'old.example.test', https: true, sourceDefault: true }] }),
      ],
      [
        database({ ref: 'pg', name: 'App DB' }),
        database({ ref: 'cache', name: 'Cache', engine: 'redis', image: null }),
        database({ ref: 'data', name: 'Data', engine: 'clickhouse', image: null }),
        database({ ref: 'none', name: 'None', engine: null, image: null }),
      ],
    );
    expect(await preparedOutcomes(source, operator, api as never, () => true).then((outcomes) => outcomes.map(({ status }) => status))).toEqual([
      'prepared', 'prepared', 'prepared', 'prepared', 'prepared', 'prepared', 'skipped',
    ]);
    const targets = preparedImportTargets(source, operator);
    expect(targets.databases).toEqual([
      { id: 9, name: 'App DB', slug: 'app-db', engine: 'postgres' },
      { id: 10, name: 'Cache', slug: 'cache', engine: 'redis' },
    ]);
    expect(targets.volumes).toEqual([{ id: 41, name: 'Api', slug: 'api', volumeMount: '/data' }]);
    expect(targets.services.map(({ id, bindings }) => [id, bindings.map(({ alias, databaseName, database }) => `${alias}=${databaseName}:${database?.id}`)])).toEqual([
      [41, ['DATABASE_URL=App DB:9', 'REDIS_URL=Cache:10']], [42, []], [43, []],
    ]);
    expect(targets.domains.map(({ id, host, manual, https }) => `${id}:${host}:${manual ? 'manual' : 'automatic'}:${https ? 'https' : 'http'}`)).toEqual([
      '41:api.example.test:manual:https', '41:*.example.test:manual:https', '41:shared.example.test:manual:https',
      '41:twice.example.test:manual:http', '41:only.example.test:automatic:https',
      '42:shared.example.test:manual:http', '42:api.example.test:manual:http',
    ]);
    for (let i = 0; i < sessionStorage.length; i += 1) sessionStorage.setItem(sessionStorage.key(i)!, 'not a receipt');
    expect(preparedImportTargets(source, operator)).toEqual({ databases: [], volumes: [], domains: [], services: [], entries: [] });
  });
});

describe('applyMigrationEnvironment', () => {
  const pg = { id: 9, name: 'App DB', slug: 'app-db', engine: 'postgres' as const };
  const target = (bindings: PreparedImportService['bindings'] = [], env: Array<{ key: string }> = [{ key: 'API_KEY' }]): PreparedImportService => ({
    id: 41, name: 'Web', slug: 'web', service: { ...service(), env }, bindings,
  });
  type Live = { id: number; slug: string; engine: string; status: string };
  /** A panel holding the given databases, where attachments succeed unless told otherwise. */
  const environment = (live: Live[] = [], held: Array<{ key: string }> = [], attached: Array<{ envAlias: string; databaseId: number }> = []) => ({
    services: { get: vi.fn(async () => ({ id: 41, slug: 'web', type: 'docker' })) },
    env: { list: vi.fn(async () => held), import: vi.fn(async () => ({ imported: 2, skipped: 1, errors: [{ line: 3, message: 'kept' }] })) },
    attachments: {
      list: vi.fn(async () => attached.map((item) => ({ ...item, database: null }))),
      create: vi.fn(async (_serviceId: number, input: { databaseId: number; envAlias?: string }) => ({ databaseId: input.databaseId, envAlias: input.envAlias, database: null })),
    },
    databases: { list: vi.fn(async () => live) },
  });
  const lines = new Map([['API_KEY', "API_KEY='secret'"]]);

  it('stops when the session or the service is not the one that started', async () => {
    await expect(applyMigrationEnvironment(environment() as never, target(), lines, () => false)).rejects.toThrow('Migration session changed');
    const other = environment();
    other.services.get.mockResolvedValue({ id: 41, slug: 'renamed', type: 'docker' } as never);
    await expect(applyMigrationEnvironment(other as never, target(), lines, () => true)).rejects.toThrow('Migration target changed');
    expect(other.env.import).not.toHaveBeenCalled();
  });

  it('refuses more than the panel accepts in one import', async () => {
    const long = new Map([['API_KEY', `API_KEY='${'x'.repeat(ENV_IMPORT_MAX_CHARS)}'`]]);
    await expect(applyMigrationEnvironment(environment() as never, target(), long, () => true)).rejects.toBeInstanceOf(InvalidMigrationEnvironment);
  });

  it('reports a failed import and goes on to the attachments', async () => {
    const api = environment([{ ...pg, status: 'running' }]);
    api.env.import.mockRejectedValue(new Error('panel unreachable'));
    expect(await applyMigrationEnvironment(api as never, target([{ alias: 'DATABASE_URL', databaseName: 'App DB', database: pg }]), lines, () => true)).toEqual({
      imported: 0, skipped: 0, errors: 0, envFailed: true, outcomes: [{ alias: 'DATABASE_URL', status: 'attached' }],
    });
    expect(api.env.import).toHaveBeenCalledWith(41, "API_KEY='secret'", { isSecret: true, overwriteExisting: false });
    expect(api.attachments.create).toHaveBeenCalledWith(41, { databaseId: 9, envAlias: 'DATABASE_URL' });
  });

  it('leaves a key the service already holds as it is, and counts it as skipped', async () => {
    const api = environment([{ ...pg, status: 'running' }], [{ key: 'API_KEY' }]);
    expect(await applyMigrationEnvironment(api as never, target([{ alias: 'DATABASE_URL', databaseName: 'App DB', database: pg }]), lines, () => true)).toEqual({
      imported: 0, skipped: 1, errors: 0, envFailed: false, outcomes: [{ alias: 'DATABASE_URL', status: 'attached' }],
    });
    expect(api.env.import).not.toHaveBeenCalled();
  });

  it('reviews every planned connection, and attaches only the ones that are free', async () => {
    const live = (id: number, slug = `db-${id}`): Live => ({ id, slug, engine: 'postgres', status: 'running' });
    const prepared = (id: number, slug = `db-${id}`) => ({ ...pg, id, slug });
    const api = environment(
      [live(9, 'app-db'), live(11), live(12), live(13), live(14), live(15), live(16), live(17)],
      [{ key: 'E' }],
      [{ envAlias: 'D', databaseId: 11 }, { envAlias: 'OTHER', databaseId: 13 }],
    );
    api.attachments.create.mockImplementation(async (_serviceId: number, input: { databaseId: number; envAlias?: string }) => {
      if (input.databaseId === 15) return { databaseId: 99, envAlias: 'H', database: null };
      if (input.databaseId === 16) throw new Error('refused');
      return { databaseId: input.databaseId, envAlias: input.envAlias, database: null };
    });
    const bindings: PreparedImportService['bindings'] = [
      { alias: 'A', databaseName: 'App DB', database: prepared(9, 'app-db') },
      { alias: 'A', databaseName: 'Other', database: prepared(10) },
      { alias: 'A', databaseName: 'App DB again', database: prepared(9, 'app-db') },
      { alias: 'B', databaseName: 'Never prepared', database: undefined },
      { alias: 'C', databaseName: 'Renamed', database: prepared(9, 'renamed') },
      { alias: 'D', databaseName: 'Db 11', database: prepared(11) },
      { alias: 'E', databaseName: 'Db 12', database: prepared(12) },
      { alias: 'F', databaseName: 'Db 13', database: prepared(13) },
      { alias: 'G', databaseName: 'Db 14', database: prepared(14) },
      { alias: 'H', databaseName: 'Db 15', database: prepared(15) },
      { alias: 'I', databaseName: 'Db 16', database: prepared(16) },
      { alias: 'not an alias!', databaseName: 'Db 17', database: prepared(17) },
    ];
    expect(await applyMigrationEnvironment(api as never, target(bindings), lines, () => true)).toEqual({
      imported: 2, skipped: 1, errors: 1, envFailed: false,
      outcomes: [
        { alias: 'A', status: 'conflict' }, { alias: 'B', status: 'missing' }, { alias: 'C', status: 'missing' },
        { alias: 'D', status: 'attached' }, { alias: 'E', status: 'conflict' }, { alias: 'F', status: 'conflict' },
        { alias: 'G', status: 'attached' }, { alias: 'H', status: 'conflict' }, { alias: 'I', status: 'failed' },
        { alias: 'not an alias!', status: 'conflict' },
      ],
    });
    expect(api.attachments.create.mock.calls).toEqual([
      [41, { databaseId: 14, envAlias: 'G' }], [41, { databaseId: 15, envAlias: 'H' }], [41, { databaseId: 16, envAlias: 'I' }],
    ]);
  });
});
