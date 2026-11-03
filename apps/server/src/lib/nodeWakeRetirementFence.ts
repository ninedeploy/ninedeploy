import type { DatabaseSync } from 'node:sqlite';
import { load } from 'js-yaml';
import { validNodeCatcherName } from './nodeCatcherIdentity.js';

const table = 'CREATE TABLE IF NOT EXISTS retired_wake_backend (name TEXT PRIMARY KEY, container_id TEXT NOT NULL)';
const gateTable = "SELECT 1 FROM sqlite_master WHERE type='table' AND name='wake_proxy_writer_gate'";

/** Old agents must not bypass a newer writer's retired-backend validation. */
export function adoptWakeRetirementWriter(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS wake_proxy_writer_gate(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
    INSERT INTO wake_proxy_writer_gate(id,version) VALUES(1,2) ON CONFLICT(id) DO NOTHING;
    CREATE TRIGGER IF NOT EXISTS wake_proxy_insert_guard BEFORE INSERT ON proxy_write_head
      WHEN ninedeploy_wake_proxy_writer() != 1
      BEGIN SELECT RAISE(ABORT,'Ordered proxy writer must support wake retirement; update the agent'); END;
    CREATE TRIGGER IF NOT EXISTS wake_proxy_update_guard BEFORE UPDATE ON proxy_write_head
      WHEN ninedeploy_wake_proxy_writer() != 1
      BEGIN SELECT RAISE(ABORT,'Ordered proxy writer must support wake retirement; update the agent'); END;`);
  const gate = database.prepare('SELECT version FROM wake_proxy_writer_gate WHERE id=1').get();
  if (!gate || gate.version !== 2) throw new Error('Wake proxy writer gate is unconfirmed');
}

/** Admission is connection-local: old agents lack the function, even after a restart. */
export async function withWakeProxyWriter<T>(database: DatabaseSync, effect: () => Promise<T>): Promise<T> {
  if (!database.prepare(gateTable).get()) return effect();
  const gate = database.prepare('SELECT version FROM wake_proxy_writer_gate WHERE id=1').get();
  if (!gate || gate.version !== 2) throw new Error('Wake proxy writer gate is unconfirmed');
  let allowed = true;
  database.function('ninedeploy_wake_proxy_writer', () => allowed ? 1 : 0);
  try { return await effect(); }
  finally { allowed = false; }
}

/** These names must never be reused by a later catcher instance. */
export function retiredWakeBackends(database: DatabaseSync): Map<string, string> {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='retired_wake_backend'").get()) return new Map();
  const rows = database.prepare('SELECT name,container_id FROM retired_wake_backend').all();
  if (rows.length > 50_000) throw new Error('Wake retirement journal needs review');
  const result = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.name !== 'string' || !validNodeCatcherName(row.name) || typeof row.container_id !== 'string' || row.container_id.length !== 64 || !/^[a-f0-9]{64}$/.test(row.container_id)) {
      throw new Error('Wake retirement journal is unconfirmed');
    }
    result.set(row.name, row.container_id);
  }
  return result;
}

export function recordRetiredWakeBackend(database: DatabaseSync, name: string, id: string): void {
  if (!validNodeCatcherName(name) || id.length !== 64 || !/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid wake retirement identity');
  database.exec(table);
  const retired = retiredWakeBackends(database), prior = retired.get(name);
  if (prior && prior !== id) throw new Error('Wake retirement name was reused');
  if (!prior && retired.size >= 50_000) throw new Error('Wake retirement journal needs review');
  database.prepare('INSERT INTO retired_wake_backend(name,container_id) VALUES(?,?) ON CONFLICT(name) DO NOTHING').run(name, id);
}

/** Inspect parsed URL/address values, including encoded hosts and aliases, without exposing config. */
export function assertNoWakeBackendReference(value: unknown, names: ReadonlySet<string>): void {
  if (!names.size) return;
  const seen = new WeakSet<object>(); let count = 0;
  const walk = (entry: unknown, depth: number) => {
    if (++count > 100_000 || depth > 100) throw new Error('Node proxy configuration is too complex for safe retirement');
    if (typeof entry === 'string') {
      let host: string | undefined;
      try {
        if (entry.includes('://')) host = new URL(entry).hostname;
        else if (/^[A-Za-z0-9_.-]+:[0-9]+$/.test(entry)) host = entry.slice(0, entry.lastIndexOf(':'));
      } catch { throw new Error('Node proxy address is unconfirmed'); }
      if (host && names.has(host.toLowerCase().replace(/\.$/, ''))) throw new Error('Node proxy configuration references a retired wake backend');
    } else if (entry && typeof entry === 'object' && !seen.has(entry)) {
      seen.add(entry);
      for (const item of Object.values(entry)) walk(item, depth + 1);
    }
  };
  walk(value, 0);
}

export function assertNoRetiredWakeBackend(database: DatabaseSync, content: string): void {
  const retired = retiredWakeBackends(database);
  if (retired.size) assertNoWakeBackendReference(parseWakeRouting(content), new Set(retired.keys()));
}

export function parseWakeRouting(content: string): unknown {
  try { return load(content); }
  catch { throw new Error('Node proxy configuration could not be parsed for safe retirement'); }
}
