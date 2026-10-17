import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EXCLUDES, UPLOAD_MAX_BYTES, deployUp, packDirectory } from '../src/commands/upload.js';

/** 0.16.1 `ninedeploy deploy up [path]`: pack, pick or create the service, upload, report. */

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'nd-cli-up-'));
  dirs.push(d);
  return d;
};

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    services: {
      list: vi.fn().mockResolvedValue([{ id: 4, slug: 'site', name: 'Site' }]),
      create: vi.fn().mockResolvedValue({ id: 9, slug: 'drop' }),
      uploadSource: vi.fn().mockResolvedValue({ sha: 'abcdef1234567890', entries: 3, deploymentId: 12 }),
    },
    ...overrides,
  };
}
const out = () => [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().join('\n');
const pack = vi.fn(async () => Buffer.from([0x1f, 0x8b, 1]));

beforeEach(() => {
  vi.clearAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('deployUp', () => {
  it('packs the folder with the default excludes and uploads it to the service named by slug', async () => {
    const client = makeClient();
    const dir = tmp();
    await deployUp(client as never, dir, { service: 'site', exclude: ['dist'] }, { pack });
    expect(pack).toHaveBeenCalledWith(path.resolve(dir), [...DEFAULT_EXCLUDES, 'dist']);
    expect(client.services.uploadSource).toHaveBeenCalledWith(4, new Uint8Array([0x1f, 0x8b, 1]), { deploy: true });
    expect(out()).toMatch(/Uploaded abcdef1 \(3 entries\)/);
    expect(out()).toMatch(/Deployment #12 queued/);
  });

  it('takes a numeric service id as is', async () => {
    const client = makeClient();
    await deployUp(client as never, tmp(), { service: '7' }, { pack });
    expect(client.services.list).not.toHaveBeenCalled();
    expect(client.services.uploadSource.mock.calls[0]![0]).toBe(7);
  });

  it('--create makes a docker service (with --port) and uploads to it', async () => {
    const client = makeClient();
    await deployUp(client as never, tmp(), { create: 'Drop', port: '8080' }, { pack });
    expect(client.services.create).toHaveBeenCalledWith({ name: 'Drop', type: 'docker', port: 8080 });
    expect(client.services.uploadSource.mock.calls[0]![0]).toBe(9);
  });

  it('--no-deploy only stores it and says how to deploy', async () => {
    const client = makeClient();
    client.services.uploadSource.mockResolvedValue({ sha: 'abcdef1234567890', entries: 1, deploymentId: null });
    await deployUp(client as never, tmp(), { service: '4', deploy: false }, { pack });
    expect(client.services.uploadSource.mock.calls[0]![2]).toEqual({ deploy: false });
    expect(out()).toMatch(/ninedeploy services deploy 4/);
  });

  it('sends a ready .zip as it is', async () => {
    const client = makeClient();
    const file = path.join(tmp(), 'app.zip');
    writeFileSync(file, Buffer.from([0x50, 0x4b, 3, 4]));
    await deployUp(client as never, file, { service: '4' }, { pack });
    expect(pack).not.toHaveBeenCalled();
    expect(client.services.uploadSource.mock.calls[0]![1]).toEqual(new Uint8Array([0x50, 0x4b, 3, 4]));
  });

  const refusals: Array<[string, () => Promise<void>, RegExp]> = [
    ['no service named', () => deployUp(makeClient() as never, tmp(), {}, { pack }), /--service <id\|slug>/],
    ['a missing path', () => deployUp(makeClient() as never, path.join(tmpdir(), 'nd-nope-404'), { service: '1' }, { pack }), /does not exist/],
    ['an unknown slug', () => deployUp(makeClient() as never, tmp(), { service: 'ghost' }, { pack }), /No service named "ghost"/],
    ['a bad port', () => deployUp(makeClient() as never, tmp(), { create: 'x', port: 'http' }, { pack }), /--port must be a port number/],
    [
      'a file that is no archive',
      async () => {
        const f = path.join(tmp(), 'notes.txt');
        writeFileSync(f, 'x');
        await deployUp(makeClient() as never, f, { service: '1' }, { pack });
      },
      /folder, a \.zip or a \.tar\.gz/,
    ],
    [
      'an archive over the limit',
      () => deployUp(makeClient() as never, tmp(), { service: '1' }, { pack: async () => Buffer.alloc(UPLOAD_MAX_BYTES + 1) }),
      /up to 100 MiB/,
    ],
  ];
  for (const [what, run, message] of refusals) {
    it(`refuses ${what}`, async () => {
      await run();
      expect(out()).toMatch(message);
      expect(process.exitCode).toBe(1);
    });
  }

  it("prints the panel's refusal", async () => {
    const client = makeClient();
    client.services.uploadSource.mockRejectedValue(new Error('Unsafe path in the archive: "../x"'));
    await deployUp(client as never, tmp(), { service: '4' }, { pack });
    expect(out()).toMatch(/Unsafe path/);
  });
});

describe('packDirectory', () => {
  it('packs the folder contents with system tar and leaves the excludes out', async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'Dockerfile'), 'FROM nginx\n');
    mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', 'x', 'i.js'), '1');
    writeFileSync(path.join(dir, '.env'), 'SECRET=1');
    const buf = await packDirectory(dir, DEFAULT_EXCLUDES);
    expect(buf[0]).toBe(0x1f);
    const extractTo = tmp();
    const file = path.join(extractTo, 'a.tar.gz');
    writeFileSync(file, buf);
    const listed = spawnSync('tar', ['-tzf', 'a.tar.gz'], { cwd: extractTo, encoding: 'utf8' }).stdout;
    expect(listed).toMatch(/Dockerfile/);
    expect(listed).not.toMatch(/node_modules/);
    expect(listed).not.toMatch(/\.env/);
    expect(gunzipSync(buf).length).toBeGreaterThan(0);
  });

  it('reports a tar failure', async () => {
    await expect(packDirectory(path.join(tmpdir(), 'nd-missing-dir-xyz'), [])).rejects.toThrow(/tar exited/);
  });
});
