import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import * as schema from './schema.js';

export type DB = LibSQLDatabase<typeof schema>;
export type Schema = typeof schema;

export interface CreateDbOptions {
  /** libSQL URL. Use `file:<path>` for a local SQLite file. */
  url: string;
  /** Auth token (only relevant for remote/libSQL servers). */
  authToken?: string;
  /**
   * When `false`, suppress the raw libSQL client from the returned object so
   * the caller can avoid retaining the underlying connection when only the
   * Drizzle handle is needed. The client is included by default.
   */
  withClient?: boolean;
}

export interface CreateDbResult {
  db: DB;
  /**
   * Raw libSQL client. Present unless the caller set
   * `CreateDbOptions.withClient` to `false`. The runtime migrator uses the
   * Drizzle `db` only, so it is safe to suppress this in read-only workers.
   */
  client?: Client;
  /** Connection PRAGMAs that must settle before the first application query. */
  ready: Promise<void>;
}

/**
 * Create a Drizzle-backed database connection backed by libSQL (local file by default).
 *
 * @example
 * const { db } = createDb({ url: 'file:./.data/ninedeploy.db' });
 */
const BUSY_TIMEOUT_MS = 5000;

export function createDb(opts: CreateDbOptions): CreateDbResult {
  /* v8 ignore start */
  if (opts.url.startsWith('file:')) {
    const raw = opts.url.slice('file:'.length);
    mkdirSync(path.dirname(path.resolve(raw)), { recursive: true });
  }
  /* v8 ignore stop */
  // r162: `timeout` is libsql's per-connection busy timeout. It must be set
  // here, not only via PRAGMA: `client.transaction()` hands its connection to
  // the transaction and lazily opens a FRESH one for everything after it, so
  // PRAGMAs issued on the first connection were silently gone (busy_timeout
  // fell back to 0 → immediate SQLITE_BUSY) after the first transaction.
  const client = createClient({ url: opts.url, authToken: opts.authToken, timeout: BUSY_TIMEOUT_MS });
  if (typeof client.transaction === 'function') {
    const beginTransaction = client.transaction.bind(client);
    client.transaction = async (...args: Parameters<typeof client.transaction>) => {
      const tx = await beginTransaction(...args);
      // Re-assert on the connection that replaces the one the transaction just
      // took (foreign_keys is not a client option).
      await client.execute('PRAGMA foreign_keys = ON;');
      return tx;
    };
  }
  // SQLite defaults `foreign_keys` to OFF, which would silently disable every
  // `onDelete cascade` / `set null` rule declared in the schema. Enable it per
  // connection. Fired without awaiting — execute calls on a single libSQL client
  // are serialized, so this runs before any subsequent query on this connection.
  // busy_timeout: without it a reader/writer that collides with the deploy
  // worker's write fails immediately with SQLITE_BUSY; 5s lets it wait.
  // journal_mode=WAL is DELIBERATELY not enabled: the system export handler and
  // install.sh's pre-update backup tar only the single ninedeploy.db file, so
  // WAL would leave recent committed state in ninedeploy.db-wal and silently
  // drop it from those archives. If WAL is ever wanted, the export/import
  // handlers and install.sh backup must first wal_checkpoint(TRUNCATE) or
  // include the sidecar files.
  const ready = client
    .execute('PRAGMA foreign_keys = ON;')
    .then(() => client.execute(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`))
    .then(() => undefined);
  const db = drizzle(client, { schema });
  // The client is opt-out via `withClient: false` so call sites that only
  // need the Drizzle handle can release the underlying libSQL connection.
  return opts.withClient === false ? { db, ready } : { db, client, ready };
}
