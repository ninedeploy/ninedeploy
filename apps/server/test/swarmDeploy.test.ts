import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, databaseAttachments, databases, runMigrations, servers, services, serviceTargets, serviceVolumeAttachments, settings } from '@ninedeploy/db';

/**
 * Multi-node T7, the Swarm deploy flow (engine/swarmDeploy.ts, design §7.1,
 * §7.4): refusals, the image (release, shipped, built on the panel),
 * distribution by registry or preload with the constraint label, the
 * encrypted overlay joined by Traefik, the convergence wait, the probe and
 * the rollback. Docker, the driver and the transfers are mocked.
 */

const h = vi.hoisted(() => ({
  docker: [] as string[][],
  /** `docker service ls` answers, consumed in order (the last one repeats). */
  replicas: [] as string[],
  exists: false,
  updateState: '',
  probe: 'ok' as 'ok' | '404' | 'down',
  networkOptions: null as string | null,
  nodes: '' as string,
}));
vi.mock('../src/lib/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/exec.js')>()),
  capture: vi.fn(async (_cmd: string, args: string[]) => {
    h.docker.push(args);
    const [a, b] = args;
    if (a === 'info') return '{"LocalNodeState":"active","ControlAvailable":true,"NodeID":"mgr1","NodeAddr":"10.0.0.1"}';
    if (a === 'node' && b === 'ls') return h.nodes;
    if (a === 'node' && b === 'inspect') return 'ready';
    if (a === 'network' && b === 'inspect') {
      if (h.networkOptions === null) throw new Error('No such network');
      return h.networkOptions;
    }
    if (a === 'inspect') return '{"ninedeploy":{}}';
    if (a === 'service' && b === 'inspect') {
      if (args.includes('{{.ID}}')) {
        if (!h.exists) throw new Error('no such service');
        return 'svcid';
      }
      if (args.some((x) => x.includes('UpdateStatus'))) return h.updateState;
      return `nginx:1.27@sha256:${'e'.repeat(64)}`;
    }
    if (a === 'service' && b === 'ls') return (h.replicas.length > 1 ? h.replicas.shift() : h.replicas[0]) ?? '';
    if (a === 'exec') {
      if (h.probe === 'ok') return '';
      throw new Error(h.probe === '404' ? 'wget: server returned error: HTTP/1.1 404 Not Found' : 'wget: can’t connect to remote host');
    }
    return '';
  }),
  run: vi.fn(async (_cmd: string, args: string[]) => {
    h.docker.push(args);
    if (args[0] === 'network' && args[1] === 'create') h.networkOptions = '{"encrypted":""}';
  }),
  sleep: vi.fn(async () => undefined),
}));

const {
  createSwarmBuilder,
  isSwarmService,
  swarmDeployRefusal,
  swarmServiceRefusal,
  withSwarmRetirement,
} = await import('../src/engine/swarmDeploy.js');
const { dockerBuilder } = await import('../src/engine/builders/docker.js');

let db: DB;
beforeEach(async () => {
  h.docker = [];
  h.replicas = ['nd-web_web 2/2'];
  h.exists = false;
  h.updateState = '';
  h.probe = 'ok';
  h.networkOptions = null;
  h.nodes = '{"ID":"mgr1","Hostname":"panel","ManagerStatus":"Leader","Availability":"Active","Status":"Ready"}';
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
});

const svcRow = async (values: Record<string, unknown> = {}) =>
  (await db.insert(services).values({ name: 'web', slug: 'web', type: 'docker', image: 'nginx:1.27', port: 80, orchestrator: 'swarm', replicas: 2, ...values } as never).returning())[0]!;

type Spec = { name: string; resolveImage?: string; services: Array<Record<string, any>>; networks: unknown[] };
const fakeDriver = (status: { error?: string } = {}) => {
  const specs: Spec[] = [];
  return {
    specs,
    driver: {
      deployStack: vi.fn(async (spec: Spec) => {
        specs.push(spec);
        return { name: spec.name, services: [], appliedAt: '', ...status };
      }),
    },
  };
};
const ctxFor = (service: Record<string, any>, over: Record<string, unknown> = {}) =>
  ({ deploymentId: 9, service, workDir: '/w', commitSha: 'abc1234def', env: { A: '1' }, log: vi.fn(), ...over }) as never;
const lines = (ctx: { log: ReturnType<typeof vi.fn> }) => ctx.log.mock.calls.map((c) => String(c[0])).join('\n');

describe('isSwarmService / refusals (design §7.1)', () => {
  it('only an opted-in, non-preview service is a Swarm service; NULL is 0.15', () => {
    expect(isSwarmService({ orchestrator: null })).toBe(false);
    expect(isSwarmService({})).toBe(false);
    expect(isSwarmService({ orchestrator: 'container' })).toBe(false);
    expect(isSwarmService({ orchestrator: 'swarm' })).toBe(true);
    expect(isSwarmService({ orchestrator: 'swarm', isEphemeralPreview: true })).toBe(false);
  });

  it('refuses compose, pm2, a node pin, the primary volume, the socket, a published port, attachments, databases and fan-out targets', async () => {
    const base = await svcRow();
    expect(await swarmServiceRefusal(db, base)).toBeNull();
    const refuse = async (over: Record<string, unknown>, re: RegExp) => expect(await swarmServiceRefusal(db, { ...base, ...over })).toMatch(re);
    await refuse({ type: 'compose' }, /compose service cannot run on Swarm/);
    await refuse({ composeContent: 'services: {}' }, /compose stack/);
    await refuse({ type: 'pm2' }, /pm2 service/);
    await refuse({ serverId: 3 }, /pinned to a node/);
    await refuse({ volumeMount: '/data' }, /persistent volume/);
    await refuse({ dockerSocket: true }, /Docker socket/);
    await refuse({ publishedPort: 8080 }, /Traefik is the only ingress/);
    await refuse({ templateDatabaseEnv: { DB: 'url' } }, /Managed databases/);
    await refuse({ image: null, repoUrl: null }, /neither an image nor a repository/);
    await db.insert(serviceVolumeAttachments).values({ serviceId: base.id, volumeName: 'nd-svc-web-cache', containerPath: '/c' });
    await refuse({}, /Volume attachments/);
    await db.delete(serviceVolumeAttachments);
    const [d] = await db.insert(databases).values({ name: 'pg', slug: 'pg', engine: 'postgres', passwordEncrypted: 'x' } as never).returning();
    await db.insert(databaseAttachments).values({ serviceId: base.id, databaseId: d!.id, envAlias: 'DATABASE' } as never);
    await refuse({}, /Managed databases/);
    await db.delete(databaseAttachments);
    const [node] = await db.insert(servers).values({ name: 'n', host: 'h', port: 1, tokenEncrypted: 'x' } as never).returning();
    await db.insert(serviceTargets).values({ serviceId: base.id, serverId: node!.id } as never);
    await refuse({}, /Fan-out targets/);
  });

  it('the deploy also needs Swarm enabled and the panel an active manager', async () => {
    const svc = await svcRow();
    expect(await swarmDeployRefusal(db, svc)).toMatch(/Swarm is not enabled/);
    await db.insert(settings).values({ key: 'swarm_enabled', value: true });
    expect(await swarmDeployRefusal(db, svc)).toBeNull();
  });
});

describe('the Swarm builder (design §7.4)', () => {
  it('an image release: encrypted overlay + Traefik, one stack spec, registry resolution, runtime nd-<slug>_web with one backend', async () => {
    const svc = await svcRow({ cmd: ['nginx', '-g', 'daemon off;'], memLimitMb: 256 });
    const { driver, specs } = fakeDriver();
    const ctx = ctxFor(svc, { registryAuth: { username: 'u', password: 'p', server: 'reg.example.com' } });
    const runtime = await createSwarmBuilder(db, { driver }).buildAndRun(ctx);
    expect(runtime).toEqual({ runtimeId: 'nd-web_web', port: 80, healthPath: '/', replicas: 1, imageDigest: `nginx:1.27@sha256:${'e'.repeat(64)}` });
    expect(h.docker).toContainEqual(['network', 'create', '--driver', 'overlay', '--opt', 'encrypted', '--attachable', 'nd-swarm-web']);
    expect(h.docker).toContainEqual(['network', 'connect', 'nd-swarm-web', 'ninedeploy-traefik']);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      name: 'nd-web',
      networks: [{ name: 'nd-swarm-web', driver: 'overlay', attachable: true }],
      services: [
        {
          name: 'web',
          image: 'nginx:1.27',
          replicas: 2,
          port: 80,
          env: { A: '1' },
          networks: ['nd-swarm-web'],
          constraints: [],
          command: ['nginx', '-g', 'daemon off;'],
          memLimitMb: 256,
          labels: { 'ninedeploy.managed': 'service', 'ninedeploy.service': String(svc.id), 'ninedeploy.deployment': '9' },
        },
      ],
    });
    expect(specs[0]!.resolveImage).toBeUndefined();
    // --with-registry-auth gets the credential: the panel logs in around the apply, then out.
    const login = h.docker.findIndex((a) => a[0] === 'login');
    expect(h.docker[login]).toEqual(['login', '--username', 'u', '--password-stdin', 'reg.example.com']);
    expect(h.docker.findIndex((a) => a[0] === 'logout')).toBeGreaterThan(login);
  });

  it('an existing unencrypted overlay is reported on the deploy log and reused, never recreated', async () => {
    h.networkOptions = '{}';
    const svc = await svcRow();
    const ctx = ctxFor(svc);
    await createSwarmBuilder(db, { driver: fakeDriver().driver }).buildAndRun(ctx);
    expect(h.docker.filter((a) => a[0] === 'network' && (a[1] === 'create' || a[1] === 'rm'))).toEqual([]);
    expect(lines(ctx as never)).toMatch(/nd-swarm-web exists WITHOUT data-plane encryption/);
  });

  it('a source build without a registry: built on the panel, preloaded onto NineDeploy nodes, the rest labelled off (D7f)', async () => {
    const svc = await svcRow({ image: null, repoUrl: 'https://github.com/acme/web.git', port: null });
    const [node] = await db.insert(servers).values({ name: 'edge', host: 'h', port: 1, tokenEncrypted: 'x', swarmNodeId: 'wrk1' } as never).returning();
    h.nodes = [
      '{"ID":"mgr1","Hostname":"panel","ManagerStatus":"Leader","Availability":"Active","Status":"Ready"}',
      '{"ID":"wrk1","Hostname":"edge","ManagerStatus":"","Availability":"Active","Status":"Ready"}',
      '{"ID":"wrk2","Hostname":"old","ManagerStatus":"","Availability":"Active","Status":"Ready"}',
      '{"ID":"ext1","Hostname":"foreign","ManagerStatus":"","Availability":"Active","Status":"Ready"}',
    ].join('\n');
    await db.insert(servers).values({ name: 'old', host: 'h2', port: 1, tokenEncrypted: 'x', swarmNodeId: 'wrk2' } as never);
    const buildOnPanel = vi.fn(async () => ({ buildHost: null, tag: 'ninedeploy/web:abc1234-b9', imageId: `sha256:${'a'.repeat(64)}`, sizeBytes: 42, builtWithNixpacks: true, builtStatic: false }));
    const ship = vi.fn(async (_db: unknown, spec: { target: number }) => {
      if (spec.target !== node!.id) throw Object.assign(new Error('The agent on node "old" cannot receive an image. Update the node agent'), { statusCode: 422 });
      return { method: 'stream', ref: 'x', bytes: 1, sha256: 'y', durationMs: 1 };
    });
    const { driver, specs } = fakeDriver();
    const ctx = ctxFor(svc);
    const runtime = await createSwarmBuilder(db, { driver, buildOnPanel: buildOnPanel as never, ship: ship as never }).buildAndRun(ctx);
    expect(buildOnPanel).toHaveBeenCalledWith(db, { kind: 'panel' }, ctx);
    expect(ship).toHaveBeenCalledTimes(2);
    expect(ship.mock.calls[0]![1]).toMatchObject({ source: null, target: node!.id, tag: 'ninedeploy/web:abc1234-b9', imageId: `sha256:${'a'.repeat(64)}`, sizeBytes: 42, deploymentId: 9 });
    const labels = h.docker.filter((a) => a[0] === 'node' && a[1] === 'update').map((a) => a.slice(2).join(' '));
    expect(labels).toEqual([
      '--label-rm nd.preload.web mgr1',
      '--label-rm nd.preload.web wrk1',
      '--label-add nd.preload.web=0 wrk2',
      '--label-add nd.preload.web=0 ext1',
    ]);
    expect(specs[0]).toMatchObject({ resolveImage: 'never', services: [{ image: 'ninedeploy/web:abc1234-b9', constraints: ['node.labels.nd.preload.web!=0'], port: 3000 }] });
    expect(specs[0]!.services[0]!.env.PORT).toBe('3000'); // Nixpacks' run convention, like the container builder
    expect(runtime).toMatchObject({ runtimeId: 'nd-web_web', port: 3000, imageDigest: `sha256:${'a'.repeat(64)}` });
    expect(lines(ctx as never)).toMatch(/node old will run no task.*Update the node agent/);
    expect(lines(ctx as never)).toMatch(/node foreign will run no task.*not a NineDeploy node/);
  });

  it('a source build with a push registry: deployed by digest with the registry credential, no preload, no constraint', async () => {
    const svc = await svcRow({ image: null, repoUrl: 'https://github.com/acme/web.git' });
    const buildOnPanel = vi.fn(async () => ({
      buildHost: null,
      tag: 'ninedeploy/web:abc1234-b9',
      imageId: `sha256:${'a'.repeat(64)}`,
      sizeBytes: 1,
      builtWithNixpacks: false,
      builtStatic: false,
      registry: { target: { repository: 'reg.example.com/acme/web', host: 'reg.example.com', username: 'ru', password: 'rp', server: 'reg.example.com' }, digest: `sha256:${'b'.repeat(64)}` },
    }));
    const ship = vi.fn();
    const { driver, specs } = fakeDriver();
    await createSwarmBuilder(db, { driver, buildOnPanel: buildOnPanel as never, ship: ship as never }).buildAndRun(ctxFor(svc));
    expect(ship).not.toHaveBeenCalled();
    expect(specs[0]).toMatchObject({ services: [{ image: `reg.example.com/acme/web@sha256:${'b'.repeat(64)}`, constraints: [] }] });
    expect(specs[0]!.resolveImage).toBeUndefined();
    expect(h.docker).toContainEqual(['login', '--username', 'ru', '--password-stdin', 'reg.example.com']);
    expect(h.docker.filter((a) => a[0] === 'node' && a[1] === 'update')).toEqual([]);
  });

  it('a first deploy that fails to converge leaves nothing behind and fails the deployment', async () => {
    const svc = await svcRow();
    const err = await createSwarmBuilder(db, { driver: fakeDriver({ error: 'docker stack deploy nd-web failed: rolled back' }).driver })
      .buildAndRun(ctxFor(svc))
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/Swarm deploy failed: .*rolled back/);
    expect(h.docker).toContainEqual(['stack', 'rm', 'nd-web']);
    expect(h.docker).toContainEqual(['network', 'rm', 'nd-swarm-web']);
  });

  it('a failed update of an existing service keeps (or restores) the previous spec, never removes the stack', async () => {
    h.exists = true;
    h.updateState = 'rollback_completed';
    const svc = await svcRow();
    const ctx = ctxFor(svc);
    await expect(createSwarmBuilder(db, { driver: fakeDriver({ error: 'update rolled back' }).driver }).buildAndRun(ctx)).rejects.toThrow(/Swarm deploy failed/);
    expect(h.docker.filter((a) => a[0] === 'stack' && a[1] === 'rm')).toEqual([]);
    expect(lines(ctx as never)).toMatch(/Swarm rolled the update back \(rollback_completed\)/);
    // Not rolled back by Swarm yet: the builder starts the rollback.
    h.updateState = 'paused';
    await expect(createSwarmBuilder(db, { driver: fakeDriver({ error: 'x' }).driver }).buildAndRun(ctxFor(svc))).rejects.toThrow();
    expect(h.docker).toContainEqual(['service', 'rollback', '--detach', 'nd-web_web']);
  });
});

describe('health and rollback (design §7.4 step 6)', () => {
  const runtime = { runtimeId: 'nd-web_web', port: 80, healthPath: '/health' };

  it('healthy once the running replicas reach the desired count and the port answers through Traefik (<500 counts)', async () => {
    h.replicas = ['nd-web_web 1/2', 'nd-web_web 2/2'];
    h.probe = '404';
    const builder = createSwarmBuilder(db);
    expect(await builder.isHealthy({ ...runtime }, 60_000, 0, vi.fn())).toBe(true);
    expect(h.docker).toContainEqual(['exec', 'ninedeploy-traefik', 'wget', '-q', '-O', '/dev/null', '-T', '3', 'http://nd-web_web:80/health']);
  });

  it('a probe that never answers fails, and an in-place update is rolled back to the previous spec', async () => {
    h.exists = true;
    h.probe = 'down';
    const svc = await svcRow();
    const builder = createSwarmBuilder(db, { driver: fakeDriver().driver });
    const live = await builder.buildAndRun(ctxFor(svc));
    const log = vi.fn();
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(10_000_000);
    expect(await builder.isHealthy(live, 1000, 0, log)).toBe(false);
    vi.restoreAllMocks();
    expect(h.docker).toContainEqual(['service', 'rollback', '--detach', 'nd-web_web']);
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toMatch(/rolling the service back to its previous spec/);
  });

  it('a runtime that is not a Swarm service (the container a service switched from) goes to the container builder', async () => {
    const isHealthy = vi.spyOn(dockerBuilder, 'isHealthy').mockResolvedValue(true);
    const stop = vi.spyOn(dockerBuilder, 'stop').mockResolvedValue(undefined);
    const builder = createSwarmBuilder(db);
    expect(await builder.isHealthy({ runtimeId: 'web-7', port: 80, healthPath: '/' }, 3000, 0)).toBe(true);
    await builder.stop('web-7');
    expect(isHealthy).toHaveBeenCalled();
    expect(stop).toHaveBeenCalledWith('web-7', undefined);
    // …and the Swarm runtime is removed as a stack.
    await builder.stop('nd-web_web');
    expect(h.docker).toContainEqual(['stack', 'rm', 'nd-web']);
    vi.restoreAllMocks();
  });

  it('withSwarmRetirement: a service leaving Swarm retires its stack; every other runtime is the wrapped builder’s', async () => {
    const inner = { buildAndRun: vi.fn(), isHealthy: vi.fn(async () => true), stop: vi.fn(async () => undefined) };
    const wrapped = withSwarmRetirement(db, inner as never);
    await wrapped.stop('web-12', { graceSeconds: 3 });
    expect(inner.stop).toHaveBeenCalledWith('web-12', { graceSeconds: 3 });
    await wrapped.stop('nd-web_web');
    expect(inner.stop).toHaveBeenCalledTimes(1);
    expect(h.docker).toContainEqual(['stack', 'rm', 'nd-web']);
    expect(await wrapped.isHealthy({ runtimeId: 'nd-web_web', port: 80, healthPath: '/' }, 3000, 0, vi.fn())).toBe(true);
    expect(inner.isHealthy).not.toHaveBeenCalled();
  });
});
