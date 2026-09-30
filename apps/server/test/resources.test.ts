import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { systemRoutes } from '../src/modules/resources.js';
import { asUser, buildTestApp, createFakeDb } from './helpers.js';

const execMocks = vi.hoisted(() => ({
  capture: vi.fn(),
  run: vi.fn(async (_c: unknown, _a: unknown, _o: unknown, sink?: (l: string) => void) => { sink?.('out'); }),
}));
vi.mock('../src/lib/exec.js', () => execMocks);

const updateCheckMock = vi.hoisted(() => ({
  checkForUpdate: vi.fn(async () => ({
    current: '0.1.0', latest: '0.2.0', updateAvailable: true,
    notesUrl: 'https://github.com/ninedeploy/ninedeploy/releases/tag/v0.2.0',
    checkedAt: '2026-08-15T00:00:00Z',
  })),
}));
// Only checkForUpdate is stubbed; the real module's other exports (isNewer,
// used by lib/selfUpdate.js) stay live.
vi.mock('../src/lib/updateCheck.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/updateCheck.js')>()),
  ...updateCheckMock,
}));

// Mutable config so each test gets its own isolated data dir under os.tmpdir().
const configMock = vi.hoisted(() => ({
  wildcardDomain: '',
  isProd: false,
  publicUrl: 'http://localhost:3000',
  paths: {
    dataDir: '/tmp',
    dbFile: '/tmp/ninedeploy.db',
    masterKeyFile: '/tmp/master.key',
  },
}));
vi.mock('../src/config.js', () => ({ config: configMock }));

// createReadStream is NOT mocked: the route cleans its secret-bearing
// artifacts on the stream's 'close' (not in a finally that raced the open),
// and the export tests assert that contract against the real stream.
const fsMocks = vi.hoisted(() => ({
  // When set, renameSync calls whose destination path contains this substring throw.
  failRename: null as string | null,
  // Same idea for copyFileSync destinations.
  failCopy: null as string | null,
}));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    renameSync: (from: string, to: string) => {
      if (fsMocks.failRename && to.includes(fsMocks.failRename)) {
        throw Object.assign(new Error('EACCES: read-only file system'), { code: 'EACCES' });
      }
      return real.renameSync(from, to);
    },
    copyFileSync: (from: string, to: string) => {
      if (fsMocks.failCopy && to.includes(fsMocks.failCopy)) {
        throw Object.assign(new Error('EACCES: read-only file system'), { code: 'EACCES' });
      }
      return real.copyFileSync(from, to);
    },
  };
});

// Wrap the real child_process spawn so real tar runs, while tests can force
// failure via error/exit-code branches.
const spawnMock = vi.hoisted(() => ({
  force: { error: false, code: null as number | null },
  // Force failure on the Nth spawn (1-based) instead of the first — the import
  // path now spawns tar twice (member listing, then extraction).
  forceNth: null as number | null,
  calls: 0,
  spawn: null as unknown as (...a: unknown[]) => unknown,
}));
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  spawnMock.spawn = real.spawn;
  return {
    ...real,
    spawn: (cmd: string, args: string[], opts?: unknown) => {
      spawnMock.calls += 1;
      const nth = spawnMock.forceNth === spawnMock.calls;
      if ((spawnMock.force.error && !spawnMock.forceNth) || (nth && spawnMock.force.error)) {
        spawnMock.force.error = false;
        spawnMock.forceNth = null;
        return fakeChild((emit) => { emit('error', new Error('spawn failed')); });
      }
      if ((spawnMock.force.code !== null && !spawnMock.forceNth) || (nth && spawnMock.force.code !== null)) {
        const code = spawnMock.force.code;
        spawnMock.force.code = null;
        spawnMock.forceNth = null;
        return fakeChild((emit) => { emit('close', code); });
      }
      return spawnMock.spawn(cmd, args, opts);
    },
  };
});

type Emit = (ev: string, ...a: unknown[]) => void;
function fakeChild(trigger: (emit: Emit) => void) {
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  const emit: Emit = (ev, ...a) => { for (const cb of handlers[ev] ?? []) cb(...a); };
  // Minimal stdout stream so consumers attaching 'data' listeners don't crash.
  const stdoutHandlers: Array<(...a: unknown[]) => void> = [];
  queueMicrotask(() => trigger(emit));
  return {
    on: (ev: string, cb: (...a: unknown[]) => void) => { const list = (handlers[ev] ?? []); list.push(cb); handlers[ev] = list; },
    emit,
    stdout: { on: (ev: string, cb: (...a: unknown[]) => void) => { if (ev === 'data') stdoutHandlers.push(cb); } },
  };
}

const createdDirs: string[] = [];

function newDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-res-'));
  createdDirs.push(dir);
  configMock.paths.dataDir = dir;
  configMock.paths.dbFile = path.join(dir, 'ninedeploy.db');
  configMock.paths.masterKeyFile = path.join(dir, 'master.key');
  return dir;
}

function tar(dir: string, out: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // cwd = os.tmpdir() keeps BOTH paths relative (GNU tar on Windows mistakes
    // `D:\…` for a remote-host spec) and the archive stays outside the
    // archived directory.
    const rel = (p: string) => path.relative(os.tmpdir(), p).split(path.sep).join('/');
    const child = spawnMock.spawn('tar', ['-czf', rel(out), '-C', rel(dir), '.'], { cwd: os.tmpdir() });
    child.on('close', (code: number) => (code === 0 ? resolve() : reject(new Error(`tar ${code}`))));
    child.on('error', reject);
  });
}

/** Build a tar.gz archive from `dir` and return its raw bytes as a Buffer. */
async function makeArchive(dir: string): Promise<Buffer> {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-up-'));
  createdDirs.push(uploadDir);
  const archive = path.join(uploadDir, 'upload.tar.gz');
  await tar(dir, archive);
  return fs.readFileSync(archive);
}

async function appWith(fixtures: Record<string, unknown> = {}) {
  const app = await buildTestApp({ db: createFakeDb(fixtures as never), rawBody: true });
  await app.register(systemRoutes);
  return app;
}

/** Minimal USTAR+gzip archive carrying a single `../evil` member (one byte).
 *  Hand-built in-process: valid enough for GNU tar's extractor, and the test
 *  never executes a shell to create its fixture. */
function buildTarSlipFixture(): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write('../evil', 0);
  header.write('0000644\0', 100); // mode
  header.write('0000000\0', 108); // uid
  header.write('0000000\0', 116); // gid
  header.write('00000000001\0', 124); // size: 1
  header.write('00000000000\0', 136); // mtime
  header.write('        ', 148); // checksum placeholder (spaces)
  header.write('0', 156); // typeflag: regular file
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const data = Buffer.concat([Buffer.from('x'), Buffer.alloc(511)]);
  return gzipSync(Buffer.concat([header, data, Buffer.alloc(1024)]));
}

describe('system resources routes', () => {
  beforeEach(() => {
    newDataDir();
    vi.restoreAllMocks();
    spawnMock.calls = 0;
    spawnMock.forceNth = null;
    fsMocks.failRename = null;
    fsMocks.failCopy = null;
  });

  it('returns recent docker events (newest first, capped)', async () => {
    execMocks.capture.mockResolvedValueOnce(
      '1755000000|container|start|web-1\n1755000001|image|pull|nginx\n1755000002|network|create\n1755000003\n|attach|c-9\n\n',
    );
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(systemRoutes);
    const res = await app.inject({ method: 'GET', url: '/docker-events?minutes=30', headers: asUser() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toHaveLength(5);
    expect(body.events[0]).toEqual({ time: '', type: 'attach', action: 'c-9', name: '' });
    expect(body.events[1]).toEqual({ time: '1755000003', type: '', action: '', name: '' });
    expect(body.events[2]).toEqual({ time: '1755000002', type: 'network', action: 'create', name: '' });
    expect(execMocks.capture).toHaveBeenCalledWith(
      'docker',
      ['events', '--since', '30m', '--until', '0s', '--format', '{{.Time}}|{{.Type}}|{{.Action}}|{{.Actor.Attributes.name}}'],
    );
  });

  it('clamps the event window and tolerates docker failures', async () => {
    execMocks.capture.mockRejectedValueOnce(new Error('docker down'));
    const app = await buildTestApp({ db: createFakeDb() });
    await app.register(systemRoutes);
    const huge = await app.inject({ method: 'GET', url: '/docker-events?minutes=99999', headers: asUser() });
    expect(huge.json()).toEqual({ events: [] });
    const bogus = await app.inject({ method: 'GET', url: '/docker-events?minutes=abc', headers: asUser() });
    expect(bogus.json()).toEqual({ events: [] });
    const zero = await app.inject({ method: 'GET', url: '/docker-events?minutes=0', headers: asUser() });
    expect(zero.json()).toEqual({ events: [] });
    expect(execMocks.capture).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['events', '--since', '1440m']),
    );
  });

  afterAll(() => {
    for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports docker resources', async () => {
    execMocks.capture.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'system') {
        return Promise.resolve(
          '{"Type":"Images","Total":"3","Active":"2","Size":"1.2GB","Reclaimable":"300MB"}\n' +
            'not json\n' +
            '{"Type":"Containers","Total":"4"}\n',
        );
      }
      if (args[0] === 'images') {
        return Promise.resolve('nginx|latest|100MB\nredis|7|50MB\n');
      }
      if (args[0] === 'ps') return Promise.resolve('c1\nc2\n');
      return Promise.resolve('v1\nv2\nv3\n');
    });
    const app = await appWith();
    const res = await app.inject({ method: 'GET', url: '/resources', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      network: 'ninedeploy',
      containers: 2,
      volumes: 3,
      imagesSummary: { total: '3', active: '2', size: '1.2GB', reclaimable: '300MB' },
      images: [
        { repo: 'nginx', tag: 'latest', size: '100MB' },
        { repo: 'redis', tag: '7', size: '50MB' },
      ],
    });
  });

  it('falls back to defaults for sparse docker output', async () => {
    execMocks.capture.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'system') {
        return Promise.resolve('{"Type":"Images"}\n');
      }
      if (args[0] === 'images') {
        return Promise.resolve('repo-only\n|\n');
      }
      if (args[0] === 'ps') return Promise.resolve('');
      return Promise.resolve('');
    });
    const app = await appWith();
    const res = await app.inject({ method: 'GET', url: '/resources', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      containers: 0,
      volumes: 0,
      imagesSummary: { total: '0', active: '0', size: '—', reclaimable: '—' },
      images: [
        { repo: 'repo-only', tag: '', size: '' },
        { repo: '', tag: '', size: '' },
      ],
    });
  });

  it('falls back to defaults when docker is unavailable', async () => {
    execMocks.capture.mockRejectedValue(new Error('docker not found'));
    const app = await appWith();
    const res = await app.inject({ method: 'GET', url: '/resources', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      containers: 0,
      volumes: 0,
      imagesSummary: { total: '0', active: '0', size: '—', reclaimable: '—' },
      images: [],
    });
  });

  it('prunes images', async () => {
    const app = await appWith();
    const res = await app.inject({ method: 'POST', url: '/prune-images', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(execMocks.run).toHaveBeenCalled();
  });

  it('prune succeeds even when docker fails', async () => {
    execMocks.run.mockRejectedValueOnce(new Error('down'));
    const app = await appWith();
    const res = await app.inject({ method: 'POST', url: '/prune-images', headers: asUser() });
    expect(res.statusCode).toBe(200);
  });

  it('reports the update-check result (force flag forwarded)', async () => {
    const app = await appWith();
    const res = await app.inject({ method: 'GET', url: '/update-check', headers: asUser() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ current: '0.1.0', latest: '0.2.0', updateAvailable: true });
    expect(updateCheckMock.checkForUpdate).toHaveBeenCalledWith(false);
    const forced = await app.inject({ method: 'GET', url: '/update-check?force=1', headers: asUser() });
    expect(forced.statusCode).toBe(200);
    expect(updateCheckMock.checkForUpdate).toHaveBeenCalledWith(true);
  });

/** Wait (bounded) until pred() is true — 'close' fires a tick after the
 * response stream is consumed, so cleanup assertions need a short grace. */
async function soon(pred: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setImmediate(r));
  }
  return pred();
}

it('exports system state as a tar.gz and cleans up only after the stream closed', async () => {
  const dir = configMock.paths.dataDir;
  fs.writeFileSync(configMock.paths.dbFile, 'db-bytes');
  fs.writeFileSync(configMock.paths.masterKeyFile, 'key-bytes');
  fs.mkdirSync(path.join(dir, 'traefik'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'traefik', 'dynamic.yml'), 'http: {}');
  const app = await appWith({
    counts: {
      services: [{ n: 2 }],
      databases: [{ n: 1 }],
      deployments: [{ n: 4 }],
      users: [{ n: 1 }],
    },
  });
  const res = await app.inject({ method: 'GET', url: '/export', headers: asUser() });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toContain('application/gzip');
  expect(res.headers['content-disposition']).toContain('ninedeploy-backup-');
  // A real payload came through the stream (the old test mocked the stream
  // away precisely because the finally deleted the file before it opened).
  expect(res.rawPayload.length).toBeGreaterThan(0);
  // Every stamped artifact — archive, meta, env copy — is gone once the
  // stream has closed; none of the secret-bearing files may outlive the
  // download.
  const leftovers = () =>
    fs.readdirSync(dir).filter((f) => f.startsWith('ninedeploy-backup-') || f.startsWith('_meta-') || f.startsWith('_env-') || f.startsWith('_db-'));
  expect(await soon(() => leftovers().length === 0)).toBe(true);
});

  it('includes the cwd .env file when present', async () => {
    const oldCwd = process.cwd();
    const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-cwd-'));
    createdDirs.push(cwdDir);
    try {
      process.chdir(cwdDir);
      fs.writeFileSync(path.join(cwdDir, '.env'), 'SECRET=1');
      const app = await appWith({ counts: {} });
      const res = await app.inject({ method: 'GET', url: '/export', headers: asUser() });
      expect(res.statusCode).toBe(200);
      const envLeft = () => fs.readdirSync(configMock.paths.dataDir).some((f) => f.startsWith('_env-'));
      expect(await soon(() => !envLeft())).toBe(true);
    } finally {
      process.chdir(oldCwd);
    }
  });

  it('reports a 500 when tar fails', async () => {
    fs.writeFileSync(configMock.paths.dbFile, 'db');
    spawnMock.force.error = true;
    const app = await appWith({ counts: {} });
    const res = await app.inject({ method: 'GET', url: '/export', headers: asUser() });
    expect(res.statusCode).toBe(500);
  });

  it('reports a 500 when tar exits non-zero', async () => {
    fs.writeFileSync(configMock.paths.dbFile, 'db');
    spawnMock.force.code = 1;
    const app = await appWith({ counts: {} });
    const res = await app.inject({ method: 'GET', url: '/export', headers: asUser() });
    expect(res.statusCode).toBe(500);
  });

  it('rejects an import with no body', async () => {
    const app = await appWith();
    const res = await app.inject({ method: 'POST', url: '/import', headers: asUser() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });

  it('rejects an archive without _meta.json', async () => {
    const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-build-'));
    createdDirs.push(buildDir);
    fs.writeFileSync(path.join(buildDir, 'hello.txt'), 'hi');
    const body = await makeArchive(buildDir);
    const app = await appWith();
    const res = await app.inject({
      method: 'POST',
      url: '/import',
      headers: { 'content-type': 'application/octet-stream', ...asUser() },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('Invalid archive');
  });

  it('reports a 500 when tar extraction fails', async () => {
    const app = await appWith();
    const res = await app.inject({
      method: 'POST',
      url: '/import',
      headers: { 'content-type': 'application/octet-stream', ...asUser() },
      payload: Buffer.from('this is not a tar archive'),
    });
    expect(res.statusCode).toBe(500);
  });

  it('imports a full system state and stops the worker', async () => {
    const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-build-'));
    createdDirs.push(buildDir);
    const dir = configMock.paths.dataDir;
    fs.mkdirSync(path.join(dir, 'traefik'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'traefik', 'dynamic.yml'), 'old');
    fs.writeFileSync(path.join(dir, 'ninedeploy.db'), 'old-db');
    fs.writeFileSync(path.join(dir, 'master.key'), 'old-key');

    fs.writeFileSync(path.join(buildDir, '_meta.json'), JSON.stringify({ version: '1.0.0', stats: {} }));
    fs.writeFileSync(path.join(buildDir, 'ninedeploy.db'), 'new-db');
    fs.writeFileSync(path.join(buildDir, 'master.key'), 'new-key');
    fs.writeFileSync(path.join(buildDir, '_env'), 'NEW=1');
    fs.mkdirSync(path.join(buildDir, 'traefik'));
    fs.writeFileSync(path.join(buildDir, 'traefik', 'dynamic.yml'), 'new');

    const body = await makeArchive(buildDir);

    const app = await appWith();
    app.decorate('worker', { stop: vi.fn(async () => undefined) });
    const oldCwd = process.cwd();
    const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-cwd-'));
    createdDirs.push(cwdDir);
    try {
      process.chdir(cwdDir);
      const res = await app.inject({
        method: 'POST',
        url: '/import',
        headers: { 'content-type': 'application/octet-stream', ...asUser() },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, meta: { version: '1.0.0' } });
      expect(fs.readFileSync(configMock.paths.dbFile, 'utf8')).toBe('new-db');
      expect(fs.readFileSync(configMock.paths.masterKeyFile, 'utf8')).toBe('new-key');
      expect(fs.readFileSync(path.join(dir, 'traefik', 'dynamic.yml'), 'utf8')).toBe('new');
      expect(fs.existsSync(path.join(dir, '_import'))).toBe(false);
      const worker = (app as unknown as { worker: { stop: ReturnType<typeof vi.fn> } }).worker;
      expect(worker.stop).toHaveBeenCalled();
    } finally {
      process.chdir(oldCwd);
    }
  });

  it('imports an export archive containing timestamp-stamped _meta and _env filenames', async () => {
    const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-build-'));
    createdDirs.push(buildDir);
    fs.writeFileSync(path.join(buildDir, '_meta-123-456.json'), JSON.stringify({ version: '1.0.0', stats: {} }));
    fs.writeFileSync(path.join(buildDir, 'ninedeploy.db'), 'stamped-db');
    fs.writeFileSync(path.join(buildDir, '_env-123-456'), 'STAMPED_ENV=1');
    const body = await makeArchive(buildDir);

    const oldCwd = process.cwd();
    const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-cwd-'));
    createdDirs.push(cwdDir);
    try {
      process.chdir(cwdDir);
      const app = await appWith();
      const res = await app.inject({
        method: 'POST',
        url: '/import',
        headers: { 'content-type': 'application/octet-stream', ...asUser() },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, meta: { version: '1.0.0' } });
      expect(fs.readFileSync(configMock.paths.dbFile, 'utf8')).toBe('stamped-db');
      expect(fs.readFileSync(path.join(cwdDir, '.env'), 'utf8')).toBe('STAMPED_ENV=1');
    } finally {
      process.chdir(oldCwd);
    }
  });

  it('imports a minimal archive without pre-existing state', async () => {
    const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-build-'));
    createdDirs.push(buildDir);
    fs.writeFileSync(path.join(buildDir, '_meta.json'), JSON.stringify({ version: '1.0.0', stats: {} }));
    fs.writeFileSync(path.join(buildDir, 'ninedeploy.db'), 'fresh-db');
    const body = await makeArchive(buildDir);

    const app = await appWith();
    const res = await app.inject({
      method: 'POST',
      url: '/import',
      headers: { 'content-type': 'application/octet-stream', ...asUser() },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(fs.readFileSync(configMock.paths.dbFile, 'utf8')).toBe('fresh-db');
  });

  it('imports a metadata-only archive', async () => {
    const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-build-'));
    createdDirs.push(buildDir);
    fs.writeFileSync(path.join(buildDir, '_meta.json'), JSON.stringify({ version: '1.0.0', stats: {} }));
    const body = await makeArchive(buildDir);

    const app = await appWith();
    const res = await app.inject({
      method: 'POST',
      url: '/import',
      headers: { 'content-type': 'application/octet-stream', ...asUser() },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(fs.existsSync(configMock.paths.dbFile)).toBe(false);
  });

  it('clears a crashed import leftover before reusing the scratch dir (no stale-db poisoning)', async () => {
    // A previous import that crashed between extraction and cleanup left its
    // `_db-<stamp>.db` / `_meta-<stamp>.json` in the FIXED `_import` dir. The
    // next import's prefix finds used to pick those up, silently swapping the
    // previous archive's database into place while auditing the new one.
    const dir = configMock.paths.dataDir;
    fs.mkdirSync(path.join(dir, '_import'), { recursive: true });
    fs.writeFileSync(path.join(dir, '_import', '_db-stale.db'), 'STALE-DB');
    fs.writeFileSync(path.join(dir, '_import', '_meta-stale.json'), JSON.stringify({ version: '0.0.0-stale' }));
    fs.writeFileSync(configMock.paths.dbFile, 'current-db');

    const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-build-'));
    createdDirs.push(buildDir);
    fs.writeFileSync(path.join(buildDir, '_meta.json'), JSON.stringify({ version: '9.9.9', stats: {} }));
    const body = await makeArchive(buildDir);

    const app = await appWith();
    const res = await app.inject({
      method: 'POST',
      url: '/import',
      headers: { 'content-type': 'application/octet-stream', ...asUser() },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    // The NEW archive's meta won the find — not the stale stamped one.
    expect(res.json().meta).toEqual({ version: '9.9.9', stats: {} });
    // And the stale database never moved into place.
    expect(fs.readFileSync(configMock.paths.dbFile, 'utf8')).toBe('current-db');
    expect(fs.existsSync(path.join(dir, '_import'))).toBe(false);
  });

  it('rejects an archive with malformed _meta.json and still cleans the scratch dir', async () => {
    const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-build-'));
    createdDirs.push(buildDir);
    fs.writeFileSync(path.join(buildDir, '_meta.json'), '{not json');
    const body = await makeArchive(buildDir);

    const app = await appWith();
    const res = await app.inject({
      method: 'POST',
      url: '/import',
      headers: { 'content-type': 'application/octet-stream', ...asUser() },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('_meta.json');
    // The JSON.parse used to reject with the extracted files still in place.
    expect(fs.existsSync(path.join(configMock.paths.dataDir, '_import'))).toBe(false);
  });

  it('rejects an archive with path-traversal members (tar-slip)', async () => {
    // Craft an archive with a literal `../evil` member, built in-process as a
    // minimal USTAR+gzip so the fixture never shells out.
    const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-slip-'));
    createdDirs.push(uploadDir);
    const archive = path.join(uploadDir, 'evil.tar.gz');
    fs.writeFileSync(archive, buildTarSlipFixture());

    const app = await appWith();
    const res = await app.inject({
      method: 'POST',
      url: '/import',
      headers: { 'content-type': 'application/octet-stream', ...asUser() },
      payload: fs.readFileSync(archive),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('unsafe member');
    // The extraction dir is cleaned up.
    expect(fs.existsSync(path.join(configMock.paths.dataDir, '_import'))).toBe(false);
  });

  it('fails the import when the EXTRACTION tar fails after a clean listing', async () => {    const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-build-'));
    createdDirs.push(buildDir);
    fs.writeFileSync(path.join(buildDir, '_meta.json'), JSON.stringify({ version: '1.0.0', stats: {} }));
    const body = await makeArchive(buildDir);

    // Spawn #1 (listing), spawn #2 (verbose listing) succeed; spawn #3 (extraction) fails.
    spawnMock.forceNth = 3;
    spawnMock.force.code = 2;

    const app = await appWith();
    const res = await app.inject({
      method: 'POST',
      url: '/import',
      headers: { 'content-type': 'application/octet-stream', ...asUser() },
      payload: body,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.message).toContain('tar extract exited 2');
    await app.close();
  });

  it('rolls the original state back when a move fails midway (import rollback)', async () => {
    // Existing state that must survive a failed import.
    const dir = configMock.paths.dataDir;
    fs.mkdirSync(path.join(dir, 'traefik'), { recursive: true });
    fs.writeFileSync(configMock.paths.dbFile, 'original-db');
    fs.writeFileSync(configMock.paths.masterKeyFile, 'original-key');

    // Build a full bundle (db + key).
    const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-build-'));
    createdDirs.push(buildDir);
    fs.writeFileSync(path.join(buildDir, '_meta.json'), JSON.stringify({ version: '1.0.0', stats: {} }));
    fs.writeFileSync(path.join(buildDir, 'ninedeploy.db'), 'imported-db');
    fs.writeFileSync(path.join(buildDir, 'master.key'), 'imported-key');
    const body = await makeArchive(buildDir);

    // Fail the SECOND move (master.key) — after the db was already replaced.
    fsMocks.failRename = 'master.key';
    try {
      const app = await appWith();
      const res = await app.inject({
        method: 'POST',
        url: '/import',
        headers: { 'content-type': 'application/octet-stream', ...asUser() },
        payload: body,
      });
      expect(res.statusCode).toBe(500);

      // Rollback: the ORIGINAL db and key are back in place.
      expect(fs.readFileSync(configMock.paths.dbFile, 'utf8')).toBe('original-db');
      expect(fs.readFileSync(configMock.paths.masterKeyFile, 'utf8')).toBe('original-key');
      await app.close();
    } finally {
      fsMocks.failRename = null;
    }
  });

  it('rolls back traefik and .env too when the LAST import step fails', async () => {
    const dir = configMock.paths.dataDir;
    fs.mkdirSync(path.join(dir, 'traefik'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'traefik', 'dynamic.yml'), 'original-routing');
    fs.writeFileSync(configMock.paths.dbFile, 'original-db');
    fs.writeFileSync(configMock.paths.masterKeyFile, 'original-key');

    const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-build-'));
    createdDirs.push(buildDir);
    fs.writeFileSync(path.join(buildDir, '_meta.json'), JSON.stringify({ version: '1.0.0', stats: {} }));
    fs.writeFileSync(path.join(buildDir, 'ninedeploy.db'), 'imported-db');
    fs.writeFileSync(path.join(buildDir, 'master.key'), 'imported-key');
    fs.writeFileSync(path.join(buildDir, '_env'), 'IMPORTED=1');
    fs.mkdirSync(path.join(buildDir, 'traefik'));
    fs.writeFileSync(path.join(buildDir, 'traefik', 'dynamic.yml'), 'imported-routing');
    const body = await makeArchive(buildDir);

    const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-cwd-'));
    createdDirs.push(cwdDir);
    fs.writeFileSync(path.join(cwdDir, '.env'), 'ORIGINAL=1');
    const oldCwd = process.cwd();
    fsMocks.failCopy = '.env'; // the final step (copying the imported .env) fails
    try {
      process.chdir(cwdDir);
      const app = await appWith();
      const res = await app.inject({
        method: 'POST',
        url: '/import',
        headers: { 'content-type': 'application/octet-stream', ...asUser() },
        payload: body,
      });
      expect(res.statusCode).toBe(500);

      // Everything original is restored: db, key, traefik, and the .env.
      expect(fs.readFileSync(configMock.paths.dbFile, 'utf8')).toBe('original-db');
      expect(fs.readFileSync(configMock.paths.masterKeyFile, 'utf8')).toBe('original-key');
      expect(fs.readFileSync(path.join(dir, 'traefik', 'dynamic.yml'), 'utf8')).toBe('original-routing');
      expect(fs.readFileSync(path.join(cwdDir, '.env'), 'utf8')).toBe('ORIGINAL=1');
      await app.close();
    } finally {
      process.chdir(oldCwd);
      fsMocks.failCopy = null;
    }
  });

  it('imports an archive with a master key into a fresh data dir', async () => {
    const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-build-'));
    createdDirs.push(buildDir);
    fs.writeFileSync(path.join(buildDir, '_meta.json'), JSON.stringify({ version: '1.0.0', stats: {} }));
    fs.writeFileSync(path.join(buildDir, 'master.key'), 'fresh-key');
    const body = await makeArchive(buildDir);

    const app = await appWith();
    const res = await app.inject({
      method: 'POST',
      url: '/import',
      headers: { 'content-type': 'application/octet-stream', ...asUser() },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(fs.readFileSync(configMock.paths.masterKeyFile, 'utf8')).toBe('fresh-key');
  });

  it('imports an archive with a traefik dir into a fresh data dir', async () => {
    const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-build-'));
    createdDirs.push(buildDir);
    fs.writeFileSync(path.join(buildDir, '_meta.json'), JSON.stringify({ version: '1.0.0', stats: {} }));
    fs.mkdirSync(path.join(buildDir, 'traefik'));
    fs.writeFileSync(path.join(buildDir, 'traefik', 'dynamic.yml'), 'http: {}');
    const body = await makeArchive(buildDir);

    const app = await appWith();
    const res = await app.inject({
      method: 'POST',
      url: '/import',
      headers: { 'content-type': 'application/octet-stream', ...asUser() },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(configMock.paths.dataDir, 'traefik', 'dynamic.yml'), 'utf8')).toBe('http: {}');
  });

  it('imports an archive with _env into a cwd that has an .env', async () => {
    const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-build-'));
    createdDirs.push(buildDir);
    fs.writeFileSync(path.join(buildDir, '_meta.json'), JSON.stringify({ version: '1.0.0', stats: {} }));
    fs.writeFileSync(path.join(buildDir, '_env'), 'NEW=1');
    const body = await makeArchive(buildDir);

    const oldCwd = process.cwd();
    const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-cwd-'));
    createdDirs.push(cwdDir);
    fs.writeFileSync(path.join(cwdDir, '.env'), 'OLD=1');
    try {
      process.chdir(cwdDir);
      const app = await appWith();
      const res = await app.inject({
        method: 'POST',
        url: '/import',
        headers: { 'content-type': 'application/octet-stream', ...asUser() },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      expect(fs.readFileSync(path.join(cwdDir, '.env'), 'utf8')).toBe('NEW=1');
    } finally {
      process.chdir(oldCwd);
    }
  });
});

// ── r454: concurrent imports serialize on one scratch dir ─────────────
describe('import concurrency (r454)', () => {
  it('answers 409 while another import is in flight', async () => {
    const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-build-'));
    createdDirs.push(buildDir);
    fs.writeFileSync(path.join(buildDir, '_meta.json'), JSON.stringify({ version: '1.0.0', stats: {} }));
    const body = await makeArchive(buildDir);

    // Hold the FIRST import inside its member listing on a gated fake child:
    // the route's await pends until we emit 'close', so the in-flight flag is
    // observably set (no Promise.all ordering luck involved).
    const realSpawn = spawnMock.spawn;
    let gate: ((ev: string, code: number) => void) | null = null;
    let listings = 0;
    (spawnMock as unknown as { spawn: unknown }).spawn = (cmd: string, args: string[], opts?: unknown) => {
      if (cmd === 'tar' && args[0] === '-tzf' && listings === 0) {
        listings++;
        return fakeChild((emit) => {
          gate = emit as unknown as (ev: string, code: number) => void;
          // Intentionally emits nothing yet — the listing hangs.
        });
      }
      return realSpawn(cmd, args, opts);
    };
    const app = await appWith();
    try {
      const first = app.inject({
        method: 'POST', url: '/import',
        headers: { 'content-type': 'application/octet-stream', ...asUser() }, payload: body,
      });
      for (let spin = 0; gate === null && spin < 500; spin++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(gate).not.toBeNull();
      const second = await app.inject({
        method: 'POST', url: '/import',
        headers: { 'content-type': 'application/octet-stream', ...asUser() }, payload: body,
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().error.message).toContain('Another import');
      // Release the first: the empty gated listing has no unsafe members, so
      // the import proceeds through the REAL verbose/extract spawns to 200.
      gate!('close', 0);
      expect((await first).statusCode).toBe(200);
    } finally {
      (spawnMock as unknown as { spawn: unknown }).spawn = realSpawn;
      await app.close();
    }
  });
});
