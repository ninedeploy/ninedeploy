/**
 * backupDrill — the staging, container bookkeeping and housekeeping branches
 * the main suite (backupDrill.test.ts) does not reach. Same seams: exec,
 * backupCrypto and backupRemote are mocked, the DB is the fake from helpers.
 */
import { existsSync } from 'node:fs';
import { mkdir, open, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TMP = join(tmpdir(), `ninedeploy-drill-cov-${process.pid}-${Date.now()}`);

const PG_PLAIN = '--\n-- PostgreSQL database dump\n--\nSET x = 0;\n--\n-- PostgreSQL database dump complete\n--\n';

type ExecReply = { stdout?: string; lines?: string[]; throw?: unknown } | undefined;

const { dbState, execState, cryptoState, remoteState } = vi.hoisted(() => {
  process.env['NINEDEPLOY_MASTER_KEY'] = 'cd'.repeat(32);
  return {
    dbState: {
      databases: new Map<number, { id: number; engine: string; version?: string | null }>(),
      backups: new Map<number, { id: number; databaseId: number; path: string; remoteKey: string | null }>(),
      drills: new Map<number, Record<string, unknown>>(),
      nextDrillId: 1,
      insertReturnsNothing: false,
    },
    execState: {
      calls: [] as Array<{ cmd: string; args: string[] }>,
      handler: (_cmd: string, _args: string[]): { stdout?: string; lines?: string[]; throw?: unknown } | undefined => undefined,
    },
    cryptoState: { encryptedPaths: new Set<string>(), decryptError: null as Error | null },
    remoteState: { body: '' as string | Buffer, fetched: [] as string[] },
  };
});

vi.mock('../../src/lib/exec.js', () => {
  class ExecTimeoutError extends Error {}
  const record = (cmd: string, args: string[]) => {
    execState.calls.push({ cmd, args });
    return execState.handler(cmd, args);
  };
  return {
    ExecTimeoutError,
    capture: vi.fn(async (cmd: string, args: string[]) => {
      const r = record(cmd, args);
      if (r?.throw !== undefined) throw r.throw;
      return r?.stdout ?? '';
    }),
    run: vi.fn(async (cmd: string, args: string[], _opts: unknown, sink: (line: string) => void) => {
      const r = record(cmd, args);
      for (const line of r?.lines ?? []) sink(line);
      if (r?.throw !== undefined) throw r.throw;
    }),
  };
});

vi.mock('../../src/lib/backupCrypto.js', () => ({
  isEncryptedBackupFile: vi.fn(async (p: string) => cryptoState.encryptedPaths.has(p)),
  decryptBackupFile: vi.fn(async () => {
    if (cryptoState.decryptError) throw cryptoState.decryptError;
  }),
}));

vi.mock('../../src/lib/backupRemote.js', () => ({
  fetchRemoteBackup: vi.fn(async (_db: unknown, _remote: unknown, dest: string) => {
    remoteState.fetched.push(dest);
    await writeFile(dest, remoteState.body);
  }),
}));

import { encrypt } from '../../src/lib/crypto.js';
import { findDrillById, listBackupDrills, pruneDrillLeftovers, runBackupDrill, validateDumpFile } from '../../src/lib/backupDrill.js';
import { createFakeDb } from '../helpers.js';

const idOf = (args: unknown) =>
  (args as { where?: { queryChunks?: Array<{ value?: unknown }> } })?.where?.queryChunks?.find((c) => typeof c?.value === 'number')?.value as number | undefined;

function buildDb() {
  return createFakeDb({
    findFirst: {
      databases: (args: unknown) => dbState.databases.get(idOf(args) ?? -1),
      backups: (args: unknown) => dbState.backups.get(idOf(args) ?? -1),
      backupDrills: (args: unknown) => dbState.drills.get(idOf(args) ?? -1),
    },
    insert: {
      backupDrills: (value: Record<string, unknown>) => {
        if (dbState.insertReturnsNothing) return [];
        const id = dbState.nextDrillId++;
        const row = { id, ...value, durationMs: 0, error: null, detailsJson: null, startedAt: new Date(), completedAt: null };
        dbState.drills.set(id, row);
        return [row];
      },
    },
    update: {
      backupDrills: (value: Record<string, unknown>) => {
        const last = [...dbState.drills.entries()].pop();
        if (last) Object.assign(last[1], value);
        return [{ ...last?.[1] }];
      },
    },
    select: {
      backupDrills: () => [...dbState.drills.values()],
      backup_drills: () => [...dbState.drills.values()],
    },
  });
}

function seed(engine: string, path: string, version: string | null = null, remoteKey: string | null = null) {
  dbState.databases.set(1, { id: 1, engine, version });
  dbState.backups.set(1, { id: 1, databaseId: 1, path, remoteKey });
}

async function dumpFile(name: string, body: string | Buffer): Promise<string> {
  const p = join(TMP, name);
  await writeFile(p, body);
  return p;
}

function dockerReplies(over: Record<string, ExecReply> = {}): (cmd: string, args: string[]) => ExecReply {
  return (cmd, args) => {
    if (cmd !== 'docker') return { throw: new Error(`spawn ${cmd} ENOENT`) };
    if (args[0]! in over) return over[args[0]!];
    if (args[0] === 'image') return { stdout: 'sha256:abc\n' };
    if (args[0] === 'create') return { stdout: 'cid9\n' };
    return undefined;
  };
}

beforeEach(async () => {
  await mkdir(TMP, { recursive: true });
  dbState.databases.clear();
  dbState.backups.clear();
  dbState.drills.clear();
  dbState.nextDrillId = 1;
  dbState.insertReturnsNothing = false;
  execState.calls = [];
  execState.handler = dockerReplies();
  cryptoState.encryptedPaths.clear();
  cryptoState.decryptError = null;
  remoteState.body = PG_PLAIN;
  remoteState.fetched = [];
});

afterEach(async () => {
  await rm(TMP, { recursive: true, force: true });
});

describe('staging: legacy envelopes and failures after a fetch', () => {
  it('decrypts a legacy single-line v<n>: envelope to a sibling temp file and removes it', async () => {
    const file = await dumpFile('legacy.sql', encrypt(Buffer.from(PG_PLAIN).toString('base64')));
    seed('postgres', file);
    const result = await runBackupDrill(buildDb(), 1, 1);
    expect(result).toMatchObject({ status: 'passed', error: null, details: { tool: 'pg_dump-structure' } });
    expect(result.drillId).toBe(1);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(TMP)).filter((n) => n.endsWith('-drill.dec'))).toEqual([]);
  });

  it('a fetched legacy envelope that cannot be decrypted fails setup and drops the fetched copy (F134)', async () => {
    remoteState.body = 'v0:not:a:real-envelope';
    seed('postgres', join(TMP, 'gone.sql'), null, 's3://bucket/legacy');
    const result = await runBackupDrill(buildDb(), 1, 1);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/^Drill setup failed: /);
    expect(remoteState.fetched).toHaveLength(1);
    expect(remoteState.fetched[0]).toMatch(/nd-drill-\d+-1-\d+\.dump$/);
    expect(existsSync(remoteState.fetched[0]!)).toBe(false);
  });

  it('an encrypted backup whose decryption throws fails setup with the message', async () => {
    const file = await dumpFile('enc.dump', 'NDBK1:x');
    cryptoState.encryptedPaths.add(file);
    cryptoState.decryptError = new Error('bad master key');
    seed('postgres', file);
    const result = await runBackupDrill(buildDb(), 1, 1);
    expect(result).toMatchObject({ status: 'failed', error: 'Drill setup failed: bad master key' });
  });

  it('a non-Error thrown during setup is stringified', async () => {
    const { fetchRemoteBackup } = await import('../../src/lib/backupRemote.js');
    vi.mocked(fetchRemoteBackup).mockRejectedValueOnce('bucket unreachable');
    seed('postgres', join(TMP, 'gone.sql'), null, 's3://bucket/x');
    expect((await runBackupDrill(buildDb(), 1, 1)).error).toBe('Drill setup failed: bucket unreachable');
  });

  it('cleanup tolerates scratch files that never appeared (best-effort unlink)', async () => {
    // The fetch "succeeds" without writing, so the header sniff, the validator
    // and the unlink of the fetched copy all meet a missing file.
    const { fetchRemoteBackup } = await import('../../src/lib/backupRemote.js');
    vi.mocked(fetchRemoteBackup).mockImplementationOnce(async (_db, _remote, dest) => { remoteState.fetched.push(dest); });
    seed('postgres', join(TMP, 'gone.sql'), null, 's3://bucket/empty');
    const fetchedResult = await runBackupDrill(buildDb(), 1, 1);
    expect(fetchedResult.status).toBe('failed');
    expect(fetchedResult.error).toMatch(/^Drill setup failed: .*ENOENT/);

    // The decryption "succeeds" without writing its plaintext file.
    const enc = await dumpFile('enc2.dump', 'NDBK1:x');
    cryptoState.encryptedPaths.add(enc);
    seed('postgres', enc);
    const decResult = await runBackupDrill(buildDb(), 1, 1);
    expect(decResult.error).toMatch(/^Drill setup failed: .*ENOENT/);
  });

  it('throws when the running row cannot be inserted', async () => {
    dbState.insertReturnsNothing = true;
    seed('postgres', await dumpFile('pg.sql', PG_PLAIN));
    await expect(runBackupDrill(buildDb(), 1, 1)).rejects.toThrow('Failed to insert backup_drills row');
  });
});

describe('drill container bookkeeping', () => {
  it('is unverifiable when the drill container cannot be created', async () => {
    const file = await dumpFile('dump.rdb', 'REDIS0012');
    execState.handler = dockerReplies({ create: { throw: 'no space for the container' } });
    const r = await validateDumpFile('redis', file, 'redis:8');
    expect(r).toMatchObject({ outcome: 'unverifiable', details: { tool: 'redis-check-rdb', image: 'redis:8' } });
    expect((r as { error: string }).error).toMatch(/could not create a redis:8 drill container \(no space for the container\)/);
  });

  it('is unverifiable when the dump cannot be copied in, and still removes the container', async () => {
    const file = await dumpFile('dump.rdb', 'REDIS0012');
    execState.handler = dockerReplies({ cp: { throw: new Error('copy failed') } });
    const r = await validateDumpFile('valkey', file, 'valkey/valkey:9');
    expect((r as { error: string }).error).toMatch(/could not copy the dump into the drill container \(copy failed\)/);
    expect(execState.calls.at(-1)).toEqual({ cmd: 'docker', args: ['rm', '-f', 'cid9'] });
  });

  it('a rejection with no tool output names only the error; the rm failure is ignored', async () => {
    const file = await dumpFile('dump.rdb', 'REDIS0012');
    execState.handler = dockerReplies({ start: { throw: new Error('exit 1') }, rm: { throw: new Error('rm failed') } });
    const r = await validateDumpFile('dragonfly', file, 'df:1');
    expect(r).toMatchObject({ outcome: 'failed', error: 'redis-check-rdb rejected the file (exit 1)' });
  });

  it('keeps only the last 40 lines of tool output', async () => {
    const file = await dumpFile('pg.dump', 'PGDMP\x01binary');
    const lines = Array.from({ length: 45 }, (_, i) => `${i}; 1259 1 TABLE public t${i} nine`);
    execState.handler = dockerReplies({ start: { lines } });
    const r = await validateDumpFile('postgres', file, 'postgres:18');
    expect(r).toMatchObject({ outcome: 'passed', details: { objectCount: 40 } });
  });

  it('ClickHouse output without a file-count summary reports files: null', async () => {
    const file = await dumpFile('ch.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));
    execState.handler = dockerReplies({ start: { lines: ['Archive: x'] } });
    expect(await validateDumpFile('clickhouse', file, 'ch:1')).toMatchObject({ outcome: 'passed', details: { files: null } });
  });
});

describe('validateDumpFile without a known image', () => {
  it.each([
    ['redis', 'dump.rdb', 'REDIS0012', /no redis image is known/],
    ['keydb', 'dump.rdb', 'REDIS0012', /no keydb image is known/],
    ['postgres', 'pg.dump', 'PGDMP\x01', /no postgres image is known/],
    ['clickhouse', 'ch.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04]), /no clickhouse image is known/],
    ['meilisearch', 'm.dump', Buffer.from([0x1f, 0x8b, 0x08]), /no meilisearch image is known/],
  ] as const)('%s is unverifiable and runs no docker', async (engine, name, body, error) => {
    const r = await validateDumpFile(engine, await dumpFile(name, body), null);
    expect(r.outcome).toBe('unverifiable');
    expect((r as { error: string }).error).toMatch(error);
    expect(execState.calls).toEqual([]);
  });

  it('an unknown engine is not supported', async () => {
    expect(await validateDumpFile('etcd', await dumpFile('x', 'y'), null)).toMatchObject({ outcome: 'failed', error: 'Drill not supported for engine "etcd"' });
  });

  it('a RabbitMQ definitions file above 64 MiB is not parsed', async () => {
    const file = join(TMP, 'huge.json');
    const handle = await open(file, 'w');
    try { await handle.truncate(64 * 1024 * 1024 + 1); } finally { await handle.close(); }
    const r = await validateDumpFile('rabbitmq', file, null);
    expect(r).toMatchObject({ outcome: 'unverifiable', error: 'unverifiable: tool unavailable — the definitions file is larger than 64 MiB' });
  });

  it('a JSON null RabbitMQ file is not an object', async () => {
    expect(await validateDumpFile('rabbitmq', await dumpFile('null.json', 'null'), null)).toMatchObject({ outcome: 'failed', error: 'Not a RabbitMQ definitions file: not a JSON object' });
  });
});

describe('list / find with numeric timestamps', () => {
  it('passes numeric startedAt through and keeps a null completedAt', async () => {
    dbState.drills.set(7, { id: 7, databaseId: 1, backupId: 1, status: 'running', engine: 'redis', durationMs: 0, error: null, detailsJson: null, startedAt: 1234, completedAt: null });
    const db = buildDb();
    const [row] = await listBackupDrills(db, 1);
    expect(row).toMatchObject({ id: 7, startedAt: 1234, completedAt: null, details: null });
    expect(await findDrillById(db, 7)).toMatchObject({ databaseId: 1, startedAt: 1234, completedAt: null, details: null });
  });
});

describe('pruneDrillLeftovers (r302)', () => {
  it('removes only old drill scratch files, skipping directories, fresh files and missing dirs', async () => {
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    const names = ['a.dump.123-4-drill.dec', 'nd-drill-1-2.dump', 'nd-drill-1-2-3.dump'];
    for (const n of names) {
      await writeFile(join(TMP, n), 'x');
      await utimes(join(TMP, n), old, old);
    }
    await writeFile(join(TMP, 'fresh-drill.dec'), 'x');
    await writeFile(join(TMP, 'nd-drill-x.dump'), 'x');
    await writeFile(join(TMP, 'unrelated.sql'), 'x');
    await utimes(join(TMP, 'unrelated.sql'), old, old);
    await mkdir(join(TMP, 'dir-drill.dec'));
    await utimes(join(TMP, 'dir-drill.dec'), old, old);

    const removed = await pruneDrillLeftovers([join(TMP, 'missing'), TMP], 60 * 60_000);

    expect(removed).toBe(3);
    for (const n of names) expect(existsSync(join(TMP, n))).toBe(false);
    for (const n of ['fresh-drill.dec', 'nd-drill-x.dump', 'unrelated.sql', 'dir-drill.dec']) expect(existsSync(join(TMP, n))).toBe(true);
  });
});
