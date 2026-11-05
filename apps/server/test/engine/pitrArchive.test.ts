/**
 * R3: engine/pitrArchive.ts and its one consumer, `startDatabase`: a
 * PostgreSQL database with point-in-time recovery on starts with its WAL
 * archive volume mounted and archiving flags after the image; every other
 * database starts exactly as before (the argv fixture of
 * test/databaseArgv015.test.ts pins that).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@ninedeploy/db';

const h = vi.hoisted(() => ({ calls: [] as string[][], volumes: new Set<string>() }));

vi.mock('../../src/lib/exec.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/exec.js')>('../../src/lib/exec.js');
  const answer = (args: string[]): string => {
    h.calls.push(args);
    if (args[0] === 'volume' && args[1] === 'inspect') {
      if (!h.volumes.has(args.at(-1)!)) throw new Error('Error: No such volume');
      return '[{"Name":"x"}]';
    }
    if (args[0] === 'volume' && args[1] === 'create') h.volumes.add(args.at(-1)!);
    if (args[0] === 'inspect') return 'exited\n';
    return '';
  };
  return {
    ...actual,
    capture: vi.fn(async (_c: string, args: string[]) => answer(args)),
    run: vi.fn(async (_c: string, args: string[]) => { answer(args); }),
  };
});
vi.mock('../../src/lib/dockerPull.js', () => ({ ensureDockerImage: vi.fn(async () => undefined), pullDockerImage: vi.fn(async () => undefined) }));
vi.mock('../../src/lib/crypto.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/crypto.js')>('../../src/lib/crypto.js');
  return { ...actual, decrypt: () => 'pw' };
});

import { startDatabase } from '../../src/engine/database.js';
import {
  ensurePitrArchive, PITR_ARCHIVE_COMMAND, pitrArchiveLabels, pitrArchiveVolume, pitrArchiving, pitrServerArgs,
} from '../../src/engine/pitrArchive.js';

const row = (over: Partial<Database> = {}): Database => ({
  id: 7, name: 'main', slug: 'main', engine: 'postgres', version: null, status: 'running', containerName: 'nd-db-main', volumeName: 'nd-db-main-data',
  username: 'nine', passwordEncrypted: 'x', dbName: 'app', memLimitMb: 0, cpuLimitMilli: 0, cpuShares: 0, ownerUserId: 3,
  pitrEnabled: true, serverId: null, ...over,
} as unknown as Database);

beforeEach(() => {
  h.calls = [];
  h.volumes = new Set(['nd-db-main-data']);
});

describe('which databases archive', () => {
  it('PostgreSQL with PITR on, on the panel host only', () => {
    expect(pitrArchiving(row())).toBe(true);
    expect(pitrArchiving(row({ pitrEnabled: false }))).toBe(false);
    expect(pitrArchiving(row({ engine: 'mysql' }))).toBe(false);
    expect(pitrArchiving(row({ serverId: 2 }))).toBe(false);
    // A row from before the column (undefined) never archives.
    expect(pitrArchiving(row({ pitrEnabled: undefined as unknown as boolean }))).toBe(false);
    expect(pitrArchiveVolume('nd-db-main-data')).toBe('nd-db-main-data-wal');
  });
  it('archives into the volume, refusing to overwrite a different file, and switches segments once a minute', () => {
    expect(pitrServerArgs()).toEqual(['-c', 'archive_mode=on', '-c', `archive_command=${PITR_ARCHIVE_COMMAND}`, '-c', 'archive_timeout=60']);
    expect(PITR_ARCHIVE_COMMAND).toContain('gzip -dc "$f" | cmp -s - "%p"');
    expect(PITR_ARCHIVE_COMMAND).toContain('sync "$f.part" && mv "$f.part" "$f"');
    expect(pitrArchiveLabels(row(), 'postgres:18')).toMatchObject({ 'ninedeploy.managed': 'pitr-archive', 'ninedeploy.database.slug': 'main', 'ninedeploy.owner': '3' });
  });
});

describe('ensurePitrArchive', () => {
  it('creates the labelled volume once and lets the image chown it for its postgres user', async () => {
    const exists = async (name: string) => h.volumes.has(name);
    await ensurePitrArchive(row(), 'postgres:18', () => undefined, exists);
    const create = h.calls.find((c) => c[0] === 'volume' && c[1] === 'create')!;
    expect(create.at(-1)).toBe('nd-db-main-data-wal');
    expect(create).toEqual(expect.arrayContaining(['--label', 'ninedeploy.managed=pitr-archive']));
    const chown = h.calls.find((c) => c[0] === 'run')!;
    expect(chown).toEqual(expect.arrayContaining(['--network', 'none', '--user', '0', '-v', 'nd-db-main-data-wal:/nd-wal-archive', 'postgres:18']));
    expect(chown.slice(-2)).toEqual(['sh', '/nd-wal-archive']);
    h.calls = [];
    await ensurePitrArchive(row(), 'postgres:18', () => undefined, exists);
    expect(h.calls.some((c) => c[0] === 'volume')).toBe(false);
    await expect(ensurePitrArchive(row({ volumeName: null }), 'postgres:18', () => undefined, exists)).rejects.toThrow(/no volume name/);
  });
});

describe('startDatabase', () => {
  const runArgs = () => h.calls.find((c) => c[0] === 'run' && c.includes('-d'))!;
  it('mounts the archive and adds the archiving flags after the image when PITR is on', async () => {
    await startDatabase(row(), () => undefined);
    const args = runArgs();
    expect(args).toEqual(expect.arrayContaining(['-v', 'nd-db-main-data:/var/lib/postgresql', '-v', 'nd-db-main-data-wal:/nd-wal-archive']));
    expect(args.slice(args.indexOf('postgres:18') + 1)).toEqual(pitrServerArgs());
    expect(h.volumes.has('nd-db-main-data-wal')).toBe(true);
  });
  it('starts exactly as before when PITR is off', async () => {
    await startDatabase(row({ pitrEnabled: false }), () => undefined);
    const args = runArgs();
    expect(args.join(' ')).not.toContain('nd-wal-archive');
    expect(args.at(-1)).toBe('postgres:18');
    expect(h.volumes.has('nd-db-main-data-wal')).toBe(false);
  });
});
