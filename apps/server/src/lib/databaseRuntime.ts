import type { Database, DB } from '@ninedeploy/db';
import * as engine from '../engine/database.js';
import type { DatabaseImportPlan, RetainedVolumeAdoption } from '../engine/database.js';
import { type NodeDatabaseDeps, nodeDatabaseRuntime } from './nodeDatabase.js';

/**
 * Where a managed database runs, and the one place that decides it
 * (multi-node T6, design §5.3).
 *
 * `databases.server_id` NULL — every row that existed before multi-node, and
 * every database created without a `serverId` — is the panel host: each
 * method below is the engine/database.ts function, called with exactly the
 * arguments the caller used to pass it, so the Docker argv is byte-identical
 * to v0.15.0's (test/databaseArgv015.test.ts runs both against the recorded
 * fixture). A row with a `server_id` runs on that node (lib/nodeDatabase.ts).
 *
 * A call site that forgets this dispatch still fails CLOSED: a node row's
 * `container_name` / `volume_name` are NULL, and every engine function
 * refuses or does nothing without them (test/databaseMarker015.test.ts).
 */
export interface DatabaseRuntime {
  readonly where: 'panel' | 'node';
  start(log: (line: string) => void, opts?: { labels?: Record<string, string> }): Promise<void>;
  stop(log: (line: string) => void): Promise<void>;
  restart(log: (line: string) => void): Promise<void>;
  logs(lines?: number): Promise<string[]>;
  size(): Promise<number>;
  backup(file: string, log: (line: string) => void): Promise<void>;
  restore(file: string, log: (line: string) => void): Promise<void>;
  import(file: string, plan: DatabaseImportPlan, log: (line: string) => void): Promise<void>;
  probeCredentials(attempts?: number, delayMs?: number): Promise<boolean>;
  probeMysqlSandboxFlag(): Promise<string | null>;
  adoptRetainedVolume(log: (line: string) => void): Promise<RetainedVolumeAdoption>;
  attachToServiceBridges(serviceSlugs: string[], log: (line: string) => void): Promise<void>;
}

/** The panel host: the engine functions, unchanged. */
function panelRuntime(d: Database): DatabaseRuntime {
  return {
    where: 'panel',
    start: (log, opts) => (opts === undefined ? engine.startDatabase(d, log) : engine.startDatabase(d, log, opts)),
    stop: (log) => engine.stopDatabase(d, log),
    restart: (log) => engine.restartDatabase(d, log),
    logs: (lines) => (lines === undefined ? engine.databaseLogs(d) : engine.databaseLogs(d, lines)),
    size: () => engine.databaseSize(d),
    backup: (file, log) => engine.backupDatabase(d, file, log),
    restore: (file, log) => engine.restoreDatabase(d, file, log),
    import: (file, plan, log) => engine.importDatabase(d, file, plan, log),
    probeCredentials: (attempts, delayMs) =>
      attempts === undefined ? engine.probeDatabaseCredentials(d) : engine.probeDatabaseCredentials(d, attempts, delayMs),
    probeMysqlSandboxFlag: () => engine.probeMysqlSandboxFlag(d),
    adoptRetainedVolume: (log) => engine.adoptRetainedVolume(d, log),
    attachToServiceBridges: (slugs, log) => engine.attachDatabaseToServiceBridges(d, slugs, log),
  };
}

/** The runtime for `d`: the panel host when `server_id` is NULL, otherwise its node. */
export function databaseRuntime(db: DB, d: Database, deps: NodeDatabaseDeps = {}): DatabaseRuntime {
  return d.serverId == null ? panelRuntime(d) : nodeDatabaseRuntime(db, d, deps);
}

/** True for a database placed on a node. */
export const isNodeDatabase = (d: Pick<Database, 'serverId'>): boolean => d.serverId != null;

/** The container name the database runs under, wherever it runs (`containerName ?? nodeContainerName`). */
export const databaseContainerName = (d: Pick<Database, 'containerName' | 'nodeContainerName'>): string | null =>
  d.containerName ?? d.nodeContainerName ?? null;
