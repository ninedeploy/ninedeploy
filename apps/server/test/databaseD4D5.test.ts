import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@ninedeploy/db';

/**
 * Multi-node T6, the two panel-host defects the design asks to prove first
 * (design §0.2):
 *
 *  - D4: a database attached through the attach route, the manifest or a
 *    migration bundle is never connected to the service's `nd-svc-<slug>`
 *    bridge. The service container runs on that bridge ONLY (Model B), the
 *    database on the shared `ninedeploy` network only, so `nd-db-<slug>` does
 *    not resolve from the app. Only the template reconcile ever connected them.
 *  - D5: `databases.pgbouncer_port` is NOT NULL DEFAULT 6432, so the guard
 *    `d.pgbouncerPort != null` is always true and every PgBouncer sidecar
 *    publishes 127.0.0.1:6432 — the second one fails "port is already
 *    allocated".
 */

const h = vi.hoisted(() => ({ calls: [] as string[][], running: new Set<string>() }));
vi.mock('../src/lib/exec.js', () => ({
  run: async (_cmd: string, args: string[], _opts: unknown, sink?: (l: string) => void) => {
    h.calls.push(args);
    if (args[0] === 'run') h.running.add(args[args.indexOf('--name') + 1]!);
    sink?.('');
  },
  capture: async (_cmd: string, args: string[]) => {
    h.calls.push(args);
    if (args[0] === 'inspect' && args.includes('{{.State.Status}}')) return h.running.has(args[1]!) ? 'running' : 'exited';
    if (args[0] === 'inspect' && args.includes('{{.State.Running}}')) return h.running.has(args.at(-1)!) ? 'true' : 'false';
    if (args[0] === 'ps') return h.running.has((args[2] ?? '').replace(/^name=\^|\$$/g, '')) ? 'abc123' : '';
    if (args[0] === 'inspect') return '{}';
    if (args[0] === 'volume') throw new Error('No such volume');
    return '';
  },
  sleep: async () => undefined,
  buildEnv: () => ({}),
}));
vi.mock('../src/lib/dockerPull.js', () => ({ pullDockerImage: async () => undefined, ensureDockerImage: async () => undefined }));
vi.mock('../src/lib/crypto.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/crypto.js')>()),
  decrypt: (v: string) => `pw-${v}`,
}));
vi.mock('../src/config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/config.js')>();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nd-d4d5-'));
  return { ...orig, config: { ...orig.config, paths: { ...orig.config.paths, dataDir: dir, backupsDir: dir } } };
});

const { startDatabase } = await import('../src/engine/database.js');
const { dockerBuilder } = await import('../src/engine/builders/docker.js');
const { enablePgbouncer } = await import('../src/lib/pgbouncer.js');

const dbRow = (slug: string, extra: Partial<Database> = {}): Database =>
  ({
    id: 1,
    name: slug,
    slug,
    engine: 'postgres',
    version: null,
    status: 'running',
    containerName: `nd-db-${slug}`,
    volumeName: `nd-db-${slug}-data`,
    internalHost: `nd-db-${slug}`,
    internalPort: 5432,
    username: 'nine',
    dbName: 'app',
    passwordEncrypted: 'x',
    cpuShares: 0,
    cpuLimitMilli: 0,
    memLimitMb: 0,
    ownerUserId: 1,
    pgbouncerEnabled: false,
    pgbouncerContainerName: null,
    pgbouncerPort: 6432,
    serverId: null,
    ...extra,
  }) as Database;

/** Every network a container joins, from `run|create --name X --network N` and `network connect N X`. */
function networksOf(container: string): Set<string> {
  const nets = new Set<string>();
  for (const args of h.calls) {
    if ((args[0] === 'run' || args[0] === 'create') && args[args.indexOf('--name') + 1] === container) {
      const i = args.indexOf('--network');
      if (i >= 0) nets.add(args[i + 1]!);
    }
    if (args[0] === 'network' && args[1] === 'connect' && args[3] === container) nets.add(args[2]!);
  }
  return nets;
}

beforeEach(() => {
  h.calls.length = 0;
  h.running.clear();
});

describe('D4: an attached panel-host database is reachable from the docker service', () => {
  it('the service container and its attached database share a network after the deploy', async () => {
    const d = dbRow('pg');
    await startDatabase(d, () => undefined);
    // What the pipeline hands the docker builder for a service with this
    // database attached: `databaseContainers` from loadRuntimeEnv's running
    // panel-host attachments (asserted in test/nodeDatabases.test.ts).
    const ctx = {
      databaseContainers: ['nd-db-pg'],
      deploymentId: 9,
      service: { id: 4, slug: 'web', image: 'nginx:1.27', port: 80, cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0, healthPath: '/' },
      buildConfig: {},
      workDir: '/tmp/web',
      commitSha: 'abcdef1',
      env: { DATABASE_URL: 'postgres://nine:pw@nd-db-pg:5432/app' },
      log: () => undefined,
    };
    const runtime = await dockerBuilder.buildAndRun(ctx as never);
    const service = networksOf(runtime.runtimeId);
    const database = networksOf('nd-db-pg');
    expect(service.size).toBeGreaterThan(0);
    expect(database.size).toBeGreaterThan(0);
    expect([...service].filter((n) => database.has(n)), `service on ${[...service]}, database on ${[...database]}`).not.toEqual([]);
  });
});

describe('D5: PgBouncer publishes a host port only when one was chosen', () => {
  it('two sidecars on the default port 6432 publish nothing (the second no longer collides)', async () => {
    const run = (slug: string) => h.calls.find((a) => a[0] === 'create' && a.includes(`nd-pgb-${slug}`)) ?? [];
    for (const slug of ['a', 'b', 'c']) h.running.add(`nd-db-${slug}`);
    await enablePgbouncer({ update: () => ({ set: () => ({ where: async () => undefined }) }) } as never, dbRow('a'), () => undefined);
    await enablePgbouncer({ update: () => ({ set: () => ({ where: async () => undefined }) }) } as never, dbRow('b', { id: 2 }), () => undefined);
    expect(run('a')).not.toContain('-p');
    expect(run('b')).not.toContain('-p');
    // An explicitly chosen port is still published, on loopback.
    await enablePgbouncer({ update: () => ({ set: () => ({ where: async () => undefined }) }) } as never, dbRow('c', { id: 3, pgbouncerPort: 6500 }), () => undefined);
    expect(run('c').join(' ')).toContain('-p 127.0.0.1:6500:6500');
  });
});
