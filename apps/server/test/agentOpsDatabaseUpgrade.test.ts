/** The upgrade ops of a node at the process boundary: the real registry, the real request schema and the real catalogue; only the Docker process is replaced. */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** Containers on the fake node. */
  containers: new Map<string, { labels: Record<string, string>; state: string; exitCode: number; tag: string; mounts: string[] }>(),
  volumes: new Map<string, Record<string, string>>(),
  argv: [] as string[][],
  /** What every env file held, read while the container was being started. */
  envFiles: [] as string[],
  stopExit: 0,
  /** What `docker run` answers; non-zero is a helper that did not start. */
  runExit: 0,
  /** What a streamed docker child answers, and what it was given. */
  answer: { out: '', stderr: '', code: 0 },
  streamArgv: [] as string[][],
  streamStdin: [] as string[],
  streamed: 0,
}));

vi.mock('../src/lib/spawnValidated.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/spawnValidated.js')>()),
  spawnValidated: async (_exe: string, argv: string[], onLine: (line: string) => void) => {
    h.argv.push(argv);
    const [verb, ...rest] = argv;
    if (verb === 'inspect') {
      const c = h.containers.get(rest.at(-1)!);
      if (!c) {
        onLine(`Error: No such object: ${rest.at(-1)}`);
        return 1;
      }
      if (rest.includes('{{json .Config.Labels}}')) onLine(JSON.stringify(c.labels));
      else onLine(`${c.state}|${c.exitCode}|sha256:${'a'.repeat(64)}|${c.tag}`);
      return 0;
    }
    if (verb === 'volume') {
      const labels = h.volumes.get(rest.at(-1)!);
      if (!labels) {
        onLine(`Error: No such volume: ${rest.at(-1)}`);
        return 1;
      }
      onLine(JSON.stringify(labels));
      return 0;
    }
    if (verb === 'run') {
      const labels: Record<string, string> = {};
      for (let i = rest.indexOf('--label'); i !== -1; i = rest.indexOf('--label', i + 1)) {
        const [key, value] = rest[i + 1]!.split('=');
        labels[key!] = value ?? '';
      }
      const envFile = rest.includes('--env-file') ? rest[rest.indexOf('--env-file') + 1]! : null;
      if (envFile) h.envFiles.push(readFileSync(envFile, 'utf8'));
      const lastOption = Math.max(rest.lastIndexOf('-v'), rest.lastIndexOf('--env-file'));
      if (h.runExit) return h.runExit;
      h.containers.set(rest[rest.indexOf('--name') + 1]!, {
        labels, state: 'running', exitCode: 0, tag: rest[lastOption + 1]!, mounts: rest.filter((_, i) => rest[i - 1] === '-v'),
      });
      return 0;
    }
    if (verb === 'stop') {
      const c = h.containers.get(rest.at(-1)!);
      if (!c) return 1;
      c.state = 'exited';
      c.exitCode = h.stopExit;
      return 0;
    }
    if (verb === 'rm') {
      h.containers.delete(rest.at(-1)!);
      return 0;
    }
    throw new Error(`unexpected docker argv: ${argv.join(' ')}`);
  },
  spawnValidatedStream: (_exe: string, argv: string[], opts: { stdin?: string }) => {
    h.streamArgv.push(argv);
    h.streamed++;
    const stdout = new PassThrough();
    const stdin = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        h.streamStdin.push(chunk.toString('utf8'));
        callback();
      },
    });
    const answer = h.answer;
    const exit = new Promise<{ code: number; stderr: string }>((resolve) => {
      setImmediate(() => {
        stdout.end(answer.out);
        resolve({ code: answer.code, stderr: answer.stderr });
      });
    });
    return { stdout, stdin: opts.stdin === 'pipe' ? stdin : null, exit, kill: () => undefined };
  },
}));

import { advertisedCapabilities, runRegisteredOp } from '../src/agentOps/index.js';
import { COPY_SCRIPT, SQL_ANSWER_CAP, UPGRADE_HELPER_LABEL, nodeHelperName, nodeUpgradeRequest } from '../src/agentOps/databaseUpgrade.js';
import { upgradeStatement } from '../src/lib/databaseUpgradeSql.js';
import { agentRequestTimeoutMs, isLongAgentRequest, isSealedOnlyAgentOp } from '../src/lib/agentClient.js';

const id = { databaseId: 42, slug: 'main', engine: 'mysql', container: 'nd-db-main' };
const PG = { ...id, engine: 'postgres' } as const;
/** The labels of a database's own volume; `databaseId` says whose. */
const own = (databaseId = '42'): Record<string, string> => ({ 'ninedeploy.managed': 'database', 'ninedeploy.database.id': databaseId, 'ninedeploy.database.slug': 'main' });
let cwd: string;

beforeEach(() => {
  h.containers.clear();
  h.volumes.clear();
  h.argv.length = 0;
  h.envFiles.length = 0;
  h.streamArgv.length = 0;
  h.streamStdin.length = 0;
  h.streamed = 0;
  h.stopExit = 0;
  h.runExit = 0;
  h.answer = { out: '', stderr: '', code: 0 };
  h.volumes.set('nd-db-main-data', own());
  h.volumes.set('nd-db-main-data-u7', own());
  cwd = mkdtempSync(path.join(os.tmpdir(), 'nd-upg-agent-'));
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(cwd, { recursive: true, force: true });
});

const REPLY = 'ND-DB-UPGRADE ';
async function op(params: Record<string, unknown>, sealed = true) {
  const lines: string[] = [];
  const code = await runRegisteredOp('db.upgrade', params, (line) => lines.push(line), { sealed });
  const reply = lines.find((line) => line.startsWith(REPLY));
  return { code, lines: lines.filter((line) => !line.startsWith(REPLY)), reply: reply ? (JSON.parse(reply.slice(REPLY.length)) as Record<string, unknown>) : null };
}
const helper = (which: 'old' | 'new' | 'copy', labels: Record<string, string> = {}) => {
  const name = nodeHelperName(id, which);
  h.containers.set(name, { labels: { 'ninedeploy.managed': UPGRADE_HELPER_LABEL, 'ninedeploy.database.id': '42', 'ninedeploy.database.slug': 'main', ...labels }, state: 'running', exitCode: 0, tag: 'mysql:8.0', mounts: [] });
  return name;
};
const runArgv = (name: string) => h.argv.find((argv) => argv[0] === 'run' && argv[argv.indexOf('--name') + 1] === name)!;
const RUN = { action: 'run', database: id, helper: 'old', image: 'sha256:old', volume: 'nd-db-main-data', mount: '/var/lib/mysql', env: { MYSQL_ROOT_PASSWORD: 's3cret"pass' } } as const;

describe('the capability', () => {
  it('is advertised, goes with the databases switch, and is sealed only', () => {
    expect(advertisedCapabilities({})).toContain('db.upgrade');
    expect(advertisedCapabilities({ NINEDEPLOY_AGENT_DATABASES: 'off' })).not.toContain('db.upgrade');
    expect(isSealedOnlyAgentOp('db.upgrade')).toBe(true);
  });

  it('is refused over the unencrypted transport before anything is validated or run', async () => {
    await expect(op({ ...RUN }, false)).rejects.toThrow(/Refusing db\.upgrade over the unencrypted transport/);
    expect(h.argv).toEqual([]);
  });
});

describe('the request', () => {
  it('takes only the fields of its action', async () => {
    expect(() => nodeUpgradeRequest.parse({ ...RUN, timeoutMs: 1 })).toThrow();
    expect(() => nodeUpgradeRequest.parse({ action: 'rm', database: id })).toThrow();
    expect(() => nodeUpgradeRequest.parse({ ...RUN, helper: 'other' })).toThrow();
    expect(() => nodeUpgradeRequest.parse({ ...RUN, volume: 'victim-data' })).toThrow();
    expect(() => nodeUpgradeRequest.parse({ ...RUN, mount: 'relative/path' })).toThrow();
    expect(() => nodeUpgradeRequest.parse({ ...RUN, env: { 'A=B': 'x' } })).toThrow();
    expect(() => nodeUpgradeRequest.parse({ ...RUN, env: { A: 'two\nlines' } })).toThrow();
    expect(() => nodeUpgradeRequest.parse({ ...RUN, database: { ...id, container: 'victim' } })).toThrow();
  });

  it('an unknown action or a bad field reaches no docker', async () => {
    await expect(op({ database: id, action: 'prune' })).rejects.toThrow();
    await expect(op({ ...RUN, mount: 'etc' })).rejects.toThrow(/absolute path/);
    expect(h.argv).toEqual([]);
  });
});

describe('run: a helper with no network', () => {
  it('starts the old image on the old volume with the credentials of the row in a 0600 env file that is gone afterwards', async () => {
    const out = await op(RUN);
    expect(out.code).toBe(0);
    expect(out.reply).toEqual({ started: 'nd-db-upg-main-old' });
    const argv = runArgv('nd-db-upg-main-old')!;
    expect(argv).toEqual(expect.arrayContaining(['--network', 'none', '--restart', 'no', '--pull', 'never', '-v', 'nd-db-main-data:/var/lib/mysql', 'sha256:old']));
    expect(argv).toEqual(expect.arrayContaining(['--label', `ninedeploy.managed=${UPGRADE_HELPER_LABEL}`, '--label', 'ninedeploy.database.id=42', '--label', 'ninedeploy.database.upgrade=old']));
    expect(argv.some((a) => a.includes('s3cret'))).toBe(false);
    expect(h.envFiles).toEqual(['MYSQL_ROOT_PASSWORD=s3cret"pass\n']);
    // The env file lived under the agent's env directory and is removed.
    expect(h.argv.some((a) => a.includes('--env-file'))).toBe(true);
    expect(readdirSync(path.join(cwd, '.agent-env'), { recursive: true })).toEqual([]);
  });

  it('gives the helper the memory limit, as the panel host does', async () => {
    await op({ ...RUN, memLimitMb: 256 });
    expect(runArgv('nd-db-upg-main-old')).toEqual(expect.arrayContaining(['--memory', '256m', '--memory-swap', '256m']));
  });

  it('refuses a volume that is of another database, and one that does not exist, before anything runs', async () => {
    h.volumes.set('nd-db-other-data', own('99'));
    await expect(op({ ...RUN, volume: 'nd-db-other-data' })).rejects.toThrow(/does not belong to database #42/);
    await expect(op({ ...RUN, volume: 'nd-db-missing-data' })).rejects.toThrow(/does not exist on this node/);
    expect(h.argv.filter((argv) => argv[0] === 'run')).toEqual([]);
  });

  it('replaces a leftover helper of the same database, and refuses a container of that name that is not one', async () => {
    helper('old');
    await op(RUN);
    expect(h.argv.some((argv) => argv[0] === 'rm' && argv.at(-1) === 'nd-db-upg-main-old')).toBe(true);
    h.containers.set(nodeHelperName(id, 'old'), { labels: { 'ninedeploy.managed': 'database', 'ninedeploy.database.id': '99' }, state: 'running', exitCode: 0, tag: 'mysql:8.0', mounts: [] });
    await expect(op(RUN)).rejects.toThrow(/is not an upgrade helper of database #42/);
    expect(h.containers.has(nodeHelperName(id, 'old'))).toBe(true);
    expect(h.argv.filter((argv) => argv[0] === 'run')).toHaveLength(1);
  });

  it('removes the env file when the container does not start', async () => {
    h.runExit = 125;
    await expect(op(RUN)).rejects.toThrow(/exited with 125/);
    expect(readdirSync(path.join(cwd, '.agent-env'), { recursive: true })).toEqual([]);
  });
});

describe('remove and stop: only the helpers of this database', () => {
  it('removes a helper; a missing one is done; a container of another database under that name is untouched', async () => {
    const name = helper('copy');
    expect((await op({ action: 'remove', database: id, helper: 'copy' })).code).toBe(0);
    expect(h.containers.has(name)).toBe(false);
    expect((await op({ action: 'remove', database: id, helper: 'copy' })).code).toBe(0);
    h.containers.set(name, { labels: { 'ninedeploy.managed': 'database', 'ninedeploy.database.id': '42' }, state: 'running', exitCode: 0, tag: 'x', mounts: [] });
    await expect(op({ action: 'remove', database: id, helper: 'copy' })).rejects.toThrow(/nothing was done to it/);
    expect(h.containers.has(name)).toBe(true);
  });

  it('stop answers the exit code of a clean stop and removes the helper', async () => {
    helper('old');
    const out = await op({ action: 'stop', database: id, helper: 'old', timeoutSec: 60 });
    expect(out.reply).toEqual({ exitCode: 0 });
    expect(h.argv.find((argv) => argv[0] === 'stop')).toEqual(['stop', '--time', '60', 'nd-db-upg-main-old']);
    expect(h.containers.has('nd-db-upg-main-old')).toBe(false);
  });

  it('a stop that ended in a kill answers its code; a helper that is not there answers null', async () => {
    h.stopExit = 137;
    helper('new');
    expect((await op({ action: 'stop', database: id, helper: 'new', timeoutSec: 5 })).reply).toEqual({ exitCode: 137 });
    expect((await op({ action: 'stop', database: id, helper: 'new', timeoutSec: 5 })).reply).toEqual({ exitCode: null });
  });
});

describe('copy: the copier is detached, read-only on the old volume', () => {
  it('starts it once both volumes belong to the database', async () => {
    const out = await op({ action: 'copy', database: id, image: 'mysql:8.4', from: 'nd-db-main-data', to: 'nd-db-main-data-u7' });
    expect(out.reply).toEqual({ started: 'nd-db-upg-main-copy' });
    expect(runArgv('nd-db-upg-main-copy')).toEqual([
      'run', '-d', '--name', 'nd-db-upg-main-copy', '--network', 'none', '--restart', 'no', '--pull', 'never',
      '--label', `ninedeploy.managed=${UPGRADE_HELPER_LABEL}`, '--label', 'ninedeploy.database.id=42', '--label', 'ninedeploy.database.slug=main', '--label', 'ninedeploy.database.upgrade=copy',
      '--entrypoint', 'sh', '-v', 'nd-db-main-data:/from:ro', '-v', 'nd-db-main-data-u7:/to', 'mysql:8.4', '-c', COPY_SCRIPT,
    ]);
  });

  it('refuses the same volume twice, and a target that is of another database', async () => {
    await expect(op({ action: 'copy', database: id, image: 'mysql:8.4', from: 'nd-db-main-data', to: 'nd-db-main-data' })).rejects.toThrow(/the same volume/);
    h.volumes.set('nd-db-other-data', own('99'));
    await expect(op({ action: 'copy', database: id, image: 'mysql:8.4', from: 'nd-db-main-data', to: 'nd-db-other-data' })).rejects.toThrow(/does not belong to database #42/);
    expect(h.argv.filter((argv) => argv[0] === 'run')).toEqual([]);
  });
});

describe('sql: a statement of the catalogue, by name', () => {
  it('builds the text on the node and never receives it', async () => {
    helper('old');
    h.answer = { out: '8.0.40\n', stderr: '', code: 0 };
    const params = { action: 'sql', database: id, target: { kind: 'helper', helper: 'old' }, statement: 'mysql.serverVersion', password: 'p#w"rd' };
    expect(JSON.stringify(params).includes('SELECT VERSION()')).toBe(false);
    const out = await op(params);
    expect(out).toEqual({ code: 0, lines: ['8.0.40'], reply: null });
    expect(h.streamArgv[0]).toEqual(['exec', '-i', 'nd-db-upg-main-old', 'mysql', '--defaults-extra-file=/dev/stdin', '-h127.0.0.1', '-uroot', '-N', '-B', '-e', 'SELECT VERSION()']);
    // The password reaches the client on stdin only.
    expect(h.streamStdin).toEqual(['[client]\npassword="p#w\\"rd"\n']);
    expect(h.streamArgv[0]!.some((a) => a.includes('p#w'))).toBe(false);
  });

  it('runs the count of one chunk of tables from the names it is given, escaped', async () => {
    helper('old');
    await op({ action: 'sql', database: id, target: { kind: 'helper', helper: 'old' }, statement: 'mysql.tableCounts', password: 'x', args: { tables: [{ schema: 'shop', table: 'orders' }, { schema: 'a`b', table: 'c`d' }], offset: 100 } });
    expect(h.streamArgv[0]!.at(-1)).toBe('SELECT 100, COUNT(*) FROM `shop`.`orders` UNION ALL SELECT 101, COUNT(*) FROM `a``b`.`c``d`');
  });

  it('refuses what is not in the catalogue, another family, and an argument the statement does not take', async () => {
    helper('old');
    const base = { action: 'sql', database: id, target: { kind: 'helper', helper: 'old' }, password: 'x' };
    await expect(op({ ...base, statement: 'SELECT 1' })).rejects.toThrow(/Unknown upgrade statement/);
    await expect(op({ ...base, statement: 'postgres.analyze' })).rejects.toThrow(/does not run on mysql/);
    await expect(op({ ...base, statement: 'mysql.serverVersion', args: { tables: [{ schema: 'a', table: 'b' }] } })).rejects.toThrow(/Invalid upgrade statement arguments for mysql.serverVersion/);
    await expect(op({ ...base, statement: 'mysql.tableCounts' })).rejects.toThrow(/Invalid upgrade statement arguments for mysql.tableCounts/);
    await expect(op({ ...base, statement: 'mysql.tableCounts', args: { tables: [{ schema: 'a', table: 'b' }], offset: -1 } })).rejects.toThrow(/Invalid upgrade statement arguments/);
    expect(h.streamed).toBe(0);
  });

  it('a PostgreSQL statement connects as the managed user to the statement’s database', async () => {
    helper('old');
    await op({ action: 'sql', database: PG, target: { kind: 'helper', helper: 'old' }, statement: 'postgres.tablesInPostgresDb', password: '' });
    expect(h.streamArgv[0]).toEqual(['exec', '-i', 'nd-db-upg-main-old', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'nine', '-d', 'postgres', '-At', '-F', '\u001f', '-c', upgradeStatement('postgres.tablesInPostgresDb').text]);
  });

  it('answers stdout alone; a failed statement answers its code with the tail of stderr', async () => {
    helper('old');
    h.answer = { out: 'shop\t7\n', stderr: 'mysql: [Warning] something\n', code: 0 };
    expect((await op({ action: 'sql', database: id, target: { kind: 'helper', helper: 'old' }, statement: 'mysql.ping', password: 'x' })).lines).toEqual(['shop\t7']);
    h.answer = { out: '', stderr: 'ERROR 1064 (42000) at line 1: You have an error in your SQL syntax', code: 1 };
    const failed = await op({ action: 'sql', database: id, target: { kind: 'helper', helper: 'old' }, statement: 'mysql.ping', password: 'x' });
    expect(failed).toEqual({ code: 1, lines: ['ERROR 1064 (42000) at line 1: You have an error in your SQL syntax'], reply: null });
  });

  it('refuses an answer the agent channel would cut, instead of answering part of it', async () => {
    helper('old');
    h.answer = { out: 'x'.repeat(SQL_ANSWER_CAP + 1), stderr: '', code: 0 };
    await expect(op({ action: 'sql', database: id, target: { kind: 'helper', helper: 'old' }, statement: 'mysql.userTables', password: 'x' })).rejects.toThrow(/larger than .* bytes/);
  });

  it('runs only in the database container or in one of its helpers', async () => {
    h.containers.set('nd-db-main', { labels: { 'ninedeploy.managed': 'database', 'ninedeploy.database.id': '99' }, state: 'running', exitCode: 0, tag: 'x', mounts: [] });
    await expect(op({ action: 'sql', database: id, target: { kind: 'database' }, statement: 'mysql.ping', password: 'x' })).rejects.toThrow(/does not belong to database #42/);
    await expect(op({ action: 'sql', database: id, target: { kind: 'helper', helper: 'new' }, statement: 'mysql.ping', password: 'x' })).rejects.toThrow(/does not exist on this node/);
    expect(h.streamed).toBe(0);
  });
});

describe('state and measure', () => {
  it('state: missing, or the state with the image id and tag; a container of another database is refused', async () => {
    expect((await op({ action: 'state', database: id, target: { kind: 'database' } })).reply).toEqual({ state: 'missing' });
    h.containers.set('nd-db-main', { labels: { 'ninedeploy.managed': 'database', 'ninedeploy.database.id': '42', 'ninedeploy.database.slug': 'main' }, state: 'running', exitCode: 0, tag: 'mysql:8.0', mounts: [] });
    expect((await op({ action: 'state', database: id, target: { kind: 'database' } })).reply).toEqual({ state: 'running', exitCode: 0, imageId: `sha256:${'a'.repeat(64)}`, imageTag: 'mysql:8.0' });
    h.containers.get('nd-db-main')!.labels['ninedeploy.database.id'] = '99';
    await expect(op({ action: 'state', database: id, target: { kind: 'database' } })).rejects.toThrow(/does not belong to database #42/);
  });

  it('measure: du of the directory, df of where it lives', async () => {
    helper('old');
    h.answer = { out: '123456\t/var/lib/mysql\n', stderr: 'du: warning ignored\n', code: 0 };
    expect((await op({ action: 'measure', database: id, target: { kind: 'helper', helper: 'old' }, what: 'size', dir: '/var/lib/mysql' })).lines).toEqual(['123456\t/var/lib/mysql']);
    h.answer = { out: 'Filesystem\t1-blocks\tUsed\tAvailable\n/dev/vda1\t100\n', stderr: '', code: 0 };
    expect((await op({ action: 'measure', database: id, target: { kind: 'helper', helper: 'old' }, what: 'free', dir: '/var/lib/mysql' })).lines).toHaveLength(2);
    expect(h.streamArgv.map((argv) => argv.slice(1))).toEqual([['nd-db-upg-main-old', 'du', '-sb', '/var/lib/mysql'], ['nd-db-upg-main-old', 'df', '-PB1', '/var/lib/mysql']]);
  });
});

describe('how long the panel waits', () => {
  it('a slow stop and a catalogue statement name their own budget; everything else is a short step', () => {
    expect(agentRequestTimeoutMs('db.upgrade', { action: 'stop', timeoutSec: 3600 })).toBe(3_840_000);
    expect(agentRequestTimeoutMs('db.upgrade', { action: 'stop', timeoutSec: 60 })).toBe(300_000);
    expect(agentRequestTimeoutMs('db.upgrade', { action: 'sql', statement: 'mysql.tableCounts' })).toBe(6 * 60 * 60_000 + 120_000);
    expect(agentRequestTimeoutMs('db.upgrade', { action: 'sql', statement: 'postgres.ping' })).toBe(30 * 60_000 + 120_000);
    expect(agentRequestTimeoutMs('db.upgrade', { action: 'state' })).toBe(600_000);
    expect(agentRequestTimeoutMs('db.upgrade', { action: 'sql', statement: 'not in the catalogue' })).toBe(600_000);
  });

  it('a step longer than the short budget is posted as a long request, without the five-minute header cap', () => {
    expect(isLongAgentRequest('db.upgrade', { action: 'stop', timeoutSec: 3600 })).toBe(true);
    expect(isLongAgentRequest('db.upgrade', { action: 'sql', statement: 'mysql.tableCounts' })).toBe(true);
    expect(isLongAgentRequest('db.upgrade', { action: 'stop', timeoutSec: 60 })).toBe(false);
    expect(isLongAgentRequest('db.upgrade', { action: 'state' })).toBe(false);
    expect(isLongAgentRequest('docker.build')).toBe(true);
    expect(isLongAgentRequest('docker.pull')).toBe(false);
  });
});
