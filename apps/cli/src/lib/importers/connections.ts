/**
 * A1: environment values copied from the source that still point at the
 * source's databases.
 *
 * A .env file passed to `import apply --dotenv` is read here, on the person's
 * machine; what comes out holds variable names, database names and host
 * names, never a value. Each hit is either:
 * - `attach`: the value is a connection string the panel's own one can
 *   replace exactly, so the new database is attached under that variable's
 *   name (the attachment sets it at every deploy);
 * - `manual`: anything else, with the reason. The panel's string has a fixed
 *   form per engine (scheme, no query options, no Mongo database name, no
 *   Redis database index), and replacing a value that differs would change
 *   what the app connects to without anyone seeing it.
 */
import type { ImportPlan, PlanDatabase, PlanEngine, SourceKind } from './plan.js';

/** The scheme each engine's panel connection string starts with (server engine/database.ts). */
const PANEL_SCHEME: Record<PlanEngine, string> = {
  postgres: 'postgres:', mysql: 'mysql:', mariadb: 'mariadb:', mongo: 'mongodb:',
  redis: 'redis:', keydb: 'redis:', dragonfly: 'redis:', clickhouse: 'clickhouse:',
};
const REDIS_FAMILY = new Set<PlanEngine>(['redis', 'keydb', 'dragonfly']);

/**
 * The names the source's apps reach a database by, from where it runs.
 * CapRover: both the app name and the `srv-captain--` alias (1.16 names new
 * apps' Swarm services plainly, older ones with the prefix). Coolify: the
 * container name (its uuid). Dokploy: the Swarm service (appName).
 */
export function sourceHosts(kind: SourceKind, db: PlanDatabase): string[] {
  const name = db.runtime?.name?.toLowerCase();
  if (!name) return [];
  switch (db.runtime!.kind) {
    case 'heroku-app':
      // The name is the Heroku app, not a host: add-on URLs name Heroku's own hosts.
      return [];
    case 'container':
    case 'swarm-service':
      break;
    default: {
      const never: never = db.runtime!.kind;
      return never;
    }
  }
  if (kind === 'caprover') {
    const app = name.replace(/^srv-captain--/, '');
    return [app, `srv-captain--${app}`];
  }
  return [name];
}

/** `KEY=value` pairs of a .env file: quotes removed, `# comments` after an unquoted value dropped. */
export function envFileEntries(content: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const line of content.split(/\r?\n/)) {
    const m = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    const q = value[0];
    if ((q === '"' || q === "'") && value.indexOf(q, 1) > 0) value = value.slice(1, value.indexOf(q, 1));
    else value = value.replace(/[ \t]+#.*$/, '').trim();
    out.push({ key: m[1]!, value });
  }
  return out;
}

export interface ConnectionHit {
  key: string;
  /** The plan database it names (null: the source platform's own host). */
  database: PlanDatabase | null;
  host: string;
  action: 'attach' | 'manual';
  reason: string;
}

function parseUrl(value: string): URL | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Why the panel's string cannot replace this one, or null when it can. */
function attachProblem(engine: PlanEngine, url: URL): string | null {
  const want = PANEL_SCHEME[engine];
  if (engine === 'mongo') return 'the panel\'s Mongo string names no database, so the app would use the default one; set the new host and credentials here, keeping the database name';
  if (engine === 'clickhouse') return 'ClickHouse is not attached by the import; set the new host and credentials here';
  if (url.protocol !== want) return `the panel's string starts with ${want}// and this one with ${url.protocol}//, which the app's driver may need`;
  if (url.search) return 'it carries options (?…) that the panel\'s string would drop';
  if (REDIS_FAMILY.has(engine) && url.pathname !== '' && url.pathname !== '/' && url.pathname !== '/0') return `it selects Redis database ${url.pathname.slice(1)}, and the panel's string uses 0`;
  return null;
}

/** Every value in the file that names a planned database's source host, or the source platform's own host. */
export function findConnections(plan: ImportPlan, envContent: string): ConnectionHit[] {
  const byHost = new Map<string, PlanDatabase>();
  for (const db of plan.databases) for (const h of sourceHosts(plan.source.kind, db)) byHost.set(h, db);
  let platform: string | null = null;
  try {
    // A Heroku plan's URL is the repository, not a host the app could reach a database on.
    if (plan.source.kind !== 'heroku') platform = new URL(plan.source.url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    platform = null;
  }
  const hits: ConnectionHit[] = [];
  for (const { key, value } of envFileEntries(envContent)) {
    const url = parseUrl(value);
    const host = (url ? url.hostname : value.replace(/:\d+$/, '')).toLowerCase().replace(/^\[|\]$/g, '');
    if (!host) continue;
    const db = byHost.get(host);
    if (db) {
      if (!url) {
        hits.push({ key, database: db, host, action: 'manual', reason: `it holds the source database's host; set it to ${db.name}'s host in NineDeploy (Databases → ${db.name} → Connection)` });
        continue;
      }
      const problem = db.engine ? attachProblem(db.engine, url) : 'NineDeploy has no managed equivalent of this database';
      hits.push(problem
        ? { key, database: db, host, action: 'manual', reason: problem }
        : { key, database: db, host, action: 'attach', reason: '' });
      continue;
    }
    if (platform && host === platform && !url?.protocol.startsWith('http')) {
      hits.push({
        key, database: null, host, action: 'manual',
        reason: 'NineDeploy can still reach that host, so the app would keep using the old database. Point it at the new one',
      });
    }
  }
  return hits;
}
