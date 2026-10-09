import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENGINES } from '../src/engine/database.js';
import {
  DATABASE_ENGINES,
  DUMPABLE_ENGINES,
  dumpCommands,
  dumpTmpPath,
  mysqlHelpCommand,
  parseSizeOutput,
  probeCommand,
  probeSucceeded,
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
