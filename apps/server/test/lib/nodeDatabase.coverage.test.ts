import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database, DB } from '@ninedeploy/db';

/**
 * lib/nodeDatabase.ts, panel side, without a database file: the runtime is
 * driven with a fake agent, a fake stream opener and a fake capability check
 * (or the real defaults with agentOp / openAgentStream / assertNodeCapability
 * faked at their modules). Covers what nodeDatabases.test.ts does not reach:
 * reuse and adoption in start, the error paths of logs / size / probes, the
 * wrong stream direction, the bridge connect / disconnect, the replica-set
 * and deadline refusals of connectServiceToNodeDatabases, the engine gate,
 * volume labels, reachability and the per-server count.
 */

const h = vi.hoisted(() => ({
  agentOps: [] as Array<{ serverId: number; op: string; params: Record<string, unknown>; opts: unknown }>,
  streamOpens: [] as Array<{ serverId: number; kind: string; params: Record<string, unknown> }>,
  capChecks: [] as Array<{ serverId: number; opts: unknown }>,
  sleeps: [] as number[],
}));

vi.mock('../../src/lib/agentClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/agentClient.js')>()),
  agentOp: vi.fn(async (_db: unknown, serverId: number, op: string, params: Record<string, unknown>, _sink: unknown, opts: unknown) => {
    h.agentOps.push({ serverId, op, params, opts });
    return { exitCode: 0, lines: ['running|10.0.0.2'] };
  }),
}));
vi.mock('../../src/lib/agentStream.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/agentStream.js')>()),
  openAgentStream: vi.fn(async (_db: unknown, serverId: number, kind: string, params: Record<string, unknown>) => {
    h.streamOpens.push({ serverId, kind, params });
    const readable = new PassThrough();
    readable.end(Buffer.from('dump'));
    return { kind, direction: 'agent-to-panel', readable, done: Promise.resolve({}), abort: () => undefined };
  }),
}));
vi.mock('../../src/lib/agentCapabilities.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/agentCapabilities.js')>()),
  assertNodeCapability: vi.fn(async (_db: unknown, serverId: number, opts: unknown) => {
    h.capChecks.push({ serverId, opts });
  }),
}));
vi.mock('../../src/lib/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/exec.js')>()),
  sleep: async (ms: number) => {
    h.sleeps.push(ms);
  },
}));

const nd = await import('../../src/lib/nodeDatabase.js');
const { encrypt } = await import('../../src/lib/crypto.js');
const { HttpError } = await import('../../src/lib/errors.js');

const fakeDb = {} as DB;
const tmp = mkdtempSync(path.join(os.tmpdir(), 'nd-nodedb-cov-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function row(values: Partial<Database> = {}): Database {
  return {
    id: 7,
    name: 'orders',
    slug: 'orders',
    engine: 'postgres',
    version: null,
    serverId: 3,
    nodeContainerName: null,
    nodeVolumeName: null,
    passwordEncrypted: encrypt('pw-orders'),
    ownerUserId: 1,
    cpuShares: 0,
    cpuLimitMilli: 0,
    memLimitMb: 0,
    ...values,
  } as Database;
}

type Answer = { exitCode: number; lines: string[] } | Error;
/** A scripted agent: `answers[op]` is one answer or a queue of answers; unknown ops answer exit 0. */
function scriptedAgent(answers: Record<string, Answer | Answer[]> = {}) {
  const calls: Array<{ op: string; params: Record<string, unknown>; opts?: unknown }> = [];
  const agent = vi.fn(async (op: string, params: Record<string, unknown>, opts?: { tolerateExit?: boolean; timeoutMs?: number }) => {
    calls.push(opts === undefined ? { op, params } : { op, params, opts });
    const scripted = answers[op];
    const next = Array.isArray(scripted) ? (scripted.length > 1 ? scripted.shift() : scripted[0]) : scripted;
    if (next instanceof Error) throw next;
    return next ?? { exitCode: 0, lines: [] };
  });
  return { agent, calls, ops: () => calls.map((c) => c.op) };
}

const noCaps = { assertCapable: async () => undefined };
const logs = () => {
  const lines: string[] = [];
  return { lines, log: (l: string) => void lines.push(l) };
};

beforeEach(() => {
  h.agentOps.length = 0;
  h.streamOpens.length = 0;
  h.capChecks.length = 0;
  h.sleeps.length = 0;
  nd.resetNodeReachability();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('names, labels and the engine gate', () => {
  it('derives the container, volume and bridge names, preferring the node_* columns', () => {
    expect(nd.nodeContainerOf({ slug: 'a', nodeContainerName: null })).toBe('nd-db-a');
    expect(nd.nodeContainerOf({ slug: 'a', nodeContainerName: 'nd-db-x' })).toBe('nd-db-x');
    expect(nd.nodeVolumeOf({ slug: 'a', nodeVolumeName: null })).toBe('nd-db-a-data');
    expect(nd.nodeVolumeOf({ slug: 'a', nodeVolumeName: 'nd-db-y' })).toBe('nd-db-y');
    expect(nd.nodeDatabaseNetwork('a')).toBe('nd-dbnet-a');
  });

  it('volume labels: provenance plus the row id; empty, multi-line and oversized values are dropped', () => {
    const labels = nd.nodeDatabaseVolumeLabels(row({ name: 'two\nlines', ownerUserId: null, version: '16' }), { 'ninedeploy.extra': 'x'.repeat(257), 'ninedeploy.ok': 'yes' });
    expect(labels).toEqual({
      'ninedeploy.managed': 'database',
      'ninedeploy.database.slug': 'orders',
      'ninedeploy.database.engine': 'postgres',
      'ninedeploy.database.image': 'postgres:16',
      'ninedeploy.database.container': 'nd-db-orders',
      'ninedeploy.database.id': '7',
      'ninedeploy.ok': 'yes',
    });
    expect(() => nd.nodeDatabaseVolumeLabels(row({ engine: 'oracle' }))).toThrow('Unknown engine: oracle');
  });

  it('keydb and dragonfly need an agent of 0.15.6 or newer; other engines pass on any version', () => {
    expect(() => nd.assertNodeAgentKnowsEngine('postgres', null, 'edge-1')).not.toThrow();
    expect(() => nd.assertNodeAgentKnowsEngine('keydb', '0.15.6', 'edge-1')).not.toThrow();
    const old = (() => {
      try {
        nd.assertNodeAgentKnowsEngine('dragonfly', null, 'edge-1');
      } catch (err) {
        return err;
      }
      return null;
    })();
    expect(old).toBeInstanceOf(HttpError);
    expect(old).toMatchObject({ statusCode: 422, code: 'node_agent_outdated' });
    expect((old as Error).message).toContain('The agent on node edge-1 (an older release) cannot run dragonfly databases.');
    expect(() => nd.assertNodeAgentKnowsEngine('keydb', '0.15.3', 'edge-2')).toThrow(/\(version 0\.15\.3\) cannot run keydb databases\. Update the node agent to v0\.15\.6/);
  });

  it('assertNodeDatabaseCapable: the injected check or the sealed queue-time default, with the feature named', async () => {
    const seen: unknown[] = [];
    await nd.assertNodeDatabaseCapable(fakeDb, 3, { assertCapable: async (...a) => void seen.push(a.slice(1)) });
    expect(seen).toEqual([[3, nd.NODE_DATABASE_CAPS, nd.NODE_DATABASE_FEATURE]]);
    await nd.assertNodeDatabaseCapable(fakeDb, 4);
    expect(h.capChecks).toEqual([{ serverId: 4, opts: { cap: nd.NODE_DATABASE_CAPS, feature: 'host a managed database', sealedRequired: true } }]);
  });
});

describe('nodeContainerState', () => {
  it('reads the state before the pipe, the first line without one, or missing', async () => {
    expect(await nd.nodeContainerState(scriptedAgent({ 'docker.inspect': { exitCode: 0, lines: ['noise', ' exited |1.2.3.4'] } }).agent, 'c')).toBe('exited');
    expect(await nd.nodeContainerState(scriptedAgent({ 'docker.inspect': { exitCode: 0, lines: ['paused'] } }).agent, 'c')).toBe('paused');
    expect(await nd.nodeContainerState(scriptedAgent({ 'docker.inspect': { exitCode: 0, lines: [] } }).agent, 'c')).toBe('missing');
    expect(await nd.nodeContainerState(scriptedAgent({ 'docker.inspect': { exitCode: 0, lines: ['|x'] } }).agent, 'c')).toBe('missing');
    expect(await nd.nodeContainerState(scriptedAgent({ 'docker.inspect': { exitCode: 1, lines: ['running|x'] } }).agent, 'c')).toBe('missing');
    const err = scriptedAgent({ 'docker.inspect': new Error('ECONNREFUSED') });
    await expect(nd.nodeContainerState(err.agent, 'c')).rejects.toThrow('ECONNREFUSED');
    expect(err.calls).toEqual([{ op: 'docker.inspect', params: { name: 'c', format: 'state' }, opts: { tolerateExit: true } }]);
  });
});

describe('nodeDatabaseRuntime.start', () => {
  it('refuses a panel-host row and an unknown engine', async () => {
    expect(() => nd.nodeDatabaseRuntime(fakeDb, row({ serverId: null }))).toThrow('not a node database');
    const rt = nd.nodeDatabaseRuntime(fakeDb, row({ engine: 'oracle' }), { agent: scriptedAgent().agent, ...noCaps });
    await expect(rt.start(() => undefined)).rejects.toThrow('Unknown engine: oracle');
  });

  it('reuses a running container without touching anything else', async () => {
    const a = scriptedAgent({ 'docker.inspect': { exitCode: 0, lines: ['running|10.0.0.2'] } });
    const { lines, log } = logs();
    const rt = nd.nodeDatabaseRuntime(fakeDb, row(), { agent: a.agent, ...noCaps });
    expect(rt).toMatchObject({ where: 'node', serverId: 3, container: 'nd-db-orders', volume: 'nd-db-orders-data', network: 'nd-dbnet-orders' });
    await rt.start(log);
    expect(a.ops()).toEqual(['docker.inspect']);
    expect(lines).toEqual(['nd-db-orders already running on node #3 — reusing']);
  });

  it('reuses an existing volume; limits and namespaced labels ride the spec; a refused network create is harmless', async () => {
    const a = scriptedAgent({
      'docker.inspect': { exitCode: 1, lines: [] },
      'docker.networkCreate': new Error('network already exists'),
      'docker.volumeInspect': { exitCode: 0, lines: [] },
      'docker.rm': new Error('no such container'),
    });
    const { lines, log } = logs();
    const rt = nd.nodeDatabaseRuntime(fakeDb, row({ engine: 'redis', slug: 'cache', cpuShares: 512, cpuLimitMilli: 500, memLimitMb: 256 }), { agent: a.agent, ...noCaps });
    await rt.start(log, { labels: { 'ninedeploy.preview': 'pr-4', 'evil.label': 'x', 'ninedeploy.UPPER': 'no' } });
    expect(a.ops()).toEqual(['docker.inspect', 'docker.networkCreate', 'docker.volumeInspect', 'docker.pull', 'docker.rm', 'docker.runSpec']);
    expect(lines).toContain('Reusing volume nd-db-cache-data on node #3');
    const spec = a.calls.find((c) => c.op === 'docker.runSpec')!.params;
    expect(spec).toEqual({
      name: 'nd-db-cache',
      image: 'redis:8.8',
      restart: 'unless-stopped',
      network: 'nd-dbnet-cache',
      volumes: [{ name: 'nd-db-cache-data', mount: '/data' }],
      labels: { 'ninedeploy.database.slug': 'cache', 'ninedeploy.database.id': '7', 'ninedeploy.preview': 'pr-4' },
      managed: 'database',
      cmd: ['--requirepass', 'pw-orders'],
      cpuShares: 512,
      cpuLimitMilli: 500,
      memLimitMb: 256,
    });
  });

  it('adopts a container that runs despite a failed runSpec, and still deletes the env file', async () => {
    const a = scriptedAgent({
      'docker.inspect': [{ exitCode: 1, lines: [] }, { exitCode: 0, lines: ['running|x'] }],
      'docker.volumeInspect': { exitCode: 1, lines: [] },
      'file.writeEnv': { exitCode: 0, lines: ['wrote .agent-env/nd-db-orders.env'] },
      'docker.runSpec': new Error('agent docker.runSpec timed out'),
      'file.deleteEnv': new Error('gone'),
    });
    const { lines, log } = logs();
    await nd.nodeDatabaseRuntime(fakeDb, row(), { agent: a.agent, ...noCaps }).start(log);
    expect(lines).toContain('nd-db-orders is running despite the run failure — adopting it');
    expect(a.ops()).toEqual([
      'docker.inspect', 'docker.networkCreate', 'docker.volumeInspect', 'docker.volumeCreate', 'docker.pull', 'docker.rm',
      'file.writeEnv', 'docker.runSpec', 'docker.inspect', 'file.deleteEnv',
    ]);
  });

  it('a failed runSpec without a running container removes it and rethrows (an unreachable state check counts as missing)', async () => {
    const a = scriptedAgent({
      'docker.inspect': [{ exitCode: 1, lines: [] }, new Error('ECONNRESET')],
      'docker.volumeInspect': { exitCode: 1, lines: [] },
      'file.writeEnv': { exitCode: 0, lines: ['wrote .agent-env/nd-db-orders.env'] },
      'docker.runSpec': new Error('image not found'),
    });
    await expect(nd.nodeDatabaseRuntime(fakeDb, row(), { agent: a.agent, ...noCaps }).start(() => undefined)).rejects.toThrow('image not found');
    expect(a.ops().slice(-4)).toEqual(['docker.runSpec', 'docker.inspect', 'docker.rm', 'file.deleteEnv']);
  });

  it('the default capability check names the start capabilities', async () => {
    const a = scriptedAgent({ 'docker.inspect': { exitCode: 0, lines: ['running|x'] } });
    await nd.nodeDatabaseRuntime(fakeDb, row(), { agent: a.agent }).start(() => undefined);
    expect(h.capChecks).toEqual([{ serverId: 3, opts: { cap: ['db.manage', 'docker.runSpec', 'volume.manage'], feature: 'host a managed database', sealedRequired: true } }]);
  });
});

describe('nodeDatabaseRuntime: stop, restart, logs, size, probes, state', () => {
  it('stop and restart reach the node; the default agent is agentOp on the row node', async () => {
    const rt = nd.nodeDatabaseRuntime(fakeDb, row());
    const { lines, log } = logs();
    await rt.stop(log);
    await rt.restart(log);
    expect(h.agentOps.map((o) => [o.serverId, o.op, o.params])).toEqual([
      [3, 'docker.rm', { name: 'nd-db-orders' }],
      [3, 'docker.restart', { name: 'nd-db-orders' }],
    ]);
    expect(h.capChecks).toEqual([{ serverId: 3, opts: { cap: ['db.manage'], feature: 'host a managed database', sealedRequired: true } }]);
    expect(lines).toEqual(['Stopping nd-db-orders on node #3 (volume retained) …', 'Restarting nd-db-orders on node #3 …']);
    expect(await rt.state()).toBe('running');
  });

  it('logs: the last lines on success, nothing on a non-zero exit or an unreachable node', async () => {
    const ok = scriptedAgent({ 'docker.logs': { exitCode: 0, lines: ['a', '', 'b', 'c'] } });
    expect(await nd.nodeDatabaseRuntime(fakeDb, row(), { agent: ok.agent }).logs(2)).toEqual(['b', 'c']);
    expect(await nd.nodeDatabaseRuntime(fakeDb, row(), { agent: ok.agent }).logs()).toEqual(['a', 'b', 'c']);
    expect(await nd.nodeDatabaseRuntime(fakeDb, row(), { agent: scriptedAgent({ 'docker.logs': { exitCode: 1, lines: ['x'] } }).agent }).logs()).toEqual([]);
    expect(await nd.nodeDatabaseRuntime(fakeDb, row(), { agent: scriptedAgent({ 'docker.logs': new Error('down') }).agent }).logs()).toEqual([]);
  });

  it('size: parsed on success, 0 on failure, an unreachable node, or an engine without a size query', async () => {
    const redis = scriptedAgent({ 'db.exec': { exitCode: 0, lines: ['# Memory', 'used_memory:1048576'] } });
    expect(await nd.nodeDatabaseRuntime(fakeDb, row({ engine: 'redis' }), { agent: redis.agent }).size()).toBe(1048576);
    expect(redis.calls[0]).toEqual({ op: 'db.exec', params: { container: 'nd-db-orders', engine: 'redis', query: 'size', password: 'pw-orders' }, opts: { tolerateExit: true } });
    expect(await nd.nodeDatabaseRuntime(fakeDb, row(), { agent: scriptedAgent({ 'db.exec': { exitCode: 2, lines: ['9'] } }).agent }).size()).toBe(0);
    expect(await nd.nodeDatabaseRuntime(fakeDb, row(), { agent: scriptedAgent({ 'db.exec': new Error('down') }).agent }).size()).toBe(0);
    const none = scriptedAgent();
    expect(await nd.nodeDatabaseRuntime(fakeDb, row({ engine: 'meilisearch' }), { agent: none.agent }).size()).toBe(0);
    expect(none.calls).toEqual([]);
  });

  it('probeCredentials: retries with the delay until the engine answers, gives up after the attempts', async () => {
    const a = scriptedAgent({ 'db.exec': [new Error('not ready'), { exitCode: 1, lines: [] }, { exitCode: 0, lines: ['', 'PONG'] }] });
    expect(await nd.nodeDatabaseRuntime(fakeDb, row({ engine: 'redis' }), { agent: a.agent }).probeCredentials(5, 250)).toBe(true);
    expect(a.calls).toHaveLength(3);
    expect(h.sleeps).toEqual([250, 250]);
    h.sleeps.length = 0;
    const never = scriptedAgent({ 'db.exec': { exitCode: 0, lines: ['0'] } });
    expect(await nd.nodeDatabaseRuntime(fakeDb, row(), { agent: never.agent }).probeCredentials(3, 10)).toBe(false);
    expect(never.calls).toHaveLength(3);
    expect(h.sleeps).toEqual([10, 10]);
    const unsupported = scriptedAgent();
    expect(await nd.nodeDatabaseRuntime(fakeDb, row({ engine: 'rabbitmq' }), { agent: unsupported.agent }).probeCredentials()).toBe(false);
    expect(unsupported.calls).toEqual([]);
  });

  it('probeMysqlSandboxFlag: the flag on success, null on failure, an unreachable node, or a non-MySQL engine', async () => {
    const mysql = scriptedAgent({ 'db.exec': { exitCode: 0, lines: ['  --system-command  Enable (\\!)'] } });
    expect(await nd.nodeDatabaseRuntime(fakeDb, row({ engine: 'mysql' }), { agent: mysql.agent }).probeMysqlSandboxFlag()).toBe('--system-command=OFF');
    expect(mysql.calls[0]!.params).toMatchObject({ query: 'mysqlHelp', engine: 'mysql' });
    expect(await nd.nodeDatabaseRuntime(fakeDb, row({ engine: 'mariadb' }), { agent: scriptedAgent({ 'db.exec': { exitCode: 1, lines: [] } }).agent }).probeMysqlSandboxFlag()).toBeNull();
    expect(await nd.nodeDatabaseRuntime(fakeDb, row({ engine: 'mariadb' }), { agent: scriptedAgent({ 'db.exec': new Error('down') }).agent }).probeMysqlSandboxFlag()).toBeNull();
    expect(await nd.nodeDatabaseRuntime(fakeDb, row(), { agent: scriptedAgent().agent }).probeMysqlSandboxFlag()).toBeNull();
  });
});

describe('nodeDatabaseRuntime: backups, restores and imports', () => {
  it('backup over the default stream opener writes the encrypted file; an unknown engine is refused before any stream', async () => {
    const dir = mkdtempSync(path.join(tmp, 'b-'));
    const file = path.join(dir, 'x.dump');
    const { lines, log } = logs();
    await nd.nodeDatabaseRuntime(fakeDb, row(), noCaps).backup(file, log);
    expect(h.streamOpens).toEqual([{ serverId: 3, kind: 'db.dump', params: { container: 'nd-db-orders', engine: 'postgres', password: 'pw-orders' } }]);
    expect(readdirSync(dir)).toEqual(['x.dump']);
    expect(lines).toContain('Dumping orders on node #3 …');
    await expect(nd.nodeDatabaseRuntime(fakeDb, row({ engine: 'oracle' }), noCaps).backup(file, () => undefined)).rejects.toThrow('backup not supported for oracle');
    await expect(nd.nodeDatabaseRuntime(fakeDb, row({ engine: 'oracle' }), noCaps).restore(file, () => undefined)).rejects.toThrow('restore not supported for oracle');
    expect(h.streamOpens).toHaveLength(1);
  });

  it('an empty dump still gets the envelope header', async () => {
    const dir = mkdtempSync(path.join(tmp, 'e-'));
    const file = path.join(dir, 'empty.dump');
    const openStream = vi.fn(async () => {
      const readable = new PassThrough();
      readable.end();
      return { kind: 'db.dump', direction: 'agent-to-panel', readable, done: Promise.resolve({}), abort: () => undefined } as never;
    });
    await nd.nodeDatabaseRuntime(fakeDb, row(), { ...noCaps, openStream }).backup(file, () => undefined);
    // The envelope: one `NDBK1:` header line, no ciphertext, the 16-byte GCM tag.
    const bytes = readFileSync(file);
    const newline = bytes.indexOf(0x0a);
    expect(bytes.subarray(0, newline + 1).toString()).toMatch(/^NDBK1:/);
    expect(bytes.length).toBe(newline + 1 + 16);
  });

  it('refuses a stream answered in the wrong direction (dump and restore)', async () => {
    const wrong = vi.fn(async (_db: DB, _id: number, kind: string) =>
      (kind === 'db.dump'
        ? { kind, direction: 'panel-to-agent', writable: new PassThrough(), done: Promise.resolve({}), abort: () => undefined }
        : { kind, direction: 'agent-to-panel', readable: new PassThrough(), done: Promise.resolve({}), abort: () => undefined }) as never,
    );
    const rt = nd.nodeDatabaseRuntime(fakeDb, row(), { ...noCaps, openStream: wrong });
    await expect(rt.backup(path.join(tmp, 'w.dump'), () => undefined)).rejects.toThrow('db.dump answered the wrong stream direction');
    const plain = path.join(tmp, 'plain.sql');
    writeFileSync(plain, 'SELECT 1;');
    await expect(rt.restore(plain, () => undefined)).rejects.toThrow('db.restore answered the wrong stream direction');
  });

  it('a restore whose send fails aborts the channel with the reason', async () => {
    const plain = path.join(tmp, 'plain2.sql');
    writeFileSync(plain, 'SELECT 1;');
    const abort = vi.fn();
    const openStream = vi.fn(async () => ({
      kind: 'db.restore',
      direction: 'panel-to-agent',
      writable: new Writable({ write: (_c, _e, cb) => cb(new Error('channel cut')) }),
      done: new Promise(() => undefined),
      abort,
    }) as never);
    const { lines, log } = logs();
    await expect(nd.nodeDatabaseRuntime(fakeDb, row(), { ...noCaps, openStream }).restore(plain, log)).rejects.toThrow('channel cut');
    expect(abort).toHaveBeenCalledWith('the panel could not send the dump');
    expect(lines).toContain('Restoring orders on node #3 …');
  });

  it('extra engines check db.dump.extra first; an import without a safety backup sends every plan field', async () => {
    const seen: unknown[] = [];
    const received: Buffer[] = [];
    const openStream = vi.fn(async (_db: DB, _id: number, kind: string, params: Record<string, unknown>) => {
      seen.push({ kind, params });
      const writable = new PassThrough();
      writable.on('data', (c: Buffer) => received.push(Buffer.from(c)));
      const done = new Promise((resolve) => writable.on('finish', () => resolve({})));
      return { kind, direction: 'panel-to-agent', writable, done, abort: () => undefined } as never;
    });
    const plain = path.join(tmp, 'import.sql');
    writeFileSync(plain, 'INSERT 1;');
    const caps: unknown[] = [];
    const rt = nd.nodeDatabaseRuntime(fakeDb, row({ engine: 'clickhouse' }), { assertCapable: async (...a) => void caps.push(a.slice(2)), openStream });
    await rt.restore(plain, () => undefined);
    expect(caps).toEqual([[['db.manage', 'db.dump.extra'], 'back up and restore clickhouse on a node']]);
    await nd
      .nodeDatabaseRuntime(fakeDb, row({ engine: 'postgres' }), { ...noCaps, openStream })
      .import(plain, { format: 'pg_custom', gzip: true, clean: false, singleTransaction: true, drop: false }, () => undefined);
    expect(seen.at(-1)).toEqual({
      kind: 'db.restore',
      params: { container: 'nd-db-orders', engine: 'postgres', password: 'pw-orders', mode: 'import', format: 'pg_custom', gzip: true, clean: false, singleTransaction: true, drop: false, sandboxFlag: null },
    });
    expect(Buffer.concat(received).toString()).toBe('INSERT 1;INSERT 1;');
  });
});

describe('nodeDatabaseRuntime: adoption, bridges and removal', () => {
  it('adoptRetainedVolume: fresh, the row own volume, or a 409 for a foreign one', async () => {
    expect(await nd.nodeDatabaseRuntime(fakeDb, row(), { agent: scriptedAgent({ 'docker.volumeInspect': { exitCode: 1, lines: [] } }).agent }).adoptRetainedVolume(() => undefined)).toEqual({ action: 'fresh' });
    const own = JSON.stringify({ Name: 'nd-db-orders-data', Labels: 'ninedeploy.database.id=7' });
    expect(
      await nd.nodeDatabaseRuntime(fakeDb, row(), { agent: scriptedAgent({ 'docker.volumeList': { exitCode: 0, lines: [own] } }).agent }).adoptRetainedVolume(() => undefined),
    ).toEqual({ action: 'no-rekey-needed' });
    const foreign = nd.nodeDatabaseRuntime(fakeDb, row(), { agent: scriptedAgent({ 'docker.volumeList': { exitCode: 0, lines: ['not json'] } }).agent });
    await expect(foreign.adoptRetainedVolume(() => undefined)).rejects.toMatchObject({ statusCode: 409, code: 'node_volume_exists' });
    await expect(nd.nodeDatabaseRuntime(fakeDb, row(), { agent: scriptedAgent().agent }).attachToServiceBridges(['x'], () => undefined)).resolves.toBeUndefined();
  });

  it('remove: container and bridge, the volume only when purged; a bridge removal failure is ignored', async () => {
    const a = scriptedAgent({ 'docker.networkRm': new Error('in use') });
    const { lines, log } = logs();
    await nd.nodeDatabaseRuntime(fakeDb, row(), { agent: a.agent }).remove({ purgeVolume: false }, log);
    expect(a.ops()).toEqual(['docker.rm', 'docker.networkRm']);
    await nd.nodeDatabaseRuntime(fakeDb, row(), { agent: a.agent }).remove({ purgeVolume: true }, log);
    expect(a.calls.at(-1)).toEqual({ op: 'docker.volumeRm', params: { name: 'nd-db-orders-data' } });
    expect(lines).toContain('Deleting volume nd-db-orders-data on node #3 …');
  });

  it('connect: idempotent on "already attached", otherwise the agent output tail', async () => {
    const ok = scriptedAgent({ 'docker.networkConnect': { exitCode: 1, lines: ['Error: endpoint with name web-1 already exists in network'] } });
    const rt = nd.nodeDatabaseRuntime(fakeDb, row(), { agent: ok.agent });
    await rt.connect('web-1');
    expect(ok.calls).toEqual([{ op: 'docker.networkConnect', params: { network: 'nd-dbnet-orders', container: 'web-1' }, opts: { tolerateExit: true } }]);
    await nd.nodeDatabaseRuntime(fakeDb, row(), { agent: scriptedAgent({ 'docker.networkConnect': { exitCode: 0, lines: [] } }).agent }).connect('web-1');
    const bad = nd.nodeDatabaseRuntime(fakeDb, row(), { agent: scriptedAgent({ 'docker.networkConnect': { exitCode: 1, lines: ['Error:', 'no such network'] } }).agent });
    await expect(bad.connect('web-1')).rejects.toThrow('could not connect web-1 to nd-dbnet-orders: Error: no such network');
  });

  it('disconnect is best effort', async () => {
    const a = scriptedAgent({ 'docker.networkDisconnect': new Error('down') });
    await expect(nd.nodeDatabaseRuntime(fakeDb, row(), { agent: a.agent }).disconnect('web-1')).resolves.toBeUndefined();
    expect(a.calls).toEqual([{ op: 'docker.networkDisconnect', params: { network: 'nd-dbnet-orders', container: 'web-1' }, opts: { tolerateExit: true } }]);
  });
});

describe('connectServiceToNodeDatabases', () => {
  const ID = (c: string) => c.repeat(64);

  it('joins every replica to every attached bridge, with a checkpoint around each join', async () => {
    const a = scriptedAgent({ 'docker.networkConnect': { exitCode: 1, lines: ['already attached'] } });
    const checkpoint = vi.fn(async () => undefined);
    const { lines, log } = logs();
    await nd.connectServiceToNodeDatabases(fakeDb, 3, [{ id: ID('a'), name: 'web-1' }, { id: ID('b'), name: 'web-2' }], [{ id: 1, slug: 'orders' }, { id: 2, slug: 'cache' }], log, { agent: a.agent, checkpoint });
    expect(a.calls.map((c) => c.params)).toEqual([
      { network: 'nd-dbnet-orders', container: ID('a') },
      { network: 'nd-dbnet-cache', container: ID('a') },
      { network: 'nd-dbnet-orders', container: ID('b') },
      { network: 'nd-dbnet-cache', container: ID('b') },
    ]);
    expect(a.calls[0]!.opts).toEqual({ tolerateExit: true, timeoutMs: 15_000 });
    expect(checkpoint).toHaveBeenCalledTimes(8);
    expect(lines[0]).toBe(`Connecting ${ID('a')} to nd-dbnet-orders on node #3`);
  });

  it('the default agent is agentOp on the given node', async () => {
    await nd.connectServiceToNodeDatabases(fakeDb, 9, 'web-9', [{ id: 1, slug: 'orders' }], () => undefined);
    expect(h.agentOps).toEqual([{ serverId: 9, op: 'docker.networkConnect', params: { network: 'nd-dbnet-orders', container: 'web-9' }, opts: { tolerateExit: true, timeoutMs: 15_000 } }]);
  });

  it.each([
    ['an empty replica set', []],
    ['a non-id container', [{ id: 'web-1', name: 'web-1' }]],
    ['a duplicate replica', [{ id: 'a'.repeat(64), name: 'a' }, { id: 'a'.repeat(64), name: 'b' }]],
  ])('refuses %s before any join', async (_what, replicas) => {
    const a = scriptedAgent();
    await expect(nd.connectServiceToNodeDatabases(fakeDb, 3, replicas, [{ id: 1, slug: 'orders' }], () => undefined, { agent: a.agent })).rejects.toThrow(
      'Node database attachment requires a complete immutable replica set',
    );
    expect(a.calls).toEqual([]);
  });

  it('a failed join names the node and the network', async () => {
    const a = scriptedAgent({ 'docker.networkConnect': { exitCode: 1, lines: ['permission denied'] } });
    await expect(nd.connectServiceToNodeDatabases(fakeDb, 3, 'web-1', [{ id: 1, slug: 'orders' }], () => undefined, { agent: a.agent })).rejects.toThrow(
      'could not connect web-1 to the database network nd-dbnet-orders on node #3: permission denied',
    );
  });

  it('the 60 s deadline: refused before a join once spent, and after a join that outlived it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T00:00:00Z'));
    const slow = scriptedAgent();
    const late = vi.fn(async () => {
      vi.setSystemTime(Date.now() + 61_000);
    });
    await expect(nd.connectServiceToNodeDatabases(fakeDb, 3, 'web-1', [{ id: 1, slug: 'orders' }], () => undefined, { agent: slow.agent, checkpoint: late })).rejects.toThrow(
      'Node database attachment deadline exceeded',
    );
    expect(slow.calls).toEqual([]);

    let n = 0;
    const second = vi.fn(async () => {
      n += 1;
      if (n === 2) vi.setSystemTime(Date.now() + 60_000);
    });
    const a = scriptedAgent();
    await expect(nd.connectServiceToNodeDatabases(fakeDb, 3, 'web-1', [{ id: 1, slug: 'orders' }], () => undefined, { agent: a.agent, checkpoint: second })).rejects.toThrow(
      'Node database attachment deadline exceeded',
    );
    expect(a.calls).toHaveLength(1);
    // The per-join timeout shrinks to what is left of the deadline.
    vi.setSystemTime(new Date('2026-10-29T01:00:00Z'));
    const t = scriptedAgent();
    let first = true;
    const spend = vi.fn(async () => {
      if (first) vi.setSystemTime(Date.now() + 50_000);
      first = false;
    });
    await nd.connectServiceToNodeDatabases(fakeDb, 3, 'web-1', [{ id: 1, slug: 'orders' }], () => undefined, { agent: t.agent, checkpoint: spend });
    expect(t.calls[0]!.opts).toEqual({ tolerateExit: true, timeoutMs: 10_000 });
  });
});

describe('reachability and the per-server count', () => {
  it('an unreachable sweep keeps the last time the node answered', () => {
    expect(nd.nodeReachability(3)).toBeNull();
    nd.recordNodeReachability(3, false, new Date(1000));
    expect(nd.nodeReachability(3)).toEqual({ reachable: false, lastSeenAt: null });
    nd.recordNodeReachability(3, true, new Date(2000));
    nd.recordNodeReachability(3, false, new Date(3000));
    expect(nd.nodeReachability(3)).toEqual({ reachable: false, lastSeenAt: new Date(2000) });
    nd.recordNodeReachability(4, true);
    expect(nd.nodeReachability(4)?.lastSeenAt).toBeInstanceOf(Date);
    nd.resetNodeReachability();
    expect(nd.nodeReachability(3)).toBeNull();
  });

  it('databasesPerServer counts rows per node and answers an empty map when the query fails', async () => {
    const rows = [{ serverId: 3 }, { serverId: 4 }, { serverId: 3 }];
    const okDb = { select: () => ({ from: () => ({ where: async () => rows }) }) } as unknown as DB;
    expect(await nd.databasesPerServer(okDb)).toEqual(new Map([[3, 2], [4, 1]]));
    const badDb = { select: () => ({ from: () => ({ where: async () => { throw new Error('no such table'); } }) }) } as unknown as DB;
    expect(await nd.databasesPerServer(badDb)).toEqual(new Map());
  });
});
