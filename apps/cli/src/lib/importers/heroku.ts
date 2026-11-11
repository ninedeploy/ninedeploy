/**
 * A1: an import plan from a Heroku app's own files: `app.json` and the
 * `Procfile` in a checkout of its repository. No Heroku API and no
 * credential: the mapping follows Heroku's documented formats
 * (devcenter: app-json-schema, procfile).
 *
 * - Every Procfile process except `release` becomes a service built from the
 *   repository with Nixpacks, whose start command is that process's line.
 *   Nixpacks is the build pack that honours a per-service start command, runs
 *   it through a shell (so `$PORT` expands) and sets PORT to the service port
 *   (checked live on a NineDeploy panel; the heroku/paketo buildpacks and
 *   Dockerfile builds ignore the start command).
 * - A process other than `web` gets the `running` health check (it answers
 *   no HTTP), no port routing and no domain.
 * - `release` is not mapped to NineDeploy's pre-deploy hook, which runs in
 *   the panel's own container before the build, without a shell (checked
 *   live). Nixpacks itself runs the Procfile's release line as a build step
 *   of every service built from the repository, with the attached
 *   DATABASE_URL (checked live), so it is flagged with what that means.
 * - Nixpacks reads the Procfile itself, as YAML: a line with `: ` inside its
 *   command fails the build (checked live), so such lines are flagged.
 * - `heroku-postgresql` and `heroku-redis` add-ons become databases attached
 *   to every service under DATABASE_URL / REDIS_URL, as Heroku sets them.
 * - Config var names come from app.json `env`; values only ever come from a
 *   .env file at apply time (`heroku config --shell`).
 */
import { type ImportPlan, type PlanDatabase, type PlanEngine, type PlanIssue, type PlanService, emptyPlan } from './plan.js';
import { isPlainName } from './shell.js';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export interface HerokuFiles {
  /** app.json content, if the repository has one. */
  appJson?: string;
  /** Procfile content, if the repository has one. */
  procfile?: string;
  /** The repository has a heroku.yml (container builds). */
  herokuYml?: boolean;
}
export interface HerokuOptions {
  repoUrl: string;
  branch: string;
  /** The Heroku app name, for the pg:backups command (optional). */
  app?: string;
  /** Fallback service name (the checkout's directory name). */
  dirName: string;
}

/** Procfile process types in file order: `<type>: <command>` lines. */
export function parseProcfile(content: string): Array<{ type: string; command: string }> {
  const out: Array<{ type: string; command: string }> = [];
  for (const line of content.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.+?)\s*$/.exec(line);
    if (m && !out.some((p) => p.type === m[1])) out.push({ type: m[1]!, command: m[2]! });
  }
  return out;
}

/** Add-ons NineDeploy runs itself, and the variable Heroku sets for each. */
const ADDONS: Record<string, { engine: PlanEngine; env: string }> = {
  'heroku-postgresql': { engine: 'postgres', env: 'DATABASE_URL' },
  'heroku-redis': { engine: 'redis', env: 'REDIS_URL' },
};

const slugName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'app';

export function planFromHeroku(files: HerokuFiles, opts: HerokuOptions): ImportPlan {
  if (files.appJson === undefined && files.procfile === undefined) {
    throw new Error('Neither app.json nor a Procfile was found: point --dir at a checkout of the Heroku app\'s repository.');
  }
  let app: Obj = {};
  if (files.appJson !== undefined) {
    try {
      app = obj(JSON.parse(files.appJson));
    } catch {
      throw new Error('app.json is not valid JSON.');
    }
  }
  const base = slugName(str(app['name']) ?? opts.dirName);
  const herokuApp = opts.app && isPlainName(opts.app) ? opts.app : undefined;
  const plan = emptyPlan('heroku', opts.repoUrl, null, `the app.json and Procfile of ${opts.repoUrl}@${opts.branch}`);
  plan.notes.push('Heroku mapping: it follows Heroku\'s documented app.json and Procfile formats; no Heroku API is read.');

  // Add-ons → databases.
  const shared: PlanIssue[] = [];
  const attachments: Array<{ database: string; envAlias: string }> = [];
  for (const raw of Array.isArray(app['addons']) ? app['addons'] : []) {
    const plan_ = typeof raw === 'string' ? raw : str(obj(raw)['plan']);
    if (!plan_) continue;
    const service = plan_.split(':')[0]!;
    const known = ADDONS[service];
    if (!known) {
      shared.push({ level: 'unsupported', option: 'addon', detail: `${plan_} has no NineDeploy equivalent; run it elsewhere and set its variables by hand.` });
      continue;
    }
    if (plan.databases.some((d) => d.engine === known.engine)) continue;
    const ref = `${base}-${known.engine}`;
    const issues: PlanIssue[] = [
      { level: 'manual', option: 'data', detail: 'Data is not moved by this step: create the database, then restore a dump into it (step 3).' },
    ];
    if (known.engine === 'postgres') {
      issues.push({ level: 'manual', option: 'ssl', detail: 'Heroku Postgres requires SSL, so apps often force it in code (sslmode=require, ssl_require=True). The NineDeploy database is reached over the internal Docker network, which has no TLS: drop that requirement for this connection.' });
    }
    const db: PlanDatabase = { ref, name: ref, engine: known.engine, image: null, issues };
    if (herokuApp) db.runtime = { kind: 'heroku-app', name: herokuApp };
    plan.databases.push(db);
    attachments.push({ database: ref, envAlias: known.env });
  }
  if (plan.databases.length && !herokuApp) {
    shared.push({ level: 'info', option: 'app', detail: 'Pass --app <heroku app name> to get a ready pg:backups command in import data.' });
  }

  // Config vars → names.
  const env: PlanService['env'] = [];
  for (const [key, v] of Object.entries(obj(app['env']))) {
    if (attachments.some((a) => a.envAlias === key)) continue;
    env.push({ key });
    if (obj(v)['generator'] === 'secret') shared.push({ level: 'manual', option: 'env', detail: `${key} is generated on Heroku (generator: secret): put its current value in the .env file, or a new random one.` });
  }

  // Build notes.
  const buildpacks = Array.isArray(app['buildpacks']) ? app['buildpacks'].map((b) => str(obj(b)['url']) ?? '').filter(Boolean) : [];
  if (buildpacks.length) {
    shared.push({ level: 'info', option: 'buildpacks', detail: `Built with Nixpacks, which detects the language itself; ${buildpacks.join(', ')} ${buildpacks.length === 1 ? 'is' : 'are'} not used. Add a nixpacks.toml if detection differs.` });
  }
  if (files.herokuYml) shared.push({ level: 'manual', option: 'heroku.yml', detail: 'heroku.yml builds a container: set the build pack to Dockerfile and its path under Service → Settings.' });
  if (str(obj(app['scripts'])['postdeploy'])) {
    shared.push({ level: 'manual', option: 'postdeploy', detail: 'scripts.postdeploy runs once on Heroku after the app is created: run it by hand after the first deploy (it is not a per-deploy hook).' });
  }

  const formation = obj(app['formation']);
  const procs = files.procfile !== undefined ? parseProcfile(files.procfile) : [];
  const release = procs.find((p) => p.type === 'release');
  const runnable = procs.filter((p) => p.type !== 'release');
  if (runnable.length === 0) runnable.push({ type: 'web', command: '' });
  for (const p of runnable) {
    const isWeb = p.type === 'web';
    const name = isWeb ? base : `${base}-${slugName(p.type)}`;
    const issues: PlanIssue[] = [...shared];
    const create: PlanService['create'] = {
      name, type: 'docker', repoUrl: opts.repoUrl, branch: opts.branch,
      build: { buildPack: 'nixpacks', ...(p.command ? { startCmd: p.command } : {}) },
    };
    if (isWeb) {
      create.port = 5000;
      issues.push({ level: 'info', option: 'PORT', detail: 'NineDeploy sets PORT to the service port (5000) for a Nixpacks build, as Heroku sets $PORT.' });
      if (release) {
        issues.push({ level: 'manual', option: 'release', detail: `Nixpacks runs the Procfile's release line ("${release.command}") as a build step of every service built from this repository, with the attached DATABASE_URL, so it runs before each deploy of each of them, not once. Make sure that is safe (a migration usually is), or take it out of the Procfile and run it by hand. A $VARIABLE in it is written, with its value, into the build log and the image.` });
      }
    }
    if (!p.command) issues.push({ level: 'info', option: 'Procfile', detail: 'No Procfile: Nixpacks picks the start command.' });
    if (/: /.test(p.command)) issues.push({ level: 'manual', option: 'Procfile', detail: 'Nixpacks reads the Procfile as YAML, and ": " inside this command breaks it: quote the command in the Procfile, or the build fails.' });
    const q = Number(obj(formation[p.type])['quantity']);
    if (Number.isInteger(q) && q > 1) create.replicas = Math.min(q, 10);
    if (Number.isInteger(q) && q > 10) issues.push({ level: 'manual', option: 'formation', detail: `${q} dynos; NineDeploy runs at most 10 replicas of a service.` });
    if (Number.isInteger(q) && q === 0) issues.push({ level: 'info', option: 'formation', detail: 'Scaled to 0 on Heroku; NineDeploy runs one when it deploys the service.' });
    const size = str(obj(formation[p.type])['size']);
    if (size) issues.push({ level: 'info', option: 'size', detail: `Dyno size ${size}: set a memory limit under Service → Settings if you need one.` });
    const svc: PlanService = { ref: p.type, name, kind: 'git', create, domains: [], env: [...env], volumes: [], issues };
    if (!isWeb) svc.settings = { healthCheck: 'running' };
    if (attachments.length) svc.attachments = attachments.map((a) => ({ ...a }));
    plan.services.push(svc);
  }
  plan.notes.push('Domains are not in app.json: add them with import cutover after editing the plan, or under Service → Domains.');
  return plan;
}
