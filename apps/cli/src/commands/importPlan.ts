/**
 * `ninedeploy import plan <coolify|dokploy|caprover> --url <source panel>`
 *
 * A1 step 1 (docs/plans/COMPETITIVE_ROADMAP_2026-11.md): read another
 * platform's API from this machine and print what NineDeploy would create,
 * what it cannot carry, and what needs a person. Nothing is created on
 * NineDeploy and nothing changes on the source. The source credential is read
 * from an environment variable or a hidden prompt, never from the command
 * line, and stays on this machine; the plan holds variable names only.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { planFromCaprover } from '../lib/importers/caprover.js';
import { planFromHeroku } from '../lib/importers/heroku.js';
import { planFromCoolify } from '../lib/importers/coolify.js';
import { planFromDokploy } from '../lib/importers/dokploy.js';
import type { ImportPlan, SourceGet, SourceKind } from '../lib/importers/plan.js';
import { caproverSource, coolifySource, dokploySource, normaliseBase, OtpRequiredError, SourceError } from '../lib/importers/sources.js';
import { c, error, header, info, success } from '../lib/format.js';
import { promptHidden } from '../prompts.js';

export const IMPORT_SOURCES: readonly SourceKind[] = ['coolify', 'dokploy', 'caprover', 'heroku'];

type PanelSource = Exclude<SourceKind, 'heroku'>;

/** Where each source's credential comes from, without the command line. Heroku is read from files and needs none. */
export const CREDENTIAL_ENV: Record<PanelSource, string> = {
  coolify: 'NINEDEPLOY_IMPORT_TOKEN',
  dokploy: 'NINEDEPLOY_IMPORT_TOKEN',
  caprover: 'NINEDEPLOY_IMPORT_PASSWORD',
};
const PROMPT: Record<PanelSource, string> = {
  coolify: 'Coolify API token (a "read" token is enough): ',
  dokploy: 'Dokploy API key: ',
  caprover: 'CapRover password: ',
};

export interface ImportPlanDeps {
  /** Heroku: the checkout to read app.json / Procfile from, the branch, and the Heroku app name. */
  heroku?: { dir?: string; branch?: string; app?: string };
  /** Reads a file of the checkout, or undefined when it does not exist (tests replace it). */
  readFile?: (file: string) => string | undefined;
  env?: NodeJS.ProcessEnv;
  ask?: (message: string) => Promise<string>;
  fetch?: typeof fetch;
}

/** Build the plan (no output). Throws SourceError with a reason a person can act on. */
export async function buildImportPlan(kind: string, url: string, deps: ImportPlanDeps = {}): Promise<ImportPlan> {
  if (!IMPORT_SOURCES.includes(kind as SourceKind)) throw new SourceError(`Unknown source "${kind}" (expected ${IMPORT_SOURCES.join(', ')}).`);
  const source = kind as SourceKind;
  if (source === 'heroku') {
    // The repository URL stays whole (normaliseBase would cut its path).
    const dir = path.resolve(deps.heroku?.dir ?? '.');
    const read = deps.readFile ?? ((f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : undefined));
    try {
      return planFromHeroku(
        { appJson: read(path.join(dir, 'app.json')), procfile: read(path.join(dir, 'Procfile')), herokuYml: read(path.join(dir, 'heroku.yml')) !== undefined },
        { repoUrl: url.trim(), branch: deps.heroku?.branch ?? 'main', app: deps.heroku?.app, dirName: path.basename(dir) },
      );
    } catch (err) {
      throw new SourceError(err instanceof Error ? err.message : String(err));
    }
  }
  const env = deps.env ?? process.env;
  const ask = deps.ask ?? promptHidden;
  const base = normaliseBase(url);
  const credential = env[CREDENTIAL_ENV[source]]?.trim() || (await ask(PROMPT[source])).trim();
  if (!credential) throw new SourceError(`No credential: set ${CREDENTIAL_ENV[source]} or type it at the prompt.`);
  let get: SourceGet;
  if (source === 'coolify') get = coolifySource(base, credential, deps.fetch);
  else if (source === 'dokploy') get = dokploySource(base, credential, deps.fetch);
  else {
    const otpEnv = env['NINEDEPLOY_IMPORT_OTP']?.trim();
    try {
      get = await caproverSource(base, credential, otpEnv || undefined, deps.fetch);
    } catch (err) {
      if (!(err instanceof OtpRequiredError) || otpEnv) throw err;
      const otp = (await ask('CapRover two-factor code: ')).trim();
      get = await caproverSource(base, credential, otp, deps.fetch);
    }
  }
  if (source === 'coolify') return planFromCoolify(get, base);
  if (source === 'dokploy') return planFromDokploy(get, base);
  return planFromCaprover(get, base);
}

/** The plan as text a person reads: per item, what would be created and what needs them. */
export function renderImportPlan(plan: ImportPlan): string {
  const lines: string[] = [];
  const s = plan.source;
  lines.push(`Source: ${s.kind}${s.version ? ` ${s.version}` : ''} at ${s.url}`);
  lines.push(`Scope: ${s.scope}`);
  lines.push('');
  lines.push(`Services (${plan.services.length})`);
  for (const svc of plan.services) {
    const what = svc.kind === 'image' ? `image ${svc.create.image ?? '(unknown)'}` : svc.kind === 'git' ? `git ${svc.create.repoUrl ?? '(no repository)'}${svc.create.branch ? `@${svc.create.branch}` : ''}` : 'compose stack';
    lines.push(`  • ${svc.name}: ${what}${svc.create.port ? `, port ${svc.create.port}` : ''}`);
    if (svc.domains.length) lines.push(`      domains: ${svc.domains.map((d) => `${d.https ? 'https' : 'http'}://${d.host}${d.sourceDefault ? " (the source's own host; stays)" : ''}`).join(', ')}`);
    if (svc.env.length) lines.push(`      env: ${svc.env.length} variable(s): ${svc.env.map((e) => e.key).join(', ')} (names only)`);
    if (svc.volumes.length) lines.push(`      volumes: ${svc.volumes.map((v) => v.mountPath).join(', ')}`);
    if (svc.create.build?.startCmd) lines.push(`      start: ${svc.create.build.startCmd}`);
    if (svc.create.build?.preDeployCmd) lines.push(`      before each deploy: ${svc.create.build.preDeployCmd}`);
    if (svc.settings?.healthCheck) lines.push(`      health check: ${svc.settings.healthCheck}`);
    if (svc.attachments?.length) lines.push(`      attaches: ${svc.attachments.map((a) => `${a.database} as ${a.envAlias}`).join(', ')}`);
    for (const i of svc.issues) lines.push(`      ${i.level === 'unsupported' ? '✗' : i.level === 'manual' ? '!' : '·'} ${i.option}: ${i.detail}`);
  }
  lines.push('');
  lines.push(`Databases (${plan.databases.length})`);
  for (const db of plan.databases) {
    lines.push(`  • ${db.name}: ${db.engine ?? 'no managed equivalent'}${db.image ? ` (${db.image})` : ''}`);
    for (const i of db.issues) lines.push(`      ${i.level === 'unsupported' ? '✗' : i.level === 'manual' ? '!' : '·'} ${i.option}: ${i.detail}`);
  }
  lines.push('');
  for (const n of plan.notes) lines.push(`Note: ${n}`);
  return lines.join('\n');
}

export async function importPlanAction(
  kind: string,
  opts: { url: string; json?: boolean; out?: string; dir?: string; branch?: string; app?: string },
  deps: ImportPlanDeps = {},
): Promise<void> {
  let plan: ImportPlan;
  try {
    plan = await buildImportPlan(kind, opts.url, { ...deps, heroku: { dir: opts.dir, branch: opts.branch, app: opts.app } });
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  const json = `${JSON.stringify(plan, null, 2)}\n`;
  if (opts.out) {
    writeFileSync(opts.out, json);
    success(`Plan written to ${opts.out}`);
  }
  if (opts.json) {
    process.stdout.write(json);
    return;
  }
  header(`Import plan: ${plan.services.length} service(s), ${plan.databases.length} database(s)`);
  console.log(renderImportPlan(plan));
  info(`${c.dim('Nothing was created or changed.')} Save it with --out plan.json, then preview step 2 with \`ninedeploy import apply plan.json\`.`);
}
