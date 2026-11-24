import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { DATABASE_IMPORT_ENGINE_OPTIONS, importDatabaseVersion, slugifyResourceName, type ImportPlan, type PlanEngine, type PlanService, type PublicUser } from '@ninedeploy/schemas';
import { NineDeployError, type NineDeployClient } from '@ninedeploy/sdk';
import { apiUrl } from './apiUrl.js';
import { checkImportTarget } from './importTarget.js';

export type ImportOperator = Pick<PublicUser, 'id' | 'createdAt' | 'email'>;
export type PreparedImportDatabase = { id: number; name: string; slug: string; engine: PlanEngine };
export type PreparedImportService = {
  id: number; name: string; slug: string; service: PlanService;
  bindings: Array<{ alias: string; databaseName: string; database: PreparedImportDatabase | undefined }>;
};

type Checkpoint = { id: number; done: boolean } | null;
type Status = 'prepared' | 'occupied' | 'changed' | 'skipped' | 'failed' | 'retainedVolume';
type Outcome = { ref: string; name: string; kind: 'service' | 'database'; status: Status };
type Result = { duplicate: true } | { duplicate: false; outcomes: Outcome[] };

function readReceipt(raw: string | null): Record<string, Checkpoint> {
  const parsed: unknown = raw === null ? {} : JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid preparation receipt');
  const entries = Object.entries(parsed) as [string, unknown][];
  for (const [key, record] of entries) {
    if (!key.startsWith('service:') && !key.startsWith('database:')) throw new Error('Invalid preparation receipt');
    if (record === null) continue;
    const value = record as Partial<NonNullable<Checkpoint>> | undefined;
    if (typeof value?.id !== 'number' || !Number.isSafeInteger(value.id) || value.id <= 0 || typeof value.done !== 'boolean') {
      throw new Error('Invalid preparation receipt');
    }
  }
  return parsed as Record<string, Checkpoint>;
}

function receiptKey(plan: ImportPlan, operator: ImportOperator): string {
  const apiScope = new URL(apiUrl('/v1'), window.location.href).href;
  const identity = JSON.stringify([apiScope, operator.id, operator.createdAt, plan]);
  return `ninedeploy.import.prepare.v1.${bytesToHex(sha256(new TextEncoder().encode(identity)))}`;
}

/** A receipt identifies candidates. Confirm them against the current inventory before offering an import link. */
export function preparedImportTargets(plan: ImportPlan, operator: ImportOperator) {
  try {
    const saved = readReceipt(window.sessionStorage.getItem(receiptKey(plan, operator)));
    const preparedDatabases = new Map(plan.databases.flatMap(({ ref, name, engine }): Array<[string, PreparedImportDatabase]> => {
      const checkpoint = saved[`database:${ref}`];
      return checkpoint?.done && engine ? [[ref, { id: checkpoint.id, name, slug: slugifyResourceName(name), engine }]] : [];
    }));
    const databases = [...preparedDatabases.values()].filter(({ engine }) => Object.hasOwn(DATABASE_IMPORT_ENGINE_OPTIONS, engine));
    const databaseNames = new Map(plan.databases.map(({ ref, name }) => [ref, name]));
    const services = plan.services.flatMap((service): PreparedImportService[] => {
      const checkpoint = saved[`service:${service.ref}`];
      if (!checkpoint?.done) return [];
      const name = service.create.name;
      return [{ id: checkpoint.id, name, slug: slugifyResourceName(name), service, bindings: (service.attachments ?? []).map(({ database, envAlias }) => ({
        alias: envAlias, databaseName: databaseNames.get(database) ?? database, database: preparedDatabases.get(database),
      })) }];
    });
    const volumes = plan.services.flatMap(({ ref, create, volumes }) => {
      const checkpoint = saved[`service:${ref}`];
      const { name, volumeMount } = create;
      if (!checkpoint?.done || create.type !== 'docker' || !volumeMount || volumes.find(({ mountPath }) => mountPath === volumeMount)?.source === 'file') return [];
      return [{ id: checkpoint.id, name, slug: slugifyResourceName(name), volumeMount }];
    });
    const owners = new Map<string, Set<string>>();
    const planned = plan.services.flatMap(({ ref, create, domains }) => domains.filter(({ sourceDefault }) => !sourceDefault)
      .map(({ host, https }) => ({ ref, create, host: host.trim().toLowerCase().replace(/\.$/, ''), https })));
    for (const { host, ref } of planned) {
      const references = owners.get(host) ?? new Set<string>();
      references.add(ref);
      owners.set(host, references);
    }
    const domains = new Map<string, { id: number; name: string; slug: string; host: string; https: boolean; manual: boolean }>();
    for (const { ref, create, host, https } of planned) {
      const checkpoint = saved[`service:${ref}`];
      if (!checkpoint?.done || !host) continue;
      const key = `${checkpoint.id}:${host}`;
      const previous = domains.get(key);
      domains.set(key, {
        id: checkpoint.id, name: create.name, slug: slugifyResourceName(create.name), host, https,
        manual: host.startsWith('*.') || (owners.get(host)?.size ?? 0) > 1 || (!!previous && (previous.manual || previous.https !== https)),
      });
    }
    return { databases, volumes, domains: [...domains.values()], services };
  } catch {
    return { databases: [], volumes: [], domains: [], services: [] };
  }
}

export async function prepareImportResources(
  plan: ImportPlan,
  operator: ImportOperator,
  api: Pick<NineDeployClient, 'services' | 'databases'>,
  isActive: () => boolean,
): Promise<Result> {
  if (!isActive()) throw new Error('Preparation session changed');
  const problems = checkImportTarget(plan, { services: [], databases: [] });
  if (problems.some((item) => item.problems.includes('repeatedRef') || item.problems.includes('repeatedName'))) {
    return { duplicate: true };
  }
  const key = receiptKey(plan, operator);
  const storage = window.sessionStorage;
  const saved = readReceipt(storage.getItem(key));
  const save = (entry: string, value: Checkpoint) => {
    saved[entry] = value;
    storage.setItem(key, JSON.stringify(saved));
  };

  const [services, databases] = await Promise.all([api.services.list(), api.databases.list()]);
  const outcomes: Outcome[] = [];
  const jobs = [
    ...plan.services.map((item) => ({
      kind: 'service' as const, ref: item.ref, name: item.create.name, inventory: services,
      create: () => api.services.create(item.create),
      configure: item.settings?.healthCheck === 'running'
        ? (id: number) => api.services.update(id, { healthCheck: 'running' }) : undefined,
    })),
    ...plan.databases.map((item) => ({
      kind: 'database' as const, ref: item.ref, name: item.name, inventory: databases,
      create: () => api.databases.createEmpty({
        name: item.name, engine: item.engine!, version: importDatabaseVersion(item.engine!, item.image),
      }),
      configure: undefined,
    })),
  ];
  const invalid = new Set(problems.map(({ kind, ref }) => `${kind}:${ref}`));
  for (const { kind, ref, name, inventory, create, configure } of jobs) {
    if (!isActive()) break;
    const entry = `${kind}:${ref}`;
    const record = (status: Status) => outcomes.push({ kind, ref, name, status });
    if (invalid.has(entry)) {
      record('skipped');
      continue;
    }
    const previous = saved[entry];
    const existing = inventory.find(({ slug }) => slug === slugifyResourceName(name));
    let id = previous?.id;
    if (id !== undefined && existing?.id !== id) {
      record('changed');
      continue;
    }
    if (id === undefined && existing) {
      record('occupied');
      continue;
    }
    if (previous?.done) {
      record('prepared');
      continue;
    }
    if (id !== undefined && existing?.status !== 'idle') {
      record('changed');
      continue;
    }
    if (id === undefined) {
      save(entry, null);
      try {
        ({ id } = await create());
      } catch (error) {
        record(error instanceof NineDeployError && error.code === 'fresh_volume_required' ? 'retainedVolume' : 'failed');
        continue;
      }
      save(entry, { id, done: !configure });
    }
    if (!isActive()) break;
    if (configure) {
      try {
        await configure(id);
      } catch {
        record('failed');
        continue;
      }
      save(entry, { id, done: true });
    }
    record('prepared');
  }
  return { duplicate: false, outcomes };
}
