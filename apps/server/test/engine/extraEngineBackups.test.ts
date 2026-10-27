/**
 * G1.8: ClickHouse, Meilisearch and RabbitMQ backup/restore
 * (engine/extraEngineBackups.ts). The docker calls are faked here; each flow
 * was also run end to end against the real images before it was written.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  run: vi.fn<(cmd: string, args: string[], opts: unknown, sink: (l: string) => void) => Promise<void>>(),
  capture: vi.fn<(cmd: string, args: string[], opts?: unknown, input?: Buffer) => Promise<string>>(),
  sleep: vi.fn(async () => undefined),
}));
vi.mock('../../src/lib/exec.js', () => ({ run: h.run, capture: h.capture, sleep: h.sleep }));
vi.mock('../../src/lib/secretFile.js', () => ({ writeSecretFile: () => ({ path: '/tmp/secret.env', cleanup: vi.fn() }) }));

const {
  backupClickhouse,
  backupMeilisearch,
  backupRabbitmq,
  clickhouseArchiveDatabases,
  rabbitmqExpected,
  restoreClickhouse,
  restoreMeilisearch,
  restoreRabbitmq,
} = await import('../../src/engine/extraEngineBackups.js');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-extra-backups-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const log = vi.fn();
const ch = { cn: 'nd-db-ch', password: 'pw', username: 'nine' };
/** The SQL of every clickhouse-client call made through `run`. */
const chQueries = () => h.run.mock.calls.filter(([, a]) => a.includes('clickhouse-client')).map(([, a]) => a.at(-1));

beforeEach(() => {
  vi.clearAllMocks();
  h.run.mockReset();
  h.capture.mockReset();
  h.sleep.mockReset();
  h.run.mockResolvedValue(undefined);
  h.capture.mockResolvedValue('');
});

describe('ClickHouse', () => {
  const liveOnly = (_cmd: string, args: string[]) => Promise.resolve(/__nd_(restore|old)'/.test(String(args.at(-1))) ? '0\n' : '1\n');
  it('backs up the user databases only, copies the archive out and removes it from the container', async () => {
    h.capture.mockResolvedValueOnce('app\ndefault\nsecond\n');
    await backupClickhouse(ch, '/host/b.zip', log);
    const listQuery = h.capture.mock.calls[0]![1];
    expect(listQuery).toEqual(expect.arrayContaining(['exec', 'nd-db-ch', 'clickhouse-client', '-u', 'nine', '--password=pw']));
    expect(listQuery.at(-1)).toContain("NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA')");
    const backup = chQueries()[0]!;
    expect(backup).toMatch(/^BACKUP DATABASE `app`, DATABASE `default`, DATABASE `second` TO File\('nd-backup-[0-9a-f-]+\.zip'\)$/);
    const name = /File\('([^']+)'\)/.exec(backup)![1];
    expect(h.run).toHaveBeenCalledWith('docker', ['cp', `nd-db-ch:/var/lib/clickhouse/backups/${name}`, '/host/b.zip'], {}, log);
    expect(h.run.mock.calls.at(-1)![1]).toEqual(['exec', '-u', '0', 'nd-db-ch', 'rm', '-f', `/var/lib/clickhouse/backups/${name}`]);
  });

  it('refuses database names it cannot quote, and cleans up after a failed backup', async () => {
    h.capture.mockResolvedValueOnce('app\nweird-name\n');
    await expect(backupClickhouse(ch, '/host/b.zip', log)).rejects.toThrow(/weird-name/);
    expect(h.run).not.toHaveBeenCalled();

    h.capture.mockResolvedValueOnce('app\n');
    h.run.mockRejectedValueOnce(new Error('BACKUP failed')).mockRejectedValueOnce(new Error('rm failed'));
    await expect(backupClickhouse(ch, '/host/b.zip', log)).rejects.toThrow('BACKUP failed');
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/could not remove the temporary backup/));
  });

  it('reads the database names from a BusyBox unzip listing', () => {
    const listing = [
      'Archive:  /var/lib/clickhouse/backups/x.zip',
      '4294967295  00-00-1980 00:00   metadata/default.sql',
      '4294967295  00-00-1980 00:00   metadata/app.sql',
      '4294967295  00-00-1980 00:00   metadata/app/t.sql',
      '4294967295  00-00-1980 00:00   metadata/system.sql',
      '4294967295  00-00-1980 00:00   data/app/t/all_1_1_0/data.bin',
    ].join('\n');
    expect(clickhouseArchiveDatabases(listing)).toEqual(['app', 'default']);
  });

  it('restores each database under a temporary name, then swaps them all in', async () => {
    h.capture.mockResolvedValueOnce('  metadata/app.sql\n  metadata/second.sql\n');
    // Both databases exist live.
    h.capture.mockImplementation(liveOnly);
    await restoreClickhouse(ch, '/host/r.zip', log);
    const archiveCopy = h.run.mock.calls[0]![1];
    expect(archiveCopy[0]).toBe('cp');
    const archive = (archiveCopy[2] as string).split(':')[1]!;
    expect(h.run.mock.calls[1]![1]).toEqual(['exec', '-u', '0', 'nd-db-ch', 'chown', 'clickhouse:clickhouse', archive]);
    const name = path.posix.basename(archive);
    expect(chQueries()).toEqual([
      `RESTORE DATABASE \`app\` AS \`app__nd_restore\` FROM File('${name}')`,
      `RESTORE DATABASE \`second\` AS \`second__nd_restore\` FROM File('${name}')`,
      'RENAME DATABASE `app` TO `app__nd_old`',
      'RENAME DATABASE `app__nd_restore` TO `app`',
      'RENAME DATABASE `second` TO `second__nd_old`',
      'RENAME DATABASE `second__nd_restore` TO `second`',
      // The set-aside originals go only once every swap succeeded.
      'DROP DATABASE IF EXISTS `app__nd_old` SYNC',
      'DROP DATABASE IF EXISTS `second__nd_old` SYNC',
    ]);
    expect(h.run.mock.calls.at(-1)![1]).toEqual(['exec', '-u', '0', 'nd-db-ch', 'rm', '-f', archive]);
  });

  it('renames an original back when its copy cannot be swapped in, and keeps an already swapped one', async () => {
    h.capture.mockResolvedValueOnce('  metadata/app.sql\n  metadata/second.sql\n');
    h.capture.mockImplementation(liveOnly);
    h.run.mockImplementation(async (_c, args) => {
      if (String(args.at(-1)) === 'RENAME DATABASE `second__nd_restore` TO `second`') throw new Error('promotion failed');
    });
    await expect(restoreClickhouse(ch, '/host/r.zip', log)).rejects.toThrow('promotion failed');
    const queries = chQueries();
    const failedAt = queries.indexOf('RENAME DATABASE `second__nd_restore` TO `second`');
    expect(queries.slice(failedAt + 1)).toEqual([
      'RENAME DATABASE `second__nd_old` TO `second`',
    ]);
    // Nothing set aside is dropped after a failure.
    expect(queries.slice(failedAt + 1).some((q) => q.includes('__nd_old` SYNC'))).toBe(false);
    expect(log).toHaveBeenCalledWith('⚠ app was already restored before the failure; its previous data is kept as app__nd_old');
  });

  it('says how to recover when an original cannot be renamed back', async () => {
    h.capture.mockResolvedValueOnce('  metadata/app.sql\n');
    h.capture.mockImplementation(liveOnly);
    h.run.mockImplementation(async (_c, args) => {
      const q = String(args.at(-1));
      if (q === 'RENAME DATABASE `app__nd_restore` TO `app`' || q === 'RENAME DATABASE `app__nd_old` TO `app`') throw new Error('rename refused');
    });
    await expect(restoreClickhouse(ch, '/host/r.zip', log)).rejects.toThrow('rename refused');
    expect(log).toHaveBeenCalledWith('⚠ the original of app is kept as app__nd_old; rename it back by hand');
  });

  it('only warns when a set-aside original cannot be dropped after a successful restore', async () => {
    h.capture.mockResolvedValueOnce('  metadata/app.sql\n');
    h.capture.mockImplementation(liveOnly);
    let drops = 0;
    h.run.mockImplementation(async (_c, args) => {
      if (String(args.at(-1)) === 'DROP DATABASE IF EXISTS `app__nd_old` SYNC' && ++drops === 1) throw new Error('busy');
    });
    await restoreClickhouse(ch, '/host/r.zip', log);
    expect(log).toHaveBeenCalledWith('⚠ could not drop the previous copy app__nd_old; drop it by hand');
  });

  it('leaves the live databases and temporary copies alone when a restore fails', async () => {
    h.capture.mockResolvedValueOnce('  metadata/app.sql\n  metadata/second.sql\n');
    h.capture.mockImplementation(liveOnly);
    h.run.mockImplementation(async (_c, args) => {
      if (String(args.at(-1)).startsWith('RESTORE DATABASE `second`')) throw new Error('RESTORE failed');
    });
    await expect(restoreClickhouse(ch, '/host/r.zip', log)).rejects.toThrow('RESTORE failed');
    const queries = chQueries();
    expect(queries.some((q) => q === 'DROP DATABASE IF EXISTS `app` SYNC')).toBe(false);
    expect(queries.some(q => q?.startsWith('DROP DATABASE'))).toBe(false);
  });

  it('retains a recoverable database when promotion fails after the live database is removed', async () => {
    h.capture.mockResolvedValueOnce('  metadata/app.sql\n');
    h.capture.mockImplementation(liveOnly);
    const databases = new Set(['app']);
    h.run.mockImplementation(async (_cmd, args) => {
      const query = String(args.at(-1));
      const drop = /^DROP DATABASE IF EXISTS `([^`]+)` SYNC$/.exec(query);
      const restore = /^RESTORE DATABASE `app` AS `([^`]+)`/.exec(query);
      const rename = /^RENAME DATABASE `([^`]+)` TO `([^`]+)`$/.exec(query);
      if (drop) databases.delete(drop[1]!);
      if (restore) databases.add(restore[1]!);
      if (rename) {
        if (rename[1] === 'app__nd_restore') throw new Error('promotion failed');
        if (databases.delete(rename[1]!)) databases.add(rename[2]!);
      }
    });
    await expect(restoreClickhouse(ch, '/host/r.zip', log)).rejects.toThrow('promotion failed');
    expect([...databases].some(name => name.startsWith('app'))).toBe(true);
  });

  it.each(['app__nd_old', 'app__nd_restore'])('refuses an existing recovery database %s without deleting it', async name => {
    h.capture.mockResolvedValueOnce('  metadata/app.sql\n');
    h.capture.mockImplementation(async (_cmd, args) => String(args.at(-1)).includes(`'${name}'`) ? '1\n' : '0\n');
    await expect(restoreClickhouse(ch, '/host/r.zip', log)).rejects.toThrow(/already exists/);
    expect(chQueries()).toEqual([]);
  });

  it('refuses unconfirmed recovery names and overlapping names in an archive before changing databases', async () => {
    h.capture.mockResolvedValueOnce('  metadata/app.sql\n').mockResolvedValueOnce('unexpected');
    await expect(restoreClickhouse(ch, '/host/r.zip', log)).rejects.toThrow(/existence is unconfirmed/);
    expect(chQueries()).toEqual([]);
    h.capture.mockReset();
    h.capture.mockResolvedValueOnce('  metadata/app.sql\n  metadata/app__nd_old.sql\n');
    await expect(restoreClickhouse(ch, '/host/r.zip', log)).rejects.toThrow(/conflict with recovery names/);
    expect(chQueries()).toEqual([]);
  });

  it('refuses an archive with no database or with names it cannot quote', async () => {
    h.capture.mockResolvedValueOnce('Archive: x\n');
    await expect(restoreClickhouse(ch, '/host/r.zip', log)).rejects.toThrow('holds no ClickHouse database');
    h.capture.mockResolvedValueOnce('  metadata/bad%2Dname.sql\n');
    await expect(restoreClickhouse(ch, '/host/r.zip', log)).rejects.toThrow(/cannot quote safely: bad%2Dname/);
    expect(chQueries()).toEqual([]);
  });
});

describe('RabbitMQ', () => {
  const defs = {
    rabbitmq_version: '4.0.9',
    vhosts: [{ name: '/' }, { name: 'shop' }],
    queues: [{ name: 'orders', vhost: 'shop' }],
    exchanges: [{ name: 'ev', vhost: 'shop' }, { name: 'amq.topic', vhost: 'shop' }],
    bindings: [{ source: 'ev', vhost: 'shop', destination: 'orders', routing_key: 'o.#' }],
  };

  it('exports the definitions through a temp file in the container', async () => {
    await backupRabbitmq({ cn: 'nd-db-mq' }, '/host/d.json', log);
    const tmpFile = h.run.mock.calls[0]![1][6] as string;
    expect(h.run.mock.calls[0]![1]).toEqual(['exec', '-u', 'rabbitmq', 'nd-db-mq', 'rabbitmqctl', 'export_definitions', tmpFile]);
    expect(h.run.mock.calls[1]![1]).toEqual(['cp', `nd-db-mq:${tmpFile}`, '/host/d.json']);
    expect(h.run.mock.calls[2]![1]).toEqual(['exec', '-u', 'rabbitmq', 'nd-db-mq', 'rm', '-f', tmpFile]);
  });

  it('lists what a definitions file names, leaving out the built-in exchanges', () => {
    expect(rabbitmqExpected(defs)).toEqual({
      vhosts: ['/', 'shop'],
      queues: ['shop\torders'],
      exchanges: ['shop\tev'],
      bindings: ['shop\tev\torders\to.#'],
    });
    expect(rabbitmqExpected(null)).toEqual({ vhosts: [], queues: [], exchanges: [], bindings: [] });
  });

  it('imports, then waits until every vhost, queue, exchange and binding is there', async () => {
    const file = path.join(tmp, 'defs.json');
    writeFileSync(file, JSON.stringify(defs));
    let round = 0;
    h.capture.mockImplementation(async (_c, args) => {
      const what = args.find((a) => a.startsWith('list_'));
      if (what === 'list_vhosts') return round === 0 ? '/\n' : '/\nshop\n';
      if (what === 'list_queues') return 'orders\n';
      if (what === 'list_exchanges') return 'ev\namq.topic\n';
      if (what === 'list_bindings') return '\torders\torders\nev\torders\to.#\n';
      return '';
    });
    h.sleep.mockImplementation(async () => {
      round++;
    });
    await restoreRabbitmq({ cn: 'nd-db-mq' }, file, log);
    expect(h.run.mock.calls.map(([, a]) => a.slice(0, 4))).toEqual([
      ['cp', file, expect.stringMatching(/^nd-db-mq:\/tmp\/ninedeploy-restore-/)],
      ['exec', '-u', '0', 'nd-db-mq'],
      ['exec', '-u', 'rabbitmq', 'nd-db-mq'],
      ['exec', '-u', '0', 'nd-db-mq'],
    ]);
    expect(h.sleep).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('RabbitMQ definitions applied');
  });

  it('fails when the import never completes, naming what is missing', async () => {
    const file = path.join(tmp, 'defs2.json');
    writeFileSync(file, JSON.stringify(defs));
    h.capture.mockImplementation(async (_c, args) => (args.includes('list_vhosts') ? '/\nshop\n' : args.includes('list_queues') ? '' : ''));
    await expect(restoreRabbitmq({ cn: 'nd-db-mq' }, file, log, { timeoutMs: -1 })).rejects.toThrow(
      'still missing: queue shop/orders, exchange shop/ev, binding ev → orders → o.#',
    );
    // The temp file is removed either way.
    expect(h.run.mock.calls.at(-1)![1].slice(-3)).toEqual(['rm', '-f', expect.stringMatching(/^\/tmp\/ninedeploy-restore-/)]);
  });

  it('refuses a file that is not a definitions export before touching the server', async () => {
    const file = path.join(tmp, 'bad.json');
    writeFileSync(file, '{"truncated');
    await expect(restoreRabbitmq({ cn: 'nd-db-mq' }, file, log)).rejects.toThrow(/not a RabbitMQ definitions file/);
    expect(h.run).not.toHaveBeenCalled();
  });

  it('reports a missing vhost before looking inside it', async () => {
    const file = path.join(tmp, 'defs3.json');
    writeFileSync(file, JSON.stringify(defs));
    h.capture.mockResolvedValue('/\n');
    await expect(restoreRabbitmq({ cn: 'nd-db-mq' }, file, log, { timeoutMs: -1 })).rejects.toThrow('still missing: vhost shop');
    expect(h.capture.mock.calls.every(([, a]) => a.includes('list_vhosts'))).toBe(true);
  });
});

describe('Meilisearch', () => {
  const meili = { cn: 'nd-db-meili', password: 'master' };

  it('asks for a dump, waits for its task and copies the dump file out', async () => {
    h.capture
      .mockResolvedValueOnce('{"taskUid":7,"status":"enqueued"}')
      .mockResolvedValueOnce('{"status":"processing"}')
      .mockResolvedValueOnce('{"status":"succeeded","details":{"dumpUid":"20261027-073410181"}}');
    await backupMeilisearch(meili, '/host/m.dump', log);
    // The master key goes over stdin, never on argv.
    expect(h.capture.mock.calls[0]![1]).toEqual(['exec', '-i', 'nd-db-meili', 'curl', '-sS', '--fail-with-body', '-H', '@-', '-X', 'POST', 'http://localhost:7700/dumps']);
    expect(String(h.capture.mock.calls[0]![3])).toBe('Authorization: Bearer master\n');
    expect(h.capture.mock.calls.flatMap(([, a]) => a).join(' ')).not.toContain('master');
    expect(h.capture.mock.calls[1]![1].at(-1)).toBe('http://localhost:7700/tasks/7');
    expect(h.sleep).toHaveBeenCalledTimes(1);
    expect(h.run.mock.calls[0]![1]).toEqual(['cp', 'nd-db-meili:/meili_data/dumps/20261027-073410181.dump', '/host/m.dump']);
    expect(h.run.mock.calls[1]![1]).toEqual(['exec', 'nd-db-meili', 'rm', '-f', '/meili_data/dumps/20261027-073410181.dump']);
  });

  it('fails on a refused request, a failed task, a missing dump name or a timeout', async () => {
    h.capture.mockResolvedValueOnce('{"message":"invalid key"}');
    await expect(backupMeilisearch(meili, '/host/m.dump', log)).rejects.toThrow('did not accept the dump request');

    h.capture.mockResolvedValueOnce('{"taskUid":1}').mockResolvedValueOnce('{"status":"failed","error":{"message":"no space left"}}');
    await expect(backupMeilisearch(meili, '/host/m.dump', log)).rejects.toThrow('The Meilisearch dump failed: no space left');

    h.capture.mockResolvedValueOnce('{"taskUid":1}').mockResolvedValueOnce('{"status":"succeeded","details":{"dumpUid":"../../etc"}}');
    await expect(backupMeilisearch(meili, '/host/m.dump', log)).rejects.toThrow('named no dump file');

    h.capture.mockResolvedValueOnce('{"taskUid":1}').mockResolvedValue('{"status":"enqueued"}');
    await expect(backupMeilisearch(meili, '/host/m.dump', log, { timeoutMs: -1 })).rejects.toThrow('did not finish in time');
  });

  const target = { ...meili, volumeName: 'nd-db-meili-data', image: 'getmeili/meilisearch:v1.53' };

  it('imports the dump into a new path with a one-off container, swaps it in and starts the database', async () => {
    h.capture.mockImplementation(async (_c, args) => (args.includes('http://localhost:7700/health') ? '{"status":"available"}' : 'true'));
    await restoreMeilisearch(target, '/host/m.dump', log);
    const calls = h.run.mock.calls.map(([, a]) => a);
    const dump = (calls[0]![2] as string).split(':')[1]!;
    expect(calls[0]).toEqual(['cp', '/host/m.dump', `nd-db-meili:${dump}`]);
    expect(calls[1]).toEqual(['stop', 'nd-db-meili']);
    const importer = calls.find((a) => a[0] === 'run' && a.includes('--import-dump'))!;
    expect(importer).toEqual(expect.arrayContaining(['--name', 'nd-db-meili-nd-restore', '--network', 'none', '-v', 'nd-db-meili-data:/meili_data', '--env-file', '/tmp/secret.env']));
    expect(importer.slice(-5)).toEqual(['meilisearch', '--db-path', expect.stringMatching(/^\/meili_data\/nd-restore-.+\.ms$/), '--import-dump', dump]);
    const scripts = calls.filter((a) => a.includes('--entrypoint')).map((a) => a.at(-1) as string);
    expect(scripts[0]).toMatch(/^mv data\.ms (data\.ms\.nd-old-\S+) && \{ mv nd-restore-\S+\.ms data\.ms \|\| \{ mv \1 data\.ms; exit 1; \}; \}$/);
    expect(scripts[1]).toMatch(/^rm -rf data\.ms\.nd-old-\S+ nd-restore-\S+\.dump$/);
    // Started again before the previous data is removed.
    const startAt = calls.findIndex((a) => a[0] === 'start');
    expect(startAt).toBeLessThan(calls.indexOf(calls.filter((a) => a.includes('--entrypoint'))[1]!));
  });

  it('keeps the current data when the import fails, removes the half-imported copy and starts the database again', async () => {
    h.capture.mockImplementation(async (_c, args) => {
      if (args.includes('http://localhost:7700/health')) throw new Error('not running');
      if (args[0] === 'inspect') return 'false';
      if (args[0] === 'logs') return 'line1\nError: the dump is corrupted\n';
      return '';
    });
    await expect(restoreMeilisearch(target, '/host/m.dump', log)).rejects.toThrow('The Meilisearch dump import failed: line1 | Error: the dump is corrupted');
    const calls = h.run.mock.calls.map(([, a]) => a);
    const scripts = calls.filter((a) => a.includes('--entrypoint')).map((a) => a.at(-1) as string);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatch(/^rm -rf nd-restore-\S+\.ms nd-restore-\S+\.dump$/);
    expect(calls.some((a) => a[0] === 'start' && a[1] === 'nd-db-meili')).toBe(true);
  });

  it('gives up on an import that never becomes healthy, and logs a cleanup it could not do', async () => {
    h.capture.mockImplementation(async (_c, args) => (args[0] === 'inspect' ? 'true' : ''));
    h.run.mockImplementation(async (_c, args) => {
      if (args.includes('--entrypoint')) throw new Error('volume busy');
    });
    await expect(restoreMeilisearch(target, '/host/m.dump', log, { timeoutMs: -1 })).rejects.toThrow('did not finish in time');
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/could not clean up nd-restore-\S+\.ms in volume nd-db-meili-data/));
  });
});
