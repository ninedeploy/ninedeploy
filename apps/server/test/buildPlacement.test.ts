import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, imageTransfers, runMigrations, servers, services, sources, users } from '@ninedeploy/db';
import { MULTI_NODE_CAPABILITIES } from '@ninedeploy/schemas';

/**
 * 0.16 T4 — build placement and image transfer (design §6). Real migrated
 * SQLite; the agent, the stream channel and Docker are fakes (nothing here
 * reaches a daemon or the network).
 */

const h = vi.hoisted(() => ({
  ping: '' as string,
  sealed: true,
  ops: [] as Array<{ server: number; op: string; params: Record<string, unknown> }>,
  reply: null as null | ((server: number, op: string, params: Record<string, unknown>) => { exitCode: number; lines: string[] } | undefined),
}));
vi.mock('../src/lib/agentClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/agentClient.js')>()),
  agentTransportSealed: async () => h.sealed,
  agentOp: async (_db: unknown, server: number, op: string, params: Record<string, unknown>, sink?: (l: string) => void) => {
    h.ops.push({ server, op, params });
    if (op === 'agent.ping') return { exitCode: 0, lines: h.ping ? [h.ping] : [] };
    const r = h.reply?.(server, op, params);
    if (r) {
      for (const l of r.lines) sink?.(l);
      return r;
    }
    return { exitCode: 0, lines: [] };
  },
}));
const auditMock = vi.hoisted(() => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../src/lib/audit.js', () => auditMock);

const caps = await import('../src/lib/agentCapabilities.js');
const { resolveBuildPlacement, BUILD_SERVER_REMOVED, railpackBuildsOnCapableNode, primaryBuildPack } = await import('../src/engine/buildPlacement.js');
const { createBuildSlots, buildSlotKey } = await import('../src/engine/buildSlots.js');
const { shipImageByStream, resolvePushTarget, pushImage, pullImageByDigest, buildTag } = await import('../src/lib/imageTransfer.js');
const { HttpError } = await import('../src/lib/errors.js');
const { encrypt } = await import('../src/lib/crypto.js');
const { setBoundRegistryHosts } = await import('../src/lib/registryBinding.js');
const { servicePlacementRoutes } = await import('../src/modules/servicePlacement.js');
const { serverRolesRoutes } = await import('../src/modules/serverRoles.js');
const { imageTransferRoutes, deploymentTransferRoutes } = await import('../src/modules/imageTransfers.js');
const { asUser, buildTestApp } = await import('./helpers.js');

const pingLine = (version: string, list: readonly string[]) => `ND-AGENT ${JSON.stringify({ version, caps: list })}`;
const CAPS_015_LIST = ['build-path-guard', 'workspace.remove', 'git.credential', 'terminal', 'terminal.host'];
const CAPS_015 = pingLine('0.15.1', CAPS_015_LIST);
const CAPS_ALL = pingLine('0.15.2', [...CAPS_015_LIST, ...MULTI_NODE_CAPABILITIES]);
const IMG = `sha256:${'a'.repeat(64)}`;
const OTHER = `sha256:${'b'.repeat(64)}`;

let db: DB;
let node: number;
let builder: number;

beforeEach(async () => {
  h.ping = CAPS_ALL;
  h.sealed = true;
  h.ops = [];
  h.reply = null;
  auditMock.audit.mockClear();
  caps.resetNodeCapabilityCache();
  ({ db } = createDb({ url: ':memory:' }));
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  await db.insert(users).values([1, 7, 99].map((id) => ({ id, email: `u${id}@example.com`, passwordHash: 'x', isInstanceOperator: id === 1 })));
  node = (await db.insert(servers).values({ name: 'edge-1', host: '10.0.0.5', port: 4600, tokenEncrypted: encrypt('t'), status: 'online' }).returning())[0]!.id;
  builder = (await db
    .insert(servers)
    .values({ name: 'builder', host: '10.0.0.6', port: 4600, tokenEncrypted: encrypt('t'), status: 'online', isBuildServer: true, buildConcurrency: 2 })
    .returning())[0]!.id;
});

async function service(values: Record<string, unknown> = {}) {
  const [svc] = await db
    .insert(services)
    .values({ name: 'web', slug: 'web', type: 'docker', repoUrl: 'https://github.com/acme/web.git', branch: 'main', ownerUserId: 7, ...values } as never)
    .returning();
  return svc!;
}

describe('placement resolution (design §6.8 table)', () => {
  it('NULL build_on is `target` for a panel or node service — without a database read (upgrade-safe default)', async () => {
    expect(await resolveBuildPlacement({} as never, { id: 1, serverId: null })).toEqual({ kind: 'target' });
    expect(await resolveBuildPlacement({} as never, { id: 1, serverId: 4, buildOn: null })).toEqual({ kind: 'target' });
    expect(await resolveBuildPlacement({} as never, { id: 1, serverId: 4, buildOn: 'target' })).toEqual({ kind: 'target' });
  });

  it('panel: a node service builds on the panel; a panel service just builds where it runs', async () => {
    expect(await resolveBuildPlacement(db, { id: 1, serverId: node, buildOn: 'panel' })).toEqual({ kind: 'panel' });
    expect(await resolveBuildPlacement(db, { id: 1, serverId: null, buildOn: 'panel' })).toEqual({ kind: 'target' });
  });

  it('server: builds on the build server, for a node or a panel-host service; its own node is `target`', async () => {
    expect(await resolveBuildPlacement(db, { id: 1, serverId: node, buildOn: 'server', buildServerId: builder })).toEqual({ kind: 'server', serverId: builder });
    expect(await resolveBuildPlacement(db, { id: 1, serverId: null, buildOn: 'server', buildServerId: builder })).toEqual({ kind: 'server', serverId: builder });
    expect(await resolveBuildPlacement(db, { id: 1, serverId: builder, buildOn: 'server', buildServerId: builder })).toEqual({ kind: 'target' });
  });

  it('server deleted (NULL build_server_id, or the row is gone) or no longer a build server: refused, never a fallback', async () => {
    await expect(resolveBuildPlacement(db, { id: 1, serverId: node, buildOn: 'server', buildServerId: null })).rejects.toThrow(BUILD_SERVER_REMOVED);
    await expect(resolveBuildPlacement(db, { id: 1, serverId: node, buildOn: 'server', buildServerId: 999 })).rejects.toThrow(BUILD_SERVER_REMOVED);
    await db.update(servers).set({ isBuildServer: false }).where(eq(servers.id, builder));
    await expect(resolveBuildPlacement(db, { id: 1, serverId: node, buildOn: 'server', buildServerId: builder })).rejects.toThrow(/no longer a build server/);
  });

  it('the ON DELETE SET NULL of build_server_id is what a deleted build server leaves', async () => {
    const svc = await service({ serverId: node, buildOn: 'server', buildServerId: builder });
    await db.delete(servers).where(eq(servers.id, builder));
    const row = await db.query.services.findFirst({ where: eq(services.id, svc.id) });
    expect(row!.buildServerId).toBeNull();
    await expect(resolveBuildPlacement(db, row!)).rejects.toThrow(BUILD_SERVER_REMOVED);
  });

  it('D2 helper: only a Dockerfile primary can be rebuilt by a target', async () => {
    expect((await primaryBuildPack('/nonexistent', undefined)).pack).toBe('dockerfile');
    expect((await primaryBuildPack('/nonexistent', { buildPack: 'static' })).pack).toBe('static');
    expect((await primaryBuildPack('/nonexistent', { buildPack: 'railpack' })).pack).toBe('railpack');
    expect(await primaryBuildPack('/nonexistent', { buildPack: 'dockerfile', dockerfilePath: '/docker/App.Dockerfile', baseDir: '/app' })).toEqual({
      pack: 'dockerfile',
      dockerfile: 'docker/App.Dockerfile',
      context: 'app',
    });
  });

  it('the Railpack save check skips the panel BUILDKIT_HOST only for a node whose cached capabilities include build.railpack', async () => {
    expect(await railpackBuildsOnCapableNode(db, { serverId: null })).toBe(false);
    expect(await railpackBuildsOnCapableNode(db, { serverId: node })).toBe(false); // never reached: no cache
    await db.update(servers).set({ agentCaps: [...CAPS_015_LIST, 'build.railpack'], agentCheckedAt: new Date() }).where(eq(servers.id, node));
    expect(await railpackBuildsOnCapableNode(db, { serverId: node })).toBe(true);
    // Built on the panel: the panel's own check applies.
    expect(await railpackBuildsOnCapableNode(db, { serverId: node, buildOn: 'panel' })).toBe(false);
    // Built on a build server: that node's capabilities decide.
    expect(await railpackBuildsOnCapableNode(db, { serverId: null, buildOn: 'server', buildServerId: builder })).toBe(false);
    await db.update(servers).set({ agentCaps: ['build.railpack'] }).where(eq(servers.id, builder));
    expect(await railpackBuildsOnCapableNode(db, { serverId: null, buildOn: 'server', buildServerId: builder })).toBe(true);
  });
});

describe('build slots per build host (design §6.3 "Concurrency")', () => {
  it('a full host makes the next build wait (and say how many are ahead); a release lets it in', async () => {
    const slots = createBuildSlots(() => 1);
    const key = buildSlotKey(3);
    const first = await slots.acquire(key);
    const onWait = vi.fn();
    let second: (() => void) | null = null;
    const p = slots.acquire(key, onWait).then((r) => {
      second = r;
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(onWait).toHaveBeenCalledWith(1);
    expect(second).toBeNull();
    expect(slots.usage(key)).toEqual({ active: 1, waiting: 1 });
    // Another host is independent.
    const other = await slots.acquire(buildSlotKey(null));
    first();
    first(); // idempotent
    await p;
    expect(second).not.toBeNull();
    expect(slots.usage(key)).toEqual({ active: 1, waiting: 0 });
    other();
  });

  it('the capacity is read at every acquire (build_concurrency changes apply to the next build), clamped to 1–8', async () => {
    let cap = 2;
    const slots = createBuildSlots(() => cap);
    const key = buildSlotKey(1);
    await slots.acquire(key);
    await slots.acquire(key);
    expect(slots.usage(key).active).toBe(2);
    cap = 0; // clamped to 1
    const onWait = vi.fn();
    void slots.acquire(key, onWait);
    await new Promise((r) => setTimeout(r, 5));
    expect(onWait).toHaveBeenCalled();
    expect(buildSlotKey(null)).toBe('build:panel');
  });
});

// ── the stream relay ─────────────────────────────────────────────────────────

/** A fake `image.save` handle: the bytes, and the end frame the sender announced. */
function saveHandle(data: Buffer, end: { bytes?: number; sha256?: string; imageId?: string } = {}) {
  return {
    kind: 'image.save',
    direction: 'agent-to-panel' as const,
    readable: Readable.from([data]),
    done: Promise.resolve({ bytes: end.bytes ?? data.length, sha256: end.sha256 ?? 'sha-sent', result: { imageId: end.imageId ?? IMG } }),
    abort: vi.fn(),
  };
}
/** A fake `image.load` handle that collects what the panel sent. */
function loadHandle(end: { bytes?: number; sha256?: string; imageId?: string } = {}) {
  const got: Buffer[] = [];
  const writable = new Writable({
    write(chunk: Buffer, _e, cb) {
      got.push(chunk);
      cb();
    },
  });
  return {
    got,
    handle: {
      kind: 'image.load',
      direction: 'panel-to-agent' as const,
      writable,
      done: new Promise<{ bytes: number; sha256: string; result: Record<string, unknown> }>((resolve) =>
        writable.on('finish', () => resolve({ bytes: end.bytes ?? Buffer.concat(got).length, sha256: end.sha256 ?? 'sha-sent', result: { imageId: end.imageId ?? IMG } })),
      ),
      abort: vi.fn(),
    },
  };
}
const transferRows = () => db.select().from(imageTransfers);

describe('stream relay (design §6.3, §6.4)', () => {
  const spec = (svcId: number, over: Record<string, unknown> = {}) => ({
    deploymentId: null,
    serviceId: svcId,
    source: builder as number | null,
    target: node as number | null,
    tag: 'ninedeploy/web:abc1234-b7',
    imageId: IMG,
    ...over,
  });

  it('node → node: save piped into load, end-to-end sha256 checked, one completed row with bytes and sha256', async () => {
    const svc = await service();
    const payload = Buffer.from('gzip-archive-bytes');
    const load = loadHandle();
    const openStream = vi.fn(async (_db: unknown, id: number, kind: string, params: Record<string, unknown>) => {
      if (kind === 'image.save') {
        expect(id).toBe(builder);
        expect(params).toEqual({ image: IMG });
        return saveHandle(payload);
      }
      expect(id).toBe(node);
      expect(params).toEqual({ expectTag: 'ninedeploy/web:abc1234-b7', expectId: IMG });
      return load.handle;
    });
    const res = await shipImageByStream(db, spec(svc.id), () => undefined, { openStream: openStream as never });
    expect(res).toMatchObject({ method: 'stream', ref: 'ninedeploy/web:abc1234-b7', bytes: payload.length, sha256: 'sha-sent' });
    expect(Buffer.concat(load.got)).toEqual(payload);
    const [row] = await transferRows();
    expect(row).toMatchObject({ method: 'stream', status: 'completed', bytes: payload.length, sha256: 'sha-sent', sourceServerId: builder, targetServerId: node, imageId: IMG });
    expect(row!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('a sha256 mismatch between what the source sent and the target received fails (after one retry); the row is failed', async () => {
    const svc = await service();
    const openStream = vi.fn(async (_db: unknown, _id: number, kind: string) =>
      kind === 'image.save' ? saveHandle(Buffer.from('x'), { sha256: 'sent' }) : loadHandle({ sha256: 'received' }).handle,
    );
    const log = vi.fn();
    await expect(shipImageByStream(db, spec(svc.id), log, { openStream: openStream as never })).rejects.toThrow(/changed in transit/);
    expect(openStream).toHaveBeenCalledTimes(4); // two attempts × (save, load)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('retrying once on a fresh channel'));
    expect(await transferRows()).toEqual([expect.objectContaining({ status: 'failed', error: expect.stringMatching(/changed in transit/) })]);
  });

  it('an image id mismatch fails (the target removed what it loaded); a source that saved another id fails too', async () => {
    const svc = await service();
    const wrongLoad = vi.fn(async (_db: unknown, _id: number, kind: string) => (kind === 'image.save' ? saveHandle(Buffer.from('x')) : loadHandle({ imageId: OTHER }).handle));
    await expect(shipImageByStream(db, spec(svc.id), () => undefined, { openStream: wrongLoad as never })).rejects.toThrow(/loaded image sha256:b+, not sha256:a+/);
    const wrongSave = vi.fn(async (_db: unknown, _id: number, kind: string) => (kind === 'image.save' ? saveHandle(Buffer.from('x'), { imageId: OTHER }) : loadHandle().handle));
    await expect(shipImageByStream(db, spec(svc.id), () => undefined, { openStream: wrongSave as never })).rejects.toThrow(/saved image sha256:b+, not sha256:a+/);
  });

  it('retry once: a dropped channel is retried on a fresh one and the transfer completes', async () => {
    const svc = await service();
    let n = 0;
    const openStream = vi.fn(async (_db: unknown, _id: number, kind: string) => {
      if (kind === 'image.save' && n++ === 0) throw new Error('the stream connection to node "builder" failed');
      return kind === 'image.save' ? saveHandle(Buffer.from('ok')) : loadHandle().handle;
    });
    await expect(shipImageByStream(db, spec(svc.id), () => undefined, { openStream: openStream as never })).resolves.toMatchObject({ bytes: 2 });
    expect(await transferRows()).toEqual([expect.objectContaining({ status: 'completed' })]);
  });

  it('an older agent (422 node_agent_outdated) is refused once — no retry, nothing sent, the row is failed', async () => {
    const svc = await service();
    const openStream = vi.fn(async () => {
      throw new HttpError(422, 'node_agent_outdated', 'The agent on node "edge-1" (version 0.15.1) cannot receive an image. Update the node agent to v0.15.2 or newer');
    });
    await expect(shipImageByStream(db, spec(svc.id, { source: null }), () => undefined, {
      openStream: openStream as never,
      panelSave: () => ({ stream: Readable.from([Buffer.from('x')]), done: Promise.resolve(), kill: vi.fn() }),
    })).rejects.toMatchObject({ statusCode: 422, code: 'node_agent_outdated' });
    expect(openStream).toHaveBeenCalledTimes(1);
    expect(await transferRows()).toEqual([expect.objectContaining({ status: 'failed', error: expect.stringMatching(/cannot receive an image/) })]);
  });

  it('panel → node: the panel saves by id and streams it to the node', async () => {
    const svc = await service();
    const load = loadHandle();
    const panelSave = vi.fn((id: string) => {
      expect(id).toBe(IMG);
      return { stream: Readable.from([Buffer.from('panel-archive')]), done: Promise.resolve(), kill: vi.fn() };
    });
    await shipImageByStream(db, spec(svc.id, { source: null }), () => undefined, { openStream: (async () => load.handle) as never, panelSave });
    expect(Buffer.concat(load.got).toString()).toBe('panel-archive');
    expect(await transferRows()).toEqual([expect.objectContaining({ status: 'completed', sourceServerId: null, targetServerId: node })]);
  });

  it('node → panel: buffered gunzipped on the panel, then the verified local load (tag checks, id check)', async () => {
    const svc = await service();
    const panelLoad = vi.fn(async (_file: string, _tag: string, _id: string) => undefined);
    await shipImageByStream(db, spec(svc.id, { target: null }), () => undefined, {
      openStream: (async () => saveHandle(gzipSync(Buffer.from('tar')))) as never,
      panelLoad,
    });
    expect(panelLoad).toHaveBeenCalledWith(expect.stringMatching(/transfers[\\/][0-9a-f]{32}\.tar$/), 'ninedeploy/web:abc1234-b7', IMG, expect.any(Function));
    // A failed verification fails the transfer (nothing is tagged).
    panelLoad.mockRejectedValue(new Error('Refusing the image archive: it carries the tag "traefik:v3.1"'));
    await expect(
      shipImageByStream(db, spec(svc.id, { target: null }), () => undefined, { openStream: (async () => saveHandle(gzipSync(Buffer.from('tar')))) as never, panelLoad }),
    ).rejects.toThrow(/traefik/);
  });

  it('the build tag is per deployment, so concurrent targets never race on a tag', () => {
    expect(buildTag('web', 'abc1234def', 7)).toBe('ninedeploy/web:abc1234-b7');
    expect(buildTag('web', '', 7)).toBe('ninedeploy/web:latest-b7');
  });
});

// ── registry ─────────────────────────────────────────────────────────────────

describe('registry push / pull (opt-in, design §6.3)', () => {
  async function registrySource(hosts: string[], values: Record<string, unknown> = {}) {
    const [src] = await db
      .insert(sources)
      .values({ type: 'registry', name: 'ghcr-ci', registryUsername: 'ci', tokenEncrypted: encrypt('s3cret-token'), ...values } as never)
      .returning();
    await setBoundRegistryHosts(db, src!.id, hosts);
    return src!.id;
  }

  it('resolves the bound host; refuses a removed credential, a non-registry source or an ambiguous binding (deploy-time re-check)', async () => {
    expect(await resolvePushTarget(db, { pushRegistrySourceId: null, pushRepository: null })).toBeNull();
    const id = await registrySource(['ghcr.io']);
    expect(await resolvePushTarget(db, { pushRegistrySourceId: id, pushRepository: 'acme/web' })).toMatchObject({
      repository: 'ghcr.io/acme/web',
      host: 'ghcr.io',
      server: 'ghcr.io',
      username: 'ci',
    });
    // The source was deleted (ON DELETE SET NULL): fail, never a silent relay.
    await expect(resolvePushTarget(db, { pushRegistrySourceId: null, pushRepository: 'acme/web' })).rejects.toThrow(/push registry of this service was removed/);
    const git = (await db.insert(sources).values({ type: 'github', name: 'gh', tokenEncrypted: encrypt('ghp') } as never).returning())[0]!.id;
    await expect(resolvePushTarget(db, { pushRegistrySourceId: git, pushRepository: 'acme/web' })).rejects.toThrow(/not a registry credential/);
    const two = await registrySource(['ghcr.io', 'docker.io'], { name: 'two' });
    await expect(resolvePushTarget(db, { pushRegistrySourceId: two, pushRepository: 'acme/web' })).rejects.toThrow(/needs exactly one/);
    const hub = await registrySource(['docker.io'], { name: 'hub' });
    expect(await resolvePushTarget(db, { pushRegistrySourceId: hub, pushRepository: 'acme/web' })).toMatchObject({ repository: 'docker.io/acme/web', server: undefined });
  });

  it('a build node tags and pushes under login, reads the digest, logs out — and never logs the credential', async () => {
    const id = await registrySource(['ghcr.io']);
    const target = (await resolvePushTarget(db, { pushRegistrySourceId: id, pushRepository: 'acme/web' }))!;
    const digest = `sha256:${'c'.repeat(64)}`;
    h.reply = (_s, op) => (op === 'docker.push' ? { exitCode: 0, lines: [`abc1234-b7: digest: ${digest} size: 1234`] } : undefined);
    const lines: string[] = [];
    const res = await pushImage(db, builder, { tag: 'ninedeploy/web:abc1234-b7', target }, (l) => lines.push(l));
    expect(res).toEqual({ digest, pushedRef: 'ghcr.io/acme/web:abc1234-b7' });
    expect(h.ops.filter((o) => o.server === builder).map((o) => o.op)).toEqual(['agent.ping', 'docker.login', 'docker.tag', 'docker.push', 'docker.logout']);
    expect(h.ops.find((o) => o.op === 'docker.tag')!.params).toEqual({ source: 'ninedeploy/web:abc1234-b7', target: 'ghcr.io/acme/web:abc1234-b7' });
    expect(lines.join('\n')).not.toContain('s3cret-token');
  });

  it('an older build node is refused with the update message before any login', async () => {
    const id = await registrySource(['ghcr.io']);
    const target = (await resolvePushTarget(db, { pushRegistrySourceId: id, pushRepository: 'acme/web' }))!;
    h.ping = CAPS_015;
    await expect(pushImage(db, builder, { tag: 'ninedeploy/web:x', target }, () => undefined)).rejects.toMatchObject({ statusCode: 422, code: 'node_agent_outdated' });
    expect(h.ops.map((o) => o.op)).toEqual(['agent.ping']);
  });

  it('a target pulls by digest and must end up with the build image id, else it is removed and the row failed', async () => {
    const svc = await service();
    const id = await registrySource(['ghcr.io']);
    const target = (await resolvePushTarget(db, { pushRegistrySourceId: id, pushRepository: 'acme/web' }))!;
    const digest = `sha256:${'c'.repeat(64)}`;
    h.reply = (_s, op) => (op === 'docker.imageInspect' ? { exitCode: 0, lines: [`${IMG}|1000`] } : undefined);
    const spec = { deploymentId: null, serviceId: svc.id, source: builder, target: node, imageId: IMG, repository: target.repository, digest };
    await expect(pullImageByDigest(db, spec, target, () => undefined)).resolves.toMatchObject({ method: 'registry', ref: `ghcr.io/acme/web@${digest}` });
    expect(h.ops.find((o) => o.op === 'docker.pull')!.params).toEqual({ image: `ghcr.io/acme/web@${digest}` });
    h.reply = (_s, op) => (op === 'docker.imageInspect' ? { exitCode: 0, lines: [`${OTHER}|1000`] } : undefined);
    await expect(pullImageByDigest(db, spec, target, () => undefined)).rejects.toThrow(/not sha256:a+; it was removed/);
    expect(h.ops.some((o) => o.op === 'docker.imageRm')).toBe(true);
    expect((await transferRows()).map((r) => r.status)).toEqual(['completed', 'failed']);
  });
});

// ── routes ───────────────────────────────────────────────────────────────────

async function appWith() {
  const app = await buildTestApp({ db });
  await app.register(servicePlacementRoutes, { prefix: '/services' });
  await app.register(imageTransferRoutes, { prefix: '/services' });
  await app.register(serverRolesRoutes, { prefix: '/servers' });
  await app.register(deploymentTransferRoutes, { prefix: '/deployments' });
  return app;
}
const MEMBER = asUser({ id: 7, isOperator: false });

describe('GET/PUT /v1/services/:id/placement', () => {
  it('GET answers the 0.15 defaults (all null) to anyone who can see the service', async () => {
    const app = await appWith();
    const svc = await service();
    const res = await app.inject({ method: 'GET', url: `/services/${svc.id}/placement`, headers: MEMBER });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ buildOn: null, buildServerId: null, pushRegistrySourceId: null, pushRepository: null, orchestrator: null });
    await app.close();
  });

  it('PUT is operator-only: a member (even the owner) gets 403 and nothing is stored', async () => {
    const app = await appWith();
    const svc = await service({ serverId: node });
    const res = await app.inject({ method: 'PUT', url: `/services/${svc.id}/placement`, headers: MEMBER, payload: { buildOn: 'panel' } });
    expect(res.statusCode).toBe(403);
    expect((await db.query.services.findFirst())!.buildOn).toBeNull();
    await app.close();
  });

  it('PUT build_on = panel for a node service: checks the node can receive an image, stores it, audits the previous values', async () => {
    const app = await appWith();
    const svc = await service({ serverId: node });
    const res = await app.inject({ method: 'PUT', url: `/services/${svc.id}/placement`, headers: asUser(), payload: { buildOn: 'panel' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ buildOn: 'panel', buildServerId: null });
    expect((await db.query.services.findFirst())!.buildOn).toBe('panel');
    expect(auditMock.audit).toHaveBeenCalledWith(expect.anything(), 1, 'service.placement.update', 'web', expect.objectContaining({ previous: expect.objectContaining({ buildOn: null }), next: expect.objectContaining({ buildOn: 'panel' }) }));
    // null restores the default.
    expect((await app.inject({ method: 'PUT', url: `/services/${svc.id}/placement`, headers: asUser(), payload: { buildOn: null } })).json().buildOn).toBeNull();
    await app.close();
  });

  it('an older agent: 422 node_agent_outdated, only agent.ping asked, nothing stored', async () => {
    const app = await appWith();
    const svc = await service({ serverId: node });
    h.ping = CAPS_015;
    const res = await app.inject({ method: 'PUT', url: `/services/${svc.id}/placement`, headers: asUser(), payload: { buildOn: 'panel' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: 'node_agent_outdated', message: expect.stringMatching(/cannot receive an image\. Update the node agent to v0\.15\.2/) });
    expect(h.ops.map((o) => o.op)).toEqual(['agent.ping']);
    expect((await db.query.services.findFirst())!.buildOn).toBeNull();
    await app.close();
  });

  it('build_on = server needs a build server; a compose stack, a swarm orchestrator, half a registry are refused', async () => {
    const app = await appWith();
    const svc = await service({ serverId: node });
    const put = (payload: unknown, id = svc.id) => app.inject({ method: 'PUT', url: `/services/${id}/placement`, headers: asUser(), payload: payload as never });
    expect((await put({ buildOn: 'server' })).statusCode).toBe(400);
    expect((await put({ buildOn: 'server', buildServerId: node })).json().error.message).toMatch(/not a build server/);
    expect((await put({ buildOn: 'server', buildServerId: 999 })).statusCode).toBe(404);
    expect((await put({ buildOn: 'server', buildServerId: builder })).statusCode).toBe(200);
    expect((await put({ pushRepository: 'acme/web' })).json().error.message).toMatch(/needs both/);
    expect((await put({ orchestrator: 'swarm' })).statusCode).toBe(422);
    expect((await put({ buildOn: 'bogus' })).statusCode).toBe(400);
    const stack = await service({ name: 'stack', slug: 'stack', type: 'compose', composeContent: 'services: {}' });
    expect((await put({ buildOn: 'panel' }, stack.id)).json().error.code).toBe('placement_unsupported');
    await app.close();
  });

  it('push registry (security review): only an existing registry credential, operator-only; anything else 404/400 and nothing stored', async () => {
    const app = await appWith();
    const svc = await service({ serverId: node });
    const reg = (await db.insert(sources).values({ type: 'registry', name: 'ghcr', registryUsername: 'ci', tokenEncrypted: encrypt('x') } as never).returning())[0]!.id;
    const git = (await db.insert(sources).values({ type: 'github', name: 'gh', tokenEncrypted: encrypt('ghp') } as never).returning())[0]!.id;
    const put = (headers: Record<string, string>, pushRegistrySourceId: number) =>
      app.inject({ method: 'PUT', url: `/services/${svc.id}/placement`, headers, payload: { pushRegistrySourceId, pushRepository: 'acme/web' } });
    // A non-operator (the service's own admin) can never point it at a credential.
    expect((await put(MEMBER, reg)).statusCode).toBe(403);
    // A source id that does not exist: 404.
    expect((await put(asUser(), 99999)).statusCode).toBe(404);
    // Not a registry credential: 400 after the lookup.
    expect((await put(asUser(), git)).statusCode).toBe(400);
    expect((await db.query.services.findFirst())!.pushRegistrySourceId).toBeNull();
    // An operator with a registry credential: stored.
    const ok = await put(asUser(), reg);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ pushRegistrySourceId: reg, pushRepository: 'acme/web' });
    await app.close();
  });
});

describe('PATCH /v1/servers/:id (build-server role)', () => {
  it('operator-only; partial; 1–8; audited with the previous values; names the services that build there', async () => {
    const app = await appWith();
    const svc = await service({ buildOn: 'server', buildServerId: builder });
    const patch = (headers: Record<string, string>, payload: unknown, id = node) => app.inject({ method: 'PATCH', url: `/servers/${id}`, headers, payload: payload as never });
    expect((await patch(MEMBER, { isBuildServer: true })).statusCode).toBe(403);
    expect((await patch(asUser(), { buildConcurrency: 9 })).statusCode).toBe(400);
    expect((await patch(asUser(), { buildConcurrency: 0 })).statusCode).toBe(400);
    expect((await patch(asUser(), { isBuildServer: true }, 999)).statusCode).toBe(404);
    const res = await patch(asUser(), { isBuildServer: true });
    expect(res.json()).toEqual({ id: node, name: 'edge-1', isBuildServer: true, buildConcurrency: 1, buildServiceIds: [] });
    expect((await patch(asUser(), { buildConcurrency: 4 }, builder)).json()).toMatchObject({ isBuildServer: true, buildConcurrency: 4, buildServiceIds: [svc.id] });
    expect(auditMock.audit).toHaveBeenCalledWith(expect.anything(), 1, 'server.roles.update', 'builder', expect.objectContaining({ previous: { isBuildServer: true, buildConcurrency: 2 }, next: { isBuildServer: true, buildConcurrency: 4 } }));
    await app.close();
  });
});

describe('image transfer history routes', () => {
  it('per service (limit) and per deployment; viewer-visible; another tenant’s deployment is 404', async () => {
    const app = await appWith();
    const svc = await service();
    const { deployments } = await import('@ninedeploy/db');
    const [dep] = await db.insert(deployments).values({ serviceId: svc.id }).returning();
    for (let i = 0; i < 3; i++) {
      await db.insert(imageTransfers).values({ serviceId: svc.id, deploymentId: dep!.id, method: 'stream', imageRef: `ninedeploy/web:x-b${i}`, status: 'completed', bytes: 10 });
    }
    const list = await app.inject({ method: 'GET', url: `/services/${svc.id}/image-transfers?limit=2`, headers: MEMBER });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(2);
    expect(list.json()[0]).toMatchObject({ imageRef: 'ninedeploy/web:x-b2', method: 'stream', status: 'completed', bytes: 10, sourceServerId: null });
    expect((await app.inject({ method: 'GET', url: `/services/${svc.id}/image-transfers?limit=101`, headers: MEMBER })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/deployments/${dep!.id}/image-transfers`, headers: MEMBER })).json()).toHaveLength(3);
    const stranger = asUser({ id: 99, isOperator: false });
    expect((await app.inject({ method: 'GET', url: `/deployments/${dep!.id}/image-transfers`, headers: stranger })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/services/${svc.id}/image-transfers`, headers: stranger })).statusCode).toBe(404);
    await app.close();
  });
});

describe('buildElsewhere / retention (design §6.3 steps 1, 2, 6)', () => {
  const ctxFor = (svc: Record<string, unknown>, over: Record<string, unknown> = {}) =>
    ({ deploymentId: 7, service: svc, workDir: '/nonexistent', commitSha: 'abc1234def', env: {}, log: vi.fn(), ...over }) as never;

  it('panel: the panel builder builds the per-deployment tag; its id and size are read back', async () => {
    const { buildElsewhere } = await import('../src/engine/buildPlacement.js');
    const svc = await service({ serverId: node, buildOn: 'panel' });
    const buildOnPanel = vi.fn(async () => ({ builtWithNixpacks: true, builtStatic: false }));
    const panelImageInfo = vi.fn(async () => ({ id: IMG, size: 4096 }));
    const built = await buildElsewhere(db, { kind: 'panel' }, ctxFor(svc), { deps: { buildOnPanel, panelImageInfo } });
    expect(buildOnPanel.mock.calls[0]![1]).toBe('ninedeploy/web:abc1234-b7');
    expect(built).toEqual({ buildHost: null, tag: 'ninedeploy/web:abc1234-b7', imageId: IMG, sizeBytes: 4096, builtWithNixpacks: true, builtStatic: false });
    expect(h.ops).toEqual([]);
  });

  it('server: the static pack is refused on a build server; a current one builds there with the node rules and reports the image id', async () => {
    const { buildElsewhere } = await import('../src/engine/buildPlacement.js');
    const svc = await service({ serverId: null, buildOn: 'server', buildServerId: builder });
    const buildOnNode = vi.fn(async (_a: unknown, ctx: { service: { serverId: number } }) => {
      expect(ctx.service.serverId).toBe(builder); // the §2/§3 rules apply to the BUILD node
      return { target: 'ninedeploy/web:abc1234-b7', builtWithNixpacks: false };
    });
    await expect(buildElsewhere(db, { kind: 'server', serverId: builder }, ctxFor(svc, { buildConfig: { buildPack: 'static' } }), { deps: { buildOnNode } })).rejects.toThrow(/static build pack/);
    expect(buildOnNode).not.toHaveBeenCalled();
    h.reply = (_s, op) => (op === 'docker.imageInspect' ? { exitCode: 0, lines: [`${IMG}|2048`] } : undefined);
    const built = await buildElsewhere(db, { kind: 'server', serverId: builder }, ctxFor(svc), { deps: { buildOnNode } });
    expect(built).toMatchObject({ buildHost: builder, imageId: IMG, sizeBytes: 2048 });
  });

  it('an image service or a compose stack never builds elsewhere', async () => {
    const { buildElsewhere, BuildPlacementError } = await import('../src/engine/buildPlacement.js');
    const img = await service({ image: 'nginx:1.27', repoUrl: null });
    await expect(buildElsewhere(db, { kind: 'panel' }, ctxFor(img))).rejects.toBeInstanceOf(BuildPlacementError);
  });

  it('a full build host makes the next build wait and says so in the deploy log', async () => {
    const { buildElsewhere } = await import('../src/engine/buildPlacement.js');
    const svc = await service({ serverId: node, buildOn: 'panel' });
    const slots = createBuildSlots(() => 1);
    const hold = await slots.acquire('build:panel');
    const log = vi.fn();
    const p = buildElsewhere(db, { kind: 'panel' }, ctxFor(svc, { log }), {
      slots,
      deps: { buildOnPanel: async () => ({ builtWithNixpacks: false, builtStatic: false }), panelImageInfo: async () => ({ id: IMG, size: 1 }) },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/waiting for the build slot on the panel host \(1 ahead\)/));
    hold();
    await expect(p).resolves.toMatchObject({ imageId: IMG });
    expect(slots.usage('build:panel')).toEqual({ active: 0, waiting: 0 });
  });

  // ── push registry vs secrets baked into the image config ──
  // Nixpacks has no env-file option: the service env travels as `--env K=V` and
  // Nixpacks bakes it into the image config as ENV. A registry push would hand
  // those values to everyone with pull access, so the push path refuses it
  // BEFORE anything is built. Every other combination is untouched.
  describe('a Nixpacks build pushed to a registry never carries secrets', () => {
    const DIGEST = `sha256:${'c'.repeat(64)}`;
    async function pushService(values: Record<string, unknown> = {}) {
      const [reg] = await db
        .insert(sources)
        .values({ type: 'registry', name: 'ghcr-ci', registryUsername: 'ci', tokenEncrypted: encrypt('s3cret-token') } as never)
        .returning();
      await setBoundRegistryHosts(db, reg!.id, ['ghcr.io']);
      return service({ serverId: node, buildOn: 'server', buildServerId: builder, pushRegistrySourceId: reg!.id, pushRepository: 'acme/web', ...values });
    }
    const replyOk = () => {
      h.reply = (_s, op) => {
        if (op === 'docker.imageInspect') return { exitCode: 0, lines: [`${IMG}|2048`] };
        if (op === 'docker.push') return { exitCode: 0, lines: [`latest: digest: ${DIGEST} size: 1234`] };
        return undefined;
      };
    };
    const ctxWith = (svc: Record<string, unknown>, over: Record<string, unknown>) =>
      ({ deploymentId: 7, service: svc, workDir: '/nonexistent', commitSha: 'abc1234def', env: { DATABASE_URL: 'postgres://u:pw@db/x', PUBLIC_URL: 'https://x' }, log: vi.fn(), ...over }) as never;

    it('refuses push + Nixpacks + a secret-flagged variable before any build, login or push', async () => {
      const { buildElsewhere, BuildPlacementError } = await import('../src/engine/buildPlacement.js');
      const svc = await pushService();
      const buildOnNode = vi.fn(async () => ({ target: 'x', builtWithNixpacks: true }));
      const err = await buildElsewhere(db, { kind: 'server', serverId: builder }, ctxWith(svc, { buildConfig: { buildPack: 'nixpacks' }, buildSecretKeys: ['DATABASE_URL'] }), { deps: { buildOnNode } }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BuildPlacementError);
      expect((err as Error).message).toMatch(/DATABASE_URL/);
      expect((err as Error).message).toMatch(/registry/i);
      expect((err as Error).message).not.toContain('postgres://');
      expect(buildOnNode).not.toHaveBeenCalled();
      expect(h.ops.filter((o) => o.op === 'docker.login' || o.op === 'docker.push' || o.op === 'docker.build')).toEqual([]);
    });

    it('names every secret key it found, and offers the ways out', async () => {
      const { buildElsewhere } = await import('../src/engine/buildPlacement.js');
      const svc = await pushService();
      const err = await buildElsewhere(db, { kind: 'server', serverId: builder }, ctxWith(svc, { env: { A: '1', B: '2', C: '3' }, buildConfig: { buildPack: 'nixpacks' }, buildSecretKeys: ['A', 'B'] }), { deps: { buildOnNode: vi.fn() } }).catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/A, B/);
      expect((err as Error).message).toMatch(/Dockerfile or Railpack/);
      expect((err as Error).message).toMatch(/stream relay/);
    });

    it('control: Dockerfile, Railpack, no secret keys, or no push registry all build as before', async () => {
      const { buildElsewhere } = await import('../src/engine/buildPlacement.js');
      replyOk();
      const pushing = await pushService();
      for (const [buildPack, keys] of [
        ['dockerfile', ['DATABASE_URL']],
        ['railpack', ['DATABASE_URL']],
        ['nixpacks', []],
        ['nixpacks', undefined],
      ] as const) {
        const buildOnNode = vi.fn(async () => ({ target: 'x', builtWithNixpacks: buildPack === 'nixpacks' }));
        const built = await buildElsewhere(db, { kind: 'server', serverId: builder }, ctxWith(pushing, { buildConfig: { buildPack }, buildSecretKeys: keys }), { deps: { buildOnNode } });
        expect(buildOnNode, `${buildPack} ${String(keys)}`).toHaveBeenCalledTimes(1);
        expect(built.registry?.digest).toBe(DIGEST);
      }
      // No push registry: the stream relay keeps the image on hosts that already hold the env.
      const relay = await service({ serverId: node, buildOn: 'server', buildServerId: builder, slug: 'relay', name: 'relay' });
      const buildOnNode = vi.fn(async () => ({ target: 'x', builtWithNixpacks: true }));
      const built = await buildElsewhere(db, { kind: 'server', serverId: builder }, ctxWith(relay, { buildConfig: { buildPack: 'nixpacks' }, buildSecretKeys: ['DATABASE_URL'] }), { deps: { buildOnNode } });
      expect(buildOnNode).toHaveBeenCalledTimes(1);
      expect(built.registry).toBeUndefined();
    });
  });

  it('retention: the build node drops the previous deployment’s build tag of the service, keeps the current one', async () => {
    const { retainBuildHostTags } = await import('../src/engine/buildPlacement.js');
    const { deployments } = await import('@ninedeploy/db');
    const svc = await service({ buildOn: 'server', buildServerId: builder });
    const [old] = await db.insert(deployments).values({ serviceId: svc.id, commitSha: 'deadbeef00', buildHost: `node:${builder}` }).returning();
    const [cur] = await db.insert(deployments).values({ serviceId: svc.id, commitSha: 'abc1234def', buildHost: `node:${builder}` }).returning();
    await retainBuildHostTags(db, { buildHost: builder, tag: buildTag('web', 'abc1234def', cur!.id), imageId: IMG, sizeBytes: 0, builtWithNixpacks: false, builtStatic: false }, svc, cur!.id, () => undefined);
    expect(h.ops).toEqual([{ server: builder, op: 'docker.imageRm', params: { image: buildTag('web', 'deadbeef00', old!.id) } }]);
    // A panel build keeps the panel's own prune rules.
    h.ops = [];
    await retainBuildHostTags(db, { buildHost: null, tag: 'x', imageId: IMG, sizeBytes: 0, builtWithNixpacks: false, builtStatic: false }, svc, cur!.id, () => undefined);
    expect(h.ops).toEqual([]);
  });
});
