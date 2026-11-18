/** Actual agent registry, archive engine and file framing; only the Docker process boundary is replaced. */
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fault: '', archive: true, calls: [] as string[][], runs: [] as string[][], listing: '', files: new Map<string, Buffer>() }));
vi.mock('../src/lib/exec.js', async (original) => ({
  ...await original<typeof import('../src/lib/exec.js')>(),
  capture: vi.fn(async (_exe: string, args: string[]) => {
    h.calls.push(args);
    if (args[0] === 'volume') {
      const wal = args.at(-1)!.endsWith('-wal');
      if (wal && !h.archive) throw new Error('missing volume');
      return JSON.stringify([{ Labels: { 'ninedeploy.managed': wal ? 'pitr-archive' : 'database', 'ninedeploy.database.id': h.fault === (wal ? 'archive owner' : 'data owner') ? '99' : '42', 'ninedeploy.database.slug': h.fault === 'data slug' ? 'other' : 'main', 'ninedeploy.database.engine': h.fault === 'data engine' ? 'mysql' : 'postgres' } }]);
    }
    if (args[0] === 'inspect') {
      if (args[1] !== 'nd-db-main') return 'true';
      return JSON.stringify([{ Config: { Image: h.fault === 'image' ? 'postgres:17' : 'postgres:18', Labels: { 'ninedeploy.managed': 'database', 'ninedeploy.database.id': h.fault === 'container owner' ? '99' : '42', 'ninedeploy.database.slug': 'main' }, Cmd: h.fault === 'flags' ? [] : ['-c', 'archive_mode=on', '-c', archiveCommand, '-c', 'archive_timeout=60'] }, Mounts: [
        { Name: 'nd-db-main-data', Destination: h.fault === 'data mount' ? '/other' : '/var/lib/postgresql', RW: true },
        { Name: h.fault === 'archive mount' ? 'nd-db-other-data-wal' : 'nd-db-main-data-wal', Destination: '/nd-wal-archive', RW: true },
      ] }]);
    }
    if (args.some((s) => s.includes('stat -c "W %n %s %Y"'))) return h.listing;
    if (args.some((s) => s.includes("current_setting('wal_segment_size')"))) return '16MB|replica';
    return '';
  }),
  run: vi.fn(async (_exe: string, args: string[]) => {
    h.runs.push(args);
    if (args[0] === 'cp') {
      const name = args[1]!.split('/nd-wal-archive/')[1]!;
      const data = h.files.get(name); if (!data) throw new Error('missing archive file');
      await writeFile(args[2]!, data);
    }
  }),
}));

import { PITR_ARCHIVE_COMMAND } from '../src/engine/pitrArchive.js';
import { advertisedCapabilities, runRegisteredOp } from '../src/agentOps/index.js';
import { pitrExportKind } from '../src/agentOps/pitr.js';
import { checkpointSystemIdentifier, unpackCheckpoint } from '../src/engine/pitrCheckpoint.js';
import { unpackPitrWal } from '../src/engine/pitrWalTransfer.js';
import { withNodeDatabaseLifecycle } from '../src/lib/nodeDatabaseLifecycle.js';
import { NODE_PITR_REPLY } from '../src/lib/nodePitrContract.js';
import { closeAllStreamChannels } from '../src/agentOps/stream.js';
import { agentRequestTimeoutMs } from '../src/lib/agentClient.js';
import { PITR_BASE_BACKUP_TIMEOUT_MS } from '../src/engine/postgresPitr.js';

const archiveCommand = `archive_command=${PITR_ARCHIVE_COMMAND}`;
const target = { databaseId: 42, slug: 'main', container: 'nd-db-main', volume: 'nd-db-main-data', version: '18', username: 'nine', dbName: 'app' };
const segment = '000000010000000000000003', label = 'nd-20261117T090000000Z';
let dir: string;
const op = async (action: string, extra: Record<string, unknown> = {}) => {
  const lines: string[] = [];
  const code = await runRegisteredOp('db.pitr', { database: target, action, ...extra }, (s) => lines.push(s), { sealed: true });
  return { code, value: JSON.parse(lines.find((s) => s.startsWith(NODE_PITR_REPLY))!.slice(NODE_PITR_REPLY.length)) };
};
async function exported(selection: Record<string, unknown>) {
  const prepared = await pitrExportKind.prepare({ database: target, selection }, { maxBytes: 1e9 });
  if (prepared.direction !== 'agent-to-panel') throw new Error('wrong direction');
  const source = await prepared.start(), chunks: Buffer[] = [];
  for await (const chunk of source.stream) chunks.push(Buffer.from(chunk));
  await source.done;
  const file = path.join(dir, `wire-${Math.random()}`); await writeFile(file, Buffer.concat(chunks)); return file;
}
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'nd-node-pitr-test-')); h.fault = ''; h.archive = true; h.calls = []; h.runs = []; h.files.clear();
  const wal = gzipSync(Buffer.alloc(16 * 1024 * 1024)); const base = gzipSync(Buffer.from('fixture base'));
  h.files.set(`wal/${segment}.gz`, wal); h.files.set(`wal/${segment}.00000028.backup.gz`, gzipSync(Buffer.from('history')));
  h.files.set(`base/${label}/base.tar.gz`, base); h.files.set(`base/${label}/backup_manifest`, Buffer.from('{"System-Identifier":12345678901234567890,"Files":[]}'));
  h.listing = [`W wal/${segment}.gz ${wal.length} 1794906120`, `B base/${label}/base.tar.gz ${base.length} 1794906060`, `H wal/${segment}.00000028.backup.gz`, `| START WAL LOCATION: 0/3000028 (file ${segment})`, '| START TIME: 2026-11-17 09:00:00 UTC', `| LABEL: ${label}`, '| STOP TIME: 2026-11-17 09:01:00 UTC'].join('\n');
});
afterEach(async () => { closeAllStreamChannels(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

describe('node PostgreSQL archive authority', () => {
  it('allows readiness plus a full base backup, and inventory plus the pruning command, within the RPC budget', () => {
    expect(agentRequestTimeoutMs('db.pitr', { action: 'baseBackup' })).toBeGreaterThan(PITR_BASE_BACKUP_TIMEOUT_MS + 3 * 60_000);
    expect(agentRequestTimeoutMs('db.pitr', { action: 'prune' })).toBeGreaterThan(12 * 60_000);
  });
  it.each(['checkpoint', 'wal'])('opens the registered %s stream with the framework envelope and rejects unknown fields', async (kind) => {
    const lines: string[] = [];
    const selection = kind === 'checkpoint' ? { kind } : { kind, names: [segment], identityBase: label };
    const request = { kind: 'db.pitr.export', direction: 'agent-to-panel', maxBytes: 100_000_000, database: target, selection };
    await expect(runRegisteredOp('stream.open', request, (s) => lines.push(s), { sealed: true })).resolves.toBe(0);
    expect(lines[0]).toMatch(/^ND-STREAM /);
    await expect(runRegisteredOp('stream.open', { ...request, argv: ['sh'] }, () => undefined, { sealed: true })).rejects.toThrow(/Invalid stream param/);
    expect(h.runs).toEqual([]);
  });
  it('requires sealed requests and honors both node owner switches before Docker is touched', async () => {
    await expect(runRegisteredOp('db.pitr', { database: target, action: 'inventory' }, () => undefined, { sealed: false })).rejects.toThrow(/sealed/);
    for (const env of [{ NINEDEPLOY_AGENT_DATABASES: 'off' }, { NINEDEPLOY_AGENT_PITR: 'off' }]) {
      expect(advertisedCapabilities(env)).not.toContain('db.pitr.archive');
      await expect(runRegisteredOp('db.pitr', { database: target, action: 'inventory' }, () => undefined, { sealed: true }, env)).rejects.toThrow(/disabled/);
    }
    expect(h.calls).toEqual([]); expect(h.runs).toEqual([]);
  });
  it.each(['data owner', 'data slug', 'data engine', 'container owner', 'image', 'data mount', 'archive owner', 'archive mount', 'flags'])('refuses an unbound archive: %s', async (fault) => {
    h.fault = fault;
    expect(await op('inventory')).toMatchObject({ code: 1, value: { error: { status: 409, code: 'node_pitr_identity' } } });
    await expect(pitrExportKind.prepare({ database: target, selection: { kind: 'checkpoint' } }, { maxBytes: 1e9 })).rejects.toMatchObject({ code: 'node_pitr_identity' });
    expect(h.runs).toEqual([]);
  });
  it('refuses unvalidated operands, arbitrary selectors and credentials without executing Docker', async () => {
    for (const database of [{ ...target, volume: '../data' }, { ...target, container: 'unmanaged' }, { ...target, version: '18;touch /tmp/pwn' }]) await expect(pitrExportKind.prepare({ database, selection: { kind: 'checkpoint' } }, { maxBytes: 1e9 })).rejects.toThrow();
    await expect(pitrExportKind.prepare({ database: target, selection: { kind: 'wal', names: ['../data'], identityBase: label } }, { maxBytes: 1e9 })).rejects.toThrow();
    await expect(op('inventory', { passphrase: 'must-not-reach-node' })).rejects.toThrow();
    expect(h.calls).toEqual([]);
  });
  it('keeps read-only status available while another node archive mutation owns the lease', async () => {
    await withNodeDatabaseLifecycle(42, async () => {
      expect(await op('inventory')).toMatchObject({ code: 0, value: { inventory: { baseBackups: [{ label }] } } });
      expect(await op('prune', { retentionDays: 7 })).toMatchObject({ code: 1, value: { error: { code: 'node_database_busy' } } });
    });
    expect(h.runs).toEqual([]);
  });
  it('exports an authenticated-layout checkpoint from a read-only helper and removes private scratch', async () => {
    const file = await exported({ kind: 'checkpoint' });
    const unpacked = await unpackCheckpoint(file, path.join(dir, 'unpacked'));
    expect(unpacked.manifest.source).toEqual({ slug: 'main', version: '18', username: 'nine', dbName: 'app' });
    expect(await checkpointSystemIdentifier(unpacked.files[1]!)).toBe('12345678901234567890');
    expect(h.runs.find((a) => a[0] === 'create')).toEqual(expect.arrayContaining(['--network', 'none', 'nd-db-main-data-wal:/nd-wal-archive:ro']));
    const scratch = h.runs.find((a) => a[0] === 'cp')![2]!;
    await expect(access(scratch)).rejects.toThrow();
  });
  it('copies only selected WAL and preserves an exact uint64 cluster identity across the wire', async () => {
    const file = await exported({ kind: 'wal', names: [segment], identityBase: label });
    const copied = await unpackPitrWal(file, path.join(dir, 'wal'), [segment]);
    expect(copied.systemIdentifier).toBe('12345678901234567890'); expect([...copied.files.keys()]).toEqual([segment]);
    expect(h.runs.filter((a) => a[0] === 'cp').some((a) => a[1]!.endsWith('/base.tar.gz'))).toBe(false);
  });
  it.each(['truncated', 'trailing', 'changed selection', 'corrupt content'])('refuses a damaged WAL transfer: %s', async (fault) => {
    const file = await exported({ kind: 'wal', names: [segment], identityBase: label });
    const good = await readFile(file);
    if (fault === 'truncated') await writeFile(file, good.subarray(0, good.length - 1));
    if (fault === 'trailing') await writeFile(file, Buffer.concat([good, Buffer.from('x')]));
    if (fault === 'corrupt content') { good[good.length - 1] ^= 1; await writeFile(file, good); }
    await expect(unpackPitrWal(file, path.join(dir, 'bad'), fault === 'changed selection' ? ['000000010000000000000004'] : [segment])).rejects.toThrow(/Truncated|trailing|selection|integrity/);
  });
});
