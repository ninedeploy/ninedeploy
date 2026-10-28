// Client surface: databases, backups, backupDestinations, volumeBackups.
// Split out of the former single-file SDK entry (src/index.ts); the public
// surface is re-exported unchanged from there.
import type {
  CreateVolumeBackupInput,
  Backup,
  BackupPolicy,
  BackupPolicyInput,
  BackupWithDb,
  CreateDatabaseInput,
  ManagedDatabase,
  DatabaseDetail,
  SetLimitsInput,
  PublicAccessPut,
  PublicAccessStatus,
  DatabaseImport,
  DatabaseImportCreate,
  BackupDestinationObject,
  BackupReplica,
  BackupReplicasView,
} from '@ninedeploy/schemas';
import type { ImportWaitOptions, ImportFileData, ImportFileOptions } from '../databaseImport.js';
import type { BackupDrillResult, BackupDrillEntry, PgbouncerStatus, DatabaseCredentialsWithPublic } from '../types.js';
import type { Transport } from '../transport.js';
import { createImportHelpers } from '../databaseImport.js';

export interface DatabasesApi {
  databases: {
    /** `query` is appended verbatim, e.g. `?projectId=3` (project scoping). */
    list: (query?: string) => Promise<ManagedDatabase[]>;
    create: (input: CreateDatabaseInput) => Promise<ManagedDatabase>;
    get: (id: number) => Promise<DatabaseDetail>;
    remove: (id: number, options?: { force?: boolean }) => Promise<void>;
    restart: (id: number) => Promise<void>;
    stop: (id: number) => Promise<void>;
    start: (id: number) => Promise<void>;
    logs: (id: number, lines?: number) => Promise<{ logs: string[] }>;
    credentials: (id: number) => Promise<DatabaseCredentialsWithPublic>;
    setLimits: (id: number, input: SetLimitsInput) => Promise<{ cpuShares: number | null; memLimitMb: number | null }>;
    startStudio: (id: number, port?: number) => Promise<{ ok: boolean; port: number | null; url: string; serverId?: number }>;
    stopStudio: (id: number) => Promise<{ ok: boolean }>;
    /**
     * PgBouncer sidecar (G-32). Returns the current sidecar
     * state — `enabled` + `running` + the URL the services
     * should connect to. Use the same call after
     * `enablePgbouncer` / `disablePgbouncer` for a fresh
     * read (the route returns the post-mutation status).
     */
    pgbouncerStatus: (id: number) => Promise<PgbouncerStatus>;
    /**
     * Spin up the sidecar. `port` is optional — the row's
     * existing `pgbouncerPort` (default 6432) is used
     * when omitted. Only `engine='postgres'` is supported;
     * the server returns 422 for any other engine.
     */
    enablePgbouncer: (id: number, input?: { port?: number }) => Promise<PgbouncerStatus>;
    /** Stop + remove the sidecar and clear the row's flags. */
    disablePgbouncer: (id: number) => Promise<PgbouncerStatus>;
    /**
     * Run an engine-specific smoke check against a backup
     * file (pg_restore --list, redis-check-rdb, mysqldump
     * header parse, ...). Returns the drill row with `status`
     * of `passed` or `failed`; a failed drill is a real
     * signal that the backup cannot be restored cleanly, not
     * a warning. `unverifiable` (r356) means the check could
     * not run at all. Requires the `member` role on the database.
     */
    drillBackup: (id: number, input: { backupId: number }) => Promise<BackupDrillResult>;
    /** List the most recent drills for a database, newest first. */
    drills: (id: number) => Promise<BackupDrillEntry[]>;
    /**
     * 0.14: public access through a per-database Traefik TCP sidecar. Reading
     * needs `admin` on the database; `set` and `disable` are operator-only.
     * Public access exposes the database's ROOT credentials.
     */
    publicAccess: {
      get: (id: number) => Promise<PublicAccessStatus>;
      /** Applies synchronously; answers the GET shape. */
      set: (id: number, input: PublicAccessPut) => Promise<PublicAccessStatus>;
      disable: (id: number) => Promise<{ ok: boolean }>;
    };
    /**
     * 0.14: dump imports. Uploads are chunked at the server-advertised
     * `chunkSize`; an S3 source (operator-only) downloads in the background
     * (`uploading` → `pending`) and is then started like an upload.
     */
    imports: {
      create: (id: number, input: DatabaseImportCreate) => Promise<DatabaseImport>;
      /** Chunk `index` must be the next one (`receivedBytes / chunkSize`). */
      uploadChunk: (id: number, importId: number, index: number, chunk: Uint8Array) => Promise<DatabaseImport>;
      /** 202: the job runs in the background; poll `get` or use `wait`. */
      start: (id: number, importId: number) => Promise<DatabaseImport>;
      list: (id: number) => Promise<DatabaseImport[]>;
      get: (id: number, importId: number) => Promise<DatabaseImport>;
      /** Cancels an `uploading` or `pending` import. */
      cancel: (id: number, importId: number) => Promise<DatabaseImport>;
      /** Poll until the import finishes (or, with `until: 'uploaded'`, leaves `uploading`). */
      wait: (id: number, importId: number, opts?: ImportWaitOptions) => Promise<DatabaseImport>;
    };
    /**
     * 0.14: upload a dump in chunks (resuming from the server's
     * `receivedBytes` when `resumeImportId` is given), start it, and
     * optionally poll until it finishes.
     */
    importFile: (id: number, data: ImportFileData, opts?: ImportFileOptions) => Promise<DatabaseImport>;
  };
  backups: {
    storage: (databaseId: number) => Promise<{ sizeBytes: number }>;
    backupNow: (databaseId: number) => Promise<Backup>;
    listForDb: (databaseId: number) => Promise<Backup[]>;
    restore: (databaseId: number, backupId: number) => Promise<{ ok: boolean }>;
    list: () => Promise<BackupWithDb[]>;
    remove: (backupId: number) => Promise<void>;
    downloadUrl: (backupId: number) => string;
    /** 0.12: the database's backup schedule. `configured: false` = no policy
     *  saved — the built-in daily run with 7 kept applies. */
    getPolicy: (databaseId: number) => Promise<BackupPolicy>;
    /** 0.12: save (replace) the database's backup schedule, retention and destination. */
    setPolicy: (databaseId: number, input: BackupPolicyInput) => Promise<BackupPolicy>;
    /** G3.3: more destinations for the scheduled dumps, each with its own retention (operators set them). */
    replicas: {
      get: (databaseId: number) => Promise<BackupReplicasView>;
      set: (databaseId: number, replicas: BackupReplica[]) => Promise<BackupReplicasView>;
    };
  };
  backupDestinations: {
    list: () => Promise<Array<{ id: number; name: string; endpoint: string; region: string; bucket: string; prefix: string; active: boolean; createdAt: string }>>;
    create: (input: { name: string; endpoint: string; region?: string; bucket: string; prefix?: string; accessKeyId: string; secretAccessKey: string }) => Promise<{ id: number }>;
    update: (id: number, input: Partial<{ name: string; endpoint: string; region: string; bucket: string; prefix: string; active: boolean; accessKeyId: string; secretAccessKey: string }>) => Promise<{ ok: boolean }>;
    remove: (id: number) => Promise<{ ok: boolean }>;
    test: (id: number) => Promise<{ ok: boolean }>;
    /** 0.14: list objects (operator-only); `prefix` defaults to the destination prefix. */
    objects: (id: number, prefix?: string) => Promise<BackupDestinationObject[]>;
  };
  /** Per-volume backup history. The base URL is `/v1/volumes/:name/backups`;
   *  restore + download go through the same path. The global `/v1/backups`
   *  list/delete are exposed as `backups` below. */
  volumeBackups: {
    list: (volumeName: string) => Promise<Backup[]>;
    create: (volumeName: string, input: CreateVolumeBackupInput) => Promise<Backup>;
    restore: (volumeName: string, backupId: number) => Promise<{ ok: boolean }>;
    downloadUrl: (volumeName: string, backupId: number) => string;
  };
}

export function databasesApi(t: Transport): DatabasesApi {
  const { get, send, request } = t;
  const { importPath, getImport, uploadChunk, startImport, waitForImport, importFile } = createImportHelpers(t);
  return {
    databases: {
      list: (query) => get<ManagedDatabase[]>(`/v1/databases${query ?? ''}`),
      create: (input) => send<ManagedDatabase>('POST', '/v1/databases', input),
      get: (id) => get<DatabaseDetail>(`/v1/databases/${id}`),
      remove: async (id, opts) => {
        await request(`/v1/databases/${id}${opts?.force ? '?force=true' : ''}`, { method: 'DELETE' });
      },
      restart: async (id) => {
        await request(`/v1/databases/${id}/restart`, { method: 'POST' });
      },
      stop: async (id) => {
        await request(`/v1/databases/${id}/stop`, { method: 'POST' });
      },
      start: async (id) => {
        await request(`/v1/databases/${id}/start`, { method: 'POST' });
      },
      logs: (id, lines) => get<{ logs: string[] }>(`/v1/databases/${id}/logs${lines ? `?lines=${lines}` : ''}`),
      credentials: (id) => get<DatabaseCredentialsWithPublic>(`/v1/databases/${id}/credentials`),
      setLimits: (id, input) => send<{ cpuShares: number | null; cpuLimitMilli: number | null; memLimitMb: number | null }>('PATCH', `/v1/databases/${id}/limits`, input),
      // Allow bounded image preparation and keep the path-scoped browser cookie.
      startStudio: (id, port) => request<{ ok: boolean; port: number | null; url: string; serverId?: number }>(`/v1/databases/${id}/studio`, { method: 'POST', body: { port }, credentials: 'include' }, 240_000),
      stopStudio: async (id) => {
        await request(`/v1/databases/${id}/studio`, { method: 'DELETE', credentials: 'include' }, 270_000);
        return { ok: true };
      },
      drillBackup: (id, input) =>
        send<BackupDrillResult>('POST', `/v1/databases/${id}/backups/drill`, input),
      drills: (id) => get<BackupDrillEntry[]>(`/v1/databases/${id}/drills`),
      pgbouncerStatus: (id) => get<PgbouncerStatus>(`/v1/databases/${id}/pgbouncer`),
      enablePgbouncer: (id, input) =>
        send<PgbouncerStatus>('POST', `/v1/databases/${id}/pgbouncer/enable`, input ?? {}),
      disablePgbouncer: (id) =>
        send<PgbouncerStatus>('POST', `/v1/databases/${id}/pgbouncer/disable`, {}),
      publicAccess: {
        get: (id) => get<PublicAccessStatus>(`/v1/databases/${id}/public-access`),
        set: (id, input) => send<PublicAccessStatus>('PUT', `/v1/databases/${id}/public-access`, input),
        disable: (id) => send<{ ok: boolean }>('DELETE', `/v1/databases/${id}/public-access`),
      },
      imports: {
        create: (id, input) => send<DatabaseImport>('POST', importPath(id), input),
        uploadChunk,
        start: startImport,
        list: (id) => get<DatabaseImport[]>(importPath(id)),
        get: getImport,
        cancel: (id, importId) => send<DatabaseImport>('DELETE', importPath(id, importId)),
        wait: waitForImport,
      },
      importFile,
    },
    backups: {
      storage: (databaseId) => get<{ sizeBytes: number }>(`/v1/databases/${databaseId}/storage`),
      backupNow: (databaseId) => send<Backup>('POST', `/v1/databases/${databaseId}/backups`),
      listForDb: (databaseId) => get<Backup[]>(`/v1/databases/${databaseId}/backups`),
      restore: (databaseId, backupId) => send<{ ok: boolean }>('POST', `/v1/databases/${databaseId}/backups/${backupId}/restore`),
      list: () => get<BackupWithDb[]>('/v1/backups'),
      remove: async (backupId) => {
        await request(`/v1/backups/${backupId}`, { method: 'DELETE' });
      },
      downloadUrl: (backupId) => `/v1/backups/${backupId}/download`,
      getPolicy: (databaseId) => get<BackupPolicy>(`/v1/databases/${databaseId}/backup-policy`),
      setPolicy: (databaseId, input) => send<BackupPolicy>('PUT', `/v1/databases/${databaseId}/backup-policy`, input),
      replicas: {
        get: (databaseId) => get<BackupReplicasView>(`/v1/databases/${databaseId}/backup-replicas`),
        set: (databaseId, replicas) => send<BackupReplicasView>('PUT', `/v1/databases/${databaseId}/backup-replicas`, { replicas }),
      },
    },
    backupDestinations: {
      list: () => get('/v1/backup-destinations'),
      create: (input) => send<{ id: number }>('POST', '/v1/backup-destinations', input),
      update: (id, input) => send<{ ok: boolean }>('PATCH', `/v1/backup-destinations/${id}`, input),
      remove: (id) => send<{ ok: boolean }>('DELETE', `/v1/backup-destinations/${id}`),
      test: (id) => send<{ ok: boolean }>('POST', `/v1/backup-destinations/${id}/test`),
      objects: (id, prefix) =>
        get<BackupDestinationObject[]>(
          `/v1/backup-destinations/${id}/objects${prefix === undefined ? '' : `?prefix=${encodeURIComponent(prefix)}`}`,
        ),
    },
    volumeBackups: {
      // Path segments are user-visible names: encode them like the rest of
      // the client does, or '?'/'#'/'%' in a volume name rewrite the URL.
      list: (volumeName) => get<Backup[]>(`/v1/volumes/${encodeURIComponent(volumeName)}/backups`),
      create: (volumeName, input) =>
        send<Backup>('POST', `/v1/volumes/${encodeURIComponent(volumeName)}/backups`, input),
      restore: (volumeName, backupId) =>
        send<{ ok: boolean }>('POST', `/v1/volumes/${encodeURIComponent(volumeName)}/backups/${backupId}/restore`),
      downloadUrl: (volumeName, backupId) =>
        `/v1/volumes/${encodeURIComponent(volumeName)}/backups/${backupId}/download`,
    },
  };
}
