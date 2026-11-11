/**
 * Coolify v4 (field names checked against v4.7.0, eaaaf7a7): REST under
 * /api/v1 with a team-bound Bearer token. A `read` token is enough for a plan:
 * values that need `read:sensitive` (env values, compose YAML, passwords) are
 * never asked for. Databases come from /databases, not from per-environment
 * lists, which leave out KeyDB, Dragonfly, ClickHouse and SQLite.
 */
import {
  cpusToMilli, DATA_NOT_MOVED, domainsFrom, emptyPlan, firstVolumeMount, memToMb, stripUserinfo,
  type ImportPlan, type PlanDatabase, type PlanEngine, type PlanIssue, type PlanService, type SourceGet,
} from './plan.js';

type Obj = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);

const ENGINES: Record<string, PlanEngine | null> = {
  'standalone-postgresql': 'postgres',
  'standalone-mysql': 'mysql',
  'standalone-mariadb': 'mariadb',
  'standalone-mongodb': 'mongo',
  'standalone-redis': 'redis',
  'standalone-keydb': 'keydb',
  'standalone-dragonfly': 'dragonfly',
  'standalone-clickhouse': 'clickhouse',
  'standalone-sqlite': null,
};

/** Coolify git_repository is a URL, or `owner/repo` for GitHub sources. */
function repoUrlOf(app: Obj, issues: PlanIssue[]): string | undefined {
  const full = str(app['git_full_url']) ?? str(app['git_repository']);
  if (!full) return undefined;
  if (/^(https?|ssh|git):\/\//i.test(full) || /^[^@\s]+@[^:\s]+:/.test(full)) return stripUserinfo(full);
  if (/^[\w.-]+\/[\w.-]+$/.test(full)) {
    issues.push({ level: 'info', option: 'git_repository', detail: `"${full}" read as a GitHub repository.` });
    return `https://github.com/${full}`;
  }
  return stripUserinfo(full);
}

async function envKeys(get: SourceGet, path: string): Promise<Array<{ key: string }>> {
  const rows = list(await get(path));
  const keys = new Set<string>();
  // Preview variables (is_preview) belong to PR previews, not the service itself.
  for (const r of rows) if (r['is_preview'] !== true && str(r['key'])) keys.add(String(r['key']));
  return [...keys].map((key) => ({ key }));
}

async function volumesOf(get: SourceGet, path: string): Promise<PlanService['volumes']> {
  const s = (await get(path)) as Obj | null;
  const out: PlanService['volumes'] = [];
  for (const v of list(s?.['persistent_storages'])) {
    const mountPath = str(v['mount_path']);
    if (mountPath) out.push({ mountPath, source: str(v['host_path']) ? 'bind' : 'volume', name: str(v['name']) });
  }
  for (const v of list(s?.['file_storages'])) {
    const mountPath = str(v['mount_path']);
    if (mountPath) out.push({ mountPath, source: 'file' });
  }
  return out;
}

async function applicationItem(get: SourceGet, app: Obj): Promise<PlanService> {
  const ref = String(app['uuid']);
  const name = str(app['name']) ?? ref;
  const issues: PlanIssue[] = [];
  const pack = str(app['build_pack']) ?? 'nixpacks';
  const base = { name, type: 'docker' as const };
  let kind: PlanService['kind'] = 'git';
  let create: PlanService['create'] = base;

  if (pack === 'dockerimage') {
    kind = 'image';
    const image = str(app['docker_registry_image_name']);
    const tag = str(app['docker_registry_image_tag']) ?? 'latest';
    create = { ...base, image: image ? `${image}:${tag}` : undefined };
    if (!image) issues.push({ level: 'manual', option: 'docker_registry_image_name', detail: 'No image name in the source; set one before importing.' });
  } else if (pack === 'dockercompose') {
    kind = 'compose';
    create = { name, type: 'compose', repoUrl: repoUrlOf(app, issues), branch: str(app['git_branch']) };
    const loc = str(app['docker_compose_location']);
    issues.push({ level: 'info', option: 'docker_compose_location', detail: `Compose file ${loc ?? '/docker-compose.yaml'} in the repository; NineDeploy reads it from there.` });
  } else {
    const buildPack = pack === 'nixpacks' || pack === 'static' || pack === 'dockerfile' || pack === 'railpack' ? pack : 'auto';
    if (buildPack === 'auto') issues.push({ level: 'unsupported', option: 'build_pack', detail: `Build pack "${pack}" has no NineDeploy equivalent; the plan uses auto-detect.` });
    const dockerfile = str(app['dockerfile_location'])?.replace(/^\/+/, '');
    create = {
      ...base,
      repoUrl: repoUrlOf(app, issues),
      branch: str(app['git_branch']),
      build: {
        buildPack,
        baseDir: str(app['base_directory']) ?? '/',
        ...(buildPack === 'dockerfile' && dockerfile ? { dockerfilePath: dockerfile } : {}),
        ...(buildPack === 'static' && str(app['publish_directory']) ? { outputDir: str(app['publish_directory'])!.replace(/^\/+/, '') } : {}),
      },
    };
    if (!create.repoUrl) issues.push({ level: 'manual', option: 'git_repository', detail: 'No repository in the source.' });
  }
  const sourceType = str(app['source_type']) ?? '';
  // Coolify gives every app made from a public repository its built-in "Public GitHub"
  // source, GithubApp id 0 (checked live on 4.7.5). Only another source needs credentials.
  const publicSource = /GithubApp/i.test(sourceType) && app['source_id'] != null && Number(app['source_id']) === 0;
  const gitSource = /Github|Gitlab|Gitea|Bitbucket/i.test(sourceType) && !publicSource;
  // A read token hides private_key_id, so a deploy-key app shows as an SSH repository URL.
  const sshRepo = /^(ssh:\/\/|[^@\s/]+@[^:\s]+:)/i.test(str(app['git_repository']) ?? '');
  if (gitSource || app['private_key_id'] != null || sshRepo || str(app['git_https_username'])) {
    issues.push({ level: 'manual', option: 'source', detail: 'Private repository access does not transfer: reconnect it in NineDeploy (GitHub App, token or deploy key).' });
  }

  const ports = (str(app['ports_exposes']) ?? '').split(',').map((p) => Number(p.trim())).filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  if (ports[0]) create.port = ports[0];
  if (ports.length > 1) issues.push({ level: 'info', option: 'ports_exposes', detail: `Exposes ${ports.join(', ')}; NineDeploy routes one port (${ports[0]}).` });
  const mapping = str(app['ports_mappings']);
  if (mapping) issues.push({ level: 'manual', option: 'ports_mappings', detail: `Host port mappings (${mapping}) are not carried; set Public Host Port or port mappings by hand.` });
  if (app['health_check_enabled'] === true && str(app['health_check_path'])) create.healthPath = str(app['health_check_path']);
  const mem = memToMb(str(app['limits_memory']));
  if (mem) create.memLimitMb = mem;
  const cpu = cpusToMilli(str(app['limits_cpus']));
  if (cpu) create.cpuLimitMilli = cpu;

  const volumes = kind === 'compose' ? [] : await volumesOf(get, `/api/v1/applications/${ref}/storages`);
  const mount = kind === 'compose' ? undefined : firstVolumeMount(volumes, issues);
  if (mount) create.volumeMount = mount;
  return {
    ref, name, kind, create,
    domains: domainsFrom(str(app['fqdn'])),
    env: await envKeys(get, `/api/v1/applications/${ref}/envs`),
    volumes, issues,
  };
}

async function serviceStackItem(get: SourceGet, svc: Obj): Promise<PlanService> {
  const ref = String(svc['uuid']);
  const name = str(svc['name']) ?? ref;
  const issues: PlanIssue[] = [
    { level: 'manual', option: 'docker_compose', detail: 'The stack\'s compose file needs a read:sensitive token to read; paste it into a new compose service.' },
  ];
  const template = str(svc['service_type']);
  if (template) issues.push({ level: 'info', option: 'service_type', detail: `Coolify one-click template "${template}"; the NineDeploy Hub may have an equivalent.` });
  const detail = (await get(`/api/v1/services/${ref}`)) as Obj | null;
  const domains = list(detail?.['applications']).flatMap((a) => domainsFrom(str(a['fqdn'])));
  return { ref, name, kind: 'compose', create: { name, type: 'compose' }, domains, env: await envKeys(get, `/api/v1/services/${ref}/envs`), volumes: [], issues };
}

function databaseItem(db: Obj): PlanDatabase {
  const type = str(db['database_type']) ?? '';
  const engine = type in ENGINES ? ENGINES[type]! : null;
  const issues: PlanIssue[] = [];
  if (engine === null) issues.push({ level: 'unsupported', option: 'database_type', detail: type === 'standalone-sqlite' ? 'SQLite is a file inside an app, not a managed server; NineDeploy has no managed SQLite.' : `Unknown database type "${type}".` });
  else issues.push(DATA_NOT_MOVED);
  if (db['is_public'] === true) issues.push({ level: 'manual', option: 'is_public', detail: 'Public access was on; turn on public access in NineDeploy if you still need it.' });
  // Coolify names a standalone database's container after its uuid.
  return { ref: String(db['uuid']), name: str(db['name']) ?? String(db['uuid']), engine, image: str(db['image']) ?? null, runtime: { kind: 'container', name: String(db['uuid']) }, issues };
}

export async function planFromCoolify(get: SourceGet, url: string): Promise<ImportPlan> {
  const version = await get('/api/v1/version').then((v) => (typeof v === 'string' ? v.trim() : null), () => null);
  const plan = emptyPlan('coolify', url, version, 'the team the API token belongs to');
  for (const app of list(await get('/api/v1/applications'))) plan.services.push(await applicationItem(get, app));
  for (const svc of list(await get('/api/v1/services'))) plan.services.push(await serviceStackItem(get, svc));
  for (const db of list(await get('/api/v1/databases'))) plan.databases.push(databaseItem(db));
  return plan;
}
