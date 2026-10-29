import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * agentOps/databases.ts, the paths agentOpsDatabases.test.ts leaves open: the
 * G1.8 extra engines (ClickHouse, Meilisearch, RabbitMQ) dumped and restored
 * through the panel host's routines on a node temp file, a container that
 * exists but is not labelled a managed database, the streamed dump's failure
 * and abort paths, and the import plan's boolean fields. Docker is never
 * reached: argv is captured at the spawnValidated seam and the extra-engine
 * routines are faked.
 */

const h = vi.hoisted(() => ({
  calls: [] as string[][],
  streams: [] as string[][],
  label: new Map<string, string>([
    ['nd-db-ch', 'database'],
    ['nd-db-meili', 'database'],
    ['nd-db-rmq', 'database'],
    ['nd-db-pg', 'database'],
    ['nd-db-app', 'web'],
  ]),
  fail: null as null | ((argv: string[]) => number | null),
  inspect: new Map<string, string[]>(),
  exit: null as null | Promise<{ code: number; stderr: string }>,
  kills: 0,
  backupWrites: 'EXTRA-DUMP' as string | 'none' | 'dir',
  backupThrows: null as Error | null,
  extra: [] as Array<{ fn: string; target: Record<string, unknown>; file: string }>,
}));

vi.mock('../src/lib/spawnValidated.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/spawnValidated.js')>()),
  spawnValidated: vi.fn(async (_exe: string, argv: string[], onLine: (l: string) => void) => {
    h.calls.push(argv);
    const forced = h.fail?.(argv);
    if (forced != null) return forced;
    if (argv[0] === 'inspect' && argv[2] === '{{index .Config.Labels "ninedeploy.managed"}}') {
      const label = h.label.get(argv[3]!);
      if (label === undefined) return 1;
      onLine('');
      onLine(label);
      return 0;
    }
    if (argv[0] === 'inspect') {
      for (const l of h.inspect.get(argv[2]!) ?? []) onLine(l);
      return 0;
    }
    return 0;
  }),
  spawnValidatedStream: vi.fn((_exe: string, argv: string[]) => {
    h.streams.push(argv);
    return {
      stdout: Readable.from([Buffer.from('DUMP-')]),
      stdin: null,
      exit: h.exit ?? Promise.resolve({ code: 0, stderr: '' }),
      kill: () => {
        h.kills += 1;
      },
    };
  }),
}));

const fakeBackup = (fn: string) =>
  vi.fn(async (target: Record<string, unknown>, file: string) => {
    h.extra.push({ fn, target, file });
    if (h.backupThrows) throw h.backupThrows;
    if (h.backupWrites === 'dir') mkdirSync(file);
    else if (h.backupWrites !== 'none') writeFileSync(file, h.backupWrites);
  });
const fakeRestore = (fn: string) =>
  vi.fn(async (target: Record<string, unknown>, file: string) => {
    h.extra.push({ fn, target, file });
  });

vi.mock('../src/engine/extraEngineBackups.js', () => ({
  backupClickhouse: fakeBackup('backupClickhouse'),
  backupMeilisearch: fakeBackup('backupMeilisearch'),
  backupRabbitmq: fakeBackup('backupRabbitmq'),
  restoreClickhouse: fakeRestore('restoreClickhouse'),
  restoreMeilisearch: fakeRestore('restoreMeilisearch'),
  restoreRabbitmq: fakeRestore('restoreRabbitmq'),
}));

const registry = await import('../src/agentOps/index.js');
const { dbDumpKind, dbRestoreKind } = await import('../src/agentOps/databases.js');

const IMAGE_FORMAT = '{{.Config.Image}}';
const MOUNTS_FORMAT = '{{range .Mounts}}{{.Destination}}={{.Name}}{{println}}{{end}}';

beforeEach(() => {
  h.calls.length = 0;
  h.streams.length = 0;
  h.fail = null;
  h.inspect.clear();
  h.exit = null;
  h.kills = 0;
  h.backupWrites = 'EXTRA-DUMP';
  h.backupThrows = null;
  h.extra.length = 0;
});

async function dumpSource(container: string, engine: string) {
  const prepared = await dbDumpKind.prepare({ container, engine, password: 'pw' }, { maxBytes: 1024 });
  if (prepared.direction !== 'agent-to-panel') throw new Error('direction');
  return prepared;
}

async function restorer(params: Record<string, unknown>) {
  const prepared = await dbRestoreKind.prepare({ password: 'pw', ...params }, { maxBytes: 1024 });
  if (prepared.direction !== 'panel-to-agent') throw new Error('direction');
  return prepared;
}

async function drain(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString();
}

describe('the managed-database label check', () => {
  it('refuses an existing nd-db-* container that is not labelled a managed database', async () => {
    const run = registry.runRegisteredOp('docker.restart', { name: 'nd-db-app' }, () => undefined, { sealed: true }, {});
    await expect(run).rejects.toThrow('Container nd-db-app is not a managed database on this node');
    expect(h.calls).toEqual([['inspect', '--format', '{{index .Config.Labels "ninedeploy.managed"}}', 'nd-db-app']]);
    await expect(dbDumpKind.prepare({ container: 'nd-db-app', engine: 'clickhouse', password: 'pw' }, { maxBytes: 1 })).rejects.toThrow(/not a managed database/);
    await expect(dbRestoreKind.prepare({ container: 'nd-db-app', engine: 'postgres', password: 'pw' }, { maxBytes: 1 })).rejects.toThrow(/not a managed database/);
  });

  it('refuses an oversized container name and an oversized password before anything runs', async () => {
    await expect(dbDumpKind.prepare({ container: `nd-db-${'a'.repeat(130)}`, engine: 'postgres', password: 'pw' }, { maxBytes: 1 })).rejects.toThrow(/Invalid database container/);
    await expect(dbDumpKind.prepare({ container: 'nd-db-pg', engine: 'postgres', password: 'x'.repeat(1025) }, { maxBytes: 1 })).rejects.toThrow('Invalid database password');
    await expect(dbDumpKind.prepare({ container: 'nd-db-pg', engine: 'postgres', password: 42 }, { maxBytes: 1 })).rejects.toThrow('Invalid database password');
    expect(h.calls).toEqual([]);
  });
});

describe('G1.8 extra-engine dumps on a node temp file', () => {
  it.each([
    ['clickhouse', 'nd-db-ch', 'backupClickhouse', { cn: 'nd-db-ch', password: 'pw', username: 'nine' }],
    ['meilisearch', 'nd-db-meili', 'backupMeilisearch', { cn: 'nd-db-meili', password: 'pw' }],
    ['rabbitmq', 'nd-db-rmq', 'backupRabbitmq', { cn: 'nd-db-rmq' }],
  ])('%s: the panel host routine writes the temp file, it is streamed, then removed', async (engine, cn, fn, target) => {
    const prepared = await dumpSource(cn, engine);
    expect(h.calls).toEqual([['inspect', '--format', '{{index .Config.Labels "ninedeploy.managed"}}', cn]]);
    const source = await prepared.start();
    expect(await drain(source.stream)).toBe('EXTRA-DUMP');
    expect(await source.done).toEqual({ engine });
    expect(h.extra).toEqual([{ fn, target, file: expect.stringMatching(/nd-db-extra-.+[\\/]dump$/) }]);
    expect(existsSync(path.dirname(h.extra[0]!.file))).toBe(false);
    // No docker exec, no cat: the dump never ran inside the container.
    expect(h.streams).toEqual([]);
  });

  it('a failing routine fails the start and removes the temp directory', async () => {
    h.backupThrows = new Error('clickhouse BACKUP failed');
    const prepared = await dumpSource('nd-db-ch', 'clickhouse');
    await expect(prepared.start()).rejects.toThrow('clickhouse BACKUP failed');
    expect(existsSync(path.dirname(h.extra[0]!.file))).toBe(false);
  });

  it.each(['none', 'dir'] as const)('refuses to read a temp file that is not a plain file (%s)', async (what) => {
    h.backupWrites = what;
    const prepared = await dumpSource('nd-db-rmq', 'rabbitmq');
    await expect(prepared.start()).rejects.toThrow('The database container produced something other than a plain file; refusing to read it');
    expect(existsSync(path.dirname(h.extra[0]!.file))).toBe(false);
  });

  it('abort destroys the stream and removes the temp directory', async () => {
    const prepared = await dumpSource('nd-db-meili', 'meilisearch');
    const source = await prepared.start();
    source.abort();
    expect(existsSync(path.dirname(h.extra[0]!.file))).toBe(false);
    expect((source.stream as Readable).destroyed).toBe(true);
    await expect(source.done).resolves.toEqual({ engine: 'meilisearch' });
  });
});

describe('the streamed dump: failure and abort', () => {
  it('a non-zero cat fails done with the stderr tail and still removes the temp file', async () => {
    h.exit = Promise.resolve({ code: 3, stderr: '  cat: no such file  \n' });
    const source = await (await dumpSource('nd-db-pg', 'postgres')).start();
    await drain(source.stream);
    await expect(source.done).rejects.toThrow('reading the dump exited with 3: cat: no such file');
    expect(h.calls.at(-1)?.slice(0, 4)).toEqual(['exec', 'nd-db-pg', 'rm', '-f']);
  });

  it('a rejected exit is rethrown after the cleanup', async () => {
    h.exit = Promise.reject(new Error('spawn docker ENOENT'));
    h.exit.catch(() => undefined);
    const source = await (await dumpSource('nd-db-pg', 'postgres')).start();
    await drain(source.stream);
    await expect(source.done).rejects.toThrow('spawn docker ENOENT');
    expect(h.calls.at(-1)?.slice(0, 4)).toEqual(['exec', 'nd-db-pg', 'rm', '-f']);
  });

  it('abort kills the cat and removes the temp file', async () => {
    let finish!: (v: { code: number; stderr: string }) => void;
    h.exit = new Promise((resolve) => {
      finish = resolve;
    });
    const source = await (await dumpSource('nd-db-pg', 'postgres')).start();
    h.calls.length = 0;
    source.abort();
    expect(h.kills).toBe(1);
    await vi.waitFor(() => expect(h.calls).toEqual([['exec', 'nd-db-pg', 'rm', '-f', expect.stringMatching(/^\/tmp\/ninedeploy-dump-/)]]));
    finish({ code: 0, stderr: '' });
    await source.done;
  });
});

describe('G1.8 extra-engine restores', () => {
  it('clickhouse and rabbitmq: the panel host routine reads the verified file', async () => {
    const ch = await restorer({ container: 'nd-db-ch', engine: 'clickhouse', mode: 'restore' });
    expect(await ch.apply('/agent/.transfer/a.part')).toEqual({ engine: 'clickhouse', mode: 'restore' });
    const rmq = await restorer({ container: 'nd-db-rmq', engine: 'rabbitmq' });
    expect(await rmq.apply('/agent/.transfer/b.part')).toEqual({ engine: 'rabbitmq', mode: 'restore' });
    expect(h.extra).toEqual([
      { fn: 'restoreClickhouse', target: { cn: 'nd-db-ch', password: 'pw', username: 'nine' }, file: '/agent/.transfer/a.part' },
      { fn: 'restoreRabbitmq', target: { cn: 'nd-db-rmq' }, file: '/agent/.transfer/b.part' },
    ]);
  });

  it('meilisearch: image and data volume come from the container itself', async () => {
    h.inspect.set(IMAGE_FORMAT, ['  getmeili/meilisearch:v1.11  ']);
    h.inspect.set(MOUNTS_FORMAT, ['/etc/x=other', ' /meili_data=nd-db-meili-data ', '']);
    const prepared = await restorer({ container: 'nd-db-meili', engine: 'meilisearch' });
    h.calls.length = 0;
    await prepared.apply('/f');
    expect(h.calls).toEqual([
      ['inspect', '--format', IMAGE_FORMAT, 'nd-db-meili'],
      ['inspect', '--format', MOUNTS_FORMAT, 'nd-db-meili'],
    ]);
    expect(h.extra).toEqual([
      { fn: 'restoreMeilisearch', target: { cn: 'nd-db-meili', password: 'pw', volumeName: 'nd-db-meili-data', image: 'getmeili/meilisearch:v1.11' }, file: '/f' },
    ]);
  });

  it('meilisearch: refuses a foreign image, a missing managed volume, and a failed inspect', async () => {
    const prepared = await restorer({ container: 'nd-db-meili', engine: 'meilisearch' });
    h.inspect.set(IMAGE_FORMAT, ['evil/meilisearch:v1']);
    h.inspect.set(MOUNTS_FORMAT, ['/meili_data=nd-db-meili-data']);
    await expect(prepared.apply('/f')).rejects.toThrow('The Meilisearch container does not run a getmeili/meilisearch image');
    h.inspect.set(IMAGE_FORMAT, ['getmeili/meilisearch:v1.11']);
    h.inspect.set(MOUNTS_FORMAT, ['/meili_data=host-volume']);
    await expect(prepared.apply('/f')).rejects.toThrow('The Meilisearch container has no managed data volume');
    h.inspect.set(MOUNTS_FORMAT, []);
    await expect(prepared.apply('/f')).rejects.toThrow('no managed data volume');
    h.inspect.delete(IMAGE_FORMAT);
    await expect(prepared.apply('/f')).rejects.toThrow(/getmeili\/meilisearch image/);
    h.fail = (argv) => (argv[2] === IMAGE_FORMAT ? 1 : null);
    await expect(prepared.apply('/f')).rejects.toThrow('docker inspect exited with 1: ');
    expect(h.extra).toEqual([]);
  });

  it('an extra-engine restore takes no import plan fields', async () => {
    await expect(restorer({ container: 'nd-db-ch', engine: 'clickhouse', mode: 'restore', gzip: true })).rejects.toThrow('Invalid restore param: gzip');
    await expect(restorer({ container: 'nd-db-ch', engine: 'clickhouse', mode: 'import', format: 'pg_plain' })).rejects.toThrow('Invalid import format');
  });
});

describe('the import plan: boolean fields and the copy cleanup', () => {
  it('passes gzip / clean / singleTransaction / drop through to the panel host import argv', async () => {
    const { importCommand } = await import('../src/engine/database.js');
    const plan = { format: 'pg_custom', gzip: false, clean: true, singleTransaction: false, drop: true } as const;
    const prepared = await restorer({ container: 'nd-db-pg', engine: 'postgres', mode: 'import', ...plan, sandboxFlag: null });
    h.calls.length = 0;
    expect(await prepared.apply('/f')).toEqual({ engine: 'postgres', mode: 'import' });
    const tmp = h.calls[0]![2]!.split(':')[1]!;
    expect(h.calls).toEqual([
      ['cp', '/f', `nd-db-pg:${tmp}`],
      importCommand('postgres', 'nd-db-pg', tmp, { ...plan, sandboxFlag: null }, 'pw'),
      ['exec', 'nd-db-pg', 'rm', '-f', tmp],
    ]);
  });

  it('a failed copy skips the import and still removes the temp path', async () => {
    const prepared = await restorer({ container: 'nd-db-pg', engine: 'postgres', mode: 'import', format: 'pg_plain' });
    h.calls.length = 0;
    h.fail = (argv) => (argv[0] === 'cp' ? 2 : null);
    await expect(prepared.apply('/f')).rejects.toThrow(/^docker cp exited with 2/);
    expect(h.calls.map((c) => c[0])).toEqual(['cp', 'exec']);
    expect(h.calls[1]!.slice(2, 4)).toEqual(['rm', '-f']);
  });

  it('refuses a non-boolean clean and a non-string import format', async () => {
    await expect(restorer({ container: 'nd-db-pg', engine: 'postgres', mode: 'import', format: 'pg_plain', clean: 1 })).rejects.toThrow('Invalid clean');
    await expect(restorer({ container: 'nd-db-pg', engine: 'postgres', mode: 'import' })).rejects.toThrow('Invalid import format');
    await expect(restorer({ container: 'nd-db-pg', engine: 'clickhouse', mode: 'import', format: 'rdb' })).rejects.toThrow('Invalid import format');
  });
});
