import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, imageTransfers, runMigrations, servers, services } from '@ninedeploy/db';
import { MULTI_NODE_CAPABILITIES, type MultiNodeCapability, serverAgentInfo as serverAgentInfoSchema, serverFeatures as serverFeaturesSchema } from '@ninedeploy/schemas';

/**
 * Multi-node (design §1.2, §1.3, §1.7): a panel with this release talking to
 * a 0.15 agent refuses every new node feature cleanly — 422
 * `node_agent_outdated` with the "update the node agent" message naming the
 * minimum version — after asking the agent nothing but `agent.ping`, writing
 * no feature row and running nothing on the node. An image-based docker
 * deploy to that node keeps working unchanged (the regression baseline).
 *
 * Feature tasks add their route-level cases in their labelled block below.
 */

const h = vi.hoisted(() => ({
  ping: '' as string,
  sealed: true,
  pingThrows: null as Error | null,
  ops: [] as string[],
}));
vi.mock('../src/lib/agentClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/agentClient.js')>()),
  agentTransportSealed: async () => h.sealed,
  agentOp: async (_db: unknown, _id: number, op: string) => {
    h.ops.push(op);
    if (op === 'agent.ping') {
      if (h.pingThrows) throw h.pingThrows;
      return { exitCode: 0, lines: h.ping ? [h.ping] : [] };
    }
    throw new Error(`agent ${op} failed (400): {"error":{"code":"unknown_op"}}`);
  },
  agentPingLines: async () => ({ lines: h.ping ? [h.ping] : [] }),
}));
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

const caps = await import('../src/lib/agentCapabilities.js');
const { openAgentStream } = await import('../src/lib/agentStream.js');
const { HttpError } = await import('../src/lib/errors.js');
const { serverRoutes } = await import('../src/modules/servers.js');
const { createRemoteDockerBuilder } = await import('../src/engine/builders/remoteDocker.js');
const { encrypt } = await import('../src/lib/crypto.js');
const { asUser, buildTestApp } = await import('./helpers.js');

const pingLine = (version: string, list: string[]) => `ND-AGENT ${JSON.stringify({ version, caps: list })}`;
const CAPS_015_LIST = ['build-path-guard', 'workspace.remove', 'git.credential', 'terminal', 'terminal.host'];
/** What a v0.15.0 / v0.15.1 agent answers. */
const CAPS_015 = pingLine('0.15.1', CAPS_015_LIST);
/** A current agent with every multi-node capability. */
const CAPS_ALL = pingLine('0.15.2', [...CAPS_015_LIST, ...MULTI_NODE_CAPABILITIES]);

/** The feature each capability gates, as a refusal names it. */
const FEATURES: Record<MultiNodeCapability, string> = {
  stream: 'stream data to the panel',
  'docker.runSpec': 'run a service with volume attachments, a command or the Docker socket',
  'volume.manage': 'create node volumes',
  'image.manage': 'receive an image',
  'build.nixpacks': 'build with Nixpacks',
  'build.railpack': 'build with Railpack',
  'git.sshkey': 'clone with a deploy key',
  'db.manage': 'host a managed database',
  swarm: 'join the Swarm',
};

let db: DB;
let serverId: number;

beforeEach(async () => {
  h.ping = CAPS_015;
  h.sealed = true;
  h.pingThrows = null;
  h.ops = [];
  caps.resetNodeCapabilityCache();
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  const [row] = await db.insert(servers).values({ name: 'edge-1', host: '10.0.0.5', port: 4600, tokenEncrypted: encrypt('t'), status: 'online' }).returning();
  serverId = row!.id;
});

const scripted = async (op: string) => {
  h.ops.push(op);
  if (h.pingThrows) throw h.pingThrows;
  return { exitCode: 0, lines: h.ping ? [h.ping] : [] };
};

describe('capabilityRefusal against a 0.15 agent (CAPS_015)', () => {
  for (const cap of MULTI_NODE_CAPABILITIES) {
    // The release each capability first shipped in: 0.15.2, `db.manage` the one after (0.16 T6).
    const minimum = caps.AGENT_CAPABILITY_VERSION[cap];
    it(`${cap}: 422 node_agent_outdated, "update the node agent to v${minimum}", only agent.ping asked`, async () => {
      const refusal = await caps.capabilityRefusal(scripted, '"edge-1" (#1)', true, { cap, feature: FEATURES[cap], sealedRequired: true });
      expect(refusal).toEqual({
        status: 422,
        code: 'node_agent_outdated',
        message: expect.stringMatching(
          new RegExp(`^The agent on node "edge-1" \\(#1\\) \\(version 0\\.15\\.1\\) cannot ${FEATURES[cap].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. Update the node agent to v${minimum.replace(/\./g, '\\.')} or newer`),
        ),
      });
      expect(h.ops).toEqual(['agent.ping']);
    });
  }

  it('a pre-0.10.42 agent (no ND-AGENT line) reads as "an older release"', async () => {
    h.ping = '';
    const refusal = await caps.capabilityRefusal(scripted, '#1', true, { cap: 'stream', feature: 'stream data', sealedRequired: true });
    expect(refusal?.message).toMatch(/\(an older release\) cannot stream data/);
  });

  it('the unencrypted transport is refused before the agent is asked anything (sealed features)', async () => {
    const refusal = await caps.capabilityRefusal(scripted, '#1', false, { cap: 'image.manage', feature: 'receive an image', sealedRequired: true });
    expect(refusal).toEqual({ status: 422, code: 'node_transport_unsealed', message: 'The panel reaches node #1 only over the unencrypted transport; receive an image is never sent in clear.' });
    expect(h.ops).toEqual([]);
    // A feature that carries no secret still asks.
    h.ping = CAPS_ALL;
    expect(await caps.capabilityRefusal(scripted, '#1', false, { cap: 'volume.manage', feature: 'create node volumes', sealedRequired: false })).toBeNull();
  });

  it('an unreachable node is 502 node_unreachable', async () => {
    h.pingThrows = new Error('connect ECONNREFUSED');
    expect(await caps.capabilityRefusal(scripted, '#1', true, { cap: 'stream', feature: 'x', sealedRequired: true })).toMatchObject({
      status: 502,
      code: 'node_unreachable',
      message: expect.stringMatching(/ECONNREFUSED/),
    });
  });

  it("a current agent whose owner switched the feature off is 403 node_feature_disabled (not 'outdated')", async () => {
    h.ping = pingLine('0.15.2', [...CAPS_015_LIST, 'stream', 'image.manage']);
    expect(await caps.capabilityRefusal(scripted, '#1', true, { cap: 'build.nixpacks', feature: 'build with Nixpacks', sealedRequired: true })).toEqual({
      status: 403,
      code: 'node_feature_disabled',
      message: "The agent on node #1 (version 0.15.2) cannot build with Nixpacks: the node's owner turned it off (NINEDEPLOY_AGENT_BUILDS=off on the agent).",
    });
    // A capability with no switch missing from a current agent is still "update".
    h.ping = pingLine('0.15.2', CAPS_015_LIST);
    expect((await caps.capabilityRefusal(scripted, '#1', true, { cap: 'stream', feature: 'x', sealedRequired: true }))?.code).toBe('node_agent_outdated');
    expect(caps.agentVersionAtLeast('0.15.10', '0.15.2')).toBe(true);
    expect(caps.agentVersionAtLeast('v0.16.0', '0.15.2')).toBe(true);
    expect(caps.agentVersionAtLeast('0.15.1', '0.15.2')).toBe(false);
    expect(caps.agentVersionAtLeast(null, '0.15.2')).toBe(false);
    expect(caps.agentVersionAtLeast('dev', '0.15.2')).toBe(false);
  });

  it('a current agent passes; several capabilities are checked at once', async () => {
    h.ping = CAPS_ALL;
    expect(await caps.capabilityRefusal(scripted, '#1', true, { cap: ['stream', 'image.manage'], feature: 'x', sealedRequired: true })).toBeNull();
  });
});

describe('the queue-time check (assertNodeCapability) and the persisted cache (§1.3)', () => {
  it('refuses a 0.15 agent with an HttpError 422, writes only the capability cache, sends only agent.ping', async () => {
    const err = await caps.assertNodeCapability(db, serverId, { cap: 'volume.manage', feature: 'create node volumes', sealedRequired: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ statusCode: 422, code: 'node_agent_outdated', message: expect.stringMatching(/"edge-1" \(#\d+\) \(version 0\.15\.1\).*v0\.15\.2 or newer/) });
    expect(h.ops).toEqual(['agent.ping']);
    const row = await db.query.servers.findFirst();
    expect(row).toMatchObject({ agentVersion: '0.15.1', agentCaps: CAPS_015_LIST });
    expect(row!.agentCheckedAt).toBeInstanceOf(Date);
    expect(await db.select().from(imageTransfers)).toHaveLength(0);
    expect(await db.select().from(services)).toHaveLength(0);
  });

  it('a fresh cached answer that already allows the feature skips the ping; the job re-checks anyway', async () => {
    h.ping = CAPS_ALL;
    await caps.assertNodeCapability(db, serverId, { cap: 'stream', feature: 'x', sealedRequired: true });
    await caps.assertNodeCapability(db, serverId, { cap: 'stream', feature: 'x', sealedRequired: true });
    expect(h.ops).toEqual(['agent.ping']);
    // Past the TTL it asks again.
    await caps.assertNodeCapability(db, serverId, { cap: 'stream', feature: 'x', sealedRequired: true, now: Date.now() + caps.NODE_CAPABILITY_TTL_MS + 1 });
    expect(h.ops).toEqual(['agent.ping', 'agent.ping']);
    // An unsealed transport never answers from the cache for a sealed feature.
    h.sealed = false;
    await expect(caps.assertNodeCapability(db, serverId, { cap: 'stream', feature: 'x', sealedRequired: true })).rejects.toMatchObject({ code: 'node_transport_unsealed' });
  });

  it('serverAgentInfo / serverFeatures: what GET /v1/servers reports, shaped by the schemas', () => {
    expect(caps.serverAgentInfo({ agentVersion: null, agentCaps: null, agentCheckedAt: null })).toBeNull();
    const old = caps.serverAgentInfo({ agentVersion: '0.15.1', agentCaps: CAPS_015_LIST, agentCheckedAt: new Date(0) });
    expect(serverAgentInfoSchema.parse(old)).toEqual({ version: '0.15.1', capabilities: CAPS_015_LIST, checkedAt: '1970-01-01T00:00:00.000Z' });
    const f = serverFeaturesSchema.parse(caps.serverFeatures(old));
    expect(f).toMatchObject({ nixpacks: false, railpack: false, privateClones: false, volumes: false, databases: false, imageTransfer: false, swarm: false });
    // The newest release any missing capability needs: `swarm` ships after 0.15.3 (0.16 T7; `db.manage` after 0.15.2, T6).
    expect(f.reason).toMatch(/version 0\.15\.1\) cannot do Nixpacks builds, .*Swarm\. Update the node agent to v0\.15\.4 or newer/);
    expect(caps.serverFeatures(null).reason).toMatch(/not been reached/);
    const all = caps.serverFeatures({ version: '0.15.2', capabilities: [...MULTI_NODE_CAPABILITIES], checkedAt: null });
    expect(all).toEqual({ nixpacks: true, railpack: true, privateClones: true, volumes: true, databases: true, imageTransfer: true, swarm: true });
    expect(caps.serverFeatures({ version: '0.15.2', capabilities: ['stream', 'image.manage'], checkedAt: null })).toMatchObject({ imageTransfer: true, volumes: false });
  });

  it('GET /v1/servers adds `agent` and `features`; POST /:id/test refreshes the persisted cache', async () => {
    const app = await buildTestApp({ db });
    await app.register(serverRoutes, { prefix: '/servers' });
    await db.update(servers).set({ lastSeenAt: new Date() });
    const [first] = (await app.inject({ method: 'GET', url: '/servers', headers: asUser() })).json() as Array<Record<string, any>>;
    expect(first!.agent).toMatchObject({ version: '0.15.1', capabilities: CAPS_015_LIST });
    expect(first!.features).toMatchObject({ imageTransfer: false, reason: expect.stringMatching(/v0\.15\.4/) }); // swarm (0.16 T7) is the newest missing
    expect(first!.terminal).toEqual({ host: true, container: true }); // the 0.15 field is unchanged
    // From the persisted columns once the in-memory answer is gone (an offline node is not asked).
    caps.resetNodeCapabilityCache();
    await db.update(servers).set({ status: 'offline' });
    const [cached] = (await app.inject({ method: 'GET', url: '/servers', headers: asUser() })).json() as Array<Record<string, any>>;
    expect(cached!.agent).toMatchObject({ version: '0.15.1' });
    h.ping = CAPS_ALL;
    expect((await app.inject({ method: 'POST', url: `/servers/${serverId}/test`, headers: asUser() })).statusCode).toBe(200);
    expect((await db.query.servers.findFirst())!.agentVersion).toBe('0.15.2');
    await app.close();
  });
});

describe('the stream channel refuses a 0.15 agent before anything but agent.ping', () => {
  it('openAgentStream: 422 node_agent_outdated, no stream.open, no socket', async () => {
    const socketFactory = vi.fn();
    const err = await openAgentStream(db, serverId, 'image.load', { expectTag: 'ninedeploy/web:x', expectId: `sha256:${'a'.repeat(64)}` }, { socketFactory }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ statusCode: 422, code: 'node_agent_outdated', message: expect.stringMatching(/cannot receive an image\. Update the node agent to v0\.15\.2/) });
    expect(h.ops).toEqual(['agent.ping']);
    expect(socketFactory).not.toHaveBeenCalled();
    h.sealed = false;
    h.ops = [];
    await expect(openAgentStream(db, serverId, 'volume.export', { volume: 'nd-svc-a' }, { socketFactory })).rejects.toMatchObject({ code: 'node_transport_unsealed' });
    expect(h.ops).toEqual([]);
  });
});

describe('the regression baseline: an image deploy to a 0.15 agent is unchanged', () => {
  it('uses only 0.15 ops and succeeds', async () => {
    const OPS_015 = new Set(['docker.networkCreate', 'docker.pull', 'file.writeEnv', 'docker.runEnv', 'file.deleteEnv', 'docker.stop', 'docker.rm', 'docker.inspect']);
    const sent: string[] = [];
    // A 0.15 agent: every 0.15 op works; anything newer is `unknown_op`.
    const agent015 = async (op: string) => {
      sent.push(op);
      if (!OPS_015.has(op)) throw new Error(`agent ${op} failed (400): unknown_op`);
      return { exitCode: 0, lines: op === 'file.writeEnv' ? ['wrote .agent-env/web-7.env'] : [] };
    };
    const runtime = await createRemoteDockerBuilder(agent015).buildAndRun({
      deploymentId: 7,
      service: { id: 1, name: 'web', slug: 'web', type: 'docker', image: 'nginx:1.27', repoUrl: null, branch: 'main', port: 80, healthPath: '/', cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0, volumeMount: null, publishedPort: null, serverId },
      buildConfig: {},
      workDir: '/tmp/x',
      commitSha: null,
      env: { A: '1' },
      log: () => undefined,
    } as never);
    expect(runtime).toMatchObject({ runtimeId: 'web-7' });
    expect(sent).toEqual(['docker.networkCreate', 'docker.pull', 'file.writeEnv', 'docker.runEnv', 'file.deleteEnv']);
  });
});

// Feature-route refusal cases with CAPS_015 (design §1.7): each task adds its
// own, asserting 422 node_agent_outdated, only `agent.ping`, no row written.
// ── 0.16 T3 node builds and private clones ── (Nixpacks, Railpack, PAT, deploy key)
describe('T3: node builds and private clones against a 0.15 agent', () => {
  const T3_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ==\n-----END OPENSSH PRIVATE KEY-----';

  async function t3Service(values: Record<string, unknown>, build?: Record<string, unknown>) {
    const { buildConfigs } = await import('@ninedeploy/db');
    const [svc] = await db
      .insert(services)
      .values({ name: 'web', slug: 'web', type: 'docker', repoUrl: 'https://github.com/acme/web.git', branch: 'main', serverId, ...values })
      .returning();
    if (build) await db.insert(buildConfigs).values({ serviceId: svc!.id, ...build });
    return svc!;
  }
  async function t3Source(values: Record<string, unknown>) {
    const { sources } = await import('@ninedeploy/db');
    return (await db.insert(sources).values({ type: 'github', name: 'src', allowOnNodes: true, ...values } as never).returning())[0]!.id;
  }
  const rowCounts = async () => {
    const { deployments } = await import('@ninedeploy/db');
    return { deployments: (await db.select().from(deployments)).length, transfers: (await db.select().from(imageTransfers)).length };
  };

  for (const [name, setup, feature] of [
    ['Nixpacks', async () => t3Service({}, { buildPack: 'nixpacks' }), 'build with Nixpacks'],
    ['a PAT (allowed on nodes)', async () => t3Service({ sourceId: await t3Source({ tokenEncrypted: encrypt('ghp_x') }) }), 'clone with a personal access token'],
    ['a deploy key (allowed on nodes)', async () => t3Service({ sourceId: await t3Source({ deployKeyEncrypted: encrypt(T3_KEY) }) }), 'clone with a deploy key'],
  ] as const) {
    it(`${name}: queue time answers 422 node_agent_outdated, asks only agent.ping, writes no row`, async () => {
      const { assertRemoteServiceSupported } = await import('../src/lib/remoteDeploy.js');
      const svc = await setup();
      const before = await rowCounts();
      h.ops = [];
      const err = await assertRemoteServiceSupported(db, svc).catch((e: unknown) => e);
      expect(err).toMatchObject({
        statusCode: 422,
        code: 'node_agent_outdated',
        message: expect.stringMatching(new RegExp(`\\(version 0\\.15\\.1\\) cannot ${feature}\\. Update the node agent to v0\\.15\\.2 or newer`)),
      });
      expect(h.ops).toEqual(['agent.ping']);
      expect(await rowCounts()).toEqual(before);
    });
  }

  it('Railpack is not refused: a 0.15 agent keeps the r520 Dockerfile build, and Nixpacks fails the job before any clone', async () => {
    const { assertRemoteServiceSupported } = await import('../src/lib/remoteDeploy.js');
    await expect(assertRemoteServiceSupported(db, await t3Service({}, { buildPack: 'railpack' }))).resolves.toBeUndefined();
    const sent: string[] = [];
    const agent015 = async (op: string) => {
      sent.push(op);
      return { exitCode: 0, lines: op === 'agent.ping' ? [CAPS_015] : [] };
    };
    const err = await createRemoteDockerBuilder(agent015, { nodeLabel: '"edge-1" (#1)' })
      .buildAndRun({
        deploymentId: 7,
        service: { id: 1, name: 'web', slug: 'web', type: 'docker', image: null, repoUrl: 'https://github.com/acme/web.git', branch: null, port: 80, healthPath: '/', cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0, volumeMount: null, publishedPort: null, serverId },
        buildConfig: { buildPack: 'nixpacks' },
        workDir: '/nonexistent/x',
        commitSha: 'deadbeefcafe',
        env: {},
        log: () => undefined,
      } as never)
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/cannot build with Nixpacks\. Update the node agent to v0\.15\.2/);
    expect(sent.filter((op) => op.startsWith('git.') || op.startsWith('build.') || op === 'docker.build')).toEqual([]);
  });
});
// ── end 0.16 T3 ──
// ── 0.16 T4 build placement ── (image transfer to the node)
describe('T4: build placement and image transfer against a 0.15 agent (CAPS_015)', () => {
  const t4Service = async (values: Record<string, unknown>) =>
    (await db.insert(services).values({ name: 'web', slug: 'web', type: 'docker', repoUrl: 'https://github.com/acme/web.git', branch: 'main', serverId, ...values } as never).returning())[0]!;

  it('PUT /v1/services/:id/placement (build on the panel, ship to the node): 422, only agent.ping, nothing stored', async () => {
    const { servicePlacementRoutes } = await import('../src/modules/servicePlacement.js');
    const svc = await t4Service({});
    const app = await buildTestApp({ db });
    await app.register(servicePlacementRoutes, { prefix: '/services' });
    const res = await app.inject({ method: 'PUT', url: `/services/${svc.id}/placement`, headers: asUser(), payload: { buildOn: 'panel' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: 'node_agent_outdated', message: expect.stringMatching(/cannot receive an image\. Update the node agent to v0\.15\.2/) });
    expect(h.ops).toEqual(['agent.ping']);
    expect((await db.query.services.findFirst())!.buildOn).toBeNull();
    await app.close();
  });

  it('shipping to the node: 422 before any stream, not retried, the transfer row is failed', async () => {
    const { shipImageByStream } = await import('../src/lib/imageTransfer.js');
    const svc = await t4Service({});
    const socketFactory = vi.fn();
    const err = await shipImageByStream(
      db,
      { deploymentId: null, serviceId: svc.id, source: null, target: serverId, tag: 'ninedeploy/web:abc1234-b1', imageId: `sha256:${'a'.repeat(64)}` },
      () => undefined,
      {
        openStream: (dbArg, id, kind, params) => openAgentStream(dbArg, id, kind, params, { socketFactory }),
        panelSave: () => ({ stream: (async function* () {})() as never, done: Promise.resolve(), kill: () => undefined }),
      },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 422, code: 'node_agent_outdated' });
    expect(h.ops).toEqual(['agent.ping']);
    expect(socketFactory).not.toHaveBeenCalled();
    expect(await db.select().from(imageTransfers)).toEqual([expect.objectContaining({ status: 'failed' })]);
  });

  it('a build server on an older agent: refused before anything is cloned or built on it', async () => {
    const { buildElsewhere } = await import('../src/engine/buildPlacement.js');
    await db.update(servers).set({ isBuildServer: true });
    const svc = await t4Service({ serverId: null, buildOn: 'server', buildServerId: serverId });
    const buildOnNode = vi.fn();
    const err = await buildElsewhere(db, { kind: 'server', serverId }, {
      deploymentId: 1, service: svc, workDir: '/nonexistent', commitSha: 'abc1234', env: {}, log: () => undefined,
    } as never, { deps: { buildOnNode } }).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 422, code: 'node_agent_outdated', message: expect.stringMatching(/cannot hand a built image over as a build server/) });
    expect(buildOnNode).not.toHaveBeenCalled();
    expect(h.ops).toEqual(['agent.ping']);
  });
});
// ── end 0.16 T4 ──
// ── 0.16 T5 node volumes ── (attachments / cmd / socket, volume create)
describe('T5 node volumes against a 0.15 agent (CAPS_015)', () => {
  it('attachments, a command or the socket on a node docker service: 422, only agent.ping, nothing written', async () => {
    const { assertRemoteVolumeSupported, remoteVolumeRefusal } = await import('../src/lib/remoteVolumes.js');
    const { serviceVolumeAttachments } = await import('@ninedeploy/db');
    const [svc] = await db.insert(services).values({ name: 'minio', slug: 'minio', type: 'docker', serverId }).returning();
    await db.insert(serviceVolumeAttachments).values({ serviceId: svc!.id, volumeName: 'nd-svc-minio-cache', containerPath: '/cache' });
    for (const shape of [{}, { cmd: ['server', '/data'] }, { dockerSocket: true }]) {
      h.ops = [];
      const err = await assertRemoteVolumeSupported(db, { ...svc!, ...shape }).catch((e: unknown) => e);
      expect(err).toMatchObject({
        statusCode: 422,
        code: 'node_agent_outdated',
        message: expect.stringMatching(/cannot run a service with volume attachments, a command or the Docker socket\. Update the node agent to v0\.15\.2 or newer/),
      });
      expect(h.ops).toEqual(['agent.ping']);
    }
    expect((await db.select().from(serviceVolumeAttachments)).length).toBe(1);
    // The baseline: the same service with nothing new needed asks the node nothing.
    await db.delete(serviceVolumeAttachments);
    h.ops = [];
    expect(await remoteVolumeRefusal(db, svc!)).toBeNull();
    expect(h.ops).toEqual([]);
  });

  it('POST /v1/volumes on the node: 422 node_agent_outdated, only agent.ping, no volume created', async () => {
    const { volumeRoutes } = await import('../src/modules/volumes.js');
    const app = await buildTestApp({ db });
    await app.register(volumeRoutes, { prefix: '/volumes' });
    const res = await app.inject({ method: 'POST', url: '/volumes', headers: asUser(), payload: { name: 'nd-svc-cache', serverId } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: 'node_agent_outdated', message: expect.stringMatching(/cannot create node volumes\. Update the node agent to v0\.15\.2/) });
    expect(h.ops).toEqual(['agent.ping']);
    // Listing a node's volumes is refused the same way.
    h.ops = [];
    expect((await app.inject({ method: 'GET', url: `/volumes?serverId=${serverId}`, headers: asUser() })).json().error.code).toBe('node_agent_outdated');
    expect(h.ops).toEqual(['agent.ping']);
    await app.close();
  });
});
// ── end 0.16 T5 ──
// ── 0.16 T6 node databases ── (node database create)
describe('T6 node databases against a 0.15 agent (CAPS_015)', () => {
  it('POST /v1/databases with serverId: 422 node_agent_outdated naming v0.15.3, only agent.ping, no row, nothing on the node', async () => {
    const { databasesRoutes } = await import('../src/modules/databases.js');
    const { databases } = await import('@ninedeploy/db');
    const app = await buildTestApp({ db });
    await app.register(databasesRoutes, { prefix: '/databases' });
    const res = await app.inject({ method: 'POST', url: '/databases', headers: asUser(), payload: { name: 'orders', engine: 'postgres', serverId } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({
      code: 'node_agent_outdated',
      message: expect.stringMatching(/\(version 0\.15\.1\) cannot host a managed database\. Update the node agent to v0\.15\.3 or newer/),
    });
    expect(h.ops).toEqual(['agent.ping']);
    expect(await db.select().from(databases)).toHaveLength(0);
    // A 0.15.2 agent (multi-node, but before db.manage) is "update", never "switched off by the owner".
    h.ops = [];
    caps.resetNodeCapabilityCache();
    h.ping = pingLine('0.15.2', [...CAPS_015_LIST, 'stream', 'docker.runSpec', 'volume.manage', 'image.manage']);
    const older = await app.inject({ method: 'POST', url: '/databases', headers: asUser(), payload: { name: 'orders', engine: 'postgres', serverId } });
    expect([older.statusCode, older.json().error.code]).toEqual([422, 'node_agent_outdated']);
    expect(h.ops).toEqual(['agent.ping']);
    await app.close();
  });

  it('a DB-backed template on a node keeps the r269 refusal with the update hint added', async () => {
    const { remoteDatabaseRefusal } = await import('../src/lib/remoteDeploy.js');
    const [svc] = await db.insert(services).values({ name: 'ghost', slug: 'ghost', type: 'docker', image: 'ghost:5', serverId, templateDatabaseEnv: { database__connection__host: 'host' } } as never).returning();
    expect(await remoteDatabaseRefusal(db, svc!)).toMatch(
      /^Deployments to a remote server are not available for this service: its template provisions a managed database, which runs on the panel host.*cannot host a managed database\. Update the node agent to v0\.15\.3/,
    );
    expect(h.ops).toEqual(['agent.ping']);
  });
});
// ── end 0.16 T6 ──
// ── 0.16 T7 swarm ── (swarm join)
describe('T7 Swarm against a 0.15 agent (CAPS_015)', () => {
  it('POST /v1/servers/:id/swarm/join and /leave: 422 node_agent_outdated naming v0.15.4, only agent.ping, nothing recorded, the panel host asked nothing', async () => {
    const { serverSwarmRoutes } = await import('../src/modules/swarm.js');
    const app = await buildTestApp({ db });
    await app.register(serverSwarmRoutes, { prefix: '/servers' });
    const join = await app.inject({ method: 'POST', url: `/servers/${serverId}/swarm/join`, headers: asUser() });
    expect(join.statusCode).toBe(422);
    expect(join.json().error).toMatchObject({
      code: 'node_agent_outdated',
      message: expect.stringMatching(/\(version 0\.15\.1\) cannot join the Swarm\. Update the node agent to v0\.15\.4 or newer/),
    });
    expect(h.ops).toEqual(['agent.ping']);
    expect(await db.query.servers.findFirst()).toMatchObject({ swarmNodeId: null, swarmRole: null });
    // A 0.15.3 agent (node databases, but before `swarm`) is "update", never "switched off by the owner".
    h.ops = [];
    caps.resetNodeCapabilityCache();
    h.ping = pingLine('0.15.3', [...CAPS_015_LIST, 'stream', 'docker.runSpec', 'volume.manage', 'image.manage', 'db.manage']);
    const older = await app.inject({ method: 'POST', url: `/servers/${serverId}/swarm/join`, headers: asUser() });
    expect([older.statusCode, older.json().error.code]).toEqual([422, 'node_agent_outdated']);
    expect(h.ops).toEqual(['agent.ping']);
    // Leave, for a node recorded as a member: refused before anything is drained.
    await db.update(servers).set({ swarmNodeId: 'wrk1', swarmRole: 'worker' });
    h.ops = [];
    h.ping = CAPS_015;
    const leave = await app.inject({ method: 'POST', url: `/servers/${serverId}/swarm/leave`, headers: asUser() });
    expect([leave.statusCode, leave.json().error.code]).toEqual([422, 'node_agent_outdated']);
    expect(h.ops).toEqual(['agent.ping']);
    expect(await db.query.servers.findFirst()).toMatchObject({ swarmNodeId: 'wrk1' });
    await app.close();
  });
});
// ── end 0.16 T7 ──
