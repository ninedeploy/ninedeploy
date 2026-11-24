import { z } from 'zod';
import { buildPack, serviceType } from './service.js';

const sourceKind = z.enum(['coolify', 'dokploy', 'caprover', 'heroku']);
const issueLevel = z.enum(['unsupported', 'manual', 'info']);

const issue = z.object({ level: issueLevel, option: z.string(), detail: z.string() });
const runtime = z.object({
  kind: z.enum(['container', 'swarm-service', 'heroku-app']),
  name: z.string(),
});

// Describe a plan for review. Admission of those settings happens when they
// are passed to the usual create endpoints, with their normal validation.
const serviceFields = z.object({
  name: z.string(),
  type: serviceType,
  image: z.string().optional(),
  repoUrl: z.string().optional(),
  branch: z.string().optional(),
  port: z.number().optional(),
  publishedPort: z.number().nullable().optional(),
  replicas: z.number().optional(),
  cpuLimitMilli: z.number().optional(),
  memLimitMb: z.number().optional(),
  healthPath: z.string().optional(),
  volumeMount: z.string().optional(),
  build: z.object({
    buildPack: buildPack.optional(),
    baseDir: z.string().optional(),
    dockerfilePath: z.string().optional(),
    outputDir: z.string().optional(),
    startCmd: z.string().optional(),
  }).optional(),
});

const domain = z.object({
  host: z.string(),
  https: z.boolean(),
  sourceDefault: z.literal(true).optional(),
});

const service = z.object({
  ref: z.string(),
  name: z.string(),
  kind: z.enum(['image', 'git', 'compose']),
  create: serviceFields,
  domains: z.array(domain),
  env: z.array(z.object({ key: z.string() })),
  volumes: z.array(z.object({
    mountPath: z.string(), source: z.enum(['volume', 'bind', 'file']), name: z.string().optional(),
  })),
  issues: z.array(issue),
  runtime: runtime.optional(),
  settings: z.object({ healthCheck: z.literal('running').optional() }).optional(),
  attachments: z.array(z.object({ database: z.string(), envAlias: z.string() })).optional(),
});

const engine = z.enum(['postgres', 'mysql', 'mariadb', 'mongo', 'redis', 'keydb', 'dragonfly', 'clickhouse']);
const database = z.object({
  ref: z.string(),
  name: z.string(),
  engine: engine.nullable(),
  image: z.string().nullable(),
  runtime: runtime.optional(),
  issues: z.array(issue),
});

/** Shared version 1 plan. A plan contains environment names without values. */
export const importPlan = z.object({
  planVersion: z.literal(1),
  source: z.object({ kind: sourceKind, url: z.string(), version: z.string().nullable(), scope: z.string() }),
  generatedAt: z.string(),
  services: z.array(service),
  databases: z.array(database),
  notes: z.array(z.string()),
});

export type ImportPlan = z.infer<typeof importPlan>;
export type SourceKind = z.infer<typeof sourceKind>;
export type IssueLevel = z.infer<typeof issueLevel>;
export type PlanIssue = z.infer<typeof issue>;
export type PlanRuntime = z.infer<typeof runtime>;
export type ServiceCreateFields = z.infer<typeof serviceFields>;
export type PlanDomain = z.infer<typeof domain>;
export type PlanService = z.infer<typeof service>;
export type PlanEngine = z.infer<typeof engine>;
export type PlanDatabase = z.infer<typeof database>;

/** Whether applying this item would attempt to create a service. */
export function hasImportServiceSource(service: PlanService): boolean {
  return Boolean(service.create.image || service.create.repoUrl);
}

/** Names an application on the source may use to reach this database. */
export function sourceDatabaseHosts(kind: SourceKind, db: PlanDatabase): string[] {
  const name = db.runtime?.name?.toLowerCase();
  if (!name || db.runtime?.kind === 'heroku-app') return [];
  if (kind === 'caprover') {
    const app = name.replace(/^srv-captain--/, '');
    return [app, `srv-captain--${app}`];
  }
  return [name];
}

// The image repositories used by the managed database runtime.
const ENGINE_REPOS: Record<PlanEngine, string> = {
  postgres: 'postgres', mysql: 'mysql', mariadb: 'mariadb', mongo: 'mongo', redis: 'redis',
  keydb: 'eqalpha/keydb', dragonfly: 'ghcr.io/dragonflydb/dragonfly', clickhouse: 'clickhouse/clickhouse-server',
};

/** A compatible version tag, or undefined to use the target's default. */
export function importDatabaseVersion(engine: PlanEngine, image: string | null): string | undefined {
  if (!image) return undefined;
  const ref = image.split('@')[0]!;
  const colon = ref.lastIndexOf(':');
  if (colon < 0 || ref.slice(colon).includes('/')) return undefined;
  const repo = ref.slice(0, colon).replace(/^docker\.io\//, '').replace(/^library\//, '');
  const tag = ref.slice(colon + 1);
  if (repo !== ENGINE_REPOS[engine] || !/^[0-9][A-Za-z0-9_.-]*$/.test(tag)) return undefined;
  return tag;
}
