import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENGINES } from '../src/engine/database.js';
import {
  AGENT_REDIS_FAMILY_VERSION,
  saveReplyProblem,
  DATABASE_ENGINES,
  DUMPABLE_ENGINES,
  dumpCommands,
  dumpTmpPath,
  isDatabaseEngine,
  isRedisFamily,
  mysqlHelpCommand,
  NODE_ENGINES_NEEDING_NEWER_AGENT,
  parseSizeOutput,
  probeCommand,
  probeSucceeded,
  REDIS_DUMP_PATH,
  REDIS_FAMILY_ENGINES,
  redisCliArgv,
  restoreCommand,
  restoreTmpPath,
  sandboxFlagFrom,
  sizeCommand,
} from '../src/lib/databaseCommands.js';

/**
 * Multi-node T6 (design §5.4): the node's `db.exec` and `db.dump` /
 * `db.restore` build their docker argv from lib/databaseCommands.ts. Each
 * builder must equal, byte for byte, what the panel host's engine function
 * sent for the same engine in the v0.15.0 recording
 * (fixtures/databaseArgv015.json) — so a node dump IS a panel dump, and a
 * size or credential probe asks the same question.
 */

type Event = { fn: string; args?: string[] };
const fixture = JSON.parse(readFileSync(new URL('./fixtures/databaseArgv015.json', import.meta.url), 'utf8')) as Record<string, { events: Event[] }>;
const UUID = '00000000-0000-4000-8000-000000000000';
const PW = 'pw-secret';
const docker = (name: string, fn: 'run' | 'capture' = 'run') => fixture[name]!.events.filter((e) => e.fn === fn).map((e) => e.args!);

const ROWS = [
  ['postgres', 'nd-db-postgres'],
  ['mysql', 'nd-db-mysql'],
  ['mariadb', 'nd-db-mariadb'],
  ['redis', 'nd-db-redis'],
  ['valkey', 'nd-db-valkey'],
  ['mongo', 'nd-db-mongo'],
  ['clickhouse', 'nd-db-clickhouse'],
  ['meilisearch', 'nd-db-meilisearch'],
  ['rabbitmq', 'nd-db-rabbitmq'],
] as const;

describe('the shared builders equal the v0.15.0 panel-host argv', () => {
  for (const [engine, cn] of ROWS) {
    it(`${engine}: size, probe and sandbox queries`, () => {
      const size = docker(`${engine} size`, 'capture');
      expect(sizeCommand(engine, cn, PW)).toEqual(size[0] ?? null);
      const probe = docker(`${engine} probe credentials`, 'capture');
      expect(probeCommand(engine, cn, PW)).toEqual(probe[0] ?? null);
      const help = docker(`${engine} probe sandbox`, 'capture');
      expect(mysqlHelpCommand(engine, cn)).toEqual(help[0] ?? null);
    });

    it(`${engine}: the dump and the restore`, () => {
      if (!DUMPABLE_ENGINES.has(engine)) {
        expect(fixture[`${engine} backup`]!.events).toEqual([]);
        expect(() => dumpCommands(engine, cn, dumpTmpPath(UUID), PW)).toThrow(`backup not supported for ${engine}`);
        expect(() => restoreCommand(engine, cn, restoreTmpPath(UUID), PW)).toThrow(`restore not supported for ${engine}`);
        return;
      }
      const backup = docker(`${engine} backup`);
      const plan = dumpCommands(engine, cn, dumpTmpPath(UUID), PW);
      // The dump command, then (panel host) `docker cp` of exactly plan.file, then the cleanup.
      expect(backup[0]).toEqual(plan.dump);
      expect(backup[1]![0]).toBe('cp');
      expect(backup[1]![1]).toBe(`${cn}:${plan.file}`);
      expect(backup[2] ?? null).toEqual(plan.cleanup);
      if (engine === 'redis' || engine === 'valkey') return; // stop / cp / start: no command of its own
      const restore = docker(`${engine} restore`);
      expect(restore[1]).toEqual(restoreCommand(engine, cn, restoreTmpPath(UUID), PW));
    });
  }

  it('the credentials the builders use are the ones ENGINES declares', () => {
    for (const engine of ['postgres', 'mongo'] as const) expect(ENGINES[engine]!.username()).toBe('nine');
    expect(ENGINES['postgres']!.dbName()).toBe('app');
    expect(new Set(DATABASE_ENGINES)).toEqual(new Set(Object.keys(ENGINES)));
  });
});

describe('output parsing (what the panel host reads)', () => {
  it('sizes, probes and sandbox flags', () => {
    expect(parseSizeOutput('postgres', '4242\n')).toBe(4242);
    expect(parseSizeOutput('redis', '# Memory\nused_memory:777\n')).toBe(777);
    expect(parseSizeOutput('mongo', 'x 31337.5')).toBe(31337.5);
    expect(parseSizeOutput('mysql', 'garbage')).toBe(0);
    expect(probeSucceeded('postgres', ' 1\n')).toBe(true);
    expect(probeSucceeded('redis', 'PONG')).toBe(true);
    expect(probeSucceeded('redis', 'NOAUTH')).toBe(false);
    expect(sandboxFlagFrom('mariadb', '  --sandbox  x')).toBe('--sandbox');
    expect(sandboxFlagFrom('mysql', '  --system-command  x')).toBe('--system-command=OFF');
    expect(sandboxFlagFrom('mysql', 'nothing')).toBeNull();
  });
});

describe('0.15.6: keydb and dragonfly share the redis family builders', () => {
  const NEW = [
    ['keydb', 'nd-db-keydb', 'keydb-cli'],
    ['dragonfly', 'nd-db-dragonfly', 'redis-cli'],
  ] as const;

  it('the engine list gained exactly keydb and dragonfly, after the nine that existed', () => {
    expect([...DATABASE_ENGINES]).toEqual([
      'postgres', 'mysql', 'mariadb', 'redis', 'mongo', 'valkey', 'clickhouse', 'meilisearch', 'rabbitmq', 'keydb', 'dragonfly',
    ]);
    expect(new Set(DATABASE_ENGINES)).toEqual(new Set(Object.keys(ENGINES)));
    expect([...REDIS_FAMILY_ENGINES].sort()).toEqual(['dragonfly', 'keydb', 'redis', 'valkey']);
    for (const engine of ['postgres', 'mysql', 'mariadb', 'mongo', 'clickhouse', 'meilisearch', 'rabbitmq']) expect(isRedisFamily(engine)).toBe(false);
    for (const [engine] of NEW) {
      expect(isRedisFamily(engine)).toBe(true);
      expect(DUMPABLE_ENGINES.has(engine)).toBe(true);
      expect(isDatabaseEngine(engine)).toBe(true);
      expect(NODE_ENGINES_NEEDING_NEWER_AGENT.has(engine)).toBe(true);
    }
    expect(NODE_ENGINES_NEEDING_NEWER_AGENT.has('redis')).toBe(false);
    expect(NODE_ENGINES_NEEDING_NEWER_AGENT.has('valkey')).toBe(false);
    expect(AGENT_REDIS_FAMILY_VERSION).toBe('0.15.6');
  });

  it('redis and valkey keep their v0.15.0 argv byte for byte', () => {
    for (const engine of ['redis', 'valkey']) {
      expect(redisCliArgv(engine, 'c', PW, 'PING')).toEqual(['exec', 'c', 'redis-cli', '-a', PW, '--no-auth-warning', 'PING']);
      expect(dumpCommands(engine, 'c', dumpTmpPath(UUID), PW)).toEqual({
        dump: ['exec', 'c', 'redis-cli', '-a', PW, '--no-auth-warning', 'SAVE'],
        file: '/data/dump.rdb',
        cleanup: null,
      });
    }
  });

  for (const [engine, cn, cli] of NEW) {
    it(`${engine}: size, probe and dump`, () => {
      // Every engine runs its client inside its own container: the Dragonfly image ships a real redis-cli.
      const run = (...cmd: string[]) => ['exec', cn, cli, '-a', PW, '--no-auth-warning', ...cmd];
      expect(sizeCommand(engine, cn, PW)).toEqual(run('INFO', 'memory'));
      expect(probeCommand(engine, cn, PW)).toEqual(run('PING'));
      expect(mysqlHelpCommand(engine, cn)).toBeNull();
      const plan = dumpCommands(engine, cn, dumpTmpPath(UUID), PW);
      expect(plan).toEqual({ dump: run('SAVE', ...(engine === 'dragonfly' ? ['RDB'] : [])), file: REDIS_DUMP_PATH, cleanup: null });
      expect(REDIS_DUMP_PATH).toBe('/data/dump.rdb');
      // A restore has no command: it is stop / copy over dump.rdb / start (same as redis).
      expect(() => restoreCommand(engine, cn, restoreTmpPath(UUID), PW)).toThrow(`restore not supported for ${engine}`);
    });

    it(`${engine}: output parsing`, () => {
      expect(parseSizeOutput(engine, '# Memory\r\nused_memory:5150\r\nused_memory_human:5K\r\n')).toBe(5150);
      expect(parseSizeOutput(engine, 'ERR')).toBe(0);
      expect(probeSucceeded(engine, 'PONG\n')).toBe(true);
      expect(probeSucceeded(engine, 'NOAUTH Authentication required.')).toBe(false);
      expect(probeSucceeded(engine, '1')).toBe(false);
    });
  }

  it('a SAVE reply is checked for keydb and dragonfly only', () => {
    for (const engine of ['keydb', 'dragonfly']) {
      expect(saveReplyProblem(engine, 'OK\n')).toBeNull();
      expect(saveReplyProblem(engine, 'warning\nOK')).toBeNull();
      expect(saveReplyProblem(engine, '(error) ERR nope')).toBe('SAVE did not answer OK: (error) ERR nope');
      expect(saveReplyProblem(engine, '')).toBe('SAVE did not answer OK: no reply');
      expect(saveReplyProblem(engine, 'x'.repeat(500))).toBe(`SAVE did not answer OK: ${'x'.repeat(300)}`);
    }
    for (const engine of ['redis', 'valkey', 'postgres']) expect(saveReplyProblem(engine, '(error) ERR nope')).toBeNull();
  });

  it('dragonfly goes through docker exec redis-cli like redis (no client container), keydb through keydb-cli; the password rides after -a', () => {
    expect(redisCliArgv('dragonfly', 'nd-db-x', PW, 'PING')).toEqual(['exec', 'nd-db-x', 'redis-cli', '-a', PW, '--no-auth-warning', 'PING']);
    expect(redisCliArgv('dragonfly', 'nd-db-x', PW, 'PING')).toEqual(redisCliArgv('redis', 'nd-db-x', PW, 'PING'));
    expect(redisCliArgv('keydb', 'nd-db-x', PW, 'PING')).toEqual(['exec', 'nd-db-x', 'keydb-cli', '-a', PW, '--no-auth-warning', 'PING']);
    for (const argv of [redisCliArgv('dragonfly', 'c', PW, 'PING'), redisCliArgv('keydb', 'c', PW, 'PING')]) {
      expect(argv.indexOf('-a')).toBe(argv.indexOf(PW) - 1);
      expect(argv).not.toContain('run');
    }
  });
});
