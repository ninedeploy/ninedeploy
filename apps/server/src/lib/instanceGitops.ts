import { closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, rmSync, type Dirent } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { and, eq, isNull, isNotNull } from 'drizzle-orm';
import { accessGrants, domains, projects, serviceProjects, services, users, workspaces, type DB } from '@ninedeploy/db';
import {
  instanceSpec,
  scanForSecrets,
  type GitopsCheck,
  type GitopsConfig,
  type GitopsDriftItem,
  type InstanceSpec,
  type InstanceSpecProject,
  type InstanceSpecService,
} from '@ninedeploy/schemas';
import { config } from '../config.js';
import { classifyCloneFailure, displayRepoUrl, redactGitOutput } from './cloneFailure.js';
import { checkoutCommit, type CloneCreds } from './git.js';
import { getSettingJson, setSettingJson } from './settings.js';
import { resolveCloneCreds } from './sourceCreds.js';

/**
 * G5.3 instance-wide GitOps. One YAML file in a repository describes the
 * instance's projects, their services (identity and source), domains and
 * project grants. The panel reads it, compares it with the instance and
 * reports the drift; applying goes through the ordinary API (see
 * modules/instanceGitops.ts) and never deletes: what exists here and not in
 * the file is reported as `extra`, nothing more.
 *
 * No migration: the configuration and the last check are settings rows.
 */

const CONFIG_KEY = 'instance_gitops';
const CHECK_KEY = 'instance_gitops_check';
/** The file is configuration, not data. */
export const MAX_SPEC_BYTES = 256 * 1024;

export const getGitopsConfig = (db: DB) => getSettingJson<GitopsConfig>(db, CONFIG_KEY, null);
export const setGitopsConfig = (db: DB, cfg: GitopsConfig | null) => setSettingJson(db, CONFIG_KEY, cfg);
export const getLastCheck = (db: DB) => getSettingJson<GitopsCheck>(db, CHECK_KEY, null);
export const setLastCheck = (db: DB, check: GitopsCheck | null) => setSettingJson(db, CHECK_KEY, check);

/** Parse and validate the file: size, no secrets, the schema, unique names. */
export function parseInstanceSpec(text: string): InstanceSpec {
  if (Buffer.byteLength(text, 'utf8') > MAX_SPEC_BYTES) throw new Error(`The instance file is larger than ${MAX_SPEC_BYTES / 1024} KiB`);
  const hits = scanForSecrets(text);
  if (hits.length) throw new Error(`The instance file contains what looks like a secret (${[...new Set(hits.map((h) => h.patternId))].join(', ')}); keep secrets in the panel`);
  let raw: unknown;
  try {
    raw = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    throw new Error(`The instance file is not valid YAML: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
  const parsed = instanceSpec.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`The instance file is invalid at ${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'unknown error'}`);
  }
  const spec = parsed.data;
  const seen = new Set<string>();
  const once = (what: string, key: string) => {
    if (seen.has(`${what}:${key}`)) throw new Error(`The instance file names ${what} ${key} twice`);
    seen.add(`${what}:${key}`);
  };
  for (const p of spec.projects) {
    once('project', p.slug);
    for (const s of p.services) {
      once('service', s.slug);
      for (const d of s.domains) once('domain', d.toLowerCase());
    }
    for (const g of p.grants) once(`a grant in ${p.slug} for`, g.email);
  }
  return spec;
}

export interface GitopsDeps {
  checkout: typeof checkoutCommit;
}
const defaultDeps: GitopsDeps = { checkout: checkoutCommit };

/** Bounds for the checkout, as for a repository inspection. Mutable so a test can shrink them. */
export const GITOPS_CHECKOUT_LIMITS = { timeoutMs: 120_000, maxBytes: 50 * 1024 * 1024, pollMs: 1_000 };

/** Bytes under `dir`, stopping as soon as `cap` is exceeded. Symlinks are not followed. */
function sizeExceeds(dir: string, cap: number): boolean {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    let entries: Dirent[];
    const current = stack.pop()!;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        try {
          total += lstatSync(full).size;
        } catch {
          /* vanished mid-walk */
        }
        if (total > cap) return true;
      }
    }
  }
  return false;
}

/** A clone failure as a message without credentials or git's raw output. */
function cloneError(err: unknown, cfg: GitopsConfig, creds: CloneCreds | undefined): Error {
  const failure = classifyCloneFailure(err, cfg.branch, creds, cfg.repoUrl);
  if (failure) return new Error(`Could not clone ${displayRepoUrl(cfg.repoUrl)} (${failure.reason}): ${failure.advice}`);
  const message = redactGitOutput(err instanceof Error ? err.message : String(err), creds).split('\n')[0]?.slice(0, 300);
  return new Error(`Could not clone ${displayRepoUrl(cfg.repoUrl)}: ${message}`);
}

// One read at a time: each in its own fresh directory, removed afterwards.
let readQueue: Promise<unknown> = Promise.resolve();

/** Check the repository out (shallow, bounded) into a fresh directory and read the file at its path. */
export function readSpecFromRepo(db: DB, cfg: GitopsConfig, deps: GitopsDeps = defaultDeps): Promise<{ spec: InstanceSpec; commit: string | null }> {
  const run = readQueue.then(() => readSpecOnce(db, cfg, deps));
  readQueue = run.catch(() => undefined);
  return run;
}

async function readSpecOnce(db: DB, cfg: GitopsConfig, deps: GitopsDeps): Promise<{ spec: InstanceSpec; commit: string | null }> {
  mkdirSync(config.paths.reposDir, { recursive: true });
  const creds = cfg.sourceId ? await resolveCloneCreds(db, { sourceId: cfg.sourceId, repoUrl: cfg.repoUrl }) : undefined;
  const parent = mkdtempSync(path.join(config.paths.reposDir, '_instance-gitops-'));
  const dir = path.join(parent, 'repo');
  const controller = new AbortController();
  const stop: { reason: 'timeout' | 'size' | null } = { reason: null };
  const timer = setTimeout(() => {
    stop.reason = 'timeout';
    controller.abort();
  }, GITOPS_CHECKOUT_LIMITS.timeoutMs);
  const watcher = setInterval(() => {
    if (sizeExceeds(dir, GITOPS_CHECKOUT_LIMITS.maxBytes)) {
      stop.reason = 'size';
      controller.abort();
    }
  }, GITOPS_CHECKOUT_LIMITS.pollMs);
  try {
    let commit: string;
    try {
      commit = await deps.checkout(cfg.repoUrl, cfg.branch, undefined, dir, () => undefined, creds, { shallow: true, signal: controller.signal });
      if (stop.reason === null && sizeExceeds(dir, GITOPS_CHECKOUT_LIMITS.maxBytes)) stop.reason = 'size';
      if (stop.reason) throw new Error('checkout limit');
    } catch (err) {
      if (stop.reason === 'timeout') throw new Error(`The checkout took longer than ${GITOPS_CHECKOUT_LIMITS.timeoutMs / 1000}s; keep the instance file in a small repository`);
      if (stop.reason === 'size') throw new Error(`The checkout is larger than ${GITOPS_CHECKOUT_LIMITS.maxBytes / (1024 * 1024)} MB; keep the instance file in a small repository`);
      throw cloneError(err, cfg, creds);
    }
    let real: string;
    try {
      real = realpathSync(path.resolve(dir, cfg.path));
    } catch {
      throw new Error(`${cfg.path} is not in the repository on ${cfg.branch}`);
    }
    // A symlink in the repository must not read a file of the panel host.
    if (!real.startsWith(realpathSync(dir) + path.sep)) throw new Error(`${cfg.path} points outside the repository`);
    // Size and type from the open handle, then at most the limit is read.
    const fd = openSync(real, 'r');
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new Error(`${cfg.path} is not a file`);
      if (st.size > MAX_SPEC_BYTES) throw new Error(`The instance file is larger than ${MAX_SPEC_BYTES / 1024} KiB`);
      const buf = Buffer.alloc(MAX_SPEC_BYTES + 1);
      const n = readSync(fd, buf, 0, buf.length, 0);
      if (n > MAX_SPEC_BYTES) throw new Error(`The instance file is larger than ${MAX_SPEC_BYTES / 1024} KiB`);
      return { spec: parseInstanceSpec(buf.subarray(0, n).toString('utf8')), commit: commit || null };
    } finally {
      closeSync(fd);
    }
  } finally {
    clearTimeout(timer);
    clearInterval(watcher);
    rmSync(parent, { recursive: true, force: true });
  }
}

/** The live instance, with the ids applying needs. */
export interface LiveInstance {
  spec: InstanceSpec;
  projectIds: Map<string, { id: number; workspaceId: number | null }>;
  serviceIds: Map<string, number>;
  grantIds: Map<string, { id: number; workspaceId: number }>;
  workspaceIds: Map<string, number>;
}

export async function loadLive(db: DB): Promise<LiveInstance> {
  const [ws, projectRows, tags, serviceRows, domainRows, grantRows] = await Promise.all([
    db.select({ id: workspaces.id, slug: workspaces.slug }).from(workspaces),
    db.select().from(projects),
    db.select().from(serviceProjects),
    db.select().from(services),
    db.select({ serviceId: domains.serviceId, hostname: domains.hostname, path: domains.path }).from(domains),
    db
      .select({ id: accessGrants.id, workspaceId: accessGrants.workspaceId, projectId: accessGrants.projectId, role: accessGrants.role, email: users.email })
      .from(accessGrants)
      .innerJoin(users, eq(users.id, accessGrants.userId))
      .where(and(isNotNull(accessGrants.projectId), isNull(accessGrants.environmentId), isNull(accessGrants.suspendedAt))),
  ]);
  const wsSlug = new Map(ws.map((w) => [w.id, w.slug]));
  const svcById = new Map(serviceRows.map((s) => [s.id, s]));
  const live: LiveInstance = {
    spec: { version: '1', projects: [] },
    projectIds: new Map(),
    serviceIds: new Map(serviceRows.map((s) => [s.slug, s.id])),
    grantIds: new Map(),
    workspaceIds: new Map(ws.map((w) => [w.slug, w.id])),
  };
  for (const p of [...projectRows].sort((a, b) => a.slug.localeCompare(b.slug))) {
    live.projectIds.set(p.slug, { id: p.id, workspaceId: p.workspaceId ?? null });
    const svcs: InstanceSpecService[] = tags
      .filter((t) => t.projectId === p.id)
      .map((t) => svcById.get(t.serviceId))
      .filter((s): s is NonNullable<typeof s> => !!s && (s.type === 'docker' || s.type === 'compose'))
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map((s) => ({
        slug: s.slug,
        name: s.name,
        type: s.type as 'docker' | 'compose',
        ...(s.image ? { image: s.image } : {}),
        ...(s.repoUrl ? { repoUrl: s.repoUrl } : {}),
        ...(s.repoUrl && s.branch ? { branch: s.branch } : {}),
        ...(s.port ? { port: s.port } : {}),
        domains: domainRows.filter((d) => d.serviceId === s.id && d.path === '/').map((d) => d.hostname).sort(),
      }));
    const grants = grantRows
      .filter((g) => g.projectId === p.id)
      .map((g) => {
        live.grantIds.set(`${p.slug}/${g.email.toLowerCase()}`, { id: g.id, workspaceId: g.workspaceId });
        return { email: g.email.toLowerCase(), role: g.role };
      })
      .sort((a, b) => a.email.localeCompare(b.email));
    const workspace = p.workspaceId != null ? wsSlug.get(p.workspaceId) : undefined;
    live.spec.projects.push({
      slug: p.slug,
      name: p.name,
      ...(p.description ? { description: p.description } : {}),
      ...(workspace ? { workspace } : {}),
      services: svcs,
      grants,
    });
  }
  return live;
}

/** The live instance as the file, to commit (the write-back of UI edits). */
export function renderInstanceSpec(spec: InstanceSpec): string {
  return `# NineDeploy instance file (G5.3). Secrets stay in the panel.\n${yaml.dump(spec, { noRefs: true, lineWidth: 120, sortKeys: false })}`;
}

const SERVICE_FIELDS = ['name', 'type', 'image', 'repoUrl', 'branch', 'port'] as const;

function changedFields<T extends object>(desired: T, actual: T, fields: ReadonlyArray<keyof T>) {
  const out: Array<{ field: string; desired: unknown; actual: unknown }> = [];
  for (const f of fields) {
    const want = desired[f];
    if (want === undefined) continue; // not managed by the file
    const have = actual[f] ?? null;
    if (want !== have) out.push({ field: String(f), desired: want, actual: have });
  }
  return out;
}

/** What differs between the file and the instance. */
export function computeDrift(desired: InstanceSpec, live: InstanceSpec): GitopsDriftItem[] {
  const drift: GitopsDriftItem[] = [];
  const liveProjects = new Map(live.projects.map((p) => [p.slug, p]));
  const desiredSlugs = new Set(desired.projects.map((p) => p.slug));
  const liveServiceSlugs = new Map<string, InstanceSpecService>();
  for (const p of live.projects) for (const s of p.services) liveServiceSlugs.set(s.slug, s);

  for (const want of desired.projects) {
    const have = liveProjects.get(want.slug);
    if (!have) {
      drift.push({ kind: 'project', key: want.slug, change: 'missing' });
    } else {
      const fields = changedFields<InstanceSpecProject>(want, have, ['name', 'description', 'workspace']);
      if (fields.length) drift.push({ kind: 'project', key: want.slug, change: 'changed', fields });
    }
    const haveServices = new Map((have?.services ?? []).map((s) => [s.slug, s]));
    for (const s of want.services) {
      const key = `${want.slug}/${s.slug}`;
      const hs = haveServices.get(s.slug);
      if (!hs) {
        drift.push({ kind: 'service', key, change: 'missing' });
        for (const d of s.domains) drift.push({ kind: 'domain', key: `${key}/${d.toLowerCase()}`, change: 'missing' });
        continue;
      }
      const fields = changedFields<InstanceSpecService>(s, hs, SERVICE_FIELDS);
      if (fields.length) drift.push({ kind: 'service', key, change: 'changed', fields });
      const wantHosts = new Set(s.domains.map((d) => d.toLowerCase()));
      const got = new Set(hs.domains.map((d) => d.toLowerCase()));
      for (const d of wantHosts) if (!got.has(d)) drift.push({ kind: 'domain', key: `${key}/${d}`, change: 'missing' });
      for (const d of got) if (!wantHosts.has(d)) drift.push({ kind: 'domain', key: `${key}/${d}`, change: 'extra' });
    }
    for (const hs of have?.services ?? []) {
      if (!want.services.some((s) => s.slug === hs.slug)) drift.push({ kind: 'service', key: `${want.slug}/${hs.slug}`, change: 'extra' });
    }
    const haveGrants = new Map((have?.grants ?? []).map((g) => [g.email, g]));
    for (const g of want.grants) {
      const hg = haveGrants.get(g.email);
      const key = `${want.slug}/${g.email}`;
      if (!hg) drift.push({ kind: 'grant', key, change: 'missing' });
      else if (hg.role !== g.role) drift.push({ kind: 'grant', key, change: 'changed', fields: [{ field: 'role', desired: g.role, actual: hg.role }] });
    }
    for (const hg of have?.grants ?? []) {
      if (!want.grants.some((g) => g.email === hg.email)) drift.push({ kind: 'grant', key: `${want.slug}/${hg.email}`, change: 'extra' });
    }
  }
  for (const p of live.projects) if (!desiredSlugs.has(p.slug)) drift.push({ kind: 'project', key: p.slug, change: 'extra' });
  return drift;
}

/** A stable fingerprint of the drift, so an unchanged drift alerts once. */
export const driftFingerprint = (drift: GitopsDriftItem[]) => JSON.stringify(drift.map((d) => `${d.change}:${d.kind}:${d.key}`).sort());

let running: Promise<{ check: GitopsCheck; previous: GitopsCheck | null }> | null = null;

/** Read the file, compare, store the result. One check at a time (one checkout directory). */
export function runGitopsCheck(db: DB, deps: GitopsDeps = defaultDeps): Promise<{ check: GitopsCheck; previous: GitopsCheck | null }> {
  running ??= (async () => {
    const previous = await getLastCheck(db);
    const cfg = await getGitopsConfig(db);
    if (!cfg) throw new Error('Instance GitOps is not configured');
    let check: GitopsCheck;
    try {
      const { spec, commit } = await readSpecFromRepo(db, cfg, deps);
      check = { at: new Date().toISOString(), commit, error: null, drift: computeDrift(spec, (await loadLive(db)).spec) };
    } catch (err) {
      check = { at: new Date().toISOString(), commit: null, error: err instanceof Error ? err.message : String(err), drift: [] };
    }
    await setLastCheck(db, check);
    return { check, previous };
  })().finally(() => {
    running = null;
  });
  return running;
}
