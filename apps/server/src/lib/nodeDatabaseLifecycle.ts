import path from 'node:path';
import { config } from '../config.js';
import { acquireCrossProcessLock, LockUnavailableError, type CrossProcessLock } from './crossProcessLock.js';
import { HttpError } from './errors.js';

const active = new Set<number>();
const busy = () => new HttpError(409, 'node_database_busy', 'Another database or Studio operation is running; retry shortly');
/** Do not queue browser mutations behind a long preparation. A busy response
 * leaves the caller's requested operation explicitly unperformed. */
export async function withNodeDatabaseLifecycle<T>(databaseId: number, operation: () => Promise<T>): Promise<T> {
  if (!Number.isSafeInteger(databaseId) || databaseId < 1) throw new HttpError(400, 'invalid_database', 'Invalid database');
  if (active.has(databaseId)) throw busy();
  active.add(databaseId); let lock: CrossProcessLock | undefined;
  try {
    lock = await acquireCrossProcessLock(path.join(config.paths.dataDir, 'op-locks', `node-database-lifecycle-${databaseId}.lock`), { acquireTimeoutMs: 2000 });
    return await operation();
  } catch (error) { if (error instanceof LockUnavailableError) throw busy(); throw error; }
  finally { lock?.release(); active.delete(databaseId); }
}
