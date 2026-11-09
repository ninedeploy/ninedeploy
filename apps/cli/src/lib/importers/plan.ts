/**
 * A1 step 1 (docs/plans/COMPETITIVE_ROADMAP_2026-11.md): a read-only import
 * plan. An adapter reads another platform's API (Coolify, Dokploy, CapRover)
 * and describes, per item, what NineDeploy would create, what it cannot carry,
 * and what needs a person. Nothing is created and the source is not changed.
 *
 * Secret hygiene is part of the type: a plan carries environment variable
 * NAMES only, never values, passwords, tokens or keys, and every URL has its
 * userinfo removed before it enters the plan. Step 2 (`import apply`, in
 * commands/importApply.ts) takes values only from .env files the person passes.
 */
import type { CreateService } from '@ninedeploy/schemas';

export type SourceKind = 'coolify' | 'dokploy' | 'caprover';

/** GET a JSON path on the source panel (auth already applied). */
export type SourceGet = (path: string) => Promise<unknown>;

export type IssueLevel = 'unsupported' | 'manual' | 'info';
export interface PlanIssue {
  level: IssueLevel;
  /** The source option or field the issue is about, e.g. `build_pack`. */
  option: string;
  detail: string;
}

/** The createService fields a step-2 apply would send (subset, never secrets). */
export type ServiceCreateFields = Pick<CreateService, 'name' | 'type'> &
  Partial<Pick<CreateService, 'image' | 'repoUrl' | 'branch' | 'port' | 'publishedPort' | 'replicas' | 'cpuLimitMilli' | 'memLimitMb' | 'healthPath' | 'volumeMount'>> & {
    build?: { buildPack?: NonNullable<CreateService['build']>['buildPack']; baseDir?: string; dockerfilePath?: string; outputDir?: string };
  };

export interface PlanService {
  /** Stable reference in the source (uuid / id / appName). */
  ref: string;
  name: string;
  kind: 'image' | 'git' | 'compose';
  create: ServiceCreateFields;
  domains: Array<{ host: string; https: boolean }>;
  /** Names only. `secret` marks values the source keeps hidden or flags as secret. */
  env: Array<{ key: string }>;
  volumes: Array<{ mountPath: string; source: 'volume' | 'bind' | 'file'; name?: string }>;
  issues: PlanIssue[];
}

export type PlanEngine = 'postgres' | 'mysql' | 'mariadb' | 'mongo' | 'redis' | 'keydb' | 'dragonfly' | 'clickhouse';
export interface PlanDatabase {
  ref: string;
  name: string;
  /** NineDeploy engine, or null when NineDeploy has no managed equivalent. */
  engine: PlanEngine | null;
  /** The source image (the version lives in its tag), when the source says. */
  image: string | null;
  issues: PlanIssue[];
}

export interface ImportPlan {
  planVersion: 1;
  source: { kind: SourceKind; url: string; version: string | null; scope: string };
  generatedAt: string;
  services: PlanService[];
  databases: PlanDatabase[];
  /** Plan-wide notes (scope limits, what step 1 does not do). */
  notes: string[];
}

/** Always present: what this plan is and is not. */
export const PLAN_NOTES = [
  'Read-only: nothing was created here and nothing was changed on the source.',
  'Environment variables are listed by name only. Values, passwords, tokens and keys are never written to a plan.',
  'Database contents and volume data are not moved by this step.',
];

/** Remove `user:password@` from a URL; non-URLs pass through unchanged. */
export function stripUserinfo(raw: string): string {
  // Only `scheme://` strings are URLs here: `user:secret@host:repo` would
  // otherwise parse as scheme "user:" and keep its password.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      if (!u.username && !u.password) return raw;
      u.username = '';
      u.password = '';
      return u.toString();
    } catch {
      /* fall through to the textual rule */
    }
  }
  // scp-style remotes: `git@host:owner/repo.git` (no password) stays as it is;
  // `user:secret@host…` loses its credentials.
  return raw.replace(/^[^@/\s]+:[^@/\s]*@/, '');
}

/** `KEY=VALUE` lines (Dokploy's env blob) → names only. Comments and blanks skipped. */
export function envNames(blob: string | null | undefined): Array<{ key: string }> {
  const out: Array<{ key: string }> = [];
  for (const line of (blob ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    const key = (eq === -1 ? t : t.slice(0, eq)).replace(/^export\s+/, '').trim();
    if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) out.push({ key });
  }
  return out;
}

/** Each URL or bare host in a list → `{host, https}` (Coolify's comma-separated `fqdn`). */
export function domainsFrom(list: string | null | undefined): Array<{ host: string; https: boolean }> {
  const out: Array<{ host: string; https: boolean }> = [];
  for (const part of (list ?? '').split(',')) {
    const t = part.trim();
    if (!t) continue;
    try {
      const u = new URL(/^[a-z]+:\/\//i.test(t) ? t : `http://${t}`);
      if (u.hostname) out.push({ host: u.hostname, https: u.protocol === 'https:' });
    } catch {
      /* not a host */
    }
  }
  return out;
}

/** "512M" / "2g" / "1024" (bytes or MB per source) → megabytes, or undefined. */
export function memToMb(raw: string | number | null | undefined, plainUnit: 'bytes' | 'mb' = 'bytes'): number | undefined {
  if (raw == null || raw === '' || raw === '0' || raw === 0) return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i.exec(String(raw).trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  const mb = unit === 'k' ? n / 1024 : unit === 'm' ? n : unit === 'g' ? n * 1024 : unit === 't' ? n * 1024 * 1024 : plainUnit === 'mb' ? n : n / (1024 * 1024);
  return mb >= 1 ? Math.round(mb) : undefined;
}

/** "1.5" cores → 1500 millicores, or undefined. */
export function cpusToMilli(raw: string | number | null | undefined): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : undefined;
}

/** NineDeploy accepts 1..10 replicas. */
export function replicasFor(raw: unknown, issues: PlanIssue[]): number | undefined {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 1) return undefined;
  if (n > 10) {
    issues.push({ level: 'manual', option: 'replicas', detail: `${n} replicas in the source; NineDeploy runs at most 10 per service, so the plan uses 10.` });
    return 10;
  }
  return n;
}

/** The first volume becomes `volumeMount`; any others are listed for a person. */
export function firstVolumeMount(volumes: PlanService['volumes'], issues: PlanIssue[]): string | undefined {
  const named = volumes.filter((v) => v.source !== 'file');
  if (named.length > 1) {
    issues.push({ level: 'manual', option: 'volumes', detail: `${named.length} volumes; a new service gets one at create time (${named[0]!.mountPath}). Attach the others under Volumes & Storage.` });
  }
  for (const f of volumes.filter((v) => v.source === 'file')) {
    issues.push({ level: 'manual', option: 'file mount', detail: `File mount ${f.mountPath}: recreate it under Service → File mounts (its content is not read).` });
  }
  return named[0]?.mountPath;
}

export const DATA_NOT_MOVED: PlanIssue = { level: 'manual', option: 'data', detail: 'Data is not moved by this step: create the database, then restore a dump into it (step 3).' };

export function emptyPlan(kind: SourceKind, url: string, version: string | null, scope: string): ImportPlan {
  return { planVersion: 1, source: { kind, url: stripUserinfo(url), version, scope }, generatedAt: new Date().toISOString(), services: [], databases: [], notes: [...PLAN_NOTES] };
}
