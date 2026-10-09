import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type DB, runMigrations, servers } from '@ninedeploy/db';
import { MULTI_NODE_CAPABILITIES } from '@ninedeploy/schemas';
import { dockerSaveArchive, EXPECT_TAG, IMAGE_ID } from './fixtures/imageArchive.js';

/**
 * Multi-node agent transport (design §1, task T2), agent side and the stream
 * channel end to end with only Docker faked:
 *
 * - §1.7 compatibility: a 0.15 panel talking to this agent sees no behaviour
 *   change — the op table is the 0.15 table (OPS_015) plus only new ops, the
 *   ping's capabilities start with the 0.15 answer, and recorded 0.15 requests
 *   answer byte-identically (test/fixtures/agentOps015.json, recorded from
 *   the v0.15.1 agent.ts before this change);
 * - the op registry (agentOps/index.ts) and its wiring;
 * - the frame cipher's `info` (terminal derivation byte-identical, proven by
 *   a vector recorded from the 0.15 code);
 * - the sealed stream channel: integrity, limits, single use, cleanup;
 * - `docker.runSpec` validation and the volume / image ops.
 */

const spawnMock = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => 0));
const streamMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/spawnValidated.js', async (importOriginal) => ({
  BINARIES: (await importOriginal<typeof import('../src/lib/spawnValidated.js')>()).BINARIES,
  spawnValidated: spawnMock,
  spawnValidatedStream: streamMock,
}));

const agent = await import('../src/agent.js');
const registry = await import('../src/agentOps/index.js');
const stream = await import('../src/agentOps/stream.js');
const { parseRunSpec, runSpecArgv } = await import('../src/agentOps/runSpec.js');
const { open: openSealed, seal } = await import('../src/lib/agentSeal.js');
const { parseAgentCapabilities, resetNodeCapabilityCache } = await import('../src/lib/agentCapabilities.js');
const { _resetSealedSupportCache } = await import('../src/lib/agentClient.js');
const cipher = await import('../src/lib/agentFrameCipher.js');
const { openAgentStream, parseStreamChannel, AGENT_STREAM_KINDS, STREAM_HARD_CAP_MS } = await import('../src/lib/agentStream.js');
const { encrypt } = await import('../src/lib/crypto.js');
const { BINARIES } = await import('../src/lib/spawnValidated.js');
const { buildTestApp, listen } = await import('./helpers.js');

const TOKEN = 'agent-shared-token';
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/agentOps015.json', import.meta.url), 'utf8')) as {
  answers: Array<{ op: string; sealed: boolean; body: Record<string, unknown>; calls: unknown[] }>;
};

/** The 0.15 op table (OPS keys ∪ HANDLED_OPS) at tag v0.15.0 / v0.15.1: OPS_014 plus terminal.open. */
const OPS_015 = [
  'agent.ping', 'agent.stats', 'docker.build', 'docker.composeConfig', 'docker.composeDown', 'docker.composePs',
  'docker.composePull', 'docker.composeRestartPolicy', 'docker.composeUp', 'docker.inspect', 'docker.login',
  'docker.logout', 'docker.logs', 'docker.networkConnect', 'docker.networkCreate', 'docker.networkDisconnect',
  'docker.networkRm', 'docker.pull', 'docker.rm', 'docker.run', 'docker.runEnv', 'docker.start', 'docker.stop',
  'docker.volumeInspect', 'docker.volumeRm', 'file.deleteEnv', 'file.deleteWorkspace', 'file.writeEnv',
  'file.writeWorkspace', 'git.checkout', 'git.clone', 'git.ensure', 'git.fetch', 'git.reset', 'git.rev-parse',
  'proxy.ensure', 'proxy.writeConfig', 'terminal.open', 'workspace.remove',
];
/** What T2 adds (later tasks add theirs to the registry). */
const T2_OPS = ['docker.imageInspect', 'docker.imageRm', 'docker.push', 'docker.runSpec', 'docker.tag', 'docker.volumeCreate', 'docker.volumeList', 'stream.open'];
const CAPS_015_PING = ['build-path-guard', 'workspace.remove', 'git.credential', 'terminal', 'terminal.host'];

type App = Awaited<ReturnType<typeof buildTestApp>>;
let app: App;
let port: number;
let work: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  spawnMock.mockReset().mockResolvedValue(0);
  streamMock.mockReset();
  stream._resetAgentStreams();
  agent.resetNodeDockerLoggingDriverCache();
  work = mkdtempSync(path.join(os.tmpdir(), 'nd-multinode-'));
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(work);
  for (const k of ['NINEDEPLOY_AGENT_HOST_TERMINAL', 'NINEDEPLOY_HOST_TERMINAL', 'NINEDEPLOY_AGENT_DOCKER_SOCKET']) delete process.env[k];
  app = await buildTestApp();
  await app.register(agent.agentRoutes, { tokenHash: TOKEN_HASH });
  port = await listen(app);
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await app.close();
  stream._resetAgentStreams();
  cwdSpy.mockRestore();
  rmSync(work, { recursive: true, force: true });
});

/** One sealed `/agent/exec` call, as the panel's agentOp makes it. */
async function sealedOp(op: string, params: Record<string, unknown>) {
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const res = await app.inject({ method: 'POST', url: '/agent/exec', payload: { sealed: seal(TOKEN_HASH, { op, params, nonce }) } });
  if (res.statusCode !== 200) return { status: res.statusCode, error: res.json().error as { code: string; message: string }, lines: [] as string[], exitCode: -1 };
  const body = openSealed<{ lines: string[]; exitCode: number }>(TOKEN_HASH, res.json().sealed);
  return { status: 200, error: null, lines: body.lines, exitCode: body.exitCode };
}

const plainOp = (op: string, params: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/agent/exec', headers: { 'x-agent-token': TOKEN }, payload: { op, params } });

const argvs = () => spawnMock.mock.calls.map((c) => c[1] as string[]);

/** A spawnValidated fake: `answer(argv)` → [exitCode, lines]. */
function dockerFake(answer: (argv: string[]) => [number, string[]] | undefined) {
  spawnMock.mockImplementation(async (_exe: unknown, argv: unknown, onLine: unknown) => {
    const [code, lines] = answer(argv as string[]) ?? [0, []];
    for (const l of lines) (onLine as (l: string) => void)(l);
    return code;
  });
}

describe('a 0.15 panel talking to this agent sees no behaviour change (§1.7)', () => {
  it('the op table is OPS_015 plus only new ops; every T2 op is present', () => {
    const now = [...new Set([...Object.keys(agent.agentMode.OPS), ...agent.agentMode.HANDLED_OPS])].sort();
    const added = new Set(agent.agentMode.AGENT_OPS.keys());
    expect(now.filter((op) => !added.has(op))).toEqual(OPS_015);
    for (const op of T2_OPS) expect(now, op).toContain(op);
    // New ops never shadow an existing one.
    for (const op of added) expect(OPS_015, op).not.toContain(op);
  });

  it("the ping's capabilities start with the exact 0.15 answer; /agent/ping keys are unchanged", async () => {
    const caps = [...parseAgentCapabilities((await sealedOp('agent.ping', {})).lines).caps];
    expect(caps.slice(0, 5)).toEqual(CAPS_015_PING);
    expect(caps.slice(5)).toEqual(registry.advertisedCapabilities());
    const res = await app.inject({ method: 'GET', url: '/agent/ping' });
    expect(Object.keys(res.json())).toEqual(['ok', 'agent', 'sealed', 'version']);
  });

  it('an unknown op is still 400 unknown_op on both transports', async () => {
    expect((await sealedOp('stream.attach', {})).error?.code).toBe('unknown_op');
    expect((await plainOp('docker.exec', {})).json().error.code).toBe('unknown_op');
  });

  it('every recorded 0.15 request answers byte-identically, argv and env included (both transports)', async () => {
    spawnMock.mockImplementation(async (_e: unknown, argv: unknown, onLine: unknown) => {
      (onLine as (l: string) => void)(`ran ${(argv as string[])[0]}`);
      return 0;
    });
    const norm = (v: unknown): unknown => {
      if (typeof v === 'string') return v.split(work).join('<cwd>').split('\\').join('/');
      if (Array.isArray(v)) return v.map(norm);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]));
      return v;
    };
    expect(fixture.answers.map((a) => a.op)).toEqual([
      'docker.runEnv', 'docker.runEnv', 'git.ensure', 'git.ensure', 'git.ensure', 'docker.build', 'file.writeWorkspace', 'proxy.ensure',
    ]);
    const requests: Array<Record<string, unknown>> = [
      { name: 'web-3', image: 'ninedeploy/web:abc1234', envFile: '.agent-env/web-3.env', volume: 'nd-svc-web-data', mount: '/data', publish: '8080:3000', cpuShares: '512', cpuLimitMilli: '1500', memLimitMb: '256' },
      { name: 'web-3', image: 'ninedeploy/web:abc1234', envFile: '.agent-env/web-3.env' },
      { workspace: 'web', url: 'https://github.com/acme/web.git', depth: '1' },
      { workspace: 'web', url: 'https://github.com/acme/web.git', depth: '1' },
      { workspace: 'web2', url: 'https://github.com/acme/web.git', depth: '1', credential: { username: 'x-access-token', password: 'ghs_secret0123' } },
      { workspace: 'web', tag: 'ninedeploy/web:abc1234', dockerfile: 'Dockerfile', context: '.' },
      { workspace: 'web', kind: 'compose', content: 'services: {}\n' },
      {},
    ];
    for (const [i, recorded] of fixture.answers.entries()) {
      spawnMock.mockClear();
      const params = requests[i] as Record<string, unknown>;
      let body: Record<string, unknown>;
      if (recorded.sealed) {
        const res = await sealedOp(recorded.op, params);
        body = { status: res.status, lines: res.lines, exitCode: res.exitCode, envFile: null };
      } else {
        const res = await plainOp(recorded.op, params);
        body = { status: res.statusCode, ...res.json() };
      }
      const calls = spawnMock.mock.calls.map((c) => {
        const opts = Object.fromEntries(
          Object.entries((c[3] ?? {}) as Record<string, unknown>).map(([k, v]) => [k, k === 'cwd' ? path.relative(work, v as string) : v]),
        );
        return [c[0], c[1], opts];
      });
      expect(norm(body), `${i} ${recorded.op}`).toEqual(recorded.body);
      expect(norm(calls), `${i} ${recorded.op}`).toEqual(recorded.calls);
      if (recorded.op === 'git.ensure' && params['workspace'] === 'web' && recorded.sealed) writeFileSync(path.join(work, '.agent-work', 'web', '.git'), '');
    }
  });

  it('gitCredentialEnv moved to agentOps/gitCredential.ts and is re-exported unchanged', async () => {
    const moved = await import('../src/agentOps/gitCredential.js');
    expect(agent.gitCredentialEnv).toBe(moved.gitCredentialEnv);
  });
});

describe('the op registry and its wiring (M8)', () => {
  it('advertises a capability only when a module declares it, in MULTI_NODE_CAPABILITIES order, after the 0.15 list', () => {
    const tail = agent.AGENT_CAPABILITIES.slice(agent.AGENT_CAPABILITIES_015.length);
    expect(tail).toEqual(registry.registeredCapabilities());
    expect(tail).toEqual(MULTI_NODE_CAPABILITIES.filter((c) => tail.includes(c)));
    for (const cap of ['stream', 'docker.runSpec', 'volume.manage', 'image.manage']) expect(tail, cap).toContain(cap);
    // T3's ops exist (agentOps/builds.ts, git.withKey in agentOps/gitCredential.ts).
    for (const cap of ['build.nixpacks', 'build.railpack', 'git.sshkey']) expect(tail, cap).toContain(cap);
    // T6's ops exist (agentOps/databases.ts).
    expect(tail, 'db.manage').toContain('db.manage');
    // Not before their ops exist (T7).
    for (const cap of ['swarm']) expect(tail, cap).not.toContain(cap);
    for (const def of registry.AGENT_OPS.values()) expect(tail).toContain(def.cap);
  });

  it('every registered op is a handled op, and none collides with the 0.15 table', () => {
    for (const op of registry.AGENT_OPS.keys()) {
      expect(agent.agentMode.HANDLED_OPS.has(op), op).toBe(true);
      expect(agent.agentMode.OPS[op], op).toBeUndefined();
    }
    expect([...registry.AGENT_OPS.keys()].sort()).toEqual(expect.arrayContaining(T2_OPS));
  });

  it('a module cannot register an op twice or use a capability it does not declare', () => {
    const run = async () => 0;
    const mod = (name: string, caps: Array<'stream' | 'swarm'>, cap: 'stream' | 'swarm') => ({ name, caps, ops: { 'x.op': { cap, sealedOnly: false, run } } });
    expect(() => registry.buildOpTable([mod('a', ['stream'], 'stream'), mod('b', ['stream'], 'stream')])).toThrow(/registered twice/);
    expect(() => registry.buildOpTable([mod('a', ['stream'], 'swarm')])).toThrow(/does not declare/);
    expect(registry.registeredCapabilities([mod('a', ['swarm'], 'swarm'), mod('b', ['stream'], 'stream')])).toEqual(['stream', 'swarm']);
  });

  it("the node owner's kill switches remove a capability (design §1.1)", () => {
    expect(registry.capabilityKillSwitch('build.nixpacks', { NINEDEPLOY_AGENT_BUILDS: 'off' })).toBe('NINEDEPLOY_AGENT_BUILDS');
    expect(registry.capabilityKillSwitch('build.railpack', { NINEDEPLOY_AGENT_BUILDS: 'disabled' })).toBe('NINEDEPLOY_AGENT_BUILDS');
    expect(registry.capabilityKillSwitch('git.sshkey', { NINEDEPLOY_AGENT_STATIC_CREDENTIALS: '0' })).toBe('NINEDEPLOY_AGENT_STATIC_CREDENTIALS');
    expect(registry.capabilityKillSwitch('db.manage', { NINEDEPLOY_AGENT_DATABASES: 'no' })).toBe('NINEDEPLOY_AGENT_DATABASES');
    expect(registry.capabilityKillSwitch('swarm', { NINEDEPLOY_AGENT_SWARM: 'false' })).toBe('NINEDEPLOY_AGENT_SWARM');
    expect(registry.capabilityKillSwitch('swarm', { NINEDEPLOY_AGENT_SWARM: 'on' })).toBeNull();
    expect(registry.capabilityKillSwitch('stream', { NINEDEPLOY_AGENT_BUILDS: 'off' })).toBeNull();
  });

  it('the registry carries one labelled block per task', () => {
    const src = readFileSync(new URL('../src/agentOps/index.ts', import.meta.url), 'utf8');
    for (const task of ['T2', 'T3', 'T5', 'T6', 'T7']) {
      expect(src, task).toMatch(new RegExp(`// ── 0\\.16 ${task} [^\\n]*──`));
      expect(src, task).toContain(`// ── end 0.16 ${task} ──`);
    }
    for (const file of ['../src/agentOps/stream.ts', '../src/lib/agentStream.ts']) {
      expect(readFileSync(new URL(file, import.meta.url), 'utf8'), file).toContain('// ── end 0.16 T6 ──');
    }
  });

  it('agentRoutes registers GET /agent/stream; agent kinds and panel kinds are the same table', () => {
    expect(app.hasRoute({ method: 'GET', url: '/agent/stream' })).toBe(true);
    expect(Object.keys(stream.STREAM_KIND_HANDLERS).sort()).toEqual(Object.keys(AGENT_STREAM_KINDS).sort());
  });

  it('the spawn allowlist gains nixpacks and railpack, each spawning itself', () => {
    expect(BINARIES).toEqual({ docker: 'docker', git: 'git', df: 'df', nixpacks: 'nixpacks', railpack: 'railpack' });
  });
});

describe('the frame cipher info parameter (M10)', () => {
  // Recorded from the v0.15.1 lib/agentFrameCipher.ts before this change.
  const VECTOR = {
    key: '15471868fe0e1d77550bdd163c589fc08d12c93896f241cdb8edb13e3f952d30',
    frame0: '0000000000000000c1c9efd72409ff3656ca7eb0a222b69ffbab35b090d0',
    frame1: '000000000000000120ecdc4eda61854de88e36e82cf5d24cef817bc5d7cb96535de5d3',
  };
  const salt = Buffer.alloc(32, 7);

  it('the terminal derivation is byte-identical to 0.15 (default info and explicit)', () => {
    for (const key of [cipher.deriveFrameKey(TOKEN_HASH, salt), cipher.deriveFrameKey(TOKEN_HASH, salt, cipher.FRAME_HKDF_INFO)]) {
      expect(key.toString('hex')).toBe(VECTOR.key);
      const s = new cipher.FrameSealer(key, 'agent');
      expect(s.seal(cipher.FRAME_TYPE.data, Buffer.from('hello')).toString('hex')).toBe(VECTOR.frame0);
      expect(s.seal(cipher.FRAME_TYPE.exit, Buffer.from('{"code":0}')).toString('hex')).toBe(VECTOR.frame1);
    }
  });

  it('a terminal key can never open a stream frame, and vice versa', () => {
    const tKey = cipher.deriveFrameKey(TOKEN_HASH, salt);
    const sKey = cipher.deriveFrameKey(TOKEN_HASH, salt, cipher.STREAM_HKDF_INFO);
    expect(sKey.equals(tKey)).toBe(false);
    const streamFrame = new cipher.FrameSealer(sKey, 'agent').seal(cipher.STREAM_FRAME_TYPE.data, Buffer.from('x'));
    expect(() => new cipher.FrameOpener(tKey, 'agent', cipher.STREAM_FRAME_TYPES).open(streamFrame)).toThrow(/auth/);
    const termFrame = new cipher.FrameSealer(tKey, 'agent').seal(cipher.FRAME_TYPE.data, Buffer.from('x'));
    expect(() => new cipher.FrameOpener(sKey, 'agent').open(termFrame)).toThrow(/auth/);
    expect(() => cipher.deriveFrameKey(TOKEN_HASH, salt, 'other')).toThrow(/domain/);
  });

  it('end and error are stream types; a terminal opener still refuses them', () => {
    const key = cipher.deriveFrameKey(TOKEN_HASH, salt, cipher.STREAM_HKDF_INFO);
    const end = new cipher.FrameSealer(key, 'agent').seal(cipher.STREAM_FRAME_TYPE.end, cipher.encodeStreamEnd({ bytes: 1, sha256: 'a'.repeat(64) }));
    expect(() => new cipher.FrameOpener(key, 'agent').open(end)).toThrow(/unknown_type/);
    expect(new cipher.FrameOpener(key, 'agent', cipher.STREAM_FRAME_TYPES).open(end).type).toBe(6);
  });

  it('end and error codecs', () => {
    expect(cipher.decodeStreamEnd(cipher.encodeStreamEnd({ bytes: 3, sha256: 'b'.repeat(64), result: { imageId: 'x' } }))).toEqual({
      bytes: 3,
      sha256: 'b'.repeat(64),
      result: { imageId: 'x' },
    });
    const a64 = 'a'.repeat(64);
    for (const bad of ['{}', `{"bytes":-1,"sha256":"${a64}"}`, '{"bytes":1,"sha256":"zz"}', `{"bytes":1,"sha256":"${a64}","result":[]}`, 'nope']) {
      expect(cipher.decodeStreamEnd(Buffer.from(bad)), bad).toBeNull();
    }
    expect(cipher.decodeStreamError(cipher.encodeStreamError('x'.repeat(5000)))).toHaveLength(1000);
    expect(cipher.decodeStreamError(Buffer.from('nope'))).toBe('the agent reported a stream error');
  });
});

// ── the stream channel ──────────────────────────────────────────────────────

async function migratedDb(): Promise<DB> {
  const { db } = createDb({ url: ':memory:' });
  await runMigrations(db, fileURLToPath(new URL('../../../packages/db/src/migrations', import.meta.url)));
  return db;
}

async function nodeRow(db: DB): Promise<number> {
  _resetSealedSupportCache();
  resetNodeCapabilityCache();
  const [row] = await db.insert(servers).values({ name: 'edge-1', host: '127.0.0.1', port, tokenEncrypted: encrypt(TOKEN), status: 'online' }).returning();
  return row!.id;
}

/** A source the agent streams (what `docker save` / `tar` would write). */
function fakeSource(chunks: Buffer[], code = 0) {
  const kill = vi.fn();
  return { stdout: Readable.from(chunks), stdin: null, exit: Promise.resolve({ code, stderr: code ? 'boom' : '' }), kill };
}

const ID = IMAGE_ID;

describe('the sealed stream channel end to end (real sealed agentOp → real agent → faked Docker)', () => {
  it('image.save: the panel receives exactly what docker save wrote (gzip), verified by sha256; saved by id', async () => {
    const db = await migratedDb();
    const serverId = await nodeRow(db);
    const original = Buffer.concat([Buffer.alloc(100_000, 7), Buffer.from('tail')]);
    dockerFake((argv) => (argv[0] === 'image' && argv[1] === 'inspect' ? [0, [ID]] : undefined));
    streamMock.mockImplementation(() => fakeSource([original.subarray(0, 40_000), original.subarray(40_000)]));
    const h = await openAgentStream(db, serverId, 'image.save', { image: 'ninedeploy/web:abc1234' });
    expect(h.direction).toBe('agent-to-panel');
    const chunks: Buffer[] = [];
    if (h.direction !== 'agent-to-panel') throw new Error('direction');
    for await (const c of h.readable) chunks.push(c as Buffer);
    const done = await h.done;
    const wire = Buffer.concat(chunks);
    expect(gunzipSync(wire).equals(original)).toBe(true);
    expect(done).toEqual({ bytes: wire.length, sha256: createHash('sha256').update(wire).digest('hex'), result: { imageId: ID } });
    expect(streamMock).toHaveBeenCalledWith('docker', ['save', ID], expect.objectContaining({ timeoutMs: expect.any(Number) }));
    // The ping refreshed the persisted capability cache.
    const row = await db.query.servers.findFirst();
    expect(row!.agentCaps).toEqual(expect.arrayContaining(['stream', 'image.manage']));
    expect(stream.streamChannelCount()).toBe(0);
  });

  it('image.load: the verified archive is checked, loaded, its id confirmed, tagged by the node, and the file removed', async () => {
    const db = await migratedDb();
    const serverId = await nodeRow(db);
    const archive = dockerSaveArchive();
    let loadedBytes: Buffer | null = null;
    dockerFake((argv) => {
      if (argv[0] === '-kP') return [0, ['Filesystem 1024-blocks Used Available Capacity Mounted', '/dev/sda1 100000000 1 90000000 1% /']];
      if (argv[0] === 'image' && argv[1] === 'ls') return [0, [`traefik:v3.1|sha256:${'1'.repeat(64)}`]];
      if (argv[0] === 'load') {
        loadedBytes = readFileSync(argv[2] as string);
        return [0, [`Loaded image ID: ${ID}`]];
      }
      if (argv[0] === 'image' && argv[1] === 'inspect') return [0, [ID]];
      return undefined;
    });
    const h = await openAgentStream(db, serverId, 'image.load', { expectTag: EXPECT_TAG, expectId: ID, sizeBytes: archive.length });
    if (h.direction !== 'panel-to-agent') throw new Error('direction');
    const gz = gzipSync(archive);
    h.writable.end(gz);
    const done = await h.done;
    expect(done).toEqual({ bytes: gz.length, sha256: createHash('sha256').update(gz).digest('hex'), result: { imageId: ID, tag: EXPECT_TAG } });
    expect(loadedBytes!.equals(archive)).toBe(true); // stored unpacked
    expect(argvs()[0]).toEqual(['-kP', path.join(work, '.agent-work', '.transfer')]);
    expect(argvs().filter((a) => a[0] !== '-kP' && !(a[0] === 'image' && a[1] === 'ls'))).toEqual([
      ['load', '-i', expect.stringMatching(/\.part$/)],
      ['image', 'inspect', '--format', '{{.Id}}', ID],
      ['tag', ID, EXPECT_TAG],
    ]);
    expect(existsSync(path.join(work, '.agent-work', '.transfer'))).toBe(true);
    expect(readdirOrEmpty(path.join(work, '.agent-work', '.transfer'))).toEqual([]);
    // Not enough free space for the announced size: refused at open, before any byte moves.
    dockerFake((argv) => (argv[0] === '-kP' ? [0, ['h', '/dev/sda1 100 1 10 1% /']] : undefined));
    await expect(openAgentStream(db, serverId, 'image.load', { expectTag: EXPECT_TAG, expectId: ID, sizeBytes: 1_000_000 })).rejects.toThrow(/Not enough free disk space/);
  });

  it('image.load: a load that tagged the proxy image is undone and the transfer fails with SECURITY', async () => {
    const db = await migratedDb();
    const serverId = await nodeRow(db);
    let loaded = false;
    const OLD = `sha256:${'1'.repeat(64)}`;
    dockerFake((argv) => {
      if (argv[0] === 'image' && argv[1] === 'ls') return [0, [`traefik:v3.1|${loaded ? `sha256:${'e'.repeat(64)}` : OLD}`]];
      if (argv[0] === 'load') {
        loaded = true;
        return [0, ['Loaded image: traefik:v3.1']];
      }
      return undefined;
    });
    const h = await openAgentStream(db, serverId, 'image.load', { expectTag: EXPECT_TAG, expectId: ID });
    if (h.direction !== 'panel-to-agent') throw new Error('direction');
    h.writable.end(gzipSync(dockerSaveArchive()));
    await expect(h.done).rejects.toThrow(/SECURITY: the image archive tagged "traefik:v3\.1"/);
    expect(argvs()).toContainEqual(['tag', OLD, 'traefik:v3.1']);
    expect(argvs()).not.toContainEqual(['tag', ID, EXPECT_TAG]);
  });

  it('image.load: an archive carrying a foreign tag never reaches docker load', async () => {
    const db = await migratedDb();
    const serverId = await nodeRow(db);
    const h = await openAgentStream(db, serverId, 'image.load', { expectTag: EXPECT_TAG, expectId: ID });
    if (h.direction !== 'panel-to-agent') throw new Error('direction');
    h.writable.end(gzipSync(dockerSaveArchive({ repoTags: ['traefik:v3.1'] })));
    await expect(h.done).rejects.toThrow(/carries the tag "traefik:v3\.1"/);
    expect(argvs().some((a) => a[0] === 'load')).toBe(false);
  });

  it('volume.export and volume.import: the panel-host archive format and restore script, refused while in use', async () => {
    const db = await migratedDb();
    const serverId = await nodeRow(db);
    const tgz = gzipSync(Buffer.from('volume tar'));
    streamMock.mockImplementation(() => fakeSource([tgz]));
    const out = await openAgentStream(db, serverId, 'volume.export', { volume: 'nd-svc-web-data' });
    if (out.direction !== 'agent-to-panel') throw new Error('direction');
    const got: Buffer[] = [];
    for await (const c of out.readable) got.push(c as Buffer);
    expect(Buffer.concat(got).equals(tgz)).toBe(true);
    expect(await out.done).toMatchObject({ result: { volume: 'nd-svc-web-data' } });
    expect(streamMock.mock.calls[0]![1]).toEqual(['run', '--rm', '--network', 'none', '-v', 'nd-svc-web-data:/v:ro', 'alpine:3.21', 'tar', '-czf', '-', '-C', '/v', '.']);

    const cid = 'c'.repeat(64);
    dockerFake((argv) => (argv[0] === 'create' ? [0, [cid]] : undefined));
    const into = await openAgentStream(db, serverId, 'volume.import', { volume: 'nd-db-pg-data' });
    if (into.direction !== 'panel-to-agent') throw new Error('direction');
    into.writable.end(tgz);
    expect(await into.done).toMatchObject({ result: { volume: 'nd-db-pg-data' } });
    const calls = argvs();
    const create = calls.find((a) => a[0] === 'create')!;
    expect(create.slice(0, 8)).toEqual(['create', '--network', 'none', '-v', 'nd-db-pg-data:/v', 'alpine:3.21', 'sh', '-c']);
    expect(create[8]).toMatch(/^set -e\ntar -tzf \/tmp\/ninedeploy-volume\.tar\.gz/);
    expect(calls).toContainEqual(['cp', expect.stringMatching(/\.part$/), `${cid}:/tmp/ninedeploy-volume.tar.gz`]);
    expect(calls).toContainEqual(['start', '-a', cid]);
    expect(calls.at(-1)).toEqual(['rm', '-f', cid]);

    dockerFake((argv) => (argv[0] === 'ps' ? [0, ['abcdef0123456789']] : undefined));
    await expect(openAgentStream(db, serverId, 'volume.import', { volume: 'nd-db-pg-data' })).rejects.toThrow(/in use by a running container/);
    dockerFake((argv) => (argv[1] === 'inspect' ? [1, []] : undefined));
    await expect(openAgentStream(db, serverId, 'volume.export', { volume: 'nd-svc-gone-data' })).rejects.toThrow(/does not exist on this node/);
  });

  it('the size limit holds on the agent: a source past maxBytes fails the stream', async () => {
    const db = await migratedDb();
    const serverId = await nodeRow(db);
    dockerFake((argv) => (argv[1] === 'inspect' ? [0, [ID]] : undefined));
    const src = fakeSource([Buffer.alloc(5000, 1)]);
    streamMock.mockImplementation(() => src);
    const h = await openAgentStream(db, serverId, 'volume.export', { volume: 'nd-svc-web-data' }, { maxBytes: 100 });
    if (h.direction !== 'agent-to-panel') throw new Error('direction');
    h.readable.on('error', () => undefined);
    h.readable.resume();
    await expect(h.done).rejects.toThrow(/exceeded its 100-byte limit/);
  });
});

describe('the stream channel on the agent: sealed, single use, verified before anything is applied', () => {
  const salted = async (params: Record<string, unknown>) => {
    const res = await sealedOp('stream.open', params);
    expect(res.status).toBe(200);
    return parseStreamChannel(res.lines)!;
  };
  const connect = (channel: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agent/stream`, [`ninedeploy.agent-stream.${channel}`]);
    ws.binaryType = 'arraybuffer';
    sockets.push(ws);
    const frames: Buffer[] = [];
    ws.addEventListener('message', (ev) => frames.push(Buffer.from(ev.data as ArrayBuffer)));
    const opened = new Promise<void>((r) => ws.addEventListener('open', () => r()));
    const closed = new Promise<number>((r) => ws.addEventListener('close', (ev) => r(ev.code)));
    return { ws, frames, opened, closed };
  };

  it('stream.open is refused over the unencrypted transport, before any kind is validated', async () => {
    const res = await plainOp('stream.open', { kind: 'volume.export', volume: 'nd-svc-web-data', maxBytes: 10 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/unencrypted transport/);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(stream.streamChannelCount()).toBe(0);
  });

  it('refuses unknown kinds, a wrong direction, a bad size, extra params, and more than 4 channels', async () => {
    expect((await sealedOp('stream.open', { kind: 'host.cat', maxBytes: 10 })).error?.message).toMatch(/Invalid stream kind/);
    expect((await sealedOp('stream.open', { kind: 'volume.export', direction: 'panel-to-agent', volume: 'nd-svc-a', maxBytes: 10 })).error?.message).toMatch(/direction/);
    expect((await sealedOp('stream.open', { kind: 'volume.export', volume: 'nd-svc-a', maxBytes: 2 ** 41 })).error?.message).toMatch(/maxBytes/);
    expect((await sealedOp('stream.open', { kind: 'volume.export', volume: 'nd-svc-a', maxBytes: 10, cmd: 'sh' })).error?.message).toMatch(/Invalid stream param: cmd/);
    expect((await sealedOp('stream.open', { kind: 'volume.export', volume: '/etc', maxBytes: 10 })).error?.message).toMatch(/volume name/);
    for (let i = 0; i < stream.STREAM_MAX_CHANNELS; i++) await salted({ kind: 'volume.export', volume: 'nd-svc-a', maxBytes: 10 });
    expect((await sealedOp('stream.open', { kind: 'volume.export', volume: 'nd-svc-a', maxBytes: 10 })).error?.message).toMatch(/at most 4/);
  });

  it('a channel is single use; an unknown one closes 1008; nothing starts before the panel authenticates', async () => {
    streamMock.mockImplementation(() => fakeSource([Buffer.from('x')]));
    const ch = await salted({ kind: 'volume.export', volume: 'nd-svc-a', maxBytes: 10 });
    expect(await connect('0'.repeat(32)).closed).toBe(1008);
    const first = connect(ch.channel);
    await first.opened;
    expect(await connect(ch.channel).closed).toBe(1008);
    expect(streamMock).not.toHaveBeenCalled();
    // A peer without the key (a terminal-domain key) is closed, and nothing ran.
    const wrong = new cipher.FrameSealer(cipher.deriveFrameKey(TOKEN_HASH, ch.salt), 'panel');
    first.ws.send(wrong.seal(cipher.STREAM_FRAME_TYPE.resume));
    expect(await first.closed).toBe(1008);
    expect(streamMock).not.toHaveBeenCalled();
    expect(stream.streamChannelCount()).toBe(0);
  });

  it('an upload whose end hash does not match is refused and never applied; the file is removed', async () => {
    const ch = await salted({ kind: 'image.load', expectTag: EXPECT_TAG, expectId: ID, maxBytes: 1_000_000 });
    const c = connect(ch.channel);
    await c.opened;
    const key = cipher.deriveFrameKey(TOKEN_HASH, ch.salt, cipher.STREAM_HKDF_INFO);
    const tx = new cipher.FrameSealer(key, 'panel');
    const gz = gzipSync(dockerSaveArchive());
    c.ws.send(tx.seal(cipher.STREAM_FRAME_TYPE.resume));
    for (const f of tx.sealData(gz)) c.ws.send(f);
    c.ws.send(tx.seal(cipher.STREAM_FRAME_TYPE.end, cipher.encodeStreamEnd({ bytes: gz.length, sha256: 'f'.repeat(64) })));
    expect(await c.closed).toBe(1011);
    const rx = new cipher.FrameOpener(key, 'agent', cipher.STREAM_FRAME_TYPES);
    const last = rx.open(c.frames.at(-1)!);
    expect(last.type).toBe(cipher.STREAM_FRAME_TYPE.error);
    expect(cipher.decodeStreamError(last.payload)).toMatch(/truncated or altered/);
    expect(argvs().some((a) => a[0] === 'load')).toBe(false);
    expect(readdirOrEmpty(path.join(work, '.agent-work', '.transfer'))).toEqual([]);
  });

  it('a pending channel nobody attaches closes after 30 s; the hard cap is 6 h', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const lines: string[] = [];
      await agent.runOp('stream.open', { kind: 'volume.export', volume: 'nd-svc-a', maxBytes: 10 }, (l) => lines.push(l), { sealed: true });
      expect(parseStreamChannel(lines)).not.toBeNull();
      expect(stream.streamChannelCount()).toBe(1);
      vi.advanceTimersByTime(stream.STREAM_CHANNEL_TTL_MS + 1);
      expect(stream.streamChannelCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    expect(STREAM_HARD_CAP_MS).toBe(6 * 3600 * 1000);
  });

  it('the transfer sweep removes files older than 6 h and keeps the rest', () => {
    const dir = path.join(work, '.agent-work', '.transfer');
    expect(stream.sweepTransferDir(dir)).toBe(0); // no directory: nothing, and nothing created
    expect(existsSync(dir)).toBe(false);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'old.part'), 'x');
    writeFileSync(path.join(dir, 'new.part'), 'x');
    const old = new Date(Date.now() - stream.TRANSFER_MAX_AGE_MS - 60_000);
    utimesSync(path.join(dir, 'old.part'), old, old);
    expect(stream.sweepTransferDir(dir)).toBe(1);
    expect(readdirOrEmpty(dir)).toEqual(['new.part']);
  });
});

describe('the panel side refuses a lying agent', () => {
  /** The panel's socket, with the test playing the agent. */
  function fakeSocket() {
    const listeners: Record<string, Array<(ev?: unknown) => void>> = {};
    const sent: Buffer[] = [];
    const s = {
      readyState: 1,
      bufferedAmount: 0,
      binaryType: '',
      send: (d: Uint8Array) => void sent.push(Buffer.from(d)),
      close: () => {
        s.readyState = 3;
      },
      addEventListener: (type: string, cb: (ev?: unknown) => void) => {
        listeners[type] = [...(listeners[type] ?? []), cb];
      },
      emit: (type: string, ev?: unknown) => {
        for (const cb of listeners[type] ?? []) cb(ev);
      },
      sent,
    };
    return s;
  }

  it('an end frame whose sha256 does not match what arrived rejects the stream (integrity)', async () => {
    const db = await migratedDb();
    const serverId = await nodeRow(db);
    const salt = Buffer.alloc(32, 3);
    const socket = fakeSocket();
    const caller = async (op: string) => ({
      exitCode: 0,
      lines:
        op === 'agent.ping'
          ? [`ND-AGENT ${JSON.stringify({ version: '0.15.2', caps: [...CAPS_015_PING, 'stream', 'image.manage'] })}`]
          : [`ND-STREAM ${JSON.stringify({ channel: '1'.repeat(32), salt: salt.toString('base64') })}`],
    });
    const opening = openAgentStream(db, serverId, 'image.save', { image: 'x' }, {
      agent: caller,
      socketFactory: () => {
        setTimeout(() => socket.emit('open'), 5);
        return socket as never;
      },
    });
    const h = await opening;
    if (h.direction !== 'agent-to-panel') throw new Error('direction');
    h.readable.on('error', () => undefined);
    const key = cipher.deriveFrameKey(TOKEN_HASH, salt, cipher.STREAM_HKDF_INFO);
    // The panel's first frame is `resume` (it authenticates the channel).
    expect(new cipher.FrameOpener(key, 'panel', cipher.STREAM_FRAME_TYPES).open(socket.sent[0]!).type).toBe(cipher.STREAM_FRAME_TYPE.resume);
    const tx = new cipher.FrameSealer(key, 'agent');
    socket.emit('message', { data: new Uint8Array(tx.seal(cipher.STREAM_FRAME_TYPE.data, Buffer.from('abc'))) });
    socket.emit('message', { data: new Uint8Array(tx.seal(cipher.STREAM_FRAME_TYPE.end, cipher.encodeStreamEnd({ bytes: 4, sha256: 'a'.repeat(64) }))) });
    await expect(h.done).rejects.toMatchObject({ reason: 'integrity' });
  });

  it('a socket closing before the end frame rejects (truncation), and a forged frame fails the cipher', async () => {
    const db = await migratedDb();
    const serverId = await nodeRow(db);
    const salt = Buffer.alloc(32, 4);
    for (const scenario of ['close', 'forged'] as const) {
      const socket = fakeSocket();
      const caller = async (op: string) => ({
        exitCode: 0,
        lines:
          op === 'agent.ping'
            ? [`ND-AGENT ${JSON.stringify({ version: '0.15.2', caps: ['stream', 'volume.manage'] })}`]
            : [`ND-STREAM ${JSON.stringify({ channel: '2'.repeat(32), salt: salt.toString('base64') })}`],
      });
      const h = await openAgentStream(db, serverId, 'volume.import', { volume: 'nd-svc-a' }, {
        agent: caller,
        socketFactory: () => {
          setTimeout(() => socket.emit('open'), 5);
          return socket as never;
        },
      });
      if (h.direction !== 'panel-to-agent') throw new Error('direction');
      h.writable.on('error', () => undefined);
      if (scenario === 'close') {
        socket.emit('close');
        await expect(h.done).rejects.toMatchObject({ reason: 'closed' });
      } else {
        const evil = new cipher.FrameSealer(cipher.deriveFrameKey(TOKEN_HASH, salt), 'agent'); // terminal domain
        socket.emit('message', { data: new Uint8Array(evil.seal(cipher.STREAM_FRAME_TYPE.end, Buffer.from('{}'))) });
        await expect(h.done).rejects.toMatchObject({ reason: 'cipher' });
      }
    }
  });
});

describe('docker.runSpec (§1.6): a validated spec, never an argv', () => {
  const base = { name: 'web-7', image: 'ninedeploy/web:abc', envFile: '.agent-env/web-7.env', network: 'ninedeploy' };

  it('builds the argv from literal flags and validated operands; labels always carry the r593 recovery labels', () => {
    const spec = parseRunSpec({
      ...base,
      restart: 'on-failure',
      volumes: [{ name: 'nd-svc-web-data', mount: '/data' }, { name: 'nd-db-pg-data', mount: '/pg', readOnly: true }],
      dockerSocket: true,
      cmd: ['node', '--max-old-space-size=256', 'server.js; rm -rf /'],
      labels: { 'ninedeploy.role': 'web' },
      publish: '8080:3000',
      cpuShares: 512,
      cpuLimitMilli: 1500,
      memLimitMb: 256,
      deploymentId: 9,
      serviceId: 3,
    });
    expect(runSpecArgv(spec, 'run')).toEqual([
      'run', '-d', '--name', 'web-7', '--restart', 'on-failure', '--network', 'ninedeploy',
      '--label', 'ninedeploy.managed=service', '--label', 'ninedeploy.role=web', '--label', 'ninedeploy.deployment=9', '--label', 'ninedeploy.service=3',
      '--cpu-shares', '512', '--cpus', '1.5', '--memory', '256m', '--memory-swap', '256m',
      '-v', 'nd-svc-web-data:/data', '-v', 'nd-db-pg-data:/pg:ro', '-v', '/var/run/docker.sock:/var/run/docker.sock',
      '--env-file', '.agent-env/web-7.env', '-p', '8080:3000',
      'ninedeploy/web:abc', 'node', '--max-old-space-size=256', 'server.js; rm -rf /',
    ]);
  });

  it.each([
    [{ ...base, extra: 1 }, /runSpec field: extra/],
    [{ ...base, name: '-rm' }, /Invalid name/],
    [{ ...base, image: '--privileged' }, /Invalid image/],
    [{ ...base, envFile: '/etc/passwd' }, /env file/],
    [{ ...base, envFile: '.agent-env/../x.env' }, /env file/],
    [{ ...base, network: 'host' }, /network/],
    [{ ...base, extraNetworks: ['ninedeploy'] }, /extra network/],
    [{ ...base, extraNetworks: Array.from({ length: 9 }, (_, i) => `nd-n${i}`) }, /extraNetworks/],
    [{ ...base, volumes: [{ name: '/var/lib', mount: '/x' }] }, /volume name/],
    [{ ...base, volumes: [{ name: 'mydata', mount: '/x' }] }, /volume name/],
    [{ ...base, volumes: [{ name: 'nd-svc-a', mount: 'relative' }] }, /mount path/],
    [{ ...base, volumes: [{ name: 'nd-svc-a', mount: '/x:/y' }] }, /mount path/],
    [{ ...base, volumes: [{ name: 'nd-svc-a', mount: '/a/../etc' }] }, /mount path/],
    [{ ...base, volumes: [{ name: 'nd-svc-a', mount: '/x', rw: true }] }, /volume field/],
    [{ ...base, cmd: 'sh -c x' }, /Invalid cmd/],
    [{ ...base, cmd: Array.from({ length: 65 }, () => 'a') }, /Invalid cmd/],
    [{ ...base, cmd: ['a\0b'] }, /cmd element/],
    [{ ...base, labels: { 'com.evil': 'x' } }, /label/],
    [{ ...base, labels: { 'ninedeploy.managed': 'database' } }, /label/],
    [{ ...base, publish: '0:80' }, /publish/],
    [{ ...base, restart: 'sometimes' }, /restart/],
    [{ ...base, memLimitMb: '256' }, /memLimitMb/],
    [{ ...base, managed: 'proxy' }, /managed/],
  ])('refuses %j', (spec, message) => {
    expect(() => parseRunSpec(spec as Record<string, unknown>)).toThrow(message);
  });

  it("refuses the Docker socket when the node's owner turned it off", () => {
    expect(() => parseRunSpec({ ...base, dockerSocket: true }, { NINEDEPLOY_AGENT_DOCKER_SOCKET: 'off' })).toThrow(/NINEDEPLOY_AGENT_DOCKER_SOCKET=off/);
    expect(parseRunSpec({ ...base, dockerSocket: false }, { NINEDEPLOY_AGENT_DOCKER_SOCKET: 'off' }).dockerSocket).toBe(false);
  });

  it('is sealed only; extra networks run as create → connect each → start', async () => {
    const plain = await plainOp('docker.runSpec', base);
    expect(plain.statusCode).toBe(400);
    expect(spawnMock).not.toHaveBeenCalled();
    expect((await sealedOp('docker.runSpec', { ...base, extraNetworks: ['nd-dbnet-pg'] })).exitCode).toBe(0);
    expect(argvs().map((a) => a[0])).toEqual(['create', 'network', 'start']);
    expect(argvs()[1]).toEqual(['network', 'connect', 'nd-dbnet-pg', 'web-7']);
    spawnMock.mockClear();
    dockerFake((argv) => (argv[0] === 'network' ? [1, ['no such network']] : undefined));
    expect((await sealedOp('docker.runSpec', { ...base, extraNetworks: ['nd-dbnet-pg'] })).exitCode).toBe(1);
    expect(argvs().at(-1)).toEqual(['rm', '-f', 'web-7']);
  });
});

describe('volume.manage and image.manage ops', () => {
  it('docker.volumeCreate: managed names only, labels validated, ifExists fail', async () => {
    expect((await sealedOp('docker.volumeCreate', { name: 'nd-db-pg-data', labels: { 'ninedeploy.managed': 'database' } })).exitCode).toBe(0);
    expect(argvs()).toEqual([['volume', 'create', '--label', 'ninedeploy.managed=database', 'nd-db-pg-data']]);
    expect((await sealedOp('docker.volumeCreate', { name: 'pgdata' })).error?.message).toMatch(/volume name/);
    expect((await sealedOp('docker.volumeCreate', { name: 'nd-db-a', labels: { owner: 'x' } })).error?.message).toMatch(/label/);
    spawnMock.mockClear();
    const exists = await sealedOp('docker.volumeCreate', { name: 'nd-db-pg-data', ifExists: 'fail' });
    expect([exists.exitCode, exists.lines]).toEqual([3, ['ND-VOLUME-EXISTS nd-db-pg-data']]);
    expect(argvs()).toEqual([['volume', 'inspect', 'nd-db-pg-data']]);
    // Not sealed-only: an unsealed panel may list volumes.
    spawnMock.mockClear();
    expect((await plainOp('docker.volumeList', {})).statusCode).toBe(200);
    expect(argvs()).toEqual([['volume', 'ls', '--format', '{{json .}}']]);
  });

  it('image ops: tags are written only into service or registry repositories, never infrastructure', async () => {
    expect((await sealedOp('docker.imageInspect', { image: 'ninedeploy/web:abc' })).exitCode).toBe(0);
    expect((await sealedOp('docker.imageRm', { image: 'ninedeploy/web:abc-b6' })).exitCode).toBe(0);
    expect((await sealedOp('docker.tag', { source: ID, target: 'registry.example.com/team/web:abc-b7' })).exitCode).toBe(0);
    expect((await sealedOp('docker.push', { image: 'registry.example.com/team/web:abc-b7' })).exitCode).toBe(0);
    expect(argvs()).toEqual([
      ['image', 'inspect', '--format', '{{.Id}}|{{.Size}}', 'ninedeploy/web:abc'],
      ['image', 'rm', 'ninedeploy/web:abc-b6'],
      ['tag', ID, 'registry.example.com/team/web:abc-b7'],
      ['push', 'registry.example.com/team/web:abc-b7'],
    ]);
    expect(spawnMock.mock.calls.at(-1)![3]).toEqual({ timeoutMs: 30 * 60 * 1000 });
    spawnMock.mockClear();
    for (const [op, params, message] of [
      ['docker.tag', { source: ID, target: 'traefik:v3.1' }, /only ninedeploy/],
      ['docker.tag', { source: ID, target: 'ghcr.io/ninedeploy/ninedeploy:v0.15.1' }, /node's own infrastructure/],
      ['docker.tag', { source: ID, target: 'docker.io/library/alpine:3.21' }, /node's own infrastructure/],
      ['docker.tag', { source: ID, target: 'ninedeploy/ninedeploy:latest' }, /node's own infrastructure/],
      ['docker.tag', { source: '-f', target: 'ninedeploy/web:x' }, /source image/],
      ['docker.imageRm', { image: 'traefik:v3.1' }, /only ninedeploy/],
      ['docker.imageRm', { image: ID }, /only ninedeploy/],
      ['docker.imageRm', { image: 'ninedeploy/web@sha256:abc' }, /name a tag/],
      ['docker.push', { image: 'ninedeploy/web:x' }, /registry-qualified/],
    ] as const) {
      expect((await sealedOp(op, params)).error?.message, `${op} ${JSON.stringify(params)}`).toMatch(message);
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

function readdirOrEmpty(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}
