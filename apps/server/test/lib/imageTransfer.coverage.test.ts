import { EventEmitter } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DB, imageTransfers, servers, services, sources, users } from '@ninedeploy/db';
import { closeMigratedDb, migratedDb } from './githubAppKit.js';

/**
 * lib/imageTransfer.ts paths the relay and registry tests do not reach: the
 * panel's own `docker save | gzip` and verified local load, image metadata
 * parsing, the relay's direction and disk-space refusals, the registry login
 * on the panel host and on Docker Hub, and the best-effort history rows.
 * Docker, the agent and the stream channel are fakes.
 */

const h = vi.hoisted(() => ({
  children: [] as Array<{ args: string[]; opts: unknown; child: unknown }>,
  statfs: null as null | (() => { bavail: number; bsize: number }),
  sealed: true,
  ping: '',
  ops: [] as Array<{ server: number; op: string; params: Record<string, unknown> }>,
  reply: null as null | ((op: string, params: Record<string, unknown>) => { exitCode: number; lines: string[] } | Error | undefined),
  run: null as null | ((cmd: string, args: string[], opts: unknown, sink: (l: string) => void, input?: Buffer) => Promise<void>),
  capture: null as null | ((cmd: string, args: string[], opts: unknown) => Promise<string>),
  images: {
    inspectImageArchive: null as null | ((file: string, o: unknown) => void),
    assertNoTagSmuggled: null as null | ((o: unknown) => Promise<void>),
  },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter: EE } = await import('node:events');
  const { PassThrough: PT } = await import('node:stream');
  const spawn = (cmd: string, args: string[], opts: unknown) => {
    if (cmd !== 'docker') return real.spawn(cmd, args, opts as never);
    const child = Object.assign(new EE(), { stdout: new PT(), stderr: new PT(), kill: vi.fn() });
    h.children.push({ args, opts, child });
    return child;
  };
  return { ...real, spawn, default: { ...real, spawn } };
});
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const statfsSync = (...a: Parameters<typeof real.statfsSync>) => (h.statfs ? h.statfs() : real.statfsSync(...a));
  return { ...real, statfsSync, default: { ...real, statfsSync } };
});
vi.mock('../../src/lib/exec.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/exec.js')>()),
  run: (cmd: string, args: string[], opts: unknown, sink: (l: string) => void, input?: Buffer) =>
    h.run ? h.run(cmd, args, opts, sink, input) : Promise.reject(new Error(`unexpected run ${cmd} ${args.join(' ')}`)),
  capture: (cmd: string, args: string[], opts: unknown) => (h.capture ? h.capture(cmd, args, opts) : Promise.reject(new Error('unexpected capture'))),
}));
vi.mock('../../src/agentOps/images.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/agentOps/images.js')>()),
  inspectImageArchive: (file: string, o: unknown) => h.images.inspectImageArchive?.(file, o),
  imageTagSnapshot: async () => new Map([['traefik:v3.1', 'sha256:1']]),
  assertNoTagSmuggled: (o: unknown) => h.images.assertNoTagSmuggled?.(o) ?? Promise.resolve(),
}));
vi.mock('../../src/lib/agentClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/agentClient.js')>()),
  agentTransportSealed: async () => h.sealed,
  agentOp: async (_db: unknown, server: number, op: string, params: Record<string, unknown>, sink?: (l: string) => void) => {
    h.ops.push({ server, op, params });
    if (op === 'agent.ping') return { exitCode: 0, lines: [h.ping] };
    const r = h.reply?.(op, params);
    if (r instanceof Error) throw r;
    for (const l of r?.lines ?? []) sink?.(l);
    return r ?? { exitCode: 0, lines: [] };
  },
}));

const transfer = await import('../../src/lib/imageTransfer.js');
const { config } = await import('../../src/config.js');
const { encrypt } = await import('../../src/lib/crypto.js');
const { resetNodeCapabilityCache } = await import('../../src/lib/agentCapabilities.js');
const { MULTI_NODE_CAPABILITIES } = await import('@ninedeploy/schemas');

const IMG = `sha256:${'a'.repeat(64)}`;
const OTHER = `sha256:${'b'.repeat(64)}`;
const DIGEST = `sha256:${'c'.repeat(64)}`;
const TAG = 'ninedeploy/web:abc1234-b7';
const CAPS_ALL = `ND-AGENT ${JSON.stringify({ version: '0.16.9', caps: ['build-path-guard', 'workspace.remove', 'git.credential', 'terminal', 'terminal.host', ...MULTI_NODE_CAPABILITIES] })}`;

let db: DB;
let node: number;
let builder: number;
let serviceId: number;

beforeEach(async () => {
  h.children = [];
  h.statfs = null;
  h.sealed = true;
  h.ping = CAPS_ALL;
  h.ops = [];
  h.reply = null;
  h.run = null;
  h.capture = null;
  h.images.inspectImageArchive = null;
  h.images.assertNoTagSmuggled = null;
  resetNodeCapabilityCache();
  db = await migratedDb();
  await db.insert(users).values({ id: 7, email: 'u7@example.com', passwordHash: 'x' });
  [node, builder] = (
    await db
      .insert(servers)
      .values([
        { name: 'edge-1', host: '10.0.0.5', port: 4600, tokenEncrypted: encrypt('t'), status: 'online' },
        { name: 'builder', host: '10.0.0.6', port: 4600, tokenEncrypted: encrypt('t'), status: 'online', isBuildServer: true },
      ])
      .returning()
  ).map((r) => r.id) as [number, number];
  serviceId = (await db.insert(services).values({ name: 'web', slug: 'web', type: 'docker', branch: 'main', ownerUserId: 7 } as never).returning())[0]!.id;
});

afterEach(() => closeMigratedDb(db));

type Child = EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
const child = (i: number) => h.children[i]!.child as Child;
const rows = () => db.select().from(imageTransfers);

/** A fake `image.load` handle that collects what the panel sent. */
function loadHandle(end: { imageId?: string; failWrite?: boolean } = {}) {
  const got: Buffer[] = [];
  const writable = new Writable({
    write(chunk: Buffer, _e, cb) {
      if (end.failWrite) return cb(new Error('the agent closed the stream'));
      got.push(chunk);
      cb();
    },
  });
  const abort = vi.fn();
  const done = new Promise<{ bytes: number; sha256: string; result: Record<string, unknown> }>((resolve) =>
    writable.on('finish', () => resolve({ bytes: Buffer.concat(got).length, sha256: 'received', result: { imageId: end.imageId ?? IMG } })),
  );
  done.catch(() => undefined);
  return { got, abort, handle: { kind: 'image.load', direction: 'panel-to-agent' as const, writable, done, abort } };
}

function saveHandle(data: Buffer) {
  return {
    kind: 'image.save',
    direction: 'agent-to-panel' as const,
    readable: Readable.from([data]),
    done: Promise.resolve({ bytes: data.length, sha256: 'sent', result: { imageId: IMG } }),
    abort: vi.fn(),
  };
}

const spec = (over: Record<string, unknown> = {}) => ({ deploymentId: null, serviceId, source: builder as number | null, target: node as number | null, tag: TAG, imageId: IMG, ...over });

describe('image metadata', () => {
  it('panelImageInfo reads id and size with a bounded inspect; a bad size is 0, a bad id is refused', async () => {
    const calls: unknown[] = [];
    let out = `${IMG}|12345\n`;
    h.capture = async (cmd, args, opts) => {
      calls.push([cmd, args, opts]);
      return out;
    };
    expect(await transfer.panelImageInfo(TAG)).toEqual({ id: IMG, size: 12345 });
    expect(calls[0]).toEqual(['docker', ['image', 'inspect', '--format', '{{.Id}}|{{.Size}}', TAG], { timeoutMs: 30_000 }]);
    out = `${IMG}|lots`;
    expect(await transfer.panelImageInfo(TAG)).toEqual({ id: IMG, size: 0 });
    out = `${IMG}`;
    expect(await transfer.panelImageInfo(TAG)).toEqual({ id: IMG, size: 0 });
    out = 'sha256:short|5';
    await expect(transfer.panelImageInfo(TAG)).rejects.toThrow(`Image ${TAG} has no readable id on the panel host`);
  });

  it('nodeImageInfo reads the last non-empty line from docker.imageInspect', async () => {
    const agent = vi.fn(async () => ({ exitCode: 0, lines: ['warning: something', `  ${IMG}|77  `, '', '  '] }));
    expect(await transfer.nodeImageInfo(agent, TAG, '"edge-1" (#1)')).toEqual({ id: IMG, size: 77 });
    expect(agent).toHaveBeenCalledWith('docker.imageInspect', { image: TAG }, expect.any(Function));
    const empty = vi.fn(async () => ({ exitCode: 0, lines: [] }));
    await expect(transfer.nodeImageInfo(empty, TAG, '"edge-1" (#1)')).rejects.toThrow(`Image ${TAG} has no readable id on node "edge-1" (#1)`);
  });

  it('hostLabel names the panel host or the node', () => {
    expect(transfer.hostLabel(null)).toBe('the panel host');
    expect(transfer.hostLabel(4)).toBe('node #4');
  });
});

describe('panelLoadArchive (the panel twin of the node image.load)', () => {
  it('inspects the archive, loads it, confirms the id and tags it', async () => {
    const inspected: unknown[] = [];
    h.images.inspectImageArchive = (file, o) => void inspected.push([file, o]);
    const smuggle: unknown[] = [];
    h.images.assertNoTagSmuggled = async (o) => void smuggle.push(o);
    const runs: string[][] = [];
    h.run = async (_cmd, args, _o, sink) => {
      runs.push(args);
      if (args[0] === 'load') sink(`Loaded image ID: ${IMG}`);
    };
    h.capture = async () => `${IMG}|10`;
    const log = vi.fn();
    await transfer.panelLoadArchive('/tmp/x.tar', TAG, IMG, log);
    expect(inspected).toEqual([['/tmp/x.tar', { expectTag: TAG, expectId: IMG }]]);
    expect(smuggle).toEqual([{ before: expect.any(Map), after: expect.any(Map), loadLines: [`Loaded image ID: ${IMG}`], expectTag: TAG }]);
    expect(runs).toEqual([
      ['load', '-i', '/tmp/x.tar'],
      ['tag', IMG, TAG],
    ]);
    expect(log).toHaveBeenCalledWith(`Loaded ${TAG} (sha256:aaaaaaaaaaaa) on the panel host`);
  });

  it('a refused archive never reaches docker load', async () => {
    h.images.inspectImageArchive = () => {
      throw new Error('Refusing the image archive: it carries the tag "traefik:v3.1"');
    };
    h.run = vi.fn(async () => undefined);
    await expect(transfer.panelLoadArchive('/tmp/x.tar', TAG, IMG, () => undefined)).rejects.toThrow(/traefik/);
    expect(h.run).not.toHaveBeenCalled();
  });

  it('a failed load is still checked for smuggled tags, then rethrown; a smuggling check wins over it', async () => {
    h.run = async () => {
      throw new Error('docker load: unexpected EOF');
    };
    const checked = vi.fn(async () => undefined);
    h.images.assertNoTagSmuggled = checked;
    await expect(transfer.panelLoadArchive('/tmp/x.tar', TAG, IMG, () => undefined)).rejects.toThrow('docker load: unexpected EOF');
    expect(checked).toHaveBeenCalledTimes(1);
    h.images.assertNoTagSmuggled = async () => {
      throw new Error('SECURITY: the image archive tagged "traefik:v3.1"');
    };
    await expect(transfer.panelLoadArchive('/tmp/x.tar', TAG, IMG, () => undefined)).rejects.toThrow(/^SECURITY/);
  });

  it('a loaded id that is not the build image removes what was loaded (ids and the expected tag only)', async () => {
    const runs: string[][] = [];
    h.run = async (_cmd, args, _o, sink) => {
      runs.push(args);
      if (args[0] === 'load') {
        for (const l of [`Loaded image ID: ${OTHER}`, `Loaded image: ${TAG}`, 'Loaded image: someone/else:1', 'noise']) sink(l);
      }
      if (args[1] === 'rm' && args[2] === TAG) throw new Error('already gone');
    };
    h.capture = async () => `${OTHER}|1`;
    await expect(transfer.panelLoadArchive('/tmp/x.tar', TAG, IMG, () => undefined)).rejects.toThrow(`The loaded image's id does not match ${IMG}; it was removed`);
    expect(runs.slice(1)).toEqual([
      ['image', 'rm', OTHER],
      ['image', 'rm', TAG],
    ]);
    // An inspect that fails counts as "not loaded".
    runs.length = 0;
    h.capture = async () => {
      throw new Error('No such image');
    };
    await expect(transfer.panelLoadArchive('/tmp/x.tar', TAG, IMG, () => undefined)).rejects.toThrow(/does not match/);
    expect(runs.some((a) => a[0] === 'tag')).toBe(false);
  });
});

describe('the panel as the source: docker save | gzip', () => {
  it('spawns docker save by id and streams it gzipped into the node load', async () => {
    const load = loadHandle();
    const openStream = vi.fn(async (_db: unknown, id: number, kind: string, params: Record<string, unknown>) => {
      expect([id, kind, params]).toEqual([node, 'image.load', { expectTag: TAG, expectId: IMG, sizeBytes: 999 }]);
      return load.handle;
    });
    const p = transfer.shipImageByStream(db, spec({ source: null, sizeBytes: 999 }), () => undefined, { openStream: openStream as never });
    await vi.waitFor(() => expect(h.children).toHaveLength(1));
    expect(h.children[0]!.args).toEqual(['save', IMG]);
    expect(h.children[0]!.opts).toMatchObject({ stdio: ['ignore', 'pipe', 'pipe'] });
    child(0).stdout.end(Buffer.from('docker-save-tar'));
    child(0).emit('close', 0);
    const res = await p;
    expect(res).toMatchObject({ method: 'stream', ref: TAG, sha256: 'received' });
    expect(gunzipSync(Buffer.concat(load.got)).toString()).toBe('docker-save-tar');
    expect(await rows()).toEqual([expect.objectContaining({ status: 'completed', sourceServerId: null, targetServerId: node })]);
  });

  it('a docker save that exits non-zero fails with its stderr tail after one retry, and kills the save', async () => {
    const openStream = vi.fn(async () => loadHandle().handle);
    const log = vi.fn();
    const p = transfer.shipImageByStream(db, spec({ source: null }), log, { openStream: openStream as never });
    p.catch(() => undefined);
    for (let i = 0; i < 2; i++) {
      await vi.waitFor(() => expect(h.children).toHaveLength(i + 1));
      child(i).stderr.write('Error: No such image\n');
      await new Promise((r) => setImmediate(r));
      child(i).stdout.end();
      child(i).emit('close', 1);
    }
    await expect(p).rejects.toThrow('docker save exited with 1: Error: No such image');
    expect(child(0).kill).toHaveBeenCalledWith('SIGTERM');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('retrying once on a fresh channel'));
    expect(await rows()).toEqual([expect.objectContaining({ status: 'failed', error: expect.stringContaining('docker save exited with 1') })]);
  });

  it('a docker binary that cannot spawn fails the transfer', async () => {
    const openStream = vi.fn(async () => loadHandle().handle);
    const p = transfer.shipImageByStream(db, spec({ source: null }), () => undefined, { openStream: openStream as never });
    p.catch(() => undefined);
    for (let i = 0; i < 2; i++) {
      await vi.waitFor(() => expect(h.children).toHaveLength(i + 1));
      child(i).emit('error', new Error('spawn docker ENOENT'));
      child(i).stdout.end();
    }
    await expect(p).rejects.toThrow('spawn docker ENOENT');
  });
});

describe('relay refusals', () => {
  it('never ships to the build host itself', async () => {
    const openStream = vi.fn();
    await expect(transfer.shipImageByStream(db, spec({ target: builder }), () => undefined, { openStream: openStream as never })).rejects.toThrow(
      'an image is never shipped to its own build host',
    );
    expect(openStream).not.toHaveBeenCalled();
  });

  it('refuses a stream that answers in the wrong direction (save, then load)', async () => {
    const wrongSave = vi.fn(async () => loadHandle().handle);
    await expect(transfer.shipImageByStream(db, spec(), () => undefined, { openStream: wrongSave as never })).rejects.toThrow('image.save answered with the wrong direction');
    const wrongLoad = vi.fn(async () => saveHandle(Buffer.from('x')));
    await expect(transfer.shipImageByStream(db, spec(), () => undefined, { openStream: wrongLoad as never })).rejects.toThrow('image.load answered with the wrong direction');
    // Two attempts × (save, load); the save opened by each attempt was aborted.
    expect(wrongLoad).toHaveBeenCalledTimes(4);
    const saves = (await Promise.all(wrongLoad.mock.results.map((r) => r.value))) as Array<ReturnType<typeof saveHandle>>;
    expect(saves[0]!.abort).toHaveBeenCalledWith('the transfer was abandoned');
    expect(saves[2]!.abort).toHaveBeenCalledWith('the transfer was abandoned');
  });

  it('a target that fails mid-pipe is aborted with the reason, and the source too', async () => {
    const loads: Array<ReturnType<typeof loadHandle>> = [];
    const saves: Array<ReturnType<typeof saveHandle>> = [];
    const openStream = vi.fn(async (_db: unknown, _id: number, kind: string) => {
      if (kind === 'image.save') {
        saves.push(saveHandle(Buffer.from('bytes')));
        return saves.at(-1)!;
      }
      loads.push(loadHandle({ failWrite: true }));
      return loads.at(-1)!.handle;
    });
    await expect(transfer.shipImageByStream(db, spec(), () => undefined, { openStream: openStream as never })).rejects.toThrow('the agent closed the stream');
    expect(loads).toHaveLength(2);
    for (const l of loads) expect(l.abort).toHaveBeenCalledWith('the agent closed the stream');
    for (const s of saves) expect(s.abort).toHaveBeenCalledWith('the transfer was abandoned');
  });

  it('node → panel refuses when the panel disk cannot hold the image, and proceeds when free space is unknown', async () => {
    h.statfs = () => ({ bavail: 10, bsize: 4096 });
    const openStream = vi.fn(async () => saveHandle(gzipSync(Buffer.from('tar'))));
    const panelLoad = vi.fn(async () => undefined);
    await expect(transfer.shipImageByStream(db, spec({ target: null, sizeBytes: 1_000_000 }), () => undefined, { openStream: openStream as never, panelLoad })).rejects.toThrow(
      `Not enough free disk space on the panel host for this image (40960 bytes free, ${1_000_000 + 256 * 1024 * 1024} needed)`,
    );
    expect(panelLoad).not.toHaveBeenCalled();
    h.statfs = () => {
      throw new Error('ENOSYS');
    };
    await expect(transfer.shipImageByStream(db, spec({ target: null, sizeBytes: 1_000_000 }), () => undefined, { openStream: openStream as never, panelLoad })).resolves.toMatchObject({
      bytes: expect.any(Number),
    });
    expect(panelLoad).toHaveBeenCalledTimes(1);
    const dir = path.join(config.paths.dataDir, 'transfers');
    expect(existsSync(dir) ? readdirSync(dir).filter((n) => /^[0-9a-f]{32}\.tar$/.test(n)) : []).toEqual([]);
  });

  it('a non-Error failure is still reported as an Error', async () => {
    const openStream = vi.fn(async () => {
      throw 'socket hang up';
    });
    const err = await transfer.shipImageByStream(db, spec(), () => undefined, { openStream: openStream as never }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('socket hang up');
  });
});

describe('the history row is best effort', () => {
  const relay = () => {
    const load = loadHandle();
    return {
      openStream: vi.fn(async () => load.handle) as never,
      panelSave: () => ({ stream: Readable.from([Buffer.from('x')]), done: Promise.resolve(), kill: vi.fn() }),
    };
  };

  it('a failed insert ships the image without a row', async () => {
    const broken = {
      insert: () => {
        throw new Error('database is locked');
      },
      update: vi.fn(),
    } as unknown as DB;
    await expect(transfer.shipImageByStream(broken, spec({ source: null }), () => undefined, relay())).resolves.toMatchObject({ method: 'stream', bytes: 1 });
    expect((broken as unknown as { update: ReturnType<typeof vi.fn> }).update).not.toHaveBeenCalled();
  });

  it('a failed update is swallowed; an insert with no row id skips the update', async () => {
    const failingUpdate = {
      insert: () => ({ values: () => ({ returning: async () => [{ id: 5 }] }) }),
      update: () => {
        throw new Error('database is locked');
      },
    } as unknown as DB;
    await expect(transfer.shipImageByStream(failingUpdate, spec({ source: null }), () => undefined, relay())).resolves.toMatchObject({ bytes: 1 });
    const update = vi.fn();
    const noRow = { insert: () => ({ values: () => ({ returning: async () => [] }) }), update } as unknown as DB;
    await expect(transfer.shipImageByStream(noRow, spec({ source: null }), () => undefined, relay())).resolves.toMatchObject({ bytes: 1 });
    expect(update).not.toHaveBeenCalled();
  });
});

describe('registry push and pull', () => {
  const ghcr = { repository: 'ghcr.io/acme/web', host: 'ghcr.io', username: 'ci', password: 's3cret', server: 'ghcr.io' };
  const hub = { repository: 'docker.io/acme/web', host: 'docker.io', username: 'ci', password: 's3cret', server: undefined };

  it('a credential without a username or token is refused', async () => {
    const [noUser] = await db.insert(sources).values({ type: 'registry', name: 'nouser', tokenEncrypted: encrypt('tok') } as never).returning();
    await expect(transfer.resolvePushTarget(db, { pushRegistrySourceId: noUser!.id, pushRepository: 'acme/web' })).rejects.toThrow(
      'The registry credential "nouser" has no username or token, so nothing can be pushed with it.',
    );
    const [noToken] = await db.insert(sources).values({ type: 'registry', name: 'notoken', registryUsername: 'ci', tokenEncrypted: null } as never).returning();
    await expect(transfer.resolvePushTarget(db, { pushRegistrySourceId: noToken!.id, pushRepository: 'acme/web' })).rejects.toThrow(/"notoken" has no username or token/);
    await expect(transfer.resolvePushTarget(db, { pushRegistrySourceId: 999_999, pushRepository: 'acme/web' })).rejects.toThrow(/not a registry credential/);
    await expect(transfer.resolvePushTarget(db, { pushRegistrySourceId: noUser!.id, pushRepository: null })).rejects.toThrow(/removed or is incomplete/);
  });

  it('the panel host logs in with the password on stdin, tags, pushes, reads the digest and logs out', async () => {
    const runs: Array<{ args: string[]; opts: unknown; input?: string }> = [];
    h.run = async (_cmd, args, opts, sink, input) => {
      runs.push({ args, opts, input: input?.toString() });
      if (args[0] === 'push') sink(`abc1234-b7: digest: ${DIGEST} size: 1234`);
    };
    const lines: string[] = [];
    expect(await transfer.pushImage(db, null, { tag: TAG, target: ghcr }, (l) => lines.push(l))).toEqual({ digest: DIGEST, pushedRef: 'ghcr.io/acme/web:abc1234-b7' });
    expect(runs.map((r) => r.args)).toEqual([
      ['login', '--username', 'ci', '--password-stdin', 'ghcr.io'],
      ['tag', TAG, 'ghcr.io/acme/web:abc1234-b7'],
      ['push', 'ghcr.io/acme/web:abc1234-b7'],
      ['logout', 'ghcr.io'],
    ]);
    expect(runs[0]).toMatchObject({ opts: { timeoutMs: 120_000 }, input: 's3cret\n' });
    expect(lines.join('\n')).not.toContain('s3cret');
    expect(lines).toContain('Logging in to ghcr.io on the panel host …');
  });

  it('Docker Hub: no server operand; a push without a digest fails; a failing logout is ignored', async () => {
    const runs: string[][] = [];
    h.run = async (_cmd, args) => {
      runs.push(args);
      if (args[0] === 'logout') throw new Error('not logged in');
    };
    await expect(transfer.pushImage(db, null, { tag: TAG, target: hub }, () => undefined)).rejects.toThrow(
      'The registry did not report a digest for docker.io/acme/web:abc1234-b7',
    );
    expect(runs[0]).toEqual(['login', '--username', 'ci', '--password-stdin']);
    expect(runs.at(-1)).toEqual(['logout']);
  });

  it('a build node on Docker Hub logs in and out without a server operand', async () => {
    h.reply = (op) => (op === 'docker.push' ? { exitCode: 0, lines: [`latest: digest: ${DIGEST} size: 1`] } : op === 'docker.logout' ? new Error('gone') : undefined);
    expect(await transfer.pushImage(db, builder, { tag: TAG, target: hub }, () => undefined)).toEqual({ digest: DIGEST, pushedRef: 'docker.io/acme/web:abc1234-b7' });
    const byOp = Object.fromEntries(h.ops.map((o) => [o.op, o.params]));
    expect(byOp['docker.login']).toEqual({ username: 'ci', password: 's3cret' });
    expect(byOp['docker.logout']).toEqual({});
  });

  it('the panel pulls by digest, confirms the id, and removes a wrong image', async () => {
    const runs: string[][] = [];
    h.run = async (_cmd, args) => void runs.push(args);
    let id = IMG;
    h.capture = async () => `${id}|5`;
    const s = { deploymentId: null, serviceId, source: builder, target: null, imageId: IMG, repository: ghcr.repository, digest: DIGEST };
    expect(await transfer.pullImageByDigest(db, s, ghcr, () => undefined)).toMatchObject({ method: 'registry', ref: `ghcr.io/acme/web@${DIGEST}`, bytes: 0, sha256: DIGEST });
    expect(runs).toContainEqual(['pull', `ghcr.io/acme/web@${DIGEST}`]);
    id = OTHER;
    runs.length = 0;
    await expect(transfer.pullImageByDigest(db, s, ghcr, () => undefined)).rejects.toThrow(`the panel host pulled image ${OTHER} for ghcr.io/acme/web@${DIGEST}, not ${IMG}; it was removed`);
    expect(runs).toContainEqual(['image', 'rm', `ghcr.io/acme/web@${DIGEST}`]);
    const r = await rows();
    expect(r.map((x) => x.status)).toEqual(['completed', 'failed']);
    expect(r[0]).toMatchObject({ method: 'registry', sha256: 'c'.repeat(64), targetServerId: null });
  });

  it('a node whose inspect fails is trusted on the digest alone', async () => {
    h.reply = (op) => (op === 'docker.imageInspect' ? new Error('unknown op') : undefined);
    const s = { deploymentId: null, serviceId, source: null, target: node, imageId: IMG, repository: hub.repository, digest: DIGEST };
    await expect(transfer.pullImageByDigest(db, s, hub, () => undefined)).resolves.toMatchObject({ method: 'registry' });
    expect(h.ops.map((o) => o.op)).toEqual(['docker.login', 'docker.pull', 'docker.logout', 'docker.imageInspect']);
    expect(h.ops[0]!.params).toEqual({ username: 'ci', password: 's3cret' });
  });
});
