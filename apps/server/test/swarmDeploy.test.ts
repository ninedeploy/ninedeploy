import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, databaseAttachments, databases, runMigrations, servers, services, serviceTargets, serviceVolumeAttachments, settings } from '@ninedeploy/db';

/**
 * Multi-node T7, the Swarm deploy flow (engine/swarmDeploy.ts, design §7.1,
 * §7.4; security review M1c/M1d/M4/L1/L3): refusals, the image (release,
 * shipped, built on the panel), distribution by registry or preload with a
 * positive preload label, the member constraint on every service, the
 * encrypted overlay joined by Traefik (a foreign one refused), a private
 * client config per deploy, the detached apply and the panel's convergence
 * wait, the probe and the rollback. Docker, the driver and the transfers are
 * mocked; the per-deploy config dirs are real, under a scratch data dir.
 */

const DATA_DIR = mkdtempSync(join(tmpdir(), 'nd-swarm-deploy-'));
vi.stubEnv('NINEDEPLOY_DATA_DIR', DATA_DIR);
afterAll(() => rmSync(DATA_DIR, { recursive: true, force: true }));

const MGR = 'mgr0000000000000000000001';
const WRK1 = 'wrk0000000000000000000001';
const WRK2 = 'wrk0000000000000000000002';
const EXT1 = 'ext0000000000000000000001';
const ENCRYPTED = 'overlay|{"encrypted":""}';

const h = vi.hoisted(() => ({
  docker: [] as string[][],
  /** `docker service ls` answers, consumed in order (the last one repeats). */
  replicas: [] as string[],
  exists: false,
  /** `{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}` (the failure path). */
  updateState: '',
  /** `{{json .UpdateStatus}}` (the convergence wait). */
  updateJson: '',
  probe: 'ok' as 'ok' | '404' | 'down',
  /** `docker network inspect --format '{{.Driver}}|{{json .Options}}'`, null: no such network. */
  network: null as string | null,
  nodes: '' as string,
}));
vi.mock('../src/lib/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/exec.js')>()),
  capture: vi.fn(async (_cmd: string, args: string[]) => {
    h.docker.push(args);
    const [a, b] = args;
    if (a === 'info') return `{"LocalNodeState":"active","ControlAvailable":true,"NodeID":"${MGR}","NodeAddr":"10.0.0.1"}`;
    if (a === 'node' && b === 'ls') return h.nodes;
    if (a === 'node' && b === 'inspect') return 'ready';
    if (a === 'network' && b === 'inspect') {
      if (h.network === null) throw new Error('No such network');
      return h.network;
    }
    if (a === 'inspect') return '{"ninedeploy":{}}';
    if (a === 'service' && b === 'inspect') {
      if (args.includes('{{.ID}}')) {
        if (!h.exists) throw new Error('no such service');
        return 'svcid';
      }
      if (args.includes('{{json .UpdateStatus}}')) return h.updateJson;
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
    if (args[0] === 'network' && args[1] === 'create') h.network = ENCRYPTED;
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
  h.updateJson = '';
  h.probe = 'ok';
  h.network = null;
  h.nodes = `{"ID":"${MGR}","Hostname":"panel","ManagerStatus":"Leader","Availability":"Active","Status":"Ready"}`;
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
});

const svcRow = async (values: Record<string, unknown> = {}) =>
  (await db.insert(services).values({ name: 'web', slug: 'web', type: 'docker', image: 'nginx:1.27', port: 80, orchestrator: 'swarm', replicas: 2, ...values } as never).returning())[0]!;

type Spec = { name: string; resolveImage?: string; services: Array<Record<string, any>>; networks: unknown[] };
type ApplyOpts = { wait?: boolean; dockerConfig?: string; withRegistryAuth?: boolean };
const fakeDriver = (status: { error?: string } = {}) => {
  const specs: Spec[] = [];
  const opts: ApplyOpts[] = [];
  /** Whether the deploy's config dir still existed while the spec was submitted. */
  const configLive: boolean[] = [];
  /** `<dockerConfig>/config.json` as the apply saw it (null: none). */
  const configJson: Array<{ body: unknown; mode: number } | null> = [];
  return {
    specs,
    opts,
    configLive,
    configJson,
    driver: {
      deployStack: vi.fn(async (spec: Spec, o: ApplyOpts = {}) => {
        specs.push(spec);
        opts.push(o);
        configLive.push(o.dockerConfig ? existsSync(o.dockerConfig) : false);
        const file = o.dockerConfig ? join(o.dockerConfig, 'config.json') : '';
        configJson.push(file && existsSync(file) ? { body: JSON.parse(readFileSync(file, 'utf8')), mode: statSync(file).mode & 0o777 } : null);
        return { name: spec.name, services: [], appliedAt: '', ...status };
      }),
    },
  };
};
const ctxFor = (service: Record<string, any>, over: Record<string, unknown> = {}) =>
  ({ deploymentId: 9, service, workDir: '/w', commitSha: 'abc1234def', env: { A: '1' }, log: vi.fn(), ...over }) as never;
const lines = (ctx: { log: ReturnType<typeof vi.fn> }) => ctx.log.mock.calls.map((c) => String(c[0])).join('\n');
const nodeUpdates = () => h.docker.filter((a) => a[0] === 'node' && a[1] === 'update').map((a) => a.slice(2).join(' '));
/** Review M4: `docker login` would park the password in the host's credential helper; it never runs. */
const logins = () => h.docker.filter((a) => a.includes('login'));
const b64 = (s: string) => Buffer.from(s).toString('base64');
/** POSIX only: Windows reports no owner-only mode bits. */
const expectOwnerOnly = (mode: number) => {
  if (process.platform !== 'win32') expect(mode).toBe(0o600);
};

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
  it('an image release: encrypted overlay + Traefik, one stack spec with the member constraint, registry auth in a private config, runtime nd-<slug>_web', async () => {
    const svc = await svcRow({ cmd: ['nginx', '-g', 'daemon off;'], memLimitMb: 256 });
    const { driver, specs, opts, configLive, configJson } = fakeDriver();
    const ctx = ctxFor(svc, { registryAuth: { username: 'u', password: 'p', server: 'reg.example.com' } });
    const runtime = await createSwarmBuilder(db, 'web', { driver }).buildAndRun(ctx);
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
          // M1c: a node that joined the swarm any other way never runs a task.
          constraints: ['node.labels.nd.member==1'],
          command: ['nginx', '-g', 'daemon off;'],
          memLimitMb: 256,
          labels: { 'ninedeploy.managed': 'service', 'ninedeploy.service': String(svc.id), 'ninedeploy.deployment': '9' },
        },
      ],
    });
    expect(specs[0]!.resolveImage).toBeUndefined();
    // The panel's node is (re)labelled a member.
    expect(nodeUpdates()).toEqual([`--label-add nd.member=1 -- ${MGR}`]);
    // M4: the credential written into this deploy's own config (never `docker login`), forwarded with
    // --with-registry-auth, submitted detached.
    expect(opts[0]).toMatchObject({ wait: false, withRegistryAuth: true, dockerConfig: expect.stringContaining(join(DATA_DIR, 'swarm', '.docker-')) });
    expect(logins()).toEqual([]);
    expect(configJson[0]!.body).toEqual({ auths: { 'reg.example.com': { auth: b64('u:p') } } });
    expectOwnerOnly(configJson[0]!.mode);
    expect(configLive).toEqual([true]);
    expect(existsSync(opts[0]!.dockerConfig!)).toBe(false);
    // The panel waits for convergence itself.
    expect(h.docker).toContainEqual(['service', 'inspect', '--format', '{{json .UpdateStatus}}', 'nd-web_web']);
  });

  it('M4: two deploys never share a client config; a service without registry auth logs in nowhere and forwards nothing', async () => {
    const svc = await svcRow();
    const { driver, opts, configJson } = fakeDriver();
    const builder = createSwarmBuilder(db, 'web', { driver });
    await builder.buildAndRun(ctxFor(svc));
    await builder.buildAndRun(ctxFor(svc, { registryAuth: { username: 'u', password: 'p' } }));
    const [first, second] = opts;
    expect(first!.dockerConfig).toBeTruthy();
    expect(second!.dockerConfig).toBeTruthy();
    expect(first!.dockerConfig).not.toBe(second!.dockerConfig);
    expect(first!.withRegistryAuth).toBe(false);
    expect(second!.withRegistryAuth).toBe(true);
    expect(logins()).toEqual([]);
    // No credential: an empty config. Docker Hub (no server): the key the CLI looks Hub up by.
    expect(configJson[0]).toBeNull();
    expect(configJson[1]!.body).toEqual({ auths: { 'https://index.docker.io/v1/': { auth: b64('u:p') } } });
    for (const o of opts) {
      expect(o.dockerConfig!.startsWith(join(DATA_DIR, 'swarm'))).toBe(true);
      expect(existsSync(o.dockerConfig!)).toBe(false);
    }
  });

  it('L3: an existing nd-swarm-<slug> network that is not an encrypted overlay is refused, never reused or removed', async () => {
    for (const network of ['overlay|{}', 'bridge|{}']) {
      h.docker = [];
      h.network = network;
      const svc = (await db.query.services.findFirst()) ?? (await svcRow());
      const { driver, specs } = fakeDriver();
      await expect(createSwarmBuilder(db, 'web', { driver }).buildAndRun(ctxFor(svc))).rejects.toThrow(
        /A network named nd-swarm-web already exists and is (an overlay WITHOUT data-plane encryption|not an overlay network)\. NineDeploy did not create it/,
      );
      expect(h.docker.filter((a) => a[0] === 'network' && (a[1] === 'create' || a[1] === 'rm'))).toEqual([]);
      expect(specs).toEqual([]);
    }
  });

  it('a source build without a registry: built on the panel, preloaded onto member nodes, a positive preload label on exactly the nodes that hold it (D7f, M1d)', async () => {
    const svc = await svcRow({ image: null, repoUrl: 'https://github.com/acme/web.git', port: null });
    const [node] = await db.insert(servers).values({ name: 'edge', host: 'h', port: 1, tokenEncrypted: 'x', swarmNodeId: WRK1 } as never).returning();
    h.nodes = [
      `{"ID":"${MGR}","Hostname":"panel","ManagerStatus":"Leader","Availability":"Active","Status":"Ready"}`,
      `{"ID":"${WRK1}","Hostname":"edge","ManagerStatus":"","Availability":"Active","Status":"Ready"}`,
      `{"ID":"${WRK2}","Hostname":"old","ManagerStatus":"","Availability":"Active","Status":"Ready"}`,
      `{"ID":"${EXT1}","Hostname":"foreign","ManagerStatus":"","Availability":"Active","Status":"Ready"}`,
    ].join('\n');
    await db.insert(servers).values({ name: 'old', host: 'h2', port: 1, tokenEncrypted: 'x', swarmNodeId: WRK2 } as never);
    const buildOnPanel = vi.fn(async () => ({ buildHost: null, tag: 'ninedeploy/web:abc1234-b9', imageId: `sha256:${'a'.repeat(64)}`, sizeBytes: 42, builtWithNixpacks: true, builtStatic: false }));
    const ship = vi.fn(async (_db: unknown, spec: { target: number }) => {
      if (spec.target !== node!.id) throw Object.assign(new Error('The agent on node "old" cannot receive an image. Update the node agent'), { statusCode: 422 });
      return { method: 'stream', ref: 'x', bytes: 1, sha256: 'y', durationMs: 1 };
    });
    const { driver, specs } = fakeDriver();
    const ctx = ctxFor(svc);
    const runtime = await createSwarmBuilder(db, 'web', { driver, buildOnPanel: buildOnPanel as never, ship: ship as never }).buildAndRun(ctx);
    expect(buildOnPanel).toHaveBeenCalledWith(db, { kind: 'panel' }, ctx);
    // Only NineDeploy nodes are sent anything; the foreign node is never shipped to.
    expect(ship).toHaveBeenCalledTimes(2);
    expect(ship.mock.calls[0]![1]).toMatchObject({ source: null, target: node!.id, tag: 'ninedeploy/web:abc1234-b9', imageId: `sha256:${'a'.repeat(64)}`, sizeBytes: 42, deploymentId: 9 });
    expect(nodeUpdates()).toEqual([`--label-add nd.member=1 -- ${MGR}`, `--label-add nd.preload.web=aaaaaaaaaaaa -- ${MGR}`, `--label-add nd.preload.web=aaaaaaaaaaaa -- ${WRK1}`]);
    expect(specs[0]).toMatchObject({
      resolveImage: 'never',
      services: [{ image: 'ninedeploy/web:abc1234-b9', constraints: ['node.labels.nd.member==1', 'node.labels.nd.preload.web==aaaaaaaaaaaa'], port: 3000 }],
    });
    expect(specs[0]!.services[0]!.env.PORT).toBe('3000'); // Nixpacks' run convention, like the container builder
    expect(runtime).toMatchObject({ runtimeId: 'nd-web_web', port: 3000, imageDigest: `sha256:${'a'.repeat(64)}` });
    expect(lines(ctx as never)).toMatch(/node old will run no task.*Update the node agent/);
    expect(lines(ctx as never)).not.toMatch(/foreign/);
  });

  it('a source build with a push registry: deployed by digest with the registry credential, no preload, only the member constraint', async () => {
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
    const { driver, specs, opts, configJson } = fakeDriver();
    await createSwarmBuilder(db, 'web', { driver, buildOnPanel: buildOnPanel as never, ship: ship as never }).buildAndRun(ctxFor(svc));
    expect(ship).not.toHaveBeenCalled();
    expect(specs[0]).toMatchObject({ services: [{ image: `reg.example.com/acme/web@sha256:${'b'.repeat(64)}`, constraints: ['node.labels.nd.member==1'] }] });
    expect(specs[0]!.resolveImage).toBeUndefined();
    expect(logins()).toEqual([]);
    expect(configJson[0]!.body).toEqual({ auths: { 'reg.example.com': { auth: b64('ru:rp') } } });
    expect(opts[0]!.withRegistryAuth).toBe(true);
    expect(nodeUpdates()).toEqual([`--label-add nd.member=1 -- ${MGR}`]);
  });

  it('a first deploy that fails to converge leaves nothing behind and fails the deployment', async () => {
    const svc = await svcRow();
    const err = await createSwarmBuilder(db, 'web', { driver: fakeDriver({ error: 'docker stack deploy nd-web failed: rolled back' }).driver })
      .buildAndRun(ctxFor(svc))
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/Swarm deploy failed: .*rolled back/);
    expect(h.docker).toContainEqual(['stack', 'rm', 'nd-web']);
    expect(h.docker).toContainEqual(['network', 'rm', 'nd-swarm-web']);
  });

  it('the panel-side convergence wait fails a deploy that Swarm rolled back after the detached submit', async () => {
    h.exists = true;
    h.updateJson = JSON.stringify({ State: 'rollback_completed', Message: 'update rolled back due to failure', StartedAt: new Date(Date.now() + 1000).toISOString() });
    h.updateState = 'rollback_completed';
    const svc = await svcRow();
    const ctx = ctxFor(svc);
    await expect(createSwarmBuilder(db, 'web', { driver: fakeDriver().driver }).buildAndRun(ctx)).rejects.toThrow(
      /Swarm deploy failed: the rolling update was rollback completed: update rolled back due to failure/,
    );
    expect(h.docker.filter((a) => a[0] === 'stack' && a[1] === 'rm')).toEqual([]);
    // An UpdateStatus older than this apply (an unchanged spec) is not this deploy's: the replica counts decide.
    h.updateJson = JSON.stringify({ State: 'rollback_completed', StartedAt: '2020-01-01T00:00:00Z' });
    await expect(createSwarmBuilder(db, 'web', { driver: fakeDriver().driver }).buildAndRun(ctxFor(svc))).resolves.toMatchObject({ runtimeId: 'nd-web_web' });
  });

  it('a failed update of an existing service keeps (or restores) the previous spec, never removes the stack', async () => {
    h.exists = true;
    h.updateState = 'rollback_completed';
    const svc = await svcRow();
    const ctx = ctxFor(svc);
    await expect(createSwarmBuilder(db, 'web', { driver: fakeDriver({ error: 'update rolled back' }).driver }).buildAndRun(ctx)).rejects.toThrow(/Swarm deploy failed/);
    expect(h.docker.filter((a) => a[0] === 'stack' && a[1] === 'rm')).toEqual([]);
    expect(lines(ctx as never)).toMatch(/Swarm rolled the update back \(rollback_completed\)/);
    // Not rolled back by Swarm yet: the builder starts the rollback.
    h.updateState = 'paused';
    await expect(createSwarmBuilder(db, 'web', { driver: fakeDriver({ error: 'x' }).driver }).buildAndRun(ctxFor(svc))).rejects.toThrow();
    expect(h.docker).toContainEqual(['service', 'rollback', '--detach', 'nd-web_web']);
  });
});

describe('dockerAuthKey (review M4)', () => {
  it('normalises the registry the way the Docker CLI looks it up', async () => {
    const { dockerAuthKey } = await import('../src/lib/swarm.js');
    for (const hub of [undefined, '', 'docker.io', 'index.docker.io', 'registry-1.docker.io', 'https://index.docker.io/v1/', 'DOCKER.IO']) {
      expect(dockerAuthKey(hub), String(hub)).toBe('https://index.docker.io/v1/');
    }
    expect(dockerAuthKey('reg.example.com')).toBe('reg.example.com');
    expect(dockerAuthKey('https://Reg.Example.com:5000/v2/')).toBe('reg.example.com:5000');
    expect(dockerAuthKey('ghcr.io')).toBe('ghcr.io');
  });
});

describe('health and rollback (design §7.4 step 6)', () => {
  const runtime = { runtimeId: 'nd-web_web', port: 80, healthPath: '/health' };

  it('healthy once the running replicas reach the desired count and the port answers through Traefik (<500 counts)', async () => {
    h.replicas = ['nd-web_web 1/2', 'nd-web_web 2/2'];
    h.probe = '404';
    const builder = createSwarmBuilder(db, 'web');
    expect(await builder.isHealthy({ ...runtime }, 60_000, 0, vi.fn())).toBe(true);
    expect(h.docker).toContainEqual(['exec', 'ninedeploy-traefik', 'wget', '-q', '-O', '/dev/null', '-T', '3', 'http://nd-web_web:80/health']);
  });

  it('a probe that never answers fails, and an in-place update is rolled back to the previous spec', async () => {
    h.exists = true;
    h.probe = 'down';
    const svc = await svcRow();
    const builder = createSwarmBuilder(db, 'web', { driver: fakeDriver().driver });
    const live = await builder.buildAndRun(ctxFor(svc));
    const log = vi.fn();
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(10_000_000);
    expect(await builder.isHealthy(live, 1000, 0, log)).toBe(false);
    vi.restoreAllMocks();
    expect(h.docker).toContainEqual(['service', 'rollback', '--detach', 'nd-web_web']);
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toMatch(/rolling the service back to its previous spec/);
  });

  it('a runtime that is not THIS service’s Swarm service goes to the container builder; the stack removed is named from the slug (L1)', async () => {
    const isHealthy = vi.spyOn(dockerBuilder, 'isHealthy').mockResolvedValue(true);
    const stop = vi.spyOn(dockerBuilder, 'stop').mockResolvedValue(undefined);
    const builder = createSwarmBuilder(db, 'web');
    expect(await builder.isHealthy({ runtimeId: 'web-7', port: 80, healthPath: '/' }, 3000, 0)).toBe(true);
    await builder.stop('web-7');
    expect(isHealthy).toHaveBeenCalled();
    expect(stop).toHaveBeenCalledWith('web-7', undefined);
    // Another service's Swarm runtime id is never removed as a stack.
    await builder.stop('nd-victim_web');
    expect(stop).toHaveBeenCalledWith('nd-victim_web', undefined);
    expect(h.docker.filter((a) => a[0] === 'stack')).toEqual([]);
    // …and its own Swarm runtime is removed as a stack.
    await builder.stop('nd-web_web');
    expect(h.docker).toContainEqual(['stack', 'rm', 'nd-web']);
    vi.restoreAllMocks();
  });

  it('withSwarmRetirement: a service leaving Swarm retires its own stack; every other runtime is the wrapped builder’s', async () => {
    const inner = { buildAndRun: vi.fn(), isHealthy: vi.fn(async () => true), stop: vi.fn(async () => undefined) };
    const wrapped = withSwarmRetirement(db, inner as never, 'web');
    await wrapped.stop('web-12', { graceSeconds: 3 });
    expect(inner.stop).toHaveBeenCalledWith('web-12', { graceSeconds: 3 });
    await wrapped.stop('nd-victim_web');
    expect(inner.stop).toHaveBeenCalledTimes(2);
    expect(h.docker.filter((a) => a[0] === 'stack')).toEqual([]);
    await wrapped.stop('nd-web_web');
    expect(inner.stop).toHaveBeenCalledTimes(2);
    expect(h.docker).toContainEqual(['stack', 'rm', 'nd-web']);
    expect(await wrapped.isHealthy({ runtimeId: 'nd-web_web', port: 80, healthPath: '/' }, 3000, 0, vi.fn())).toBe(true);
    expect(inner.isHealthy).not.toHaveBeenCalled();
  });
});
