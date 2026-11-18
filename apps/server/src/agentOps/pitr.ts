/** Node-owned WAL operations and read-only, sealed archive export. S3 secrets never reach this module. */
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Database } from '@ninedeploy/db';
import { config } from '../config.js';
import { capture } from '../lib/exec.js';
import { HttpError } from '../lib/errors.js';
import { withNodeDatabaseLifecycle } from '../lib/nodeDatabaseLifecycle.js';
import { NODE_PITR_CAPABILITY, NODE_PITR_REPLY, nodePitrExport, nodePitrRequest, type NodePitrIdentity } from '../lib/nodePitrContract.js';
import { ENGINES, resolveVolumePath, volumeExists } from '../engine/database.js';
import { ensurePitrArchive, PITR_ARCHIVE_MOUNT, pitrArchiveVolume, pitrServerArgs } from '../engine/pitrArchive.js';
import { pitrPreflight, pitrArchiverStats, takePitrBaseBackup, prunePitrArchive, readPitrInventory, removePitrArchive } from '../engine/postgresPitr.js';
import { copyPitrWal, createPitrCheckpoint } from '../engine/pitrCheckpoint.js';
import { packPitrWal } from '../engine/pitrWalTransfer.js';
import type { AgentOpModule } from './index.js';
import type { StreamKindHandler } from './stream.js';
import { switchedOff } from './operands.js';

const refuse = (message: string) => new HttpError(409, 'node_pitr_identity', message);
function enabled() {
  if (switchedOff(process.env['NINEDEPLOY_AGENT_DATABASES']) || switchedOff(process.env['NINEDEPLOY_AGENT_PITR'])) throw new HttpError(403, 'node_pitr_disabled', 'PostgreSQL archiving is disabled by the node owner');
}
type InspectedContainer = { Config: { Image: string; Labels?: Record<string, string>; Cmd?: string[] }; Mounts?: Array<{ Name?: string; Destination?: string; RW?: boolean }> };

/** Bind the row id/slug to its labelled data volume, actual PostgreSQL image and mounts. */
async function bound(input: NodePitrIdentity, archive: boolean, requireContainer = false): Promise<Database> {
  enabled();
  const data = JSON.parse(await capture('docker', ['volume', 'inspect', input.volume])) as Array<{ Labels?: Record<string, string> }>;
  const labels = data[0]?.Labels;
  if (labels?.['ninedeploy.managed'] !== 'database' || labels['ninedeploy.database.id'] !== String(input.databaseId) || labels['ninedeploy.database.slug'] !== input.slug || labels['ninedeploy.database.engine'] !== 'postgres') throw refuse('The data volume is not this managed PostgreSQL database');
  const containerText = await capture('docker', ['inspect', input.container]).catch(() => null);
  const container = containerText === null ? null : (JSON.parse(containerText) as InspectedContainer[])[0];
  if (requireContainer && !container) throw refuse('The managed PostgreSQL container is missing');
  if (container) {
    const c = container.Config;
    if (c.Labels?.['ninedeploy.managed'] !== 'database' || c.Labels['ninedeploy.database.id'] !== String(input.databaseId) || c.Labels['ninedeploy.database.slug'] !== input.slug || c.Image !== ENGINES.postgres!.image(input.version)) throw refuse('The PostgreSQL container identity or image changed');
    if (!container.Mounts?.some((m) => m.Name === input.volume && m.Destination === resolveVolumePath(ENGINES.postgres!, input.version) && m.RW)) throw refuse('The PostgreSQL data mount changed');
    if (archive && (!container.Mounts.some((m) => m.Name === pitrArchiveVolume(input.volume) && m.Destination === PITR_ARCHIVE_MOUNT && m.RW) || JSON.stringify(c.Cmd) !== JSON.stringify(pitrServerArgs()))) throw refuse('The PostgreSQL container is not running with the expected WAL archive configuration');
  }
  const wal = pitrArchiveVolume(input.volume), exists = await volumeExists(wal);
  if (exists) {
    const inspected = JSON.parse(await capture('docker', ['volume', 'inspect', wal])) as Array<{ Labels?: Record<string, string> }>;
    const a = inspected[0]?.Labels;
    if (a?.['ninedeploy.managed'] !== 'pitr-archive' || a['ninedeploy.database.id'] !== String(input.databaseId) || a['ninedeploy.database.slug'] !== input.slug) throw refuse('The WAL archive belongs to another database');
  } else if (archive) throw refuse('The node WAL archive is missing');
  return { id: input.databaseId, slug: input.slug, name: input.slug, engine: 'postgres', serverId: null, volumeName: input.volume, containerName: input.container, version: input.version, username: input.username, dbName: input.dbName, ownerUserId: null, pitrEnabled: archive } as Database;
}

export const pitrOps: AgentOpModule = {
  name: 'agentOps/pitr.ts', caps: [NODE_PITR_CAPABILITY],
  ops: { 'db.pitr': { cap: NODE_PITR_CAPABILITY, sealedOnly: true, async run(params, onLine) {
    const request = nodePitrRequest.parse(params);
    try {
      const operation = async () => {
        const action = request.action;
        const d = await bound(request.database, ['verify', 'inventory', 'archiver', 'baseBackup', 'prune'].includes(action), ['verify', 'preflight', 'baseBackup'].includes(action));
        const log = (line: string) => onLine(line);
        switch (action) {
          case 'prepare': await ensurePitrArchive(d, ENGINES.postgres!.image(d.version!), log, volumeExists, { 'ninedeploy.database.id': String(d.id) }); return { prepared: true };
          case 'verify': return { verified: true };
          case 'preflight': return { refusal: await pitrPreflight(d) };
          case 'archiveExists': return { exists: await volumeExists(pitrArchiveVolume(d.volumeName!)) };
          case 'inventory': return { inventory: await readPitrInventory(d) };
          case 'archiver': return { archiver: await pitrArchiverStats(d) };
          case 'baseBackup': return { label: await takePitrBaseBackup(d, log) };
          case 'prune': return await prunePitrArchive(d, request.retentionDays!, log);
          case 'removeArchive': await removePitrArchive(d, log); return { removed: true };
        }
      };
      const result = ['preflight', 'verify', 'archiveExists', 'inventory', 'archiver'].includes(request.action) ? await operation() : await withNodeDatabaseLifecycle(request.database.databaseId, operation);
      onLine(`${NODE_PITR_REPLY}${JSON.stringify(result)}`); return 0;
    } catch (err) {
      const failure = err instanceof HttpError ? err : new HttpError(502, 'node_pitr_failed', 'The node could not complete the PostgreSQL archive operation');
      onLine(`${NODE_PITR_REPLY}${JSON.stringify({ error: { status: failure.statusCode, code: failure.code, message: failure.message } })}`); return 1;
    }
  } } },
};

export const pitrExportKind: StreamKindHandler = {
  keys: ['database', 'selection'],
  async prepare(params) {
    // stream.open validates these envelope keys before forwarding the whole request to the kind.
    const { kind: _kind, direction: _direction, maxBytes: _maxBytes, ...operands } = params;
    const request = nodePitrExport.parse(operands);
    await bound(request.database, true);
    return { direction: 'agent-to-panel', async start() {
      const root = path.join(config.paths.dataDir, 'pitr-node-export');
      await mkdir(root, { recursive: true, mode: 0o700 });
      const dir = await mkdtemp(path.join(root, 'copy-'));
      try {
        const file = await withNodeDatabaseLifecycle(request.database.databaseId, async () => {
          const d = await bound(request.database, true);
          if (request.selection.kind === 'checkpoint') return (await createPitrCheckpoint(d, dir, () => undefined, request.selection.throughSegment ? { throughSegment: request.selection.throughSegment } : undefined)).file;
          const copied = await copyPitrWal(d, request.selection.names, dir, () => undefined, request.selection.identityBase);
          const output = path.join(dir, 'transfer'); await packPitrWal(copied, output); return output;
        });
        const stream = createReadStream(file);
        let cleaning: Promise<void> | undefined;
        const clean = () => cleaning ??= rm(dir, { recursive: true, force: true });
        const done = new Promise<Record<string, unknown>>((resolve, reject) => {
          stream.once('close', () => { void clean().then(() => resolve({ kind: request.selection.kind }), reject); });
          stream.once('error', reject);
        });
        done.catch(() => undefined);
        return { stream, done, abort() { stream.destroy(); void clean().catch(() => undefined); } };
      } catch (err) { await rm(dir, { recursive: true, force: true }); throw err; }
    } };
  },
};
