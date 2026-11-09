/**
 * CapRover (field names checked against v1.16.0, 74a61ff2): one call,
 * `GET /api/v2/user/apps/appDefinitions/`, returns every app. The fetcher
 * signs in, sends `x-captain-auth`, and unwraps CapRover's `{status, data}`
 * envelope (errors arrive with HTTP 200 and a non-100 status).
 *
 * CapRover returns secrets in plain text in that list: env values, the git
 * password and SSH key, webhook and deploy tokens, the HTTP-auth hash. The
 * adapter copies none of them into the plan.
 */
import {
  DATA_NOT_MOVED, emptyPlan, firstVolumeMount, planDomain, replicasFor, stripUserinfo,
  type ImportPlan, type PlanDatabase, type PlanEngine, type PlanIssue, type PlanService, type SourceGet,
} from './plan.js';

type Obj = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);

/** One-click database apps carry the template name as a tag (OneClickAppDeploymentHelper). */
const ONE_CLICK_DATABASES: Record<string, PlanEngine> = {
  postgres: 'postgres', mysql: 'mysql', mariadb: 'mariadb', mongodb: 'mongo', redis: 'redis', keydb: 'keydb', dragonfly: 'dragonfly', clickhouse: 'clickhouse',
};

/** The image CapRover runs for the deployed version, if it is not one it built itself. */
function deployedImage(app: Obj): { image?: string; builtByCaprover: boolean; neverDeployed?: boolean } {
  const deployed = Number(app['deployedVersion']);
  const version = list(app['versions']).find((v) => Number(v['version']) === deployed);
  const image = str(version?.['deployedImageName']);
  if (!image) return { builtByCaprover: true };
  // A registered app runs CapRover's placeholder until its first deploy (checked live on v1.16.0).
  if (/^caprover\/caprover-placeholder-app(:|$)/.test(image)) return { builtByCaprover: false, neverDeployed: true };
  // Images CapRover builds are tagged img-captain-<app>, optionally in its own registry.
  if (/(^|\/)img-captain-/.test(image)) return { builtByCaprover: true };
  return { image, builtByCaprover: false };
}

function appItem(app: Obj, rootDomain: string): PlanService | null {
  const name = String(app['appName']);
  const issues: PlanIssue[] = [];
  const repoInfo = (app['appPushWebhook'] as Obj | undefined)?.['repoInfo'] as Obj | undefined;
  const repo = str(repoInfo?.['repo']);
  const { image, builtByCaprover, neverDeployed } = deployedImage(app);
  const base = { name, type: 'docker' as const };
  let kind: PlanService['kind'];
  let create: PlanService['create'];
  if (repo) {
    kind = 'git';
    create = { ...base, repoUrl: stripUserinfo(repo), branch: str(repoInfo?.['branch']), build: { buildPack: 'auto' } };
    const def = str(app['captainDefinitionRelativeFilePath']);
    issues.push({ level: 'info', option: 'captain-definition', detail: `Built from ${def ?? './captain-definition'}; NineDeploy detects the build (a Dockerfile it references keeps working with Build pack: Dockerfile).` });
    if (str(repoInfo?.['user']) || str(repoInfo?.['sshKey']) || str(repoInfo?.['password'])) {
      issues.push({ level: 'manual', option: 'repoInfo', detail: 'Repository credentials do not transfer: reconnect the repository in NineDeploy.' });
    }
  } else if (image && !builtByCaprover) {
    kind = 'image';
    create = { ...base, image };
  } else if (neverDeployed) {
    kind = 'image';
    create = base;
    issues.push({ level: 'manual', option: 'deployedVersion', detail: 'Never deployed in CapRover (it still runs the placeholder app): set an image or a repository for it in NineDeploy.' });
  } else {
    kind = 'image';
    create = base;
    issues.push({ level: 'unsupported', option: 'deployedImageName', detail: 'Built by CapRover from an upload or the CLI, with no repository on record: its image lives in CapRover. Push the source to a repository, or the image to a registry, then import.' });
  }

  const port = Number(app['containerHttpPort']);
  if (Number.isInteger(port) && port > 0) create.port = port;
  const replicas = replicasFor(app['instanceCount'], issues);
  if (replicas) create.replicas = replicas;
  if (app['instanceCount'] === 0) issues.push({ level: 'info', option: 'instanceCount', detail: 'Stopped in CapRover (0 instances); NineDeploy runs one when it deploys the service.' });

  const domains: PlanService['domains'] = [];
  if (app['notExposeAsWebApp'] !== true) {
    domains.push(planDomain(`${name}.${rootDomain}`, app['hasDefaultSubDomainSsl'] === true, true));
    issues.push({ level: 'info', option: 'default subdomain', detail: `${name}.${rootDomain} is CapRover's own subdomain; it moves only if that DNS points at NineDeploy.` });
  }
  for (const d of list(app['customDomain'])) {
    const host = str(d['publicDomain']);
    if (host) domains.push(planDomain(host, d['hasSsl'] === true));
  }

  const volumes: PlanService['volumes'] = list(app['volumes'])
    .map((v) => ({ mountPath: str(v['containerPath']) ?? '', source: (str(v['hostPath']) ? 'bind' : 'volume') as 'bind' | 'volume', name: str(v['volumeName']) }))
    .filter((v) => v.mountPath);
  const mount = firstVolumeMount(volumes, issues);
  if (mount) create.volumeMount = mount;

  const ports = list(app['ports']);
  if (ports.length) issues.push({ level: 'manual', option: 'ports', detail: `${ports.length} host port mapping(s) (${ports.map((p) => `${p['hostPort']}:${p['containerPort']}`).join(', ')}); set Public Host Port or port mappings by hand.` });
  if (app['httpAuth']) issues.push({ level: 'manual', option: 'httpAuth', detail: 'HTTP basic auth was on; protect the service with forward auth in NineDeploy (the password hash is not carried).' });
  if (str(app['customNginxConfig'])) issues.push({ level: 'unsupported', option: 'customNginxConfig', detail: 'A custom nginx config has no equivalent; NineDeploy routes with Traefik (redirects, headers and middlewares are set per domain).' });
  if (str(app['preDeployFunction'])) issues.push({ level: 'unsupported', option: 'preDeployFunction', detail: 'CapRover pre-deploy scripts have no equivalent.' });
  if (str(app['serviceUpdateOverride'])) issues.push({ level: 'unsupported', option: 'serviceUpdateOverride', detail: 'Swarm service overrides are not carried.' });
  if (str(app['nodeId'])) issues.push({ level: 'manual', option: 'nodeId', detail: 'Pinned to a CapRover node; choose a NineDeploy server for it.' });

  return {
    ref: name, name, kind, create, domains,
    env: list(app['envVars']).map((e) => str(e['key'])).filter((k): k is string => !!k).map((key) => ({ key })),
    volumes, issues,
  };
}

/** A one-click database app is listed as a database, not as a service. */
function databaseOf(app: Obj): PlanDatabase | null {
  for (const t of list(app['tags'])) {
    const engine = ONE_CLICK_DATABASES[String(t['tagName'] ?? '').toLowerCase()];
    if (!engine) continue;
    const { image, neverDeployed } = deployedImage(app);
    const issues: PlanIssue[] = [DATA_NOT_MOVED];
    if (neverDeployed) issues.push({ level: 'info', option: 'deployedVersion', detail: 'Never deployed in CapRover, so the source has no engine version: choose one in NineDeploy.' });
    if (list(app['ports']).length) issues.push({ level: 'manual', option: 'ports', detail: 'A host port was published; turn on public access in NineDeploy if you still need it.' });
    return { ref: String(app['appName']), name: String(app['appName']), engine, image: image ?? null, issues };
  }
  return null;
}

export async function planFromCaprover(get: SourceGet, url: string): Promise<ImportPlan> {
  const data = ((await get('/api/v2/user/apps/appDefinitions/')) ?? {}) as Obj;
  const info = (await get('/api/v2/user/system/info/').catch(() => null)) as Obj | null;
  const rootDomain = str(info?.['rootDomain']) ?? str(data['rootDomain']) ?? 'captain.localhost';
  const versionInfo = (await get('/api/v2/user/system/versionInfo/').catch(() => null)) as Obj | null;
  const plan = emptyPlan('caprover', url, str(versionInfo?.['currentVersion']) ?? null, 'every app on this CapRover instance');
  for (const app of list(data['appDefinitions'])) {
    if (!str(app['appName'])) continue;
    const db = databaseOf(app);
    if (db) plan.databases.push(db);
    else {
      const item = appItem(app, rootDomain);
      if (item) plan.services.push(item);
    }
  }
  return plan;
}
