/**
 * `ninedeploy import apply <plan.json>`
 *
 * A1 step 2 (docs/plans/COMPETITIVE_ROADMAP_2026-11.md): create what a saved
 * import plan describes, on the panel this CLI is signed in to. It reads the
 * plan file, never the source, so it needs no source credential.
 *
 * - It creates each service that has something to deploy from (an image or a
 *   repository), and each database that has a NineDeploy engine, empty.
 * - It never deploys and never adds a domain. Adding a domain writes the proxy
 *   config, so a certificate would be requested while DNS still points at
 *   the source; with the Cloudflare integration on, a DNS record would be
 *   written too. Domains move at the cutover (step 3).
 * - A value in such a file that still names a source database (a copied
 *   connection string) gets the new database attached under that variable
 *   when the panel's string replaces it exactly; the rest are listed for a
 *   person (lib/importers/connections.ts).
 * - Environment values come only from a file the person passes
 *   (--dotenv <service>=<path>), through the panel's .env import. The plan
 *   holds names only, so a variable without a value is reported, not created
 *   empty. The flag is not called --env-file: Node (checked on v26.13) reads
 *   --env-file from anywhere in argv, even after the script name, and exits
 *   before the CLI starts.
 * - A receipt is kept next to the plan. Each item is written as pending
 *   before its create call and as done after it, so a run that stops can be
 *   repeated. Creates are sent with reuseExisting, which hands back the
 *   caller's own idle service or database of the same definition instead of
 *   failing on the name. Done items are never sent again.
 *
 * The receipt holds ids, states and notes, never a value.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { getClient, type NineDeployClient } from '../client.js';
import { loadConfig } from '../config.js';
import { c, error, header, info, success } from '../lib/format.js';
import { findConnections } from '../lib/importers/connections.js';
import type { ImportPlan, PlanEngine, PlanIssue, PlanService } from '../lib/importers/plan.js';

type CreateServiceInput = Parameters<NineDeployClient['services']['create']>[0];
type CreateDatabaseInput = Parameters<NineDeployClient['databases']['create']>[0];

/** The panel calls apply makes; NineDeployClient satisfies it. */
export interface ApplyClient {
  services: { create: (input: CreateServiceInput) => Promise<{ id: number }> };
  databases: { create: (input: CreateDatabaseInput) => Promise<{ id: number }> };
  env: { import: (serviceId: number, content: string) => Promise<{ imported: number; skipped: number; errors: Array<{ line: number; message: string }> }> };
  attachments: {
    list: (serviceId: number) => Promise<Array<{ id: number; databaseId: number; envAlias: string }>>;
    create: (serviceId: number, input: { databaseId: number; envAlias?: string; reuseExisting?: boolean }) => Promise<{ id: number; databaseId: number; envAlias: string }>;
  };
}

export type ReceiptState = 'pending' | 'done' | 'skipped' | 'failed';
export interface ReceiptItem {
  kind: 'service' | 'database' | 'env' | 'data' | 'domain' | 'attach';
  ref: string;
  name: string;
  state: ReceiptState;
  /** The NineDeploy id (the service's for an env item, the database's for a data item, the domain's for a domain item). */
  id?: number;
  /** Data items (`import data`): the panel's import id, and the dump's sha256 and size. */
  importId?: number;
  sha256?: string;
  bytes?: number;
  at: string;
  notes: string[];
}
export interface ImportReceipt {
  receiptVersion: 1;
  panel: string;
  source: { kind: string; url: string };
  items: Record<string, ReceiptItem>;
}

export interface ApplyOptions {
  /** Tag every created service and database with this project. */
  project?: number;
  /** Service name → .env file content. */
  envFiles?: Record<string, string>;
}
export interface ApplyDeps {
  client: ApplyClient;
  panel: string;
  receipt: ImportReceipt | null;
  save: (receipt: ImportReceipt) => void;
  now?: () => Date;
}

/** Accept only a plan this CLI wrote (planVersion 1) with the parts apply reads. */
export function validatePlan(raw: unknown): ImportPlan {
  const p = raw as Partial<ImportPlan> | null;
  if (!p || typeof p !== 'object' || p.planVersion !== 1) {
    throw new Error('Not an import plan this CLI can apply (planVersion 1). Make one with `ninedeploy import plan <source> --url … --out plan.json`.');
  }
  if (!p.source || typeof p.source.url !== 'string' || !Array.isArray(p.services) || !Array.isArray(p.databases)) {
    throw new Error('The plan file is incomplete: it needs source, services and databases.');
  }
  for (const s of p.services) {
    if (!s || typeof s.ref !== 'string' || typeof s.name !== 'string' || !s.create || typeof s.create !== 'object' || !Array.isArray(s.env) || !Array.isArray(s.domains) || !Array.isArray(s.issues)) {
      throw new Error('A service in the plan is incomplete (ref, name, create, env, domains and issues are required).');
    }
  }
  for (const d of p.databases) {
    if (!d || typeof d.ref !== 'string' || typeof d.name !== 'string' || !Array.isArray(d.issues)) {
      throw new Error('A database in the plan is incomplete (ref, name and issues are required).');
    }
  }
  return p as ImportPlan;
}

/** The image repository NineDeploy runs for each engine (engine/database.ts). */
const ENGINE_REPOS: Record<PlanEngine, string> = {
  postgres: 'postgres', mysql: 'mysql', mariadb: 'mariadb', mongo: 'mongo', redis: 'redis',
  keydb: 'eqalpha/keydb', dragonfly: 'ghcr.io/dragonflydb/dragonfly', clickhouse: 'clickhouse/clickhouse-server',
};

/**
 * The source's version, when its image is the same repository NineDeploy runs
 * and the tag is a version (starts with a digit). Otherwise undefined, and
 * the panel picks its default.
 */
export function databaseVersion(engine: PlanEngine, image: string | null): string | undefined {
  if (!image) return undefined;
  const ref = image.split('@')[0]!;
  const colon = ref.lastIndexOf(':');
  if (colon < 0 || ref.slice(colon).includes('/')) return undefined;
  const repo = ref.slice(0, colon).replace(/^docker\.io\//, '').replace(/^library\//, '');
  const tag = ref.slice(colon + 1);
  if (repo !== ENGINE_REPOS[engine] || !/^[0-9][A-Za-z0-9_.-]*$/.test(tag)) return undefined;
  return tag;
}

/** Variable names a .env file defines (values are never looked at). */
export function envFileKeys(content: string): string[] {
  const keys: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const m = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/.exec(line);
    if (m) keys.push(m[1]!);
  }
  return keys;
}

const hasSource = (s: PlanService): boolean => Boolean(s.create.image || s.create.repoUrl);
const issueNotes = (issues: PlanIssue[], skip: string[] = []): string[] =>
  issues.filter((i) => i.level !== 'info' && !skip.includes(i.option)).map((i) => `${i.level === 'unsupported' ? 'Not carried' : 'To do'}: ${i.detail}`);
/** Which domains move at the cutover, and which stay with the source (its own generated hosts). */
function domainNotes(s: PlanService): string[] {
  const moving = s.domains.filter((d) => !d.sourceDefault).map((d) => d.host);
  const staying = s.domains.filter((d) => d.sourceDefault).map((d) => d.host);
  return [
    ...(moving.length ? [`Domains wait for the cutover (step 3): ${moving.join(', ')}.`] : []),
    ...(staying.length ? [`The source's own host stays with it: ${staying.join(', ')}.`] : []),
  ];
}
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Create what the plan describes, recording every step in the receipt. */
export async function applyPlan(plan: ImportPlan, opts: ApplyOptions, deps: ApplyDeps): Promise<ImportReceipt> {
  const now = deps.now ?? (() => new Date());
  const receipt: ImportReceipt = deps.receipt ?? { receiptVersion: 1, panel: deps.panel, source: { kind: plan.source.kind, url: plan.source.url }, items: {} };
  if (receipt.receiptVersion !== 1 || !receipt.items || typeof receipt.items !== 'object') throw new Error('The receipt file is not one this CLI wrote (receiptVersion 1).');
  if (receipt.panel !== deps.panel) {
    throw new Error(`The receipt is for ${receipt.panel}, but the CLI is signed in to ${deps.panel}. Sign in to that panel, or pass another --receipt for this one.`);
  }
  if (receipt.source.kind !== plan.source.kind || receipt.source.url !== plan.source.url) {
    throw new Error(`The receipt is for a plan of ${receipt.source.kind} at ${receipt.source.url}, not ${plan.source.kind} at ${plan.source.url}. Pass another --receipt.`);
  }
  const envFiles = opts.envFiles ?? {};
  const unknown = Object.keys(envFiles).filter((name) => !plan.services.some((s) => s.name === name));
  if (unknown.length) throw new Error(`--dotenv names no service in the plan: ${unknown.join(', ')}.`);

  const put = (key: string, item: Omit<ReceiptItem, 'at'>): void => {
    receipt.items[key] = { ...item, at: now().toISOString() };
    deps.save(receipt);
  };

  for (const s of plan.services) {
    const key = `service:${s.ref}`;
    const base = { kind: 'service' as const, ref: s.ref, name: s.name };
    if (receipt.items[key]?.state !== 'done') {
      const notes = issueNotes(s.issues);
      if (!hasSource(s)) {
        put(key, { ...base, state: 'skipped', notes: ['Nothing to create it from: the plan has no image and no repository for it.', ...notes] });
        continue;
      }
      put(key, { ...base, state: 'pending', notes: [] });
      // Only the panel call is caught: a receipt that cannot be written stops the run.
      let created: { id: number };
      try {
        created = await deps.client.services.create({ ...s.create, reuseExisting: true, ...(opts.project ? { tagProjectIds: [opts.project] } : {}) } as CreateServiceInput);
      } catch (err) {
        put(key, { ...base, state: 'failed', notes: [message(err)] });
        continue;
      }
      const domains = domainNotes(s);
      put(key, { ...base, state: 'done', id: created.id, notes: ['Created, not deployed.', ...domains, ...notes] });
    }
    const serviceId = receipt.items[key]!.id!;

    const envKey = `env:${s.ref}`;
    const file = envFiles[s.name];
    if (receipt.items[envKey]?.state === 'done' || (s.env.length === 0 && file === undefined)) continue;
    const envBase = { kind: 'env' as const, ref: s.ref, name: s.name, id: serviceId };
    if (file === undefined) {
      put(envKey, { ...envBase, state: 'skipped', notes: [`${s.env.length} variable(s) need a value: ${s.env.map((e) => e.key).join(', ')}. Pass --dotenv ${s.name}=<path>.`] });
      continue;
    }
    put(envKey, { ...envBase, state: 'pending', notes: [] });
    let result: Awaited<ReturnType<ApplyClient['env']['import']>>;
    try {
      result = await deps.client.env.import(serviceId, file);
    } catch (err) {
      put(envKey, { ...envBase, state: 'failed', notes: [message(err)] });
      continue;
    }
    {
      const defined = new Set(envFileKeys(file));
      const missing = s.env.map((e) => e.key).filter((k) => !defined.has(k));
      const notes = [`${result.imported} imported, ${result.skipped} skipped.`];
      // Line numbers only: the panel's message could quote the line.
      if (result.errors.length) notes.push(`The panel refused line(s) ${result.errors.map((e) => e.line).join(', ')} of the file.`);
      if (missing.length) notes.push(`In the plan but not in the file: ${missing.join(', ')}.`);
      put(envKey, { ...envBase, state: result.errors.length ? 'failed' : 'done', notes });
    }
  }

  for (const d of plan.databases) {
    const key = `database:${d.ref}`;
    if (receipt.items[key]?.state === 'done') continue;
    const base = { kind: 'database' as const, ref: d.ref, name: d.name };
    if (!d.engine) {
      put(key, { ...base, state: 'skipped', notes: ['NineDeploy has no managed equivalent.', ...issueNotes(d.issues, ['data'])] });
      continue;
    }
    const version = databaseVersion(d.engine, d.image);
    put(key, { ...base, state: 'pending', notes: [] });
    let created: { id: number };
    try {
      created = await deps.client.databases.create({
        name: d.name, engine: d.engine, reuseExisting: true,
        ...(version ? { version } : {}),
        ...(opts.project ? { projectId: opts.project } : {}),
      });
    } catch (err) {
      put(key, { ...base, state: 'failed', notes: [message(err)] });
      continue;
    }
    {
      const versionNote = version
        ? `Version ${version}, as in the source.`
        : `NineDeploy's default ${d.engine} version${d.image ? ` (the source runs ${d.image}; check they are compatible before restoring)` : ''}.`;
      put(key, { ...base, state: 'done', id: created.id, notes: ['Created empty: the data moves in step 3.', versionNote, ...issueNotes(d.issues, ['data'])] });
    }
  }

  // Connection strings in the .env files that still name the source's
  // databases: attach the new database under that variable when the panel's
  // string replaces it exactly, otherwise say what to change by hand.
  for (const s of plan.services) {
    const file = envFiles[s.name];
    const svc = receipt.items[`service:${s.ref}`];
    if (file === undefined || svc?.state !== 'done' || svc.id === undefined) continue;
    let current: Array<{ id: number; databaseId: number; envAlias: string }> | null = null;
    for (const h of findConnections(plan, file)) {
      const key = `attach:${s.ref}:${h.key}`;
      if (receipt.items[key]?.state === 'done') continue;
      const base = { kind: 'attach' as const, ref: `${s.ref}:${h.key}`, name: `${h.key} of ${s.name}` };
      const what = h.database ? `the source's database ${h.database.name}` : 'the old platform';
      if (h.action === 'manual') {
        put(key, { ...base, state: 'skipped', notes: [`${h.key} names ${what} (${h.host}): ${h.reason}.`] });
        continue;
      }
      const db = h.database!;
      const made = receipt.items[`database:${db.ref}`];
      if (made?.state !== 'done' || made.id === undefined) {
        put(key, { ...base, state: 'skipped', notes: [`${h.key} names ${what} (${h.host}), which is not created here yet; run again once it is.`] });
        continue;
      }
      try {
        current ??= await deps.client.attachments.list(svc.id);
      } catch (err) {
        put(key, { ...base, state: 'failed', notes: [message(err)] });
        continue;
      }
      const same = current.find((a) => a.envAlias === h.key);
      if (same && same.databaseId !== made.id) {
        put(key, { ...base, state: 'failed', notes: [`${h.key} is already set by another attached database (#${same.databaseId}); detach it, or edit the variable by hand.`] });
        continue;
      }
      // The panel attaches a database to a service once, under one variable
      // (reuseExisting hands back that one whatever its alias), so a second
      // variable naming the same database (DATABASE_URL and DIRECT_URL) is
      // left to a person rather than recorded as attached.
      const onlyOne = (alias: string) =>
        put(key, { ...base, state: 'skipped', notes: [`${h.key} names the source's database ${db.name} (${h.host}), but ${db.name} is already attached as ${alias}, and the panel gives a database one variable per service. Set ${h.key} by hand (Databases → ${db.name} → Connection).`] });
      const other = same ? undefined : current.find((a) => a.databaseId === made.id);
      if (other) {
        onlyOne(other.envAlias);
        continue;
      }
      let id: number;
      if (same) id = same.id;
      else {
        put(key, { ...base, state: 'pending', notes: [] });
        let got: { id: number; databaseId: number; envAlias: string };
        try {
          got = await deps.client.attachments.create(svc.id, { databaseId: made.id, envAlias: h.key, reuseExisting: true });
        } catch (err) {
          put(key, { ...base, state: 'failed', notes: [message(err)] });
          continue;
        }
        if (got.envAlias !== h.key) {
          onlyOne(got.envAlias);
          continue;
        }
        current.push(got);
        id = got.id;
      }
      put(key, {
        ...base, state: 'done', id,
        notes: [`Attached ${db.name} as ${h.key} (the copied value named ${h.host}). The service's own ${h.key} still shows the old value; the attachment replaces it at every deploy.`],
      });
    }
  }
  return receipt;
}

const MARK: Record<ReceiptState, string> = { done: '✓', skipped: '–', failed: '✗', pending: '…' };

/** The receipt, item by item, in plan order. */
export function renderReceipt(receipt: ImportReceipt): string {
  const out: string[] = [];
  for (const item of Object.values(receipt.items)) {
    const id = item.id !== undefined && item.kind !== 'env' && item.kind !== 'data' ? ` #${item.id}` : '';
    const label = item.kind === 'env' ? `env of ${item.name}` : item.kind === 'data' ? `data of ${item.name}` : `${item.kind} ${item.name}`;
    out.push(`  ${MARK[item.state]} ${label}${id}: ${item.state}`);
    for (const n of item.notes) out.push(`      ${n}`);
  }
  return out.join('\n');
}

/** What --yes would do, without calling the panel. */
export function renderApplyPreview(plan: ImportPlan, receipt: ImportReceipt | null, envFiles: Record<string, string>): string {
  const done = (key: string) => receipt?.items[key]?.state === 'done';
  const out: string[] = ['Services (created, not deployed):'];
  for (const s of plan.services) {
    if (done(`service:${s.ref}`)) out.push(`  ✓ ${s.name}: already created (#${receipt!.items[`service:${s.ref}`]!.id})`);
    else if (!hasSource(s)) out.push(`  – ${s.name}: skipped, no image and no repository`);
    else out.push(`  + ${s.name}: ${s.create.image ? `image ${s.create.image}` : `git ${s.create.repoUrl}${s.create.branch ? `@${s.create.branch}` : ''}`}`);
    if (s.env.length) out.push(`      env: ${envFiles[s.name] !== undefined ? 'from the file passed' : `${s.env.length} name(s), no values (pass --dotenv ${s.name}=<path>)`}`);
    for (const n of domainNotes(s)) out.push(`      ${n}`);
  }
  out.push('Databases (created empty):');
  for (const d of plan.databases) {
    if (done(`database:${d.ref}`)) out.push(`  ✓ ${d.name}: already created (#${receipt!.items[`database:${d.ref}`]!.id})`);
    else if (!d.engine) out.push(`  – ${d.name}: skipped, no managed equivalent`);
    else out.push(`  + ${d.name}: ${d.engine}${databaseVersion(d.engine, d.image) ? ` ${databaseVersion(d.engine, d.image)}` : ' (default version)'}`);
  }
  const links = plan.services.flatMap((s) => {
    const file = envFiles[s.name];
    return file === undefined ? [] : findConnections(plan, file).map((h) => ({ s, h }));
  });
  if (links.length) {
    out.push('Connection strings that name the source:');
    for (const { s, h } of links) {
      out.push(h.action === 'attach'
        ? `  + ${h.key} of ${s.name}: attach ${h.database!.name} under ${h.key} (the copied value names ${h.host})`
        : `  ! ${h.key} of ${s.name} names ${h.database ? `the source's database ${h.database.name}` : 'the old platform'} (${h.host}); change it by hand: ${h.reason}`);
    }
  }
  return out.join('\n');
}

/** Write the receipt atomically (temp file, then rename). */
export function writeReceipt(path: string, receipt: ImportReceipt): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`);
  renameSync(tmp, path);
}

export interface ImportApplyOpts {
  receipt?: string;
  project?: string;
  dotenv?: string[];
  yes?: boolean;
}

export async function importApplyAction(planPath: string, opts: ImportApplyOpts, deps: { client?: ApplyClient; panel?: string } = {}): Promise<void> {
  try {
    const plan = validatePlan(JSON.parse(readFileSync(planPath, 'utf8')));
    const receiptPath = opts.receipt ?? `${planPath.replace(/\.json$/i, '')}.receipt.json`;
    let project: number | undefined;
    if (opts.project !== undefined) {
      project = Number(opts.project);
      if (!Number.isInteger(project) || project <= 0) throw new Error(`--project takes a project id, got "${opts.project}".`);
    }
    const envFiles: Record<string, string> = {};
    for (const spec of opts.dotenv ?? []) {
      const eq = spec.indexOf('=');
      if (eq <= 0 || eq === spec.length - 1) throw new Error(`--dotenv takes <service>=<path>, got "${spec}".`);
      envFiles[spec.slice(0, eq)] = readFileSync(spec.slice(eq + 1), 'utf8');
    }
    const existing = existsSync(receiptPath) ? (JSON.parse(readFileSync(receiptPath, 'utf8')) as ImportReceipt) : null;
    const panel = (deps.panel ?? loadConfig().baseUrl).replace(/\/+$/, '');

    if (!opts.yes) {
      header(`Import into ${panel}`);
      console.log(renderApplyPreview(plan, existing, envFiles));
      info(`${c.dim('Nothing was created.')} Repeat with --yes to create these. Nothing is deployed and no domain is added.`);
      return;
    }
    const receipt = await applyPlan(plan, { project, envFiles }, {
      client: deps.client ?? getClient(), panel, receipt: existing, save: (r) => writeReceipt(receiptPath, r),
    });
    header(`Import into ${panel}`);
    console.log(renderReceipt(receipt));
    const failed = Object.values(receipt.items).filter((i) => i.state === 'failed').length;
    if (failed) error(`${failed} item(s) failed. Fix the cause and run the same command again: done items are not repeated. Receipt: ${receiptPath}`);
    else success(`Done. Receipt: ${receiptPath}. Nothing was deployed; domains and data move in step 3.`);
  } catch (err) {
    error(message(err));
  }
}
