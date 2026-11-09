/**
 * Dokploy (field names checked against v0.31.0, 3ac1c8f2): tRPC procedures
 * exposed as REST by @dokploy/trpc-openapi, `GET /api/<procedure>?<input>`,
 * with an `x-api-key` bound to one organization. There is no application.all:
 * the plan walks project.all, then reads each item with its `*.one`.
 *
 * Dokploy returns secrets in plain text (decrypted env, database passwords,
 * the registry password): the adapter reads names only and never copies a
 * value into the plan.
 */
import {
  DATA_NOT_MOVED, emptyPlan, envNames, firstVolumeMount, memToMb, planDomain, replicasFor, stripUserinfo,
  type ImportPlan, type PlanDatabase, type PlanEngine, type PlanIssue, type PlanService, type SourceGet,
} from './plan.js';

type Obj = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const q = (procedure: string, input: Record<string, string>) => `/api/${procedure}?${new URLSearchParams(input).toString()}`;

/** The repository a Dokploy application or compose builds from, per source type. */
function repoOf(row: Obj, issues: PlanIssue[]): { repoUrl?: string; branch?: string } {
  const type = str(row['sourceType']);
  const hosted = (host: string, owner?: string, repo?: string) => (owner && repo ? `https://${host}/${owner}/${repo}` : undefined);
  let out: { repoUrl?: string; branch?: string } = {};
  if (type === 'github') out = { repoUrl: hosted('github.com', str(row['owner']), str(row['repository'])), branch: str(row['branch']) };
  else if (type === 'gitlab') out = { repoUrl: hosted('gitlab.com', str(row['gitlabOwner']), str(row['gitlabRepository'])), branch: str(row['gitlabBranch']) };
  else if (type === 'bitbucket') out = { repoUrl: hosted('bitbucket.org', str(row['bitbucketOwner']), str(row['bitbucketRepository'])), branch: str(row['bitbucketBranch']) };
  else if (type === 'gitea') {
    out = { branch: str(row['giteaBranch']) };
    issues.push({ level: 'manual', option: 'sourceType', detail: `Gitea repository ${str(row['giteaOwner']) ?? '?'}/${str(row['giteaRepository']) ?? '?'}: enter its URL by hand (the Gitea host is not in the record).` });
  } else if (type === 'git') {
    const raw = str(row['customGitUrl']);
    out = { repoUrl: raw ? stripUserinfo(raw) : undefined, branch: str(row['customGitBranch']) };
  }
  if (type === 'github' || type === 'gitlab' || type === 'bitbucket' || type === 'gitea' || (type === 'git' && row['customGitSSHKeyId'] != null)) {
    issues.push({ level: 'manual', option: 'source', detail: 'Repository access does not transfer: reconnect it in NineDeploy (GitHub App, token or deploy key).' });
  }
  if (type === 'gitlab' || type === 'bitbucket') issues.push({ level: 'info', option: 'sourceType', detail: `Assumed the hosted ${type === 'gitlab' ? 'gitlab.com' : 'bitbucket.org'}; change the URL for a self-hosted instance.` });
  return out;
}

function volumesOf(mounts: unknown): PlanService['volumes'] {
  const out: PlanService['volumes'] = [];
  for (const m of list(mounts)) {
    const mountPath = str(m['mountPath']);
    if (!mountPath) continue;
    const type = str(m['type']);
    out.push({ mountPath, source: type === 'bind' ? 'bind' : type === 'file' ? 'file' : 'volume', name: str(m['volumeName']) });
  }
  return out;
}

const BUILD_PACKS: Record<string, NonNullable<NonNullable<PlanService['create']['build']>['buildPack']>> = {
  nixpacks: 'nixpacks', dockerfile: 'dockerfile', static: 'static', railpack: 'railpack', heroku_buildpacks: 'heroku', paketo_buildpacks: 'paketo',
};

async function applicationItem(get: SourceGet, id: string): Promise<PlanService> {
  const app = ((await get(q('application.one', { applicationId: id }))) ?? {}) as Obj;
  const name = str(app['name']) ?? str(app['appName']) ?? id;
  const issues: PlanIssue[] = [];
  const base = { name, type: 'docker' as const };
  const sourceType = str(app['sourceType']);
  let kind: PlanService['kind'] = 'git';
  let create: PlanService['create'] = base;
  if (sourceType === 'docker') {
    kind = 'image';
    create = { ...base, image: str(app['dockerImage']) };
    if (str(app['username']) || app['registryUrl']) issues.push({ level: 'manual', option: 'registry', detail: 'A private registry login does not transfer: add the registry credentials in NineDeploy.' });
  } else if (sourceType === 'drop') {
    issues.push({ level: 'unsupported', option: 'sourceType', detail: 'Uploaded ("drop") source: the archive is not readable over the API. Re-upload it as a ZIP source in NineDeploy.' });
  } else {
    const { repoUrl, branch } = repoOf(app, issues);
    const buildType = str(app['buildType']) ?? 'nixpacks';
    const buildPack = BUILD_PACKS[buildType] ?? 'auto';
    if (buildPack === 'auto') issues.push({ level: 'unsupported', option: 'buildType', detail: `Build type "${buildType}" has no NineDeploy equivalent; the plan uses auto-detect.` });
    const dockerfile = str(app['dockerfile']);
    const base_dir = str(app['customGitBuildPath']) ?? str(app['buildPath']);
    create = {
      ...base, repoUrl, branch,
      build: {
        buildPack,
        ...(base_dir ? { baseDir: base_dir } : {}),
        ...(buildPack === 'dockerfile' && dockerfile ? { dockerfilePath: dockerfile.replace(/^\.?\/+/, '') } : {}),
        ...(buildPack === 'static' && str(app['publishDirectory']) ? { outputDir: str(app['publishDirectory'])!.replace(/^\.?\/+/, '') } : {}),
      },
    };
    if (!repoUrl && sourceType !== 'gitea') issues.push({ level: 'manual', option: 'repository', detail: 'No repository in the source.' });
  }
  const domains = list(app['domains']).map((d) => ({ host: str(d['host']) ?? '', https: d['https'] === true, port: Number(d['port']) })).filter((d) => d.host);
  const port = domains.find((d) => Number.isInteger(d.port) && d.port > 0)?.port;
  if (port) create.port = port;
  const portsList = list(app['ports']);
  if (portsList.length) issues.push({ level: 'manual', option: 'ports', detail: `${portsList.length} published port(s) (${portsList.map((p) => `${p['publishedPort']}:${p['targetPort']}`).join(', ')}); set Public Host Port or port mappings by hand.` });
  const mem = memToMb(str(app['memoryLimit']) ?? (app['memoryLimit'] as number | undefined));
  if (mem) create.memLimitMb = mem;
  // Dokploy passes these straight to Docker: memoryLimit as MemoryBytes and
  // cpuLimit as NanoCPUs (1e9 = one core), both as strings.
  const nano = Number(app['cpuLimit']);
  const cpu = Number.isFinite(nano) && nano > 0 ? Math.round(nano / 1_000_000) : undefined;
  if (cpu) create.cpuLimitMilli = cpu;
  const replicas = replicasFor(app['replicas'], issues);
  if (replicas) create.replicas = replicas;
  if (str(app['command'])) issues.push({ level: 'manual', option: 'command', detail: 'A custom start command is set; add it as the start command under Settings → Build & start.' });
  const volumes = volumesOf(app['mounts']);
  const mount = firstVolumeMount(volumes, issues);
  if (mount) create.volumeMount = mount;
  return { ref: id, name, kind, create, domains: domains.map(({ host, https }) => planDomain(host, https)), env: envNames(str(app['env'])), volumes, issues };
}

async function composeItem(get: SourceGet, id: string): Promise<PlanService> {
  const row = ((await get(q('compose.one', { composeId: id }))) ?? {}) as Obj;
  const name = str(row['name']) ?? str(row['appName']) ?? id;
  const issues: PlanIssue[] = [];
  const create: PlanService['create'] = { name, type: 'compose' };
  if (str(row['sourceType']) === 'raw') {
    issues.push({ level: 'manual', option: 'composeFile', detail: 'An inline compose file: paste it into a new compose service (the plan does not copy file contents).' });
  } else {
    Object.assign(create, repoOf(row, issues));
    issues.push({ level: 'info', option: 'composePath', detail: `Compose file ${str(row['composePath']) ?? './docker-compose.yml'} in the repository.` });
  }
  if (str(row['composeType']) === 'stack') issues.push({ level: 'info', option: 'composeType', detail: 'A Swarm stack; NineDeploy runs it as a Compose stack unless you choose Swarm.' });
  const domains = list(row['domains']).map((d) => planDomain(str(d['host']) ?? '', d['https'] === true)).filter((d) => d.host);
  return { ref: id, name, kind: 'compose', create, domains, env: envNames(str(row['env'])), volumes: volumesOf(row['mounts']), issues };
}

const DB_KINDS: Array<{ key: string; idField: string; procedure: string; engine: PlanEngine | null }> = [
  { key: 'postgres', idField: 'postgresId', procedure: 'postgres.one', engine: 'postgres' },
  { key: 'mysql', idField: 'mysqlId', procedure: 'mysql.one', engine: 'mysql' },
  { key: 'mariadb', idField: 'mariadbId', procedure: 'mariadb.one', engine: 'mariadb' },
  { key: 'mongo', idField: 'mongoId', procedure: 'mongo.one', engine: 'mongo' },
  { key: 'redis', idField: 'redisId', procedure: 'redis.one', engine: 'redis' },
  { key: 'libsql', idField: 'libsqlId', procedure: 'libsql.one', engine: null },
];

export async function planFromDokploy(get: SourceGet, url: string): Promise<ImportPlan> {
  const version = await get('/api/settings.getDokployVersion').then((v) => (typeof v === 'string' ? v.trim() : null), () => null);
  const plan = emptyPlan('dokploy', url, version, "the organization the API key belongs to (other organizations are not read)");
  for (const project of list(await get('/api/project.all'))) {
    for (const env of list(project['environments'])) {
      for (const a of list(env['applications'])) if (str(a['applicationId'])) plan.services.push(await applicationItem(get, String(a['applicationId'])));
      for (const c of list(env['compose'])) if (str(c['composeId'])) plan.services.push(await composeItem(get, String(c['composeId'])));
      for (const kind of DB_KINDS) {
        for (const d of list(env[kind.key])) {
          const id = str(d[kind.idField]);
          if (!id) continue;
          const row = ((await get(q(kind.procedure, { [kind.idField]: id }))) ?? {}) as Obj;
          const issues: PlanIssue[] = kind.engine
            ? [DATA_NOT_MOVED]
            : [{ level: 'unsupported', option: 'libsql', detail: 'libSQL has no managed NineDeploy equivalent.' }];
          if (row['externalPort'] != null) issues.push({ level: 'manual', option: 'externalPort', detail: 'Public access was on; turn on public access in NineDeploy if you still need it.' });
          const item: PlanDatabase = { ref: id, name: str(row['name']) ?? str(d['name']) ?? id, engine: kind.engine, image: str(row['dockerImage']) ?? null, issues };
          // Dokploy runs each database as a Swarm service named after its appName.
          const appName = str(row['appName']) ?? str(d['appName']);
          if (appName) item.runtime = { kind: 'swarm-service', name: appName };
          plan.databases.push(item);
        }
      }
    }
  }
  return plan;
}
