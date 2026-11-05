import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ calls: [] as string[][], timeouts: [] as Array<{ args: string[]; timeoutMs: number }>, stdin: [] as string[], loadPolls: 0, content: '', rabbitReady: 2, fail: '', custom: false, copied: '', name: '', image: `sha256:${'a'.repeat(64)}`, oom: '', logs: [] as string[] | null, helpers: [] as Array<{ id: string; created: string; name: string }> }));
const REDIS_CLIS = ['redis-cli', 'valkey-cli', 'keydb-cli'];
const MONGO_PING = 'db.adminCommand({ ping: 1 }).ok';
vi.mock('../../src/lib/fileCommandInput.js', () => ({
  streamFileToCommand: async (_cmd: string, args: string[], file: string, timeoutMs: number) => {
    state.calls.push(args); state.copied = file; state.timeouts.push({ args, timeoutMs });
    expect(await readFile(file, 'utf8')).toContain(state.custom ? 'PGDMP' : state.content || 'CREATE TABLE');
    if (state.fail === 'copy') throw new Error('copy error');
    if (args.includes('mongorestore') && state.fail === 'restore') throw new Error('File input command did not complete');
  },
}));
vi.mock('../../src/lib/exec.js', () => {
  class ExecTimeoutError extends Error {}
  class ExecOutputTooLargeError extends Error {}
  return {
    ExecTimeoutError, ExecOutputTooLargeError, sleep: async () => undefined,
    run: vi.fn(async (_cmd: string, args: string[], _options: { timeoutMs: number }, sink: (line: string) => void) => {
      state.calls.push(args);
      if (state.logs === null) throw new Error('No such container');
      for (const line of state.logs) sink(line);
    }),
    capture: vi.fn(async (_cmd: string, args: string[], options: { timeoutMs: number }, input?: Buffer) => {
      state.calls.push(args); state.timeouts.push({ args, timeoutMs: options.timeoutMs });
      if (input) state.stdin.push(input.toString());
      expect(options.timeoutMs).toBeGreaterThan(0);
      // Redis family: the load poll (`<cli> -h 127.0.0.1 ping`) and the
      // stdin probe (`exec -i … <cli> -h 127.0.0.1`).
      if (args[0] === 'exec' && REDIS_CLIS.some(cli => args.includes(cli))) {
        if (args.at(-1) === 'ping') {
          state.loadPolls++;
          if (state.fail === 'rdb-exit') throw new Error('Error response from daemon: container is not running');
          // Still loading on the first poll: the server answers LOADING, not PONG.
          return state.loadPolls === 1 ? 'LOADING Redis is loading the dataset in memory\n' : 'PONG\n';
        }
        if (state.fail === 'query') throw new Error('SECRET_QUERY_RESULT');
        return state.fail === 'mismatch' ? 'wrong private value\n' : 'known-row\n';
      }
      // The load poll's "is the gated server still running?" check.
      if (args[0] === 'inspect' && args.join(' ') === `inspect --format {{.State.Running}} ${state.name}`) {
        return `${state.fail !== 'rdb-exit' && state.fail !== 'dump-exit'}\n`;
      }
      if (args[0] === 'image') {
        if (state.fail === 'image') throw new Error('private daemon error');
        return state.image;
      }
      if (args[0] === 'create') {
        state.name = args[args.indexOf('--name') + 1]!;
        if (state.fail === 'create') throw new Error('lost create reply');
        return `${'b'.repeat(64)}\n`;
      }
      if (args[0] === 'cp') {
        state.copied = args[1]!;
        expect(await readFile(args[1]!, 'utf8')).toContain(state.custom ? 'PGDMP' : 'CREATE TABLE');
        if (state.fail === 'copy') throw new Error('copy error');
      }
      if ((args.includes('pg_isready') || args.includes('ping') || args.includes(MONGO_PING)) && state.fail === 'ready') throw new Error('not ready');
      // RabbitMQ: readiness, the definitions import, the settle listings
      // (`exec -u rabbitmq … rabbitmqctl -q --no-table-headers list_…`) and the probe.
      if (args[0] === 'exec' && args.includes('rabbitmq-diagnostics')) {
        if (state.fail === 'ready') throw new Error('not ready');
        return '';
      }
      if (args[0] === 'exec' && args.includes('rabbitmqctl')) {
        if (args.includes('import_definitions')) {
          if (state.fail === 'restore') throw new Error('`docker` exited 65: Error: Failed to deserialise input (format: JSON) (error: :unexpected_end)');
          return '';
        }
        if (args.includes('-u')) {
          // The settle check: nothing listed until the import has applied.
          state.loadPolls++;
          const applied = state.fail !== 'never-applied' && state.loadPolls >= state.rabbitReady;
          const listing = args[args.indexOf('--no-table-headers') + 1];
          if (!applied) return '';
          if (listing === 'list_vhosts') return '/\nshop\n';
          if (listing === 'list_queues') return 'orders\n';
          if (listing === 'list_exchanges') return 'events\namq.direct\n';
          if (listing === 'list_bindings') return '\torders\torders\nevents\torders\torder.created\n';
          return '';
        }
        if (state.fail === 'query') throw new Error('SECRET_QUERY_RESULT');
        if (args.includes('list_exchanges')) return 'events\ttopic\namq.direct\tdirect\n';
        return state.fail === 'mismatch' ? 'wrong private value\n' : 'known-row\n';
      }
      // Meilisearch: the import poll (`curl … /health`) and the GET probe.
      if (args[0] === 'exec' && args.includes('curl')) {
        if (args.at(-1)?.endsWith('/health')) {
          state.loadPolls++;
          if (state.fail === 'dump-exit') throw new Error('Error response from daemon: container is not running');
          // Still importing on the first poll: no answer yet.
          return state.loadPolls === 1 ? '' : '{"status":"available"}';
        }
        if (state.fail === 'query') throw new Error('SECRET_QUERY_RESULT');
        return state.fail === 'mismatch' ? 'wrong private value' : 'known-row';
      }
      // ClickHouse: readiness, RESTORE and the probe all go through clickhouse-client.
      if (args[0] === 'exec' && args.includes('clickhouse-client')) {
        if (args.at(-1) === 'SELECT 1') {
          if (state.fail === 'ready') throw new Error('not ready');
          return '1\n';
        }
        if (args.at(-1)?.startsWith('RESTORE ALL')) {
          if (state.fail === 'restore') throw new Error("`docker` exited 131: Code: 643. DB::Exception: Couldn't open zip archive 'nd-restore.zip'. (CANNOT_UNPACK_ARCHIVE)");
          if (state.fail === 'chspace') throw new Error('`docker` exited 243: Code: 243. DB::Exception: Cannot reserve 1.00 GiB, not enough space. (NOT_ENOUGH_SPACE)');
          return `${'c'.repeat(8)}\tRESTORED\n`;
        }
        if (state.fail === 'query') throw new Error('SECRET_QUERY_RESULT');
        return state.fail === 'mismatch' ? 'wrong private value\n' : 'known-row\n';
      }
      if (args[0] === 'exec' && args.includes('mongosh') && !args.includes(MONGO_PING)) {
        if (state.fail === 'query') throw new Error('SECRET_QUERY_RESULT');
        return state.fail === 'mismatch' ? 'wrong private value\n' : 'known-row\n';
      }
      if (args[0] === 'exec' && args.includes('restore')) {
        // mysql-family: sh -c <stdin script> restore <dump> <client> …
        if (state.fail === 'restore') throw new Error('SECRET_SQL_DUMP_CONTENT');
        if (state.fail === 'tablefull') throw new Error("`docker` exited 1: ERROR 1114 (HY000) at line 9: The table 'private_orders' is full");
        if (state.fail === 'lost') throw new Error('`docker` exited 1: ERROR 2013 (HY000) at line 3: Lost connection to server during query');
        return '';
      }
      if (args[0] === 'exec' && (args.includes('-f') || args.includes('pg_restore'))) {
        if (state.fail === 'restore') throw new Error('SECRET_SQL_DUMP_CONTENT');
        if (state.fail === 'enospc') throw new Error('`docker` exited 1: ERROR:  could not extend file "base/16384/16390": No space left on device');
        if (state.fail === 'lost') throw new Error('`docker` exited 2: psql: server closed the connection unexpectedly');
        if (state.fail === 'timeout') throw new ExecTimeoutError('secret');
      }
      if (args.includes('-c') || args.includes('-e')) {
        if (state.fail === 'query') throw new Error('SECRET_QUERY_RESULT');
        if (state.fail === 'output') throw new ExecOutputTooLargeError('secret');
        return state.fail === 'mismatch' ? 'wrong private value\n' : 'known-row\n';
      }
      if (args[0] === 'inspect' && args.includes('{{.State.Running}} {{.State.OOMKilled}}')) {
        if (state.oom === 'unreadable') throw new Error('daemon hiccup');
        // An OOM kill of the engine (PID 1) stops the helper as well.
        return `${state.oom !== 'killed' && state.oom !== 'stopped'} ${state.oom === 'killed'}\n`;
      }
      if (args[0] === 'inspect' && args.includes('{{.Created}} {{.Name}}')) {
        const helper = state.helpers.find(h => h.id === args.at(-1));
        if (!helper || helper.name === 'VANISHED') throw new Error('No such object');
        return `${helper.created} ${helper.name}\n`;
      }
      if (args[0] === 'ps' && args.includes('label=ninedeploy.role=restore-verification')) return state.helpers.map(h => h.id).join('\n');
      if (args[0] === 'rm' && state.fail === 'cleanup') throw new Error('offline');
      if (args[0] === 'ps') return state.fail === 'retained' ? `${'b'.repeat(64)}\n` : '';
      return '';
    }),
  };
});
import { pruneRestoreVerificationHelpers, RESTORE_VERIFICATION_MAX_DUMP_BYTES, verifyPostgresRestore, verifyRestore } from '../../src/lib/backupRestoreVerification.js';

let directory: string;
let file: string;
beforeEach(async () => {
  state.calls = []; state.timeouts = []; state.stdin = []; state.loadPolls = 0; state.content = ''; state.rabbitReady = 2; state.fail = ''; state.custom = false; state.copied = ''; state.name = '';
  state.image = `sha256:${'a'.repeat(64)}`; state.oom = ''; state.logs = []; state.helpers = [];
  directory = await mkdtemp(join(tmpdir(), 'nd-restore-test-'));
  file = join(directory, 'source.sql');
  await writeFile(file, 'CREATE TABLE known(id text);');
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const verify = () => verifyPostgresRestore({ file, image: 'postgres:18', query: 'SELECT id FROM known', expected: 'known-row' });

describe('isolated real PostgreSQL restore verifier orchestration', () => {
  it('restores plain SQL, queries known data, confirms removal and never changes the source', async () => {
    const result = await verify();
    expect(result).toMatchObject({ status: 'passed', cleanupConfirmed: true, format: 'plain', queryMatched: true });
    expect(await readFile(file, 'utf8')).toBe('CREATE TABLE known(id text);');
    const create = state.calls.find(args => args[0] === 'create')!;
    for (const flag of ['--read-only', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', 'postgres', '--pids-limit', '--memory', '--cpus']) expect(create).toContain(flag);
    expect(create).toContain(state.image);
    expect(state.calls.some(args => args[0] === 'cp')).toBe(false);
    expect(state.calls.find(args => args.includes('restore-copy'))).toEqual(expect.arrayContaining(['exec', '-i', 'sh', '-c', 'umask 077; cat > "$1"']));
    expect(create).not.toContain('postgres:18');
    expect(create.some(arg => ['--mount', '-v', '--volume', '-p', '--publish', '--privileged'].includes(arg))).toBe(false);
    expect(create.filter(arg => arg.startsWith('PGDATA='))).toEqual(['PGDATA=/tmp/nd-restore/data']);
    expect(state.calls.find(args => args.includes('-f'))).toEqual(expect.arrayContaining(['-X', 'ON_ERROR_STOP=1', '--single-transaction']));
    expect(state.calls.find(args => args[0] === 'rm')).toEqual(['rm', '-f', '-v', state.name]);
    expect(state.calls.at(-1)?.[0]).toBe('ps');
    // The caller's private staged file is streamed as-is: no second plaintext
    // copy on the panel's disk for a crash to leave behind.
    expect(state.copied).toBe(file);
  });
  it('uses the archive restore tool for custom dumps with strict error handling', async () => {
    state.custom = true; await writeFile(file, 'PGDMP custom fixture');
    expect((await verify()).format).toBe('custom');
    expect(state.calls.find(args => args.includes('pg_restore'))).toEqual(expect.arrayContaining(['--exit-on-error', '--single-transaction']));
  });
  it.each(['image', 'create', 'copy', 'ready', 'timeout', 'output', 'cleanup', 'retained'])('refuses to certify unavailable or incomplete %s execution', async failure => {
    state.fail = failure;
    expect((await verify()).status).toBe('unverifiable');
  });
  it.each(['restore', 'query', 'mismatch'])('fails %s without exposing restored content', async failure => {
    state.fail = failure;
    const result = await verify();
    expect(result.status).toBe('failed');
    expect(result.cleanupConfirmed).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|wrong private value|SELECT id/);
    expect(state.calls.some(args => args[0] === 'rm')).toBe(true);
  });
  it('attempts owned cleanup even after a lost create response', async () => {
    state.fail = 'create'; await verify();
    expect(state.calls.find(args => args[0] === 'rm')?.at(-1)).toBe(state.name);
  });
  it('rejects invalid probes before any Docker work', async () => {
    await expect(verifyPostgresRestore({ file, image: 'postgres:18', query: '', expected: '' })).rejects.toThrow();
    expect(state.calls).toEqual([]);
  });
  it('refuses malformed image identity before creating a helper', async () => {
    state.image = 'not-an-immutable-image';
    expect((await verify()).status).toBe('unverifiable');
    expect(state.calls.some(args => args[0] === 'create')).toBe(false);
  });
});

describe('bounded helper capacity is never reported as a broken backup', () => {
  const capacity = 'Backup exceeds the bounded restore verification capacity';
  it('refuses a dump too large for the scratch before any helper or copy exists', async () => {
    const handle = await open(file, 'r+');
    try { await handle.truncate(RESTORE_VERIFICATION_MAX_DUMP_BYTES + 1); } finally { await handle.close(); }
    const result = await verify();
    expect(result).toMatchObject({ status: 'unverifiable', error: capacity, cleanupConfirmed: true });
    expect(state.calls.some(args => args[0] === 'create')).toBe(false);
    expect(state.copied).toBe('');
  });
  it('reports an out-of-space restore as unverifiable, without keeping the engine message', async () => {
    state.fail = 'enospc';
    const result = await verify();
    expect(result).toMatchObject({ status: 'unverifiable', error: capacity, cleanupConfirmed: true });
    expect(JSON.stringify(result)).not.toMatch(/base\/16384|No space/);
  });
  it('reports a cgroup OOM kill during restore as unverifiable', async () => {
    state.fail = 'restore'; state.oom = 'killed';
    const result = await verify();
    expect(result).toMatchObject({ status: 'unverifiable', error: capacity });
    expect(JSON.stringify(result)).not.toMatch(/SECRET/);
  });
  it('does not blame the backup when the helper state cannot be read', async () => {
    state.fail = 'restore'; state.oom = 'unreadable';
    expect((await verify()).status).toBe('unverifiable');
  });
  it('still fails a genuine restore error on a healthy helper', async () => {
    state.fail = 'restore'; state.oom = 'healthy';
    expect(await verify()).toMatchObject({ status: 'failed', error: 'Restore verification failed during restore' });
  });
  it('does not blame the backup when the helper stopped during the restore', async () => {
    state.fail = 'restore'; state.oom = 'stopped';
    expect(await verify()).toMatchObject({ status: 'unverifiable', error: 'Restore verification could not complete during restore' });
  });
  it('does not blame the backup when the client lost its server, even before Docker reports the helper stopped', async () => {
    state.fail = 'lost';
    const result = await verify();
    expect(result).toMatchObject({ status: 'unverifiable', error: 'Restore verification could not complete during restore', cleanupConfirmed: true });
    expect(JSON.stringify(result)).not.toMatch(/closed the connection/);
  });
});

describe('MySQL and MariaDB restore helpers', () => {
  const run = (engine: 'mysql' | 'mariadb') => verifyRestore(engine, { file, image: `${engine}:latest`, query: 'SELECT id FROM known', expected: 'known-row' });
  const stdinScript = 'f="$1"; shift; exec "$@" < "$f"';
  const tcp = ['-uroot', '-h', '127.0.0.1', '--protocol=tcp'];
  it('restores a mysqldump into a hardened, networkless MySQL helper and probes the managed database', async () => {
    const result = await run('mysql');
    expect(result).toMatchObject({ status: 'passed', engine: 'mysql', format: 'plain', queryMatched: true, cleanupConfirmed: true });
    const create = state.calls.find(args => args[0] === 'create')!;
    for (const flag of ['--read-only', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '--memory', '--cpus']) expect(create).toContain(flag);
    expect(create.slice(create.indexOf('--user'), create.indexOf('--user') + 2)).toEqual(['--user', 'mysql']);
    expect(create).toEqual(expect.arrayContaining([
      '--tmpfs', '/var/run/mysqld:rw,nosuid,nodev,mode=1777,size=16m',
      '--tmpfs', '/var/lib/mysql:rw,nosuid,nodev,mode=1777,size=1m',
      '--env', 'MYSQL_ALLOW_EMPTY_PASSWORD=yes',
    ]));
    // The daemon flags follow the immutable image id: the entrypoint prepends mysqld.
    expect(create.slice(create.indexOf(state.image))).toEqual([state.image, '--datadir=/tmp/nd-restore/data', '--innodb-use-native-aio=0', '--skip-log-bin']);
    expect(create.some(arg => arg.startsWith('PGDATA=') || (arg.includes('PASSWORD=') && !arg.includes('EMPTY')))).toBe(false);
    expect(create.some(arg => ['--mount', '-v', '--volume', '-p', '--publish', '--privileged'].includes(arg))).toBe(false);
    expect(state.calls.find(args => args.includes('ping'))).toEqual(['exec', state.name, 'mysqladmin', 'ping', ...tcp]);
    expect(state.calls.find(args => args.includes('restore'))).toEqual(['exec', state.name, 'sh', '-c', stdinScript, 'restore', '/tmp/nd-restore-source.dump', 'mysql', ...tcp]);
    expect(state.calls.find(args => args.includes('-e'))).toEqual(['exec', state.name, 'mysql', ...tcp, '--batch', '--raw', '--skip-column-names', '--database=app', '-e', 'SELECT id FROM known']);
    expect(state.calls.find(args => args[0] === 'rm')).toEqual(['rm', '-f', '-v', state.name]);
    expect(state.copied).toBe(file);
  });
  it('uses the MariaDB client, admin tool, socket directory and empty-root variable', async () => {
    const result = await run('mariadb');
    expect(result).toMatchObject({ status: 'passed', engine: 'mariadb', format: 'plain' });
    const create = state.calls.find(args => args[0] === 'create')!;
    expect(create).toEqual(expect.arrayContaining(['--tmpfs', '/run/mysqld:rw,nosuid,nodev,mode=1777,size=16m', '--env', 'MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=1']));
    // MariaDB keeps its binary log off by default; no flag a pinned version might not know.
    expect(create.slice(create.indexOf(state.image))).toEqual([state.image, '--datadir=/tmp/nd-restore/data', '--innodb-use-native-aio=0']);
    expect(state.calls.find(args => args.includes('ping'))?.[2]).toBe('mariadb-admin');
    expect(state.calls.find(args => args.includes('restore'))?.[7]).toBe('mariadb');
    expect(state.calls.find(args => args.includes('-e'))?.[2]).toBe('mariadb');
  });
  it('never reads a MySQL dump as a PostgreSQL custom archive', async () => {
    await writeFile(file, 'PGDMP CREATE TABLE known(id text);');
    expect((await run('mysql')).format).toBe('plain');
  });
  it('fails a genuine restore error or a probe mismatch on a healthy helper without exposing either', async () => {
    state.fail = 'restore';
    expect(await run('mysql')).toMatchObject({ status: 'failed', error: 'Restore verification failed during restore' });
    state.fail = 'mismatch';
    const mismatch = await run('mariadb');
    expect(mismatch).toMatchObject({ status: 'failed', queryMatched: false });
    expect(JSON.stringify(mismatch)).not.toMatch(/wrong private value|SELECT id/);
  });
  it('reports a full scratch ("The table … is full") as capacity, without the table name', async () => {
    state.fail = 'tablefull';
    const result = await run('mysql');
    expect(result).toMatchObject({ status: 'unverifiable', error: 'Backup exceeds the bounded restore verification capacity', cleanupConfirmed: true });
    expect(JSON.stringify(result)).not.toMatch(/private_orders/);
  });
  it('treats a MariaDB server that aborted mid-restore (lost connection) as unverifiable', async () => {
    state.fail = 'lost';
    expect(await run('mariadb')).toMatchObject({ status: 'unverifiable', error: 'Restore verification could not complete during restore' });
    // The stopped helper's own log was consulted (bounded tail), before removal.
    const logs = state.calls.findIndex(args => args[0] === 'logs');
    expect(state.calls[logs]).toEqual(['logs', '--tail', '200', state.name]);
    expect(logs).toBeLessThan(state.calls.findIndex(args => args[0] === 'rm'));
  });
  it('names capacity when the aborted MariaDB helper logged a full tmpfs, keeping no log text', async () => {
    state.fail = 'lost'; state.oom = 'stopped';
    state.logs = [
      "2026-11-04 18:56:29 9 [ERROR] InnoDB: preallocating 901775360 bytes for file ./app/private_orders.ibd failed with error 28",
      "Query (0x7f): INSERT INTO private_orders VALUES ('SECRET_ROW')",
    ];
    const result = await run('mariadb');
    expect(result).toMatchObject({ status: 'unverifiable', error: 'Backup exceeds the bounded restore verification capacity', cleanupConfirmed: true });
    expect(JSON.stringify(result)).not.toMatch(/private_orders|SECRET_ROW|preallocating/);
  });
  it('stays unverifiable without a capacity claim when the stopped helper log cannot be read', async () => {
    state.fail = 'restore'; state.oom = 'stopped'; state.logs = null;
    expect(await run('mariadb')).toMatchObject({ status: 'unverifiable', error: 'Restore verification could not complete during restore' });
  });
  it('does not read logs when a healthy helper reports a genuine restore error', async () => {
    state.fail = 'restore'; state.logs = ['failed with error 28'];
    expect(await run('mysql')).toMatchObject({ status: 'failed' });
    expect(state.calls.some(args => args[0] === 'logs')).toBe(false);
  });
  it('is unverifiable when the MySQL helper never accepts TCP connections', async () => {
    state.fail = 'ready';
    expect((await run('mysql')).status).toBe('unverifiable');
    expect(state.calls.filter(args => args.includes('ping'))).toHaveLength(120);
  });
  it('refuses an engine without an adapter before any Docker work', async () => {
    await expect(verifyRestore('no-such-engine' as never, { file, image: 'nginx:1', query: 'SELECT 1', expected: '1' })).rejects.toThrow(/Unsupported/);
    expect(state.calls).toEqual([]);
  });
});

describe('MongoDB restore helper', () => {
  const query = "db.getSiblingDB('shop').orders.countDocuments()";
  const run = () => verifyRestore('mongo', { file, image: 'mongo:8.0', query, expected: 'known-row' });
  const restoreArgv = () => ['exec', '-i', state.name, 'mongorestore', '--host', '127.0.0.1', '--archive', '--gzip', '--stopOnError', '--quiet'];
  it('streams the archive straight into mongorestore in a hardened helper, with the whole scratch for data', async () => {
    const result = await run();
    expect(result).toMatchObject({ status: 'passed', engine: 'mongo', format: 'archive', queryMatched: true, cleanupConfirmed: true });
    const create = state.calls.find(args => args[0] === 'create')!;
    for (const flag of ['--read-only', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '--cpus']) expect(create).toContain(flag);
    expect(create.slice(create.indexOf('--user'), create.indexOf('--user') + 2)).toEqual(['--user', 'mongodb']);
    expect(create.slice(create.indexOf('--pids-limit'), create.indexOf('--pids-limit') + 2)).toEqual(['--pids-limit', '256']);
    // The image's VOLUMEs are tmpfs: the 1 GiB scratch holds the data, configdb gets 1 MiB.
    const tmpfs = create.flatMap((arg, index) => (create[index - 1] === '--tmpfs' ? [arg] : []));
    expect(tmpfs).toEqual([
      '/data/db:rw,nosuid,nodev,mode=1777,size=1024m',
      '/data/configdb:rw,nosuid,nodev,mode=1777,size=1m',
      '/tmp:rw,nosuid,nodev,mode=1777,size=64m',
    ]);
    // No MONGO_INITDB_* variables: no temporary initialization server, no access control.
    expect(create.filter(arg => arg.startsWith('MONGO'))).toEqual([]);
    expect(create).toEqual(expect.arrayContaining(['--env', 'HOME=/tmp', '--env', 'GLIBC_TUNABLES=glibc.pthread.rseq=1']));
    expect(create.at(-1)).toBe(state.image);
    expect(create.some(arg => ['--mount', '-v', '--volume', '-p', '--publish', '--privileged'].includes(arg))).toBe(false);
    // mongosh needs about a second to start: a longer readiness budget.
    expect(state.timeouts.find(entry => entry.args.includes(MONGO_PING))?.timeoutMs).toBe(5000);
    // Streamed: no copy into the helper, and the restore has the long budget.
    expect(state.calls.some(args => args.includes('restore-copy'))).toBe(false);
    expect(state.timeouts.find(entry => entry.args.includes('mongorestore'))).toEqual({ args: restoreArgv(), timeoutMs: 300_000 });
    expect(state.copied).toBe(file);
    expect(state.calls.find(args => args.includes('mongosh') && !args.includes(MONGO_PING))).toEqual(['exec', state.name, 'mongosh', '--quiet', '--norc', '--host', '127.0.0.1', '--eval', query]);
    expect(result.restoreMs).not.toBeNull();
    expect(state.calls.find(args => args[0] === 'rm')).toEqual(['rm', '-f', '-v', state.name]);
  });
  it('fails a corrupt archive on a healthy helper, and a probe mismatch, without exposing either', async () => {
    state.fail = 'restore';
    expect(await run()).toMatchObject({ status: 'failed', error: 'Restore verification failed during restore', restoreMs: null, cleanupConfirmed: true });
    state.fail = 'mismatch';
    const mismatch = await run();
    expect(mismatch).toMatchObject({ status: 'failed', queryMatched: false });
    expect(JSON.stringify(mismatch)).not.toMatch(/wrong private value|getSiblingDB/);
  });
  it('is unverifiable when the streamed restore ends with a stopped helper', async () => {
    state.fail = 'restore'; state.oom = 'stopped';
    expect(await run()).toMatchObject({ status: 'unverifiable', error: 'Restore verification could not complete during restore' });
  });
  it('is unverifiable when mongod never answers the readiness ping', async () => {
    state.fail = 'ready';
    expect((await run()).status).toBe('unverifiable');
    expect(state.calls.filter(args => args.includes(MONGO_PING))).toHaveLength(60);
    expect(state.calls.some(args => args.includes('mongorestore'))).toBe(false);
  });
});

describe('crashed restore helpers are swept', () => {
  const uuid = '0f1e2d3c-4b5a-4968-8776-655443322110';
  const now = Date.parse('2026-11-04T12:00:00Z');
  it('removes only labelled helpers with the generated name that outlived the age floor', async () => {
    state.helpers = [
      { id: 'a'.repeat(64), created: '2026-11-04T10:00:00.123456789Z', name: `/ninedeploy-restore-check-${uuid}` },
      { id: 'b'.repeat(64), created: '2026-11-04T11:55:00Z', name: `/ninedeploy-restore-check-${uuid}` },
      { id: 'c'.repeat(64), created: '2026-11-04T09:00:00Z', name: '/someone-elses-container' },
      { id: 'd'.repeat(64), created: 'not-a-date', name: `/ninedeploy-restore-check-${uuid}` },
    ];
    expect(await pruneRestoreVerificationHelpers(60 * 60 * 1000, now)).toBe(1);
    const removed = state.calls.filter(args => args[0] === 'rm');
    expect(removed).toEqual([['rm', '-f', '-v', 'a'.repeat(64)]]);
  });
  it('keeps sweeping after one container vanishes mid-scan, and ignores non-id lines', async () => {
    state.helpers = [
      { id: 'f'.repeat(64), created: '', name: 'VANISHED' },
      { id: 'not-a-container-id', created: '2026-11-04T08:00:00Z', name: `/ninedeploy-restore-check-${uuid}` },
      { id: 'e'.repeat(64), created: '2026-11-04T08:00:00Z', name: `/ninedeploy-restore-check-${uuid}` },
    ];
    expect(await pruneRestoreVerificationHelpers(60 * 60 * 1000, now)).toBe(1);
    expect(state.calls.filter(args => args[0] === 'rm')).toEqual([['rm', '-f', '-v', 'e'.repeat(64)]]);
    expect(state.calls.some(args => args.includes('not-a-container-id'))).toBe(false);
  });
});

describe('RabbitMQ restore helper (a definitions export, applied asynchronously)', () => {
  const definitions = JSON.stringify({
    vhosts: [{ name: 'shop' }],
    queues: [{ name: 'orders', vhost: 'shop', durable: true }],
    exchanges: [{ name: 'events', vhost: 'shop', type: 'topic' }],
    bindings: [{ source: 'events', vhost: 'shop', destination: 'orders', destination_type: 'queue', routing_key: 'order.created' }],
  });
  const query = 'list_queues -p shop name durable';
  const run = (q = query) => verifyRestore('rabbitmq', { file, image: 'rabbitmq:4-management', query: q, expected: 'known-row' });
  beforeEach(async () => { state.content = '"vhosts"'; await writeFile(file, definitions); });
  it('imports the definitions, waits until every named object exists, then runs the list probe', async () => {
    const result = await run();
    expect(result).toMatchObject({ status: 'passed', engine: 'rabbitmq', format: 'definitions', queryMatched: true, cleanupConfirmed: true });
    const create = state.calls.find(args => args[0] === 'create')!;
    for (const flag of ['--read-only', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '--cpus']) expect(create).toContain(flag);
    expect(create.slice(create.indexOf('--user'), create.indexOf('--user') + 2)).toEqual(['--user', 'rabbitmq']);
    expect(create.slice(create.indexOf('--pids-limit'), create.indexOf('--pids-limit') + 2)).toEqual(['--pids-limit', '512']);
    const tmpfs = create.flatMap((arg, index) => (create[index - 1] === '--tmpfs' ? [arg] : []));
    expect(tmpfs).toEqual([
      '/var/lib/rabbitmq:rw,nosuid,nodev,mode=1777,size=1024m',
      '/var/log/rabbitmq:rw,nosuid,nodev,mode=1777,size=16m',
      '/tmp:rw,nosuid,nodev,mode=1777,size=64m',
    ]);
    expect(create.at(-1)).toBe(state.image);
    // The broker, not just the Erlang node, must be running; each CLI call starts a VM.
    expect(state.calls.find(args => args.includes('rabbitmq-diagnostics'))).toEqual(['exec', state.name, 'rabbitmq-diagnostics', '-q', 'check_running']);
    expect(state.timeouts.find(entry => entry.args.includes('rabbitmq-diagnostics'))?.timeoutMs).toBe(5000);
    expect(state.calls.find(args => args.includes('restore-copy'))?.at(-1)).toBe('/var/lib/rabbitmq/nd-restore.json');
    const imported = state.calls.findIndex(args => args.includes('import_definitions'));
    expect(state.calls[imported]).toEqual(['exec', state.name, 'rabbitmqctl', '-q', 'import_definitions', '/var/lib/rabbitmq/nd-restore.json']);
    // The settle check polled until the import applied (empty listings first).
    const settle = state.calls.filter(args => args.includes('-u'));
    expect(settle.length).toBeGreaterThan(1);
    expect(settle[0]).toEqual(['exec', '-u', 'rabbitmq', state.name, 'rabbitmqctl', '-q', '--no-table-headers', 'list_vhosts', 'name']);
    const probe = state.calls.findIndex(args => args.includes('list_queues') && !args.includes('-u'));
    expect(state.calls[probe]).toEqual(['exec', state.name, 'rabbitmqctl', '-q', '--no-table-headers', 'list_queues', '-p', 'shop', 'name', 'durable']);
    // The probe runs only after the import settled.
    expect(probe).toBeGreaterThan(state.calls.lastIndexOf(settle.at(-1)!));
    expect(result.restoreMs).not.toBeNull();
  });
  it('compares listed rows as a set: rabbitmqctl lists them in no fixed order', async () => {
    const probe = (expected: string) => verifyRestore('rabbitmq', { file, image: 'rabbitmq:4-management', query: 'list_exchanges -p shop name type', expected });
    expect(await probe('amq.direct\tdirect\nevents\ttopic')).toMatchObject({ status: 'passed', queryMatched: true });
    expect(await probe('events\ttopic\namq.direct\tdirect')).toMatchObject({ status: 'passed', queryMatched: true });
    // A missing or an extra row still fails.
    expect(await probe('events\ttopic')).toMatchObject({ status: 'failed', queryMatched: false });
    expect(await probe('events\ttopic\namq.direct\tdirect\namq.fanout\tfanout')).toMatchObject({ status: 'failed', queryMatched: false });
  });
  it('fails a definitions file RabbitMQ cannot import, without the engine message', async () => {
    state.fail = 'restore';
    const result = await run();
    expect(result).toMatchObject({ status: 'failed', error: 'Restore verification failed during restore', cleanupConfirmed: true });
    expect(JSON.stringify(result)).not.toMatch(/deserialise|unexpected_end/);
  });
  it('is unverifiable when the imported definitions never all appear', async () => {
    state.fail = 'never-applied';
    let clock = Date.parse('2026-11-05T09:00:00Z');
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 30_000));
    try {
      expect(await run()).toMatchObject({ status: 'unverifiable', error: 'Restore verification could not complete during restore' });
    } finally { now.mockRestore(); }
  });
  it.each(['eval rabbit:stop()', 'list_queues; reboot', 'LIST_QUEUES name', 'status', 'list_queues  name'])('refuses %j before any Docker work: it is not one list command', async (q) => {
    await expect(run(q)).rejects.toThrow(/rabbitmqctl list command/);
    expect(state.calls).toEqual([]);
  });
});

describe('Meilisearch restore helper (the dump is imported at startup)', () => {
  const path = '/indexes/movies/documents/1?fields=title';
  const run = (query = path) => verifyRestore('meilisearch', { file, image: 'getmeili/meilisearch:v1.53', query, expected: 'known-row' });
  it('copies the dump into a gated helper, releases the import, waits for health and GETs the probe path', async () => {
    const result = await run();
    expect(result).toMatchObject({ status: 'passed', engine: 'meilisearch', format: 'archive', queryMatched: true, cleanupConfirmed: true });
    const create = state.calls.find(args => args[0] === 'create')!;
    for (const flag of ['--read-only', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '--cpus']) expect(create).toContain(flag);
    // The image has no service user: an unprivileged id.
    expect(create.slice(create.indexOf('--user'), create.indexOf('--user') + 2)).toEqual(['--user', '65534:65534']);
    const tmpfs = create.flatMap((arg, index) => (create[index - 1] === '--tmpfs' ? [arg] : []));
    expect(tmpfs).toEqual(['/meili_data:rw,nosuid,nodev,mode=1777,size=1024m', '/tmp:rw,nosuid,nodev,mode=1777,size=64m']);
    // No master key and no MEILI_* settings: the helper serves the probe only.
    expect(create.some(arg => arg.startsWith('MEILI_'))).toBe(false);
    expect(create.slice(create.indexOf(state.image))).toEqual([state.image, '-c', 'while [ ! -e /meili_data/.nd-start ]; do sleep 0.2; done; exec "$@"', 'nd-restore',
      'meilisearch', '--db-path', '/meili_data/data.ms', '--import-dump', '/meili_data/nd-restore.dump', '--http-addr', '127.0.0.1:7700', '--no-analytics']);
    const copy = state.calls.findIndex(args => args.includes('restore-copy'));
    const release = state.calls.findIndex(args => args.join(' ') === `exec ${state.name} touch /meili_data/.nd-start`);
    expect(state.calls[copy]?.at(-1)).toBe('/meili_data/nd-restore.dump');
    expect(copy).toBeLessThan(release);
    // An empty answer is not healthy yet: the import is polled until it is.
    expect(state.loadPolls).toBe(2);
    expect(state.calls.find(args => args.at(-1)?.endsWith('/health'))).toEqual(['exec', state.name, 'curl', '-s', 'http://127.0.0.1:7700/health']);
    expect(state.calls.find(args => args.at(-1)?.includes('/indexes/'))).toEqual(['exec', state.name, 'curl', '-s', '-g', '--max-time', '10', `http://127.0.0.1:7700${path}`]);
  });
  it('fails a dump Meilisearch refused to import, keeping no log text', async () => {
    state.fail = 'dump-exit'; state.oom = 'stopped';
    state.logs = ['Error: failed to iterate over archive', '', 'Caused by:', '    invalid gzip header'];
    const result = await run();
    expect(result).toMatchObject({ status: 'failed', error: 'Restore verification failed during restore', restoreMs: null, cleanupConfirmed: true });
    expect(JSON.stringify(result)).not.toMatch(/gzip|iterate/);
  });
  it('is unverifiable when Meilisearch exits during the import without naming the dump', async () => {
    state.fail = 'dump-exit'; state.oom = 'stopped'; state.logs = ['INFO starting'];
    expect(await run()).toMatchObject({ status: 'unverifiable', error: 'Restore verification could not complete during restore' });
  });
  it.each(['GET /indexes', 'indexes/movies', '/indexes/movies documents', ''])('refuses %j as a probe before any Docker work: it is not an API path', async (query) => {
    await expect(run(query)).rejects.toThrow();
    expect(state.calls).toEqual([]);
  });
  it('fails a probe mismatch without exposing the response', async () => {
    state.fail = 'mismatch';
    const result = await run();
    expect(result).toMatchObject({ status: 'failed', queryMatched: false });
    expect(JSON.stringify(result)).not.toMatch(/wrong private value|indexes\/movies/);
  });
});

describe('ClickHouse restore helper', () => {
  const run = () => verifyRestore('clickhouse', { file, image: 'clickhouse/clickhouse-server:25.8', query: 'SELECT count() FROM events', expected: 'known-row' });
  it('copies the BACKUP archive under the allowed backups path, restores ALL and probes the managed database', async () => {
    const result = await run();
    expect(result).toMatchObject({ status: 'passed', engine: 'clickhouse', format: 'archive', queryMatched: true, cleanupConfirmed: true });
    const create = state.calls.find(args => args[0] === 'create')!;
    for (const flag of ['--read-only', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '--cpus']) expect(create).toContain(flag);
    expect(create.slice(create.indexOf('--user'), create.indexOf('--user') + 2)).toEqual(['--user', 'clickhouse']);
    // Several hundred threads at start: a 256 or 128 limit makes ClickHouse abort.
    expect(create.slice(create.indexOf('--pids-limit'), create.indexOf('--pids-limit') + 2)).toEqual(['--pids-limit', '4096']);
    const tmpfs = create.flatMap((arg, index) => (create[index - 1] === '--tmpfs' ? [arg] : []));
    expect(tmpfs).toEqual([
      '/var/lib/clickhouse:rw,nosuid,nodev,mode=1777,size=1024m',
      '/var/log/clickhouse-server:rw,nosuid,nodev,mode=1777,size=64m',
      '/tmp:rw,nosuid,nodev,mode=1777,size=64m',
    ]);
    // No users written under the read-only /etc; no CLICKHOUSE_USER/PASSWORD/DB.
    expect(create.filter(arg => arg.startsWith('CLICKHOUSE_'))).toEqual(['CLICKHOUSE_SKIP_USER_SETUP=1']);
    expect(create.at(-1)).toBe(state.image);
    // The backups directory exists before the copy lands in it.
    const prepare = state.calls.findIndex(args => args.join(' ') === `exec ${state.name} mkdir -p /var/lib/clickhouse/backups`);
    const copy = state.calls.findIndex(args => args.includes('restore-copy'));
    expect(prepare).toBeGreaterThan(-1);
    expect(prepare).toBeLessThan(copy);
    expect(state.calls[copy]?.at(-1)).toBe('/var/lib/clickhouse/backups/nd-restore.zip');
    expect(state.calls.find(args => args.at(-1)?.startsWith('RESTORE'))).toEqual(['exec', state.name, 'clickhouse-client', '-q', "RESTORE ALL FROM File('nd-restore.zip')"]);
    expect(state.calls.find(args => args.at(-1) === 'SELECT count() FROM events')).toEqual(['exec', state.name, 'clickhouse-client', '--database', 'app', '-q', 'SELECT count() FROM events']);
    expect(result.restoreMs).not.toBeNull();
  });
  it('fails an archive ClickHouse cannot open on a healthy helper, without the engine message', async () => {
    state.fail = 'restore';
    const result = await run();
    expect(result).toMatchObject({ status: 'failed', error: 'Restore verification failed during restore', cleanupConfirmed: true });
    expect(JSON.stringify(result)).not.toMatch(/zip archive|CANNOT_UNPACK/);
  });
  it('reports NOT_ENOUGH_SPACE during RESTORE as capacity', async () => {
    state.fail = 'chspace';
    expect(await run()).toMatchObject({ status: 'unverifiable', error: 'Backup exceeds the bounded restore verification capacity' });
  });
  it('is unverifiable when the server never answers', async () => {
    state.fail = 'ready';
    expect((await run()).status).toBe('unverifiable');
    expect(state.calls.some(args => args.includes('restore-copy'))).toBe(false);
  });
});

describe('Redis-family restore helpers (the server loads its RDB at startup)', () => {
  const gate = 'while [ ! -e /data/.nd-start ]; do sleep 0.2; done; exec "$@"';
  const run = (engine: 'redis' | 'valkey' | 'keydb' | 'dragonfly' = 'redis') => verifyRestore(engine, { file, image: `${engine}:latest`, query: 'GET greeting', expected: 'known-row' });
  it('copies the RDB into a gated, hardened helper, releases the server, waits for the load and probes on stdin', async () => {
    const result = await run();
    expect(result).toMatchObject({ status: 'passed', engine: 'redis', format: 'rdb', queryMatched: true, cleanupConfirmed: true });
    const create = state.calls.find(args => args[0] === 'create')!;
    for (const flag of ['--read-only', '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '--cpus']) expect(create).toContain(flag);
    expect(create.slice(create.indexOf('--user'), create.indexOf('--user') + 2)).toEqual(['--user', 'redis']);
    const tmpfs = create.flatMap((arg, index) => (create[index - 1] === '--tmpfs' ? [arg] : []));
    expect(tmpfs).toEqual(['/data:rw,nosuid,nodev,mode=1777,size=1024m']);
    // The image's entrypoint is replaced by the start gate; the server's flags follow it.
    expect(create.slice(create.indexOf('--entrypoint'), create.indexOf('--entrypoint') + 2)).toEqual(['--entrypoint', 'sh']);
    expect(create.slice(create.indexOf(state.image))).toEqual([state.image, '-c', gate, 'nd-restore', 'redis-server',
      '--dir', '/data', '--dbfilename', 'dump.rdb', '--save', '', '--appendonly', 'no', '--bind', '127.0.0.1', '--port', '6379']);
    expect(create.some(arg => ['--mount', '-v', '--volume', '-p', '--publish', '--privileged'].includes(arg))).toBe(false);
    // Order: the copy lands, THEN the marker releases the server, THEN the load is polled.
    const copy = state.calls.findIndex(args => args.includes('restore-copy'));
    const release = state.calls.findIndex(args => args.join(' ') === `exec ${state.name} touch /data/.nd-start`);
    const firstPoll = state.calls.findIndex(args => args.at(-1) === 'ping');
    expect(state.calls[copy]).toEqual(['exec', '-i', state.name, 'sh', '-c', 'umask 077; cat > "$1"', 'restore-copy', '/data/dump.rdb']);
    expect(copy).toBeLessThan(release);
    expect(release).toBeLessThan(firstPoll);
    // LOADING is not PONG: the load is polled until the server answers.
    expect(state.loadPolls).toBe(2);
    expect(state.calls.find(args => args.at(-1) === 'ping')).toEqual(['exec', state.name, 'redis-cli', '-h', '127.0.0.1', 'ping']);
    // The probe goes to the client on stdin, one command per line, never in argv.
    expect(state.calls.find(args => args[1] === '-i' && args.includes('redis-cli'))).toEqual(['exec', '-i', state.name, 'redis-cli', '-h', '127.0.0.1']);
    expect(state.stdin).toEqual(['GET greeting\n']);
    expect(result.restoreMs).not.toBeNull();
    expect(state.calls.find(args => args[0] === 'rm')).toEqual(['rm', '-f', '-v', state.name]);
  });
  it.each([
    ['valkey', 'valkey-server', 'valkey-cli'],
    ['keydb', 'keydb-server', 'keydb-cli'],
  ] as const)('runs %s with its own user, server and client', async (engine, server, cli) => {
    expect(await run(engine)).toMatchObject({ status: 'passed', engine, format: 'rdb' });
    const create = state.calls.find(args => args[0] === 'create')!;
    expect(create.slice(create.indexOf('--user'), create.indexOf('--user') + 2)).toEqual(['--user', engine]);
    expect(create[create.indexOf('nd-restore') + 1]).toBe(server);
    expect(state.calls.find(args => args.at(-1) === 'ping')?.[2]).toBe(cli);
    expect(state.calls.find(args => args[1] === '-i' && args.includes(cli))).toBeDefined();
  });
  it('fails a backup whose RDB the engine refused while loading, keeping no log text', async () => {
    state.fail = 'rdb-exit'; state.oom = 'stopped';
    state.logs = ['1:M 05 Nov 2026 # Wrong signature trying to load DB from file', "[additional info] Reading key 'private:session:42'"];
    const result = await run();
    expect(result).toMatchObject({ status: 'failed', error: 'Restore verification failed during restore', restoreMs: null, cleanupConfirmed: true });
    expect(JSON.stringify(result)).not.toMatch(/Wrong signature|private:session/);
  });
  it('names capacity when the engine ran out of memory loading the RDB, even beside a short-read line', async () => {
    state.fail = 'rdb-exit'; state.oom = 'stopped';
    state.logs = ['zmalloc: Out of memory trying to allocate 1073741824 bytes', 'Short read or OOM loading DB. Unrecoverable error, aborting now.'];
    expect(await run()).toMatchObject({ status: 'unverifiable', error: 'Backup exceeds the bounded restore verification capacity' });
  });
  it('is unverifiable when the server exits while loading without saying the file was bad', async () => {
    state.fail = 'rdb-exit'; state.oom = 'stopped'; state.logs = ['1:M 05 Nov 2026 * Server initialized'];
    expect(await run()).toMatchObject({ status: 'unverifiable', error: 'Restore verification could not complete during restore' });
  });
  it('runs Dragonfly as dfly with the managed snapshot flags and probes it with redis-cli', async () => {
    expect(await run('dragonfly')).toMatchObject({ status: 'passed', engine: 'dragonfly', format: 'rdb' });
    const create = state.calls.find(args => args[0] === 'create')!;
    expect(create.slice(create.indexOf('--user'), create.indexOf('--user') + 2)).toEqual(['--user', 'dfly']);
    expect(create.slice(create.indexOf('nd-restore') + 1)).toEqual(['dragonfly', '--logtostderr', '--dir=/data', '--dbfilename=dump',
      '--df_snapshot_format=false', '--bind=127.0.0.1', '--port=6379']);
    expect(state.calls.find(args => args.includes('restore-copy'))?.at(-1)).toBe('/data/dump.rdb');
    expect(state.calls.find(args => args.at(-1) === 'ping')).toEqual(['exec', state.name, 'redis-cli', '-h', '127.0.0.1', 'ping']);
    expect(state.stdin).toEqual(['GET greeting\n']);
  });
  it('fails a Dragonfly backup whose RDB it refused ("Rdb load failed")', async () => {
    state.fail = 'rdb-exit'; state.oom = 'stopped';
    state.logs = ['E20261105 07:44:10.807642 26 server_family.cc:1380] Rdb load failed: Wrong signature while trying to load from rdb file'];
    expect(await run('dragonfly')).toMatchObject({ status: 'failed', error: 'Restore verification failed during restore' });
  });
  it('fails a probe mismatch on a loaded dataset without exposing it', async () => {
    state.fail = 'mismatch';
    const result = await run('valkey');
    expect(result).toMatchObject({ status: 'failed', queryMatched: false, error: 'Restored data did not match the expected probe result' });
    expect(JSON.stringify(result)).not.toMatch(/wrong private value|GET greeting/);
  });
});
