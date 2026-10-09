import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Multi-node T3 (design §2): Nixpacks and Railpack builds on a node — the
 * agent side. Argv templates, the sealed-when-env rule, the node owner's
 * kill switch, the r274 `nixpacks.toml` rules, Railpack env as BuildKit
 * secrets (never argv), redaction, and the pins that tie the ops to the
 * image (the Railpack frontend version, the generated-file marker, D3).
 *
 * No process is spawned: spawnValidated is a recorder.
 */

const spawnMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => 0));
vi.mock('../src/lib/spawnValidated.js', () => ({ spawnValidated: spawnMock }));

const { runOp, agentCapabilities, agentMode } = await import('../src/agent.js');
const registry = await import('../src/agentOps/index.js');
const builds = await import('../src/agentOps/builds.js');
const { GENERATED_NIXPACKS_MARKER } = await import('../src/engine/builders/docker.js');

type SpawnCall = [string, string[], (l: string) => void, { cwd?: string; env?: Record<string, string>; timeoutMs?: number } | undefined];
const calls = () => spawnMock.mock.calls as unknown as SpawnCall[];
const SEALED = { sealed: true };
const THIRTY_MIN = 30 * 60 * 1000;

const tmp = mkdtempSync(join(tmpdir(), 'nd-agent-builds-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let cwdSpy: ReturnType<typeof vi.spyOn>;
const ws = () => join(tmp, '.agent-work', 'web');

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockResolvedValue(0);
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmp);
  rmSync(join(tmp, '.agent-work'), { recursive: true, force: true });
});
afterEach(() => cwdSpy.mockRestore());

const nixpacks = (extra: Record<string, unknown> = {}) => ({ workspace: 'web', baseDir: '.', tag: 'ninedeploy/web:abc1234', ...extra });

describe('build.nixpacks', () => {
  it('builds `nixpacks build <baseDir> --name <tag>` in the workspace, with the build budget', async () => {
    expect(await runOp('build.nixpacks', nixpacks({ installCmd: 'npm ci', startCmd: '--x' }), () => undefined)).toBe(0);
    const [exe, argv, , opts] = calls()[0]!;
    expect(exe).toBe('nixpacks');
    // A command is one `--flag=value` element: a value starting with `-` can never read as a flag.
    expect(argv).toEqual(['build', '.', '--name', 'ninedeploy/web:abc1234', '--install-cmd=npm ci', '--start-cmd=--x']);
    expect(opts).toMatchObject({ cwd: ws(), timeoutMs: THIRTY_MIN });
  });

  it('carries build env as --env K=V (the panel host’s exposure), sealed only, escaped like nixpacksEnvArgs', async () => {
    const env = { NEXT_PUBLIC_API: 'https://api', MULTI: 'a\nb' };
    await expect(runOp('build.nixpacks', nixpacks({ env }), () => undefined)).rejects.toThrow(/over the unencrypted transport/);
    expect(spawnMock).not.toHaveBeenCalled();
    await runOp('build.nixpacks', nixpacks({ env }), () => undefined, SEALED);
    expect(calls()[0]![1].slice(4)).toEqual(['--env', 'NEXT_PUBLIC_API=https://api', '--env', 'MULTI=a\\nb']);
    // No env: accepted on either transport (an empty object counts as none).
    await runOp('build.nixpacks', nixpacks({ env: {} }), () => undefined);
  });

  it('refuses bad operands before anything runs', async () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ tag: 'traefik:v3.1' }, /Invalid image tag/],
      [{ tag: 'ninedeploy/web' }, /Invalid image tag/],
      [{ baseDir: '../other' }, /Invalid base directory/],
      [{ baseDir: '/etc' }, /must be a path inside the service workspace/],
      [{ workspace: '.hidden' }, /Invalid workspace name/],
      [{ env: { 'BAD-KEY': 'x' } }, /Invalid build env name/],
      [{ env: { A: 1 } }, /Invalid build env value/],
      [{ env: ['A=1'] }, /Invalid build env/],
      [{ installCmd: 'a\0b' }, /Invalid installCmd/],
      [{ nixpacksToml: '[phases.setup]\n' }, /must be the panel-generated file/],
    ];
    for (const [extra, re] of bad) await expect(runOp('build.nixpacks', nixpacks(extra), () => undefined, SEALED), JSON.stringify(extra)).rejects.toThrow(re);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses a base directory that goes through a symlink in the repository', async () => {
    mkdirSync(ws(), { recursive: true });
    try {
      symlinkSync(tmpdir(), join(ws(), 'escape'), 'junction');
    } catch {
      return; // no symlink privilege on this host
    }
    await expect(runOp('build.nixpacks', nixpacks({ baseDir: 'escape' }), () => undefined)).rejects.toThrow(/symlink/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('nixpacks.toml (r274): written when absent, a repository file wins, ours is replaced, a stale one of ours removed', async () => {
    const toml = `${builds.NIXPACKS_TOML_MARKER}\n[phases.setup]\nnixPkgs = ["nodejs"]\n`;
    const file = () => join(ws(), 'apps', 'api', 'nixpacks.toml');
    mkdirSync(join(ws(), 'apps', 'api'), { recursive: true });
    const lines: string[] = [];
    await runOp('build.nixpacks', nixpacks({ baseDir: 'apps/api/', nixpacksToml: toml }), (l) => lines.push(l));
    expect(readFileSync(file(), 'utf8')).toBe(toml);
    expect(calls()[0]![1].slice(0, 2)).toEqual(['build', 'apps/api']);
    // Ours again, different content: replaced.
    const toml2 = `${builds.NIXPACKS_TOML_MARKER}\n[start]\ncmd = "node x"\n`;
    await runOp('build.nixpacks', nixpacks({ baseDir: 'apps/api', nixpacksToml: toml2 }), () => undefined);
    expect(readFileSync(file(), 'utf8')).toBe(toml2);
    // No manifest any more: our stale file goes.
    await runOp('build.nixpacks', nixpacks({ baseDir: 'apps/api' }), (l) => lines.push(l));
    expect(existsSync(file())).toBe(false);
    expect(lines.join('\n')).toMatch(/removed the nixpacks.toml generated by an earlier deploy/);
    // A committed file is kept, with or without a manifest.
    writeFileSync(file(), '[phases.build]\ncmds = ["make"]\n');
    await runOp('build.nixpacks', nixpacks({ baseDir: 'apps/api', nixpacksToml: toml }), (l) => lines.push(l));
    await runOp('build.nixpacks', nixpacks({ baseDir: 'apps/api' }), () => undefined);
    expect(readFileSync(file(), 'utf8')).toBe('[phases.build]\ncmds = ["make"]\n');
    expect(lines.join('\n')).toMatch(/repo already ships a nixpacks.toml — keeping it/);
  });

  it('redacts every build env value from the lines it returns', async () => {
    spawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      (args[2] as (l: string) => void)('ERR token=s3cr3t-value and line2-of-pem');
      return 1;
    });
    const lines: string[] = [];
    const code = await runOp('build.nixpacks', nixpacks({ env: { TOKEN: 's3cr3t-value', PEM: 'line1\nline2-of-pem', ON: 'yes' } }), (l) => lines.push(l), SEALED);
    expect(code).toBe(1);
    expect(lines.join('\n')).not.toContain('s3cr3t-value');
    expect(lines.join('\n')).not.toContain('line2-of-pem');
    expect(lines.join('\n')).toContain('ERR token=[redacted]');
  });
});

describe('build.railpack', () => {
  const railpack = (extra: Record<string, unknown> = {}) => ({ workspace: 'web', baseDir: '.', tag: 'ninedeploy/web:abc1234', ...extra });

  it('prepares a plan, then builds through the node daemon’s BuildKit with the pinned frontend; values only as BuildKit secrets', async () => {
    const env = { PATH: '/evil', DATABASE_URL: 'postgres://u:pw@db/x', RAILPACK_NODE_VERSION: '22' };
    await runOp('build.railpack', railpack({ env }), () => undefined, SEALED);
    expect(calls()).toHaveLength(2);
    const [prepExe, prepArgv, , prepOpts] = calls()[0]!;
    expect(prepExe).toBe('railpack');
    expect(prepArgv).toEqual([
      'prepare', '.', '--plan-out', '.nd-railpack/plan.json', '--info-out', '.nd-railpack/info.json',
      '--env', 'DATABASE_URL=', '--env', 'PATH=', '--env', 'RAILPACK_NODE_VERSION=22',
    ]);
    expect(prepOpts).toMatchObject({ cwd: ws() });
    expect(prepOpts?.env).toBeUndefined();
    const [exe, argv, , opts] = calls()[1]!;
    expect(exe).toBe('docker');
    expect(argv.slice(0, 7)).toEqual(['buildx', 'build', '--load', '--progress', 'plain', '-t', 'ninedeploy/web:abc1234']);
    expect(argv).toContain(`BUILDKIT_SYNTAX=${builds.RAILPACK_FRONTEND_IMAGE}`);
    expect(argv).toEqual(expect.arrayContaining(['-f', '.nd-railpack/plan.json', '--secret', 'id=DATABASE_URL,env=ND_RAILPACK_SECRET_0', '--secret', 'id=PATH,env=ND_RAILPACK_SECRET_1']));
    expect(argv.at(-1)).toBe('.');
    // A service variable named PATH never becomes the docker CLI's own PATH.
    expect(opts?.env).toEqual({ ND_RAILPACK_SECRET_0: 'postgres://u:pw@db/x', ND_RAILPACK_SECRET_1: '/evil', ND_RAILPACK_SECRET_2: '22' });
    expect(opts?.timeoutMs).toBe(THIRTY_MIN);
    for (const [, a] of calls()) expect(a.join(' ')).not.toContain('postgres://u:pw@db/x');
    // The scratch plan directory is gone afterwards.
    expect(existsSync(join(ws(), '.nd-railpack'))).toBe(false);
  });

  it('a failed prepare stops before the build; the scratch directory is removed on failure too', async () => {
    spawnMock.mockResolvedValueOnce(2);
    expect(await runOp('build.railpack', railpack(), () => undefined)).toBe(2);
    expect(calls()).toHaveLength(1);
    expect(existsSync(join(ws(), '.nd-railpack'))).toBe(false);
    spawnMock.mockResolvedValueOnce(0).mockRejectedValueOnce(new Error('boom'));
    await expect(runOp('build.railpack', railpack(), () => undefined)).rejects.toThrow('boom');
    expect(existsSync(join(ws(), '.nd-railpack'))).toBe(false);
  });

  it('with NINEDEPLOY_AGENT_BUILDKIT_HOST it runs `railpack build` against the operator’s BuildKit', async () => {
    await builds.railpackBuildOp(railpack({ env: { A: 'value' } }), () => undefined, { NINEDEPLOY_AGENT_BUILDKIT_HOST: 'tcp://buildkit:1234' });
    expect(calls()).toHaveLength(1);
    const [exe, argv, , opts] = calls()[0]!;
    expect([exe, argv]).toEqual(['railpack', ['build', '.', '--name', 'ninedeploy/web:abc1234', '--env', 'A=value']]);
    expect(opts?.env).toEqual({ BUILDKIT_HOST: 'tcp://buildkit:1234' });
    await expect(builds.railpackBuildOp(railpack(), () => undefined, { NINEDEPLOY_AGENT_BUILDKIT_HOST: 'tcp://x; rm -rf /' })).rejects.toThrow(/not a BuildKit address/);
  });

  it('is sealed only with env, like build.nixpacks', async () => {
    await expect(runOp('build.railpack', railpack({ env: { A: '1' } }), () => undefined)).rejects.toThrow(/over the unencrypted transport/);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('wiring and pins (M11)', () => {
  it('both ops are registered, handled, and advertised after the 0.15 list unless the owner switched builds off', async () => {
    for (const op of ['build.nixpacks', 'build.railpack']) {
      expect(registry.AGENT_OPS.get(op)?.cap, op).toBe(op);
      expect(agentMode.HANDLED_OPS.has(op), op).toBe(true);
    }
    expect(agentCapabilities({})).toEqual(expect.arrayContaining(['build.nixpacks', 'build.railpack']));
    const off = agentCapabilities({ NINEDEPLOY_AGENT_BUILDS: 'off' });
    expect(off).not.toContain('build.nixpacks');
    expect(off).not.toContain('build.railpack');
    await expect(registry.runRegisteredOp('build.nixpacks', nixpacks(), () => undefined, { sealed: true }, { NINEDEPLOY_AGENT_BUILDS: 'off' })).rejects.toThrow(
      /disabled on this node by its owner \(NINEDEPLOY_AGENT_BUILDS=off\)/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('the generated-file marker is the panel builder’s, and the frontend matches the bundled Railpack CLI', () => {
    expect(builds.NIXPACKS_TOML_MARKER).toBe(GENERATED_NIXPACKS_MARKER);
    const dockerfile = readFileSync(new URL('../../../Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toContain(`ARG RAILPACK_VERSION=${builds.RAILPACK_VERSION}`);
    expect(builds.RAILPACK_FRONTEND_IMAGE).toBe(`ghcr.io/railwayapp/railpack-frontend:v${builds.RAILPACK_VERSION}`);
  });

  it('D3: the runtime image installs an ssh client (deploy keys run `ssh -i`; git only Recommends it)', () => {
    const dockerfile = readFileSync(new URL('../../../Dockerfile', import.meta.url), 'utf8');
    const runtime = dockerfile.slice(dockerfile.indexOf('AS runtime'));
    const apt = /apt-get install -y --no-install-recommends ([^&\\\n]+)/.exec(runtime)?.[1]?.trim().split(/\s+/) ?? [];
    expect(apt).toContain('git');
    expect(apt).toContain('openssh-client');
  });
});
