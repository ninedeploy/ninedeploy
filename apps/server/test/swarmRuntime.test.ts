import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asUser, buildTestApp, createFakeDb, svcRow } from './helpers.js';

/**
 * Multi-node T7: what reads `services.runtimeId` for a Swarm service (design
 * §7.4 "Where 0.16 handles orchestrator='swarm' explicitly"): logs, stop /
 * start / restart, the terminal's local task, stats, the doctor, the runtime
 * reconcile, deletion. A Swarm runtime id is `nd-<slug>_web`; no other
 * runtime can look like one, so every non-Swarm service keeps its exact
 * behaviour (the existing lifecycle tests pin that). The static case at the
 * end lists every runtimeId reader and requires a Swarm branch or a stated
 * exemption in each, so a new reader cannot silently mistreat a Swarm row.
 */

const h = vi.hoisted(() => ({
  docker: [] as string[][],
  answers: new Map<string, string>(),
}));
vi.mock('../src/lib/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/exec.js')>()),
  capture: vi.fn(async (_c: string, args: string[]) => {
    h.docker.push(args);
    for (const [prefix, out] of h.answers) if (args.join(' ').startsWith(prefix)) return out;
    return '';
  }),
  run: vi.fn(async (_c: string, args: string[]) => {
    h.docker.push(args);
  }),
  sleep: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/agentClient.js', () => ({ agentOp: vi.fn(), agentTransportSealed: vi.fn(async () => true) }));
vi.mock('../src/engine/proxy.js', () => ({
  writeDynamicConfig: vi.fn(async () => undefined),
  getAcmeEmail: vi.fn(async () => null),
  getStickyEnabledForService: vi.fn(async () => false),
  NETWORK: 'ninedeploy',
  TRAEFIK_CONTAINER: 'ninedeploy-traefik',
  TRAEFIK_IMAGE: 'traefik:3',
}));
vi.mock('../src/engine/logs.js', () => ({ deleteLog: vi.fn(() => true) }));

const swarm = await import('../src/lib/swarm.js');
const { servicesRoutes } = await import('../src/modules/services.js');

beforeEach(() => {
  h.docker = [];
  h.answers = new Map();
});

describe('Swarm runtime ids', () => {
  it('nd-<slug>_web is a Swarm runtime; no container, compose or PM2 runtime can look like one', () => {
    expect(swarm.isSwarmRuntimeId('nd-web_web')).toBe(true);
    expect(swarm.swarmSlugOf('nd-my-app_web')).toBe('my-app');
    for (const other of ['web-12', 'web-12-r2', 'nd-web-12', 'ndcmp-web-app-1', 'ndcmp-web-my_web-1', 'nd-app-web', 'web-pr-3-9', null, undefined, '']) {
      expect(swarm.isSwarmRuntimeId(other), String(other)).toBe(false);
    }
    expect([swarm.swarmStackName('web'), swarm.swarmServiceName('web'), swarm.swarmNetworkName('web'), swarm.swarmPreloadLabel('web')]).toEqual([
      'nd-web',
      'nd-web_web',
      'nd-swarm-web',
      'nd.preload.web',
    ]);
  });
});

describe('the runtime helpers (lib/swarm.ts)', () => {
  it('scale / restart / logs', async () => {
    await swarm.scaleSwarmService('nd-web_web', 0);
    await swarm.scaleSwarmService('nd-web_web', 50);
    await swarm.restartSwarmService('nd-web_web');
    await swarm.swarmServiceLogs('nd-web_web');
    expect(h.docker).toEqual([
      ['service', 'scale', '--detach', 'nd-web_web=0'],
      ['service', 'scale', '--detach', 'nd-web_web=10'],
      ['service', 'update', '--force', '--detach', 'nd-web_web'],
      ['service', 'logs', '--tail', '300', '--timestamps', 'nd-web_web'],
    ]);
  });

  it('the terminal / job task: a local task by slot, else where the replica runs', async () => {
    h.answers.set('ps --filter label=com.docker.swarm.service.name=nd-web_web', 'nd-web_web.2.xyz\nnd-web_web.1.abc\nother');
    expect(await swarm.localSwarmTaskFor('nd-web_web')).toEqual({ container: 'nd-web_web.1.abc' });
    expect(await swarm.localSwarmTaskFor('nd-web_web', 2)).toEqual({ container: 'nd-web_web.2.xyz' });
    h.answers.set('service ps', 'nd-web_web.3 edge-node');
    expect(await swarm.localSwarmTaskFor('nd-web_web', 3)).toEqual({ refusal: expect.stringMatching(/Replica 3 .* runs on node edge-node, not on the panel host; open a node terminal there/) });
    h.answers.clear();
    expect(await swarm.localSwarmTaskFor('nd-web_web')).toEqual({ refusal: expect.stringMatching(/No replica of this Swarm service runs on the panel host/) });
  });

  it('stats: the local tasks summed; nothing for a service with no local task', () => {
    const containers = new Map([
      ['nd-web_web.1.a', { name: 'nd-web_web.1.a', cpuPct: 1.5, memBytes: 100, memLimitBytes: 1000 }],
      ['nd-web_web.2.b', { name: 'nd-web_web.2.b', cpuPct: 2, memBytes: 50, memLimitBytes: 1000 }],
      ['nd-web_webx.1.c', { name: 'x', cpuPct: 9, memBytes: 9, memLimitBytes: 9 }],
    ]);
    expect(swarm.swarmContainerStat(containers, 'nd-web_web')).toEqual({ name: 'nd-web_web', cpuPct: 3.5, memBytes: 150, memLimitBytes: 2000 });
    expect(swarm.swarmContainerStat(containers, 'nd-api_web')).toBeUndefined();
  });

  it('GET /v1/services/:id/swarm view: null stack off Swarm; counts and tasks on it', async () => {
    expect(await swarm.serviceSwarmView({ runtimeId: 'web-12' })).toEqual({ stack: null, desired: 0, running: 0, tasks: [] });
    expect(h.docker).toEqual([]);
    h.answers.set('service ls', 'nd-web_web 1/2');
    h.answers.set(
      'service ps',
      '{"Node":"panel","CurrentState":"Running 2 minutes ago","Error":"","Image":"nginx:1.27"}\n{"Node":"edge","CurrentState":"Rejected 1 minute ago","Error":"No such image: ninedeploy/web:x","Image":"ninedeploy/web:x"}',
    );
    expect(await swarm.serviceSwarmView({ runtimeId: 'nd-web_web' })).toEqual({
      stack: 'nd-web',
      desired: 2,
      running: 1,
      tasks: [
        { node: 'panel', state: 'Running 2 minutes ago', error: null, image: 'nginx:1.27' },
        { node: 'edge', state: 'Rejected 1 minute ago', error: 'No such image: ninedeploy/web:x', image: 'ninedeploy/web:x' },
      ],
    });
  });
});

describe('service routes on a Swarm runtime (modules/services.ts)', () => {
  const swarmSvc = (over: Record<string, unknown> = {}) => svcRow({ id: 1, type: 'docker', runtimeId: 'nd-web_web', replicas: 2, status: 'running', orchestrator: 'swarm', ...over });
  async function appFor(svc: Record<string, unknown>) {
    const app = await buildTestApp({ db: createFakeDb({ findFirst: { services: svc }, update: { services: [svc] } } as never) });
    await app.register(servicesRoutes);
    return app;
  }

  it('stop scales to 0, start back to the replicas, restart forces a rolling update, logs read every task', async () => {
    const app = await appFor(swarmSvc());
    expect((await app.inject({ method: 'POST', url: '/1/stop', headers: asUser() })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/1/start', headers: asUser() })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/1/restart', headers: asUser() })).statusCode).toBe(200);
    h.answers.set('service logs', 'line-a\nline-b');
    expect((await app.inject({ method: 'GET', url: '/1/logs', headers: asUser() })).json()).toEqual({ lines: 'line-a\nline-b' });
    expect(h.docker).toEqual([
      ['service', 'scale', '--detach', 'nd-web_web=0'],
      ['service', 'scale', '--detach', 'nd-web_web=2'],
      ['service', 'update', '--force', '--detach', 'nd-web_web'],
      ['service', 'logs', '--tail', '300', '--timestamps', 'nd-web_web'],
    ]);
    // Never the container CLI against a name no container has.
    expect(h.docker.some((a) => ['stop', 'start', 'restart', 'logs'].includes(a[0]!))).toBe(false);
  });

  it('limits apply at the next deploy (the stack is redeployed), never by docker update', async () => {
    const app = await appFor(swarmSvc({ memLimitMb: 256 }));
    const res = await app.inject({ method: 'PATCH', url: '/1/limits', headers: asUser(), payload: { memLimitMb: 256 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().liveApplied).toBe(false);
    expect(h.docker.filter((a) => a[0] === 'update')).toEqual([]);
  });
});

// ── the static check (design §7.4: "a static test lists the runtimeId readers") ──
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });

/** Every source file that reads `runtimeId`, and how it treats a Swarm service. */
const READERS: Record<string, { branch: true } | { exempt: string }> = {
  // Swarm-aware: each carries a Swarm branch.
  'engine/pipeline.ts': { branch: true },
  'engine/swarmDeploy.ts': { branch: true },
  'engine/doctor.ts': { branch: true },
  'lib/jobRunner.ts': { branch: true },
  'lib/swarm.ts': { branch: true },
  'modules/dashboard.ts': { branch: true },
  'modules/deploys.ts': { branch: true },
  'modules/services.ts': { branch: true },
  'modules/stats.ts': { branch: true },
  'modules/terminals.ts': { branch: true },
  'plugins/collector.ts': { branch: true },
  'plugins/runtimeState.ts': { branch: true },
  // Exempt, with the reason.
  'engine/autoPrune.ts': { exempt: 'collects in-use container names for the prune; running Swarm tasks keep their images from `image prune` on their own' },
  'engine/builders/compose.ts': { exempt: 'the compose builder; a compose service is refused for Swarm' },
  'engine/builders/docker.ts': { exempt: 'the container builder; the Swarm builder hands it only non-Swarm runtime ids' },
  'engine/builders/pm2.ts': { exempt: 'PM2 is refused for Swarm' },
  'engine/builders/remoteCompose.ts': { exempt: 'node-pinned services are refused for Swarm' },
  'engine/builders/remoteDocker.ts': { exempt: 'node-pinned services are refused for Swarm' },
  'engine/builders/remoteRun.ts': { exempt: 'node-pinned services are refused for Swarm' },
  'engine/dockerNames.ts': { exempt: 'names only' },
  'engine/fanout.ts': { exempt: 'fan-out targets are refused for Swarm' },
  'engine/interruptedRuntime.ts': { exempt: 'removes containers by their deployment label; Swarm task containers carry none (the labels are on the service)' },
  'engine/logShipper.ts': { exempt: 'ships local container logs; Swarm service logs are read with `docker service logs` (shipping them is deferred)' },
  'engine/proxy.ts': { exempt: 'renders runtimeId:port — the Swarm VIP resolves on the overlay Traefik joined, so no change is needed (design §7.4 step 7)' },
  'engine/types.ts': { exempt: 'types only' },
  'lib/inventory.ts': { exempt: 'names the owner of a volume or network for display; Swarm services own neither' },
  'lib/webhookDispatch.ts': { exempt: 'PR previews never run on Swarm (a preview row has no orchestrator)' },
  'modules/containers.ts': { exempt: 'node container access; Swarm services are never node-pinned' },
  'modules/databases.ts': { exempt: 'node database networks; Swarm services cannot attach databases' },
  'modules/demo.ts': { exempt: 'the legacy demo rows' },
  'modules/domainIndex.ts': { exempt: 'display only' },
  'modules/networks.ts': { exempt: 'node container access; Swarm services are never node-pinned' },
  'modules/servers.ts': { exempt: 'the panel host container list (display)' },
  'modules/serviceVolumes.ts': { exempt: 'volumes are refused for Swarm' },
  'modules/topology.ts': { exempt: 'display only' },
  'modules/volumeBackups.ts': { exempt: 'volumes are refused for Swarm' },
  'openapi/specs/services.ts': { exempt: 'documentation' },
  'plugins/worker.ts': { exempt: 'crash recovery removes containers by their deployment label; Swarm task containers carry none' },
  'version.ts': { exempt: 'release notes' },
};

describe('every runtimeId reader has a Swarm branch or an exemption (static)', () => {
  const files = walk(SRC)
    .filter((f) => /\bruntimeId\b/.test(readFileSync(f, 'utf8')))
    .map((f) => path.relative(SRC, f).replace(/\\/g, '/'))
    .sort();

  it('the list is exactly the readers (a new reader must be classified; a stale entry is removed)', () => {
    expect(files).toEqual(Object.keys(READERS).sort());
  });

  it('each Swarm-aware reader really branches on a Swarm runtime', () => {
    for (const [file, rule] of Object.entries(READERS)) {
      if (!('branch' in rule)) continue;
      const src = readFileSync(path.join(SRC, file), 'utf8');
      expect(src, file).toMatch(/\bisSwarmRuntimeId\(|\bisSwarmService\(|\bswarmSlugOf\(/);
    }
  });

  it("the driver's deployStack has a non-test caller (design §7.9: the flow is wired, not just written)", () => {
    expect(readFileSync(path.join(SRC, 'engine/swarmDeploy.ts'), 'utf8')).toMatch(/driver\.deployStack\(spec/);
    expect(readFileSync(path.join(SRC, 'engine/swarmDeploy.ts'), 'utf8')).toMatch(/new SwarmOrchestrator\(db\)/);
  });
});
