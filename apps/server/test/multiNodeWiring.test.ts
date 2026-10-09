/**
 * Multi-node wiring guard (design §9 M1–M7, the T1 rows): the stub route
 * modules are mounted in `modules/api.ts` under their prefixes, the node
 * database plugin is registered in `app.ts` after `kernelPlugin`, the spec
 * fragment is merged, housekeeping runs the `image-transfers` sweep, and the
 * pipeline, fan-out, remote-builder and server-delete hooks are reached —
 * each a no-op that keeps 0.15's behaviour until its task fills it.
 *
 * A route that is written and tested but never registered is this repo's most
 * common defect, so this pins the registrations themselves: deleting or
 * commenting out any of them fails here. Source scans rather than
 * `buildApp()`: booting the real app reaches Docker and timers, and this
 * guard must stay hermetic. The behavioural cases drive each hook directly.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyPluginAsync } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, imageTransfers, runMigrations, services, settings } from '@ninedeploy/db';

const agentMocks = vi.hoisted(() => ({ agentOp: vi.fn() }));
vi.mock('../src/lib/agentClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/agentClient.js')>()),
  agentOp: agentMocks.agentOp,
}));
const blockerMocks = vi.hoisted(() => ({ serverDeleteBlockers: vi.fn(async (_db: unknown, _id: number) => [] as Array<{ code: string; message: string }>) }));
vi.mock('../src/lib/serverDependents.js', () => blockerMocks);
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
// The egress gate resolves DNS; nothing here touches the network.
vi.mock('../src/lib/gitEgress.js', () => ({ assertCloneTargetAllowed: vi.fn(async () => undefined) }));

import { deploymentTransferRoutes, imageTransferRoutes } from '../src/modules/imageTransfers.js';
import { serverRolesRoutes } from '../src/modules/serverRoles.js';
import { servicePlacementRoutes } from '../src/modules/servicePlacement.js';
import { serverSwarmRoutes, swarmRoutes } from '../src/modules/swarm.js';
import { serverRoutes } from '../src/modules/servers.js';
import nodeDatabasesPlugin from '../src/plugins/nodeDatabases.js';
import { SPEC_FRAGMENTS } from '../src/openapi/specs/index.js';
import { multiNodeSpecs } from '../src/openapi/specs/multiNode.js';
import {
  IMAGE_TRANSFER_PRUNE_BATCH,
  IMAGE_TRANSFER_RETENTION_DAYS_DEFAULT,
  IMAGE_TRANSFER_RETENTION_DAYS_KEY,
  getImageTransferRetentionDays,
  pruneImageTransfers,
} from '../src/lib/imageTransferRetention.js';
import { resolveBuildPlacement } from '../src/engine/buildPlacement.js';
import { isSwarmService } from '../src/engine/swarmDeploy.js';
import { deployToTargets } from '../src/engine/fanout.js';
import { createRemoteDockerBuilder, envForAgent as envForAgentViaDocker } from '../src/engine/builders/remoteDocker.js';
import { envForAgent, runRemoteContainer } from '../src/engine/builders/remoteRun.js';
import * as remoteDeploy from '../src/lib/remoteDeploy.js';
import * as remoteDatabaseRefusalModule from '../src/lib/remoteDatabaseRefusal.js';
import type { BuildContext } from '../src/engine/types.js';
import { asUser, buildTestApp, createFakeDb } from './helpers.js';

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), 'utf8')
    // Comments must not satisfy the guard: drop block and line comments.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
/** The raw source, comments kept: the labelled blocks are comments. */
const raw = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const MODULES: Array<{ binding: string; file: string; prefix: string; routes: FastifyPluginAsync }> = [
  { binding: 'swarmRoutes', file: './swarm.js', prefix: '/swarm', routes: swarmRoutes },
  { binding: 'serverSwarmRoutes', file: './swarm.js', prefix: '/servers', routes: serverSwarmRoutes },
  { binding: 'serverRolesRoutes', file: './serverRoles.js', prefix: '/servers', routes: serverRolesRoutes },
  { binding: 'servicePlacementRoutes', file: './servicePlacement.js', prefix: '/services', routes: servicePlacementRoutes },
  { binding: 'imageTransferRoutes', file: './imageTransfers.js', prefix: '/services', routes: imageTransferRoutes },
  { binding: 'deploymentTransferRoutes', file: './imageTransfers.js', prefix: '/deployments', routes: deploymentTransferRoutes },
];

beforeEach(() => {
  vi.clearAllMocks();
  blockerMocks.serverDeleteBlockers.mockResolvedValue([]);
});

describe('multi-node route modules are mounted in modules/api.ts (M1)', () => {
  const api = read('../src/modules/api.ts');

  for (const m of MODULES) {
    it(`${m.binding} is imported and registered under ${m.prefix}`, () => {
      expect(api).toMatch(new RegExp(`import \\{[^}]*\\b${m.binding}\\b[^}]*\\} from '${escapeRe(m.file)}';`));
      const call = `await app\\.register\\(${m.binding}, \\{ prefix: '${escapeRe(m.prefix)}' \\}\\);`;
      expect(api.match(new RegExp(call, 'g'))).toHaveLength(1);
    });
  }

  it('each module exports the plugin api.ts registers, and it mounts cleanly', async () => {
    for (const m of MODULES) {
      expect(typeof m.routes, m.binding).toBe('function');
      const app = Fastify();
      const noop = async () => undefined;
      app.decorate('authenticate', noop);
      app.decorate('requireOperator', noop);
      app.decorate('requireAdmin', noop);
      app.decorate('requireInteractive', noop);
      app.decorate('requireScope', () => noop);
      await app.register(m.routes, { prefix: `/v1${m.prefix}` });
      await expect(app.ready()).resolves.toBeDefined();
      await app.close();
    }
  });

  it('GET /v1/deployments/:id/* is classified for fine-grained tokens like deploy history', async () => {
    const { requiredFineGrainedScope } = await import('../src/plugins/auth.js');
    expect(requiredFineGrainedScope('/v1/deployments/7/image-transfers', 'GET')).toBe('nd://scope/read/deploys');
    expect(requiredFineGrainedScope('/v1/services/7/deploys', 'GET')).toBe('nd://scope/read/deploys');
  });
});

describe('the node database plugin in app.ts (M2)', () => {
  const src = read('../src/app.ts');

  it('is imported and registered once, after kernelPlugin', () => {
    const kernelAt = src.indexOf('await app.register(kernelPlugin);');
    expect(kernelAt).toBeGreaterThan(0);
    expect(src).toMatch(/import nodeDatabasesPlugin from '\.\/plugins\/nodeDatabases\.js';/);
    const call = 'await app.register(nodeDatabasesPlugin);';
    expect(src.split(call)).toHaveLength(2);
    expect(src.indexOf(call)).toBeGreaterThan(kernelAt);
  });

  it('is a named fastify-plugin that registers on an isolated instance and starts nothing', async () => {
    const app = Fastify();
    await app.register(nodeDatabasesPlugin);
    await app.ready();
    expect(app.hasPlugin('ninedeploy-node-databases')).toBe(true);
    await app.close();
  });

  it('every test that boots the real app mocks it (it would reach node agents)', () => {
    for (const file of ['app', 'authHardening', 'oidc', 'operatorEscalation', 'securityRegression', 'authzMatrix']) {
      expect(raw(`./${file}.test.ts`), file).toMatch(/vi\.mock\('\.\.\/src\/plugins\/nodeDatabases\.js'/);
    }
  });
});

describe('the multi-node spec fragment (M3)', () => {
  it('is merged into ROUTE_SPECS, empty until the routes exist', () => {
    expect(SPEC_FRAGMENTS['multiNode']).toBe(multiNodeSpecs);
    expect(read('../src/openapi/specs/index.ts')).toMatch(/import \{ multiNodeSpecs \} from '\.\/multiNode\.js';/);
  });

  it('carries one labelled block per task, in the fragment and in each shared test', () => {
    for (const task of ['T2', 'T3', 'T4', 'T5', 'T6', 'T7']) {
      for (const file of ['../src/openapi/specs/multiNode.ts', './authzMatrix.test.ts', './auditCoverage.test.ts']) {
        const text = raw(file);
        expect(text, `${file} ${task}`).toMatch(new RegExp(`// ── 0\\.16 ${task} [^\\n]*──`));
        expect(text, `${file} ${task}`).toContain(`// ── end 0.16 ${task} ──`);
      }
    }
  });
});

describe('image-transfers retention (M4)', () => {
  it('housekeeping runs the image-transfers step with the sweep', () => {
    const src = read('../src/plugins/housekeeping.ts');
    expect(src).toMatch(/import \{ pruneImageTransfers \} from '\.\.\/lib\/imageTransferRetention\.js';/);
    expect(src).toMatch(/await step\('image-transfers', \(\) => pruneImageTransfers\(fastify\.db, now\)\);/);
  });

  it('deletes rows that started before the retention, in batches, and keeps the rest', async () => {
    const { db, client } = createDb({ url: ':memory:' });
    await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
    const [svc] = await db.insert(services).values({ name: 'api', slug: 'api' }).returning();
    const now = Date.UTC(2026, 9, 9);
    const day = 86_400_000;
    const row = (ageDays: number) => ({
      serviceId: svc!.id,
      method: 'stream' as const,
      imageRef: 'ninedeploy/api:x',
      startedAt: new Date(now - ageDays * day),
    });
    await db.insert(imageTransfers).values([row(31), row(31), row(31), row(30.5), row(29), row(1)]);

    expect(await getImageTransferRetentionDays(db)).toBe(IMAGE_TRANSFER_RETENTION_DAYS_DEFAULT);
    // Batch of 2: three old rows need two passes plus the short final one.
    expect(await pruneImageTransfers(db, now, 2)).toBe(4);
    expect((await client!.execute('SELECT COUNT(*) AS n FROM image_transfers')).rows[0]!['n']).toBe(2);
    expect(IMAGE_TRANSFER_PRUNE_BATCH).toBe(5000);

    // The setting shortens it; an invalid value falls back to the default.
    await db.insert(settings).values({ key: IMAGE_TRANSFER_RETENTION_DAYS_KEY, value: 7 as never });
    expect(await getImageTransferRetentionDays(db)).toBe(7);
    expect(await pruneImageTransfers(db, now)).toBe(1);
    await client!.execute({ sql: `UPDATE settings SET value = ? WHERE key = ?`, args: ['"2"', IMAGE_TRANSFER_RETENTION_DAYS_KEY] });
    expect(await getImageTransferRetentionDays(db)).toBe(2);
    for (const bad of ['0', '401', '"x"', '1.5', 'true']) {
      await client!.execute({ sql: `UPDATE settings SET value = ? WHERE key = ?`, args: [bad, IMAGE_TRANSFER_RETENTION_DAYS_KEY] });
      expect(await getImageTransferRetentionDays(db), bad).toBe(IMAGE_TRANSFER_RETENTION_DAYS_DEFAULT);
    }
    expect(await pruneImageTransfers(db, now)).toBe(0);
    client!.close();
  });
});

describe('pipeline hooks (M5)', () => {
  const src = read('../src/engine/pipeline.ts');
  const labelled = raw('../src/engine/pipeline.ts');

  it('asks for the build placement inside the deploy, and the T1 stub answers `target` (build where it runs)', async () => {
    expect(src).toMatch(/import \{ resolveBuildPlacement \} from '\.\/buildPlacement\.js';/);
    expect(src.match(/await resolveBuildPlacement\(db, service\)/g)).toHaveLength(1);
    expect(labelled).toContain('// ── 0.16 T4 build placement (M5) ──');
    expect(await resolveBuildPlacement({} as never, { id: 1, serverId: 4 })).toEqual({ kind: 'target' });
  });

  it('branches on Swarm before the builder is chosen, and the T1 stub never takes it', () => {
    expect(src).toMatch(/import \{ isSwarmService \} from '\.\/swarmDeploy\.js';/);
    const swarmAt = src.indexOf('if (isSwarmService(service))');
    expect(swarmAt).toBeGreaterThan(0);
    expect(swarmAt).toBeLessThan(src.indexOf('let builder = builders[service.type];'));
    expect(isSwarmService({ orchestrator: 'swarm' })).toBe(false);
    expect(isSwarmService({ orchestrator: null })).toBe(false);
  });

  it('hands the fan-out a per-target refusal hook that refuses no target yet', () => {
    expect(src).toMatch(/targetRefusal: async \(\) => null,/);
    expect(read('../src/engine/fanout.ts')).toMatch(/const refusal = ctx\.targetRefusal \? await ctx\.targetRefusal\(target\) : null;/);
  });

  it('a refused fan-out target is recorded failed and nothing is sent to it; the others proceed', async () => {
    agentMocks.agentOp.mockImplementation(async (_db: unknown, _serverId: number, op: string, params: Record<string, unknown>) => {
      if (op === 'docker.inspect') return { exitCode: 0, lines: ['running|none|0|0'] };
      if (op === 'file.writeEnv') return { exitCode: 0, lines: [`wrote .agent-env/${String(params['name'])}.env`] };
      return { exitCode: 0, lines: [] };
    });
    const db = createFakeDb({ select: { serviceTargets: [{ serverId: 5, runtimeId: 'web-t5-8' }, { serverId: 6, runtimeId: null }] } });
    const log = vi.fn();
    const targetRefusal = vi.fn(async (t: { serverId: number }) => (t.serverId === 5 ? 'the node agent is too old' : null));
    vi.useFakeTimers();
    let results: Awaited<ReturnType<typeof deployToTargets>> = [];
    try {
      const run = deployToTargets(
        db as never,
        {
          service: { id: 1, slug: 'web', type: 'docker', image: 'nginx:1.25', port: 80, healthPath: '/', cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0, volumeMount: null, publishedPort: null },
          deploymentId: 9,
          image: 'nginx:1.25',
          env: {},
          primaryServerId: null,
          targetRefusal,
        },
        log,
      );
      let done = false;
      void run.finally(() => {
        done = true;
      });
      for (let i = 0; i < 100 && !done; i++) await vi.advanceTimersByTimeAsync(500);
      results = await run;
    } finally {
      vi.useRealTimers();
    }
    expect(targetRefusal).toHaveBeenCalledTimes(2);
    expect(results).toEqual([
      { serverId: 5, runtimeId: 'web-t5-8', ok: false, error: 'the node agent is too old' },
      { serverId: 6, runtimeId: 'web-t6-9', ok: true, error: undefined },
    ]);
    expect(agentMocks.agentOp.mock.calls.every((c) => c[1] === 6)).toBe(true);
    expect(log).toHaveBeenCalledWith('✗ target node #5: the node agent is too old — the primary release is unaffected');
  });

  it('remoteDatabaseRefusal moved to lib/remoteDatabaseRefusal.ts and is re-exported unchanged', () => {
    expect(remoteDeploy.remoteDatabaseRefusal).toBe(remoteDatabaseRefusalModule.remoteDatabaseRefusal);
    expect(read('../src/lib/remoteDeploy.ts')).not.toMatch(/export async function remoteDatabaseRefusal/);
    // Callers keep importing it from remoteDeploy.ts (their mocks keep working).
    expect(src).toMatch(/import \{[^}]*\bremoteDatabaseRefusal\b[^}]*\} from '\.\.\/lib\/remoteDeploy\.js';/);
  });
});

const ctx = (over: Partial<BuildContext> = {}): BuildContext =>
  ({
    deploymentId: 7,
    service: {
      id: 1,
      name: 'web',
      slug: 'web',
      type: 'docker',
      image: null,
      repoUrl: 'https://github.com/acme/web.git',
      branch: 'main',
      port: 3000,
      healthPath: '/',
      cpuShares: 0,
      cpuLimitMilli: 0,
      memLimitMb: 0,
      volumeMount: null,
      publishedPort: null,
      serverId: 4,
    },
    buildConfig: { buildPack: 'nixpacks' },
    workDir: '/tmp/x',
    commitSha: 'abc1234def',
    env: { FOO: 'bar' },
    log: () => undefined,
    ...over,
  }) as BuildContext;

function fakeAgent() {
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  const agent = async (op: string, params: Record<string, unknown>) => {
    calls.push({ op, params });
    if (op === 'file.writeEnv') return { exitCode: 0, lines: ['wrote .agent-env/web-7.env'] };
    return { exitCode: 0, lines: [] };
  };
  return { agent, calls, ops: () => calls.map((c) => c.op) };
}

describe('remote builder hooks and the run-phase move (M6)', () => {
  it('remoteDocker runs the run phase through remoteRun.ts and re-exports envForAgent', () => {
    const src = read('../src/engine/builders/remoteDocker.ts');
    expect(src).toMatch(/import \{ runRemoteContainer \} from '\.\/remoteRun\.js';/);
    expect(src).toMatch(/await runRemoteContainer\(agent, \{/);
    expect(src).not.toMatch(/'docker\.runEnv'/);
    expect(envForAgentViaDocker).toBe(envForAgent);
    expect(typeof runRemoteContainer).toBe('function');
  });

  it('a prebuilt image is run as shipped: no pull, no clone, no build (unset by every caller today)', async () => {
    const { agent, calls, ops } = fakeAgent();
    const log = vi.fn();
    const runtime = await createRemoteDockerBuilder(agent, {
      prebuiltImage: { tag: 'ninedeploy/web:abc1234-b7', imageId: `sha256:${'b'.repeat(64)}` },
    }).buildAndRun(ctx({ log }));
    // Even a Nixpacks service (refused by an agent without build.nixpacks) runs: the build happened elsewhere.
    expect(ops()).toEqual(['docker.networkCreate', 'file.writeEnv', 'docker.runEnv', 'file.deleteEnv']);
    expect(calls.find((c) => c.op === 'docker.runEnv')!.params).toMatchObject({ name: 'web-7', image: 'ninedeploy/web:abc1234-b7' });
    expect(runtime).toMatchObject({ runtimeId: 'web-7', port: 3000, imageDigest: undefined });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('built elsewhere and shipped to the node'));
    // Without it, the same service is refused exactly as before.
    await expect(createRemoteDockerBuilder(fakeAgent().agent).buildAndRun(ctx())).rejects.toThrow(/source builds on it are blocked|cannot build with Nixpacks/);
  });

  it('remoteCompose takes the same option and carries the T3, T4 and T5 blocks', () => {
    const src = raw('../src/engine/builders/remoteCompose.ts');
    expect(src).toMatch(/import type \{ AgentCall, PrebuiltImage \} from '\.\/remoteDocker\.js';/);
    expect(src).toMatch(/prebuiltImage\?: PrebuiltImage;/);
    for (const block of ['T3 clone credential', 'T4 prebuilt image (M6)', 'T5 volume pre-create (D9)']) {
      expect(src, block).toContain(`// ── 0.16 ${block} ──`);
    }
    expect(raw('../src/engine/builders/remoteDocker.ts')).toContain('// ── 0.16 T4 prebuilt image (M6) ──');
  });
});

describe('the server delete guard (M7)', () => {
  const appWith = async (fixtures: Record<string, unknown>) => {
    const app = await buildTestApp({ db: createFakeDb(fixtures as never) });
    await app.register(serverRoutes, { prefix: '/servers' });
    return app;
  };
  const node = { id: 1, name: 'edge-1', host: '10.0.0.5', port: 4600, status: 'online', tokenEncrypted: 'x', lastSeenAt: null, createdAt: new Date(0), updatedAt: new Date(0) };

  it('DELETE /v1/servers/:id asks for blockers before anything else', () => {
    const src = read('../src/modules/servers.ts');
    expect(src).toMatch(/import \{ serverDeleteBlockers \} from '\.\.\/lib\/serverDependents\.js';/);
    const ask = src.indexOf('await serverDeleteBlockers(authed.db, id)');
    expect(ask).toBeGreaterThan(src.indexOf("authed.delete('/:id'"));
    expect(ask).toBeLessThan(src.indexOf('const hosted = await hostedOn(authed.db, id);'));
  });

  it('the T1 stub reports no blocker, so the delete behaves as before', async () => {
    const actual = await vi.importActual<typeof import('../src/lib/serverDependents.js')>('../src/lib/serverDependents.js');
    expect(await actual.serverDeleteBlockers({} as never, 1)).toEqual([]);
    const app = await appWith({ findFirst: { servers: node }, findMany: { services: [] }, select: { serviceTargets: [] } });
    const res = await app.inject({ method: 'DELETE', url: '/servers/1', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(blockerMocks.serverDeleteBlockers).toHaveBeenCalledWith(expect.anything(), 1);
  });

  it('a blocker refuses the delete with its code, even with ?force=true', async () => {
    blockerMocks.serverDeleteBlockers.mockResolvedValue([
      { code: 'server_hosts_databases', message: 'Node "edge-1" hosts 1 managed database (cache).' },
      { code: 'server_hosts_databases', message: 'Delete or move it first.' },
    ]);
    const app = await appWith({ findFirst: { servers: node }, findMany: { services: [] }, select: { serviceTargets: [] } });
    const res = await app.inject({ method: 'DELETE', url: '/servers/1?force=true', headers: asUser() });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: { code: 'server_hosts_databases', message: 'Node "edge-1" hosts 1 managed database (cache). Delete or move it first.' },
    });
  });
});
