import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Multi-node T6, the agent side of node databases (agentOps/databases.ts,
 * capability `db.manage`, design §1.1, §1.5, §5.4): `docker.restart`,
 * `db.exec` and the `db.dump` / `db.restore` stream kinds. argv is captured at
 * the `spawnValidated` / `spawnValidatedStream` seam; nothing reaches Docker.
 */

const h = vi.hoisted(() => ({
  calls: [] as string[][],
  streams: [] as string[][],
  /** Containers that carry `ninedeploy.managed=database`. */
  managed: new Set<string>(['nd-db-pg', 'nd-db-cache', 'nd-db-my', 'nd-db-mongo']),
  fail: null as null | ((argv: string[]) => number | null),
}));
vi.mock('../src/lib/spawnValidated.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/spawnValidated.js')>()),
  spawnValidated: vi.fn(async (_exe: string, argv: string[], onLine: (l: string) => void) => {
    h.calls.push(argv);
    const forced = h.fail?.(argv);
    if (forced != null) return forced;
    if (argv[0] === 'inspect' && argv[2] === '{{index .Config.Labels "ninedeploy.managed"}}') {
      if (!h.managed.has(argv[3]!)) return 1;
      onLine('database');
      return 0;
    }
    if (argv.some((a) => a.includes('pg_database_size'))) onLine('4242');
    return 0;
  }),
  spawnValidatedStream: vi.fn((_exe: string, argv: string[]) => {
    h.streams.push(argv);
    return { stdout: Readable.from([Buffer.from('DUMP-')]), stdin: null, exit: Promise.resolve({ code: 0, stderr: '' }), kill: vi.fn() };
  }),
}));

const registry = await import('../src/agentOps/index.js');
const { databaseOps, dbDumpKind, dbRestoreKind } = await import('../src/agentOps/databases.js');
const { STREAM_KIND_HANDLERS } = await import('../src/agentOps/stream.js');
const { AGENT_STREAM_KINDS } = await import('../src/lib/agentStream.js');
const { dumpCommands, restoreCommand } = await import('../src/lib/databaseCommands.js');

const run = (op: string, params: Record<string, unknown>, sealed = true, env: NodeJS.ProcessEnv = {}) => {
  const lines: string[] = [];
  return registry.runRegisteredOp(op, params, (l) => lines.push(l), { sealed }, env).then((code) => ({ code, lines }));
};
const LABEL_CHECK = (cn: string) => ['inspect', '--format', '{{index .Config.Labels "ninedeploy.managed"}}', cn];

beforeEach(() => {
  h.calls.length = 0;
  h.streams.length = 0;
  h.fail = null;
});

describe('registration (M18)', () => {
  it('db.manage ops and stream kinds are registered in the T6 blocks, sealed only', () => {
    expect(registry.AGENT_OP_MODULES).toContain(databaseOps);
    expect(registry.registeredCapabilities()).toContain('db.manage');
    for (const op of ['docker.restart', 'db.exec']) expect(registry.AGENT_OPS.get(op)).toMatchObject({ cap: 'db.manage', sealedOnly: true });
    expect(STREAM_KIND_HANDLERS['db.dump']).toBe(dbDumpKind);
    expect(STREAM_KIND_HANDLERS['db.restore']).toBe(dbRestoreKind);
    expect(AGENT_STREAM_KINDS['db.dump']).toEqual({ direction: 'agent-to-panel', cap: 'db.manage' });
    expect(AGENT_STREAM_KINDS['db.restore']).toEqual({ direction: 'panel-to-agent', cap: 'db.manage' });
  });

  it('refused over the unencrypted transport and by the node owner switch, before anything runs', async () => {
    await expect(run('db.exec', { container: 'nd-db-pg', engine: 'postgres', query: 'size', password: 'x' }, false)).rejects.toThrow(/sealed/);
    await expect(run('docker.restart', { name: 'nd-db-pg' }, true, { NINEDEPLOY_AGENT_DATABASES: 'off' })).rejects.toThrow(/disabled on this node/);
    expect(registry.advertisedCapabilities({ NINEDEPLOY_AGENT_DATABASES: 'off' })).not.toContain('db.manage');
    expect(h.calls).toEqual([]);
  });
});

describe('docker.restart and db.exec', () => {
  it('restart: an nd-db-* container that carries the managed-database label only', async () => {
    await expect(run('docker.restart', { name: 'web-7' })).rejects.toThrow(/nd-db-/);
    await expect(run('docker.restart', { name: 'nd-db-pg', extra: 1 })).rejects.toThrow(/Invalid database param: extra/);
    await expect(run('docker.restart', { name: 'nd-db-rogue' })).rejects.toThrow(/does not exist/);
    expect(h.calls).toEqual([LABEL_CHECK('nd-db-rogue')]);
    h.calls.length = 0;
    expect((await run('docker.restart', { name: 'nd-db-pg' })).code).toBe(0);
    expect(h.calls).toEqual([LABEL_CHECK('nd-db-pg'), ['restart', 'nd-db-pg']]);
  });

  it('db.exec: an enumerated query, the shared builder argv, the output as lines', async () => {
    await expect(run('db.exec', { container: 'nd-db-pg', engine: 'postgres', query: 'DROP TABLE x', password: 'x' })).rejects.toThrow(/query/);
    await expect(run('db.exec', { container: 'nd-db-pg', engine: 'oracle', query: 'size', password: 'x' })).rejects.toThrow(/engine/);
    await expect(run('db.exec', { container: 'nd-db-pg', engine: 'postgres', query: 'size', password: 'a\nb' })).rejects.toThrow(/password/);
    expect(h.calls).toEqual([]);
    const res = await run('db.exec', { container: 'nd-db-pg', engine: 'postgres', query: 'size', password: 'pw' });
    expect(res).toEqual({ code: 0, lines: ['4242'] });
    expect(h.calls[1]).toEqual(['exec', 'nd-db-pg', 'psql', '-U', 'nine', '-d', 'app', '-tAc', 'SELECT pg_database_size(current_database())']);
    // An engine without the query answers a marker, never runs anything.
    h.calls.length = 0;
    expect((await run('db.exec', { container: 'nd-db-pg', engine: 'clickhouse', query: 'size', password: 'pw' })).lines).toEqual(['ND-DB-UNSUPPORTED size clickhouse']);
    expect(h.calls).toEqual([]);
  });
});

describe('the db.dump stream kind', () => {
  it('dumps with the panel host argv inside the container, streams it with cat, removes the temp file', async () => {
    const prepared = await dbDumpKind.prepare({ container: 'nd-db-pg', engine: 'postgres', password: 'pw' }, { maxBytes: 1024 });
    expect(prepared.direction).toBe('agent-to-panel');
    if (prepared.direction !== 'agent-to-panel') return;
    const source = await prepared.start();
    const chunks: Buffer[] = [];
    for await (const c of source.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('DUMP-');
    expect(await source.done).toEqual({ engine: 'postgres' });
    const tmp = (h.calls[1]!.find((a) => a.startsWith('--file=')) ?? '').slice('--file='.length);
    expect(tmp).toMatch(/^\/tmp\/ninedeploy-dump-[0-9a-f-]{36}$/);
    expect(h.calls[1]).toEqual(dumpCommands('postgres', 'nd-db-pg', tmp, 'pw').dump);
    expect(h.streams).toEqual([['exec', 'nd-db-pg', 'cat', tmp]]);
    expect(h.calls.at(-1)).toEqual(['exec', 'nd-db-pg', 'rm', '-f', tmp]);
  });

  it('redis: SAVE, then the server file itself (no temp file)', async () => {
    const prepared = await dbDumpKind.prepare({ container: 'nd-db-cache', engine: 'redis', password: 'pw' }, { maxBytes: 1024 });
    if (prepared.direction !== 'agent-to-panel') throw new Error('direction');
    const source = await prepared.start();
    for await (const _ of source.stream) void _;
    await source.done;
    expect(h.calls.slice(1)).toEqual([['exec', 'nd-db-cache', 'redis-cli', '-a', 'pw', '--no-auth-warning', 'SAVE']]);
    expect(h.streams).toEqual([['exec', 'nd-db-cache', 'cat', '/data/dump.rdb']]);
  });

  it('refuses before any channel: an unsupported engine, a foreign container, unknown params', async () => {
    await expect(dbDumpKind.prepare({ container: 'nd-db-pg', engine: 'clickhouse', password: 'pw' }, { maxBytes: 1 })).rejects.toThrow('backup not supported for clickhouse');
    await expect(dbDumpKind.prepare({ container: 'nd-db-rogue', engine: 'postgres', password: 'pw' }, { maxBytes: 1 })).rejects.toThrow(/does not exist/);
    await expect(dbDumpKind.prepare({ container: '../x', engine: 'postgres', password: 'pw' }, { maxBytes: 1 })).rejects.toThrow(/nd-db-/);
    expect(dbDumpKind.keys).toEqual(['container', 'engine', 'password']);
  });

  it('a failed dump fails the stream and still removes the temp file', async () => {
    h.fail = (argv) => (argv.includes('pg_dump') ? 1 : null);
    const prepared = await dbDumpKind.prepare({ container: 'nd-db-pg', engine: 'postgres', password: 'pw' }, { maxBytes: 1024 });
    if (prepared.direction !== 'agent-to-panel') throw new Error('direction');
    await expect(prepared.start()).rejects.toThrow(/the dump exited with 1/);
    expect(h.calls.at(-1)?.slice(0, 4)).toEqual(['exec', 'nd-db-pg', 'rm', '-f']);
    expect(h.streams).toEqual([]);
  });
});

describe('the db.restore stream kind', () => {
  it('restore: docker cp of the verified file, the panel host restore argv, the temp file removed', async () => {
    const prepared = await dbRestoreKind.prepare({ container: 'nd-db-pg', engine: 'postgres', password: 'pw', mode: 'restore' }, { maxBytes: 1024 });
    if (prepared.direction !== 'panel-to-agent') throw new Error('direction');
    h.calls.length = 0;
    expect(await prepared.apply('/agent/.transfer/abc.part')).toEqual({ engine: 'postgres', mode: 'restore' });
    const tmp = h.calls[0]![2]!.split(':')[1]!;
    expect(h.calls).toEqual([
      ['cp', '/agent/.transfer/abc.part', `nd-db-pg:${tmp}`],
      restoreCommand('postgres', 'nd-db-pg', tmp, 'pw'),
      ['exec', 'nd-db-pg', 'rm', '-f', tmp],
    ]);
  });

  it('redis restore: stop, copy over dump.rdb, start again even when the copy fails (r232)', async () => {
    const prepared = await dbRestoreKind.prepare({ container: 'nd-db-cache', engine: 'redis', password: 'pw' }, { maxBytes: 1024 });
    if (prepared.direction !== 'panel-to-agent') throw new Error('direction');
    h.calls.length = 0;
    h.fail = (argv) => (argv[0] === 'cp' ? 1 : null);
    await expect(prepared.apply('/f')).rejects.toThrow(/docker cp exited with 1/);
    expect(h.calls).toEqual([['stop', 'nd-db-cache'], ['cp', '/f', 'nd-db-cache:/data/dump.rdb'], ['start', 'nd-db-cache']]);
  });

  it('import: the 0.14 importCommand argv with enum plan fields; anything else is refused', async () => {
    const { importCommand } = await import('../src/engine/database.js');
    const prepared = await dbRestoreKind.prepare(
      { container: 'nd-db-my', engine: 'mariadb', password: 'pw', mode: 'import', format: 'mysql_sql', sandboxFlag: '--sandbox' },
      { maxBytes: 1024 },
    );
    if (prepared.direction !== 'panel-to-agent') throw new Error('direction');
    h.calls.length = 0;
    await prepared.apply('/f');
    const tmp = h.calls[0]![2]!.split(':')[1]!;
    expect(tmp).toMatch(/^\/tmp\/ninedeploy-import-/);
    expect(h.calls[1]).toEqual(importCommand('mariadb', 'nd-db-my', tmp, { format: 'mysql_sql', sandboxFlag: '--sandbox' }, 'pw'));
    const bad = (extra: Record<string, unknown>) =>
      dbRestoreKind.prepare({ container: 'nd-db-my', engine: 'mariadb', password: 'pw', mode: 'import', format: 'mysql_sql', ...extra }, { maxBytes: 1 });
    await expect(bad({ format: 'pg_custom' })).rejects.toThrow(/format/);
    await expect(bad({ sandboxFlag: '--init-command=DROP' })).rejects.toThrow(/sandboxFlag/);
    await expect(bad({ drop: 'yes' })).rejects.toThrow(/drop/);
    await expect(dbRestoreKind.prepare({ container: 'nd-db-pg', engine: 'postgres', password: 'pw', mode: 'restore', format: 'pg_plain' }, { maxBytes: 1 })).rejects.toThrow(/restore param/);
    await expect(dbRestoreKind.prepare({ container: 'nd-db-pg', engine: 'postgres', password: 'pw', mode: 'wipe' }, { maxBytes: 1 })).rejects.toThrow(/mode/);
  });
});
