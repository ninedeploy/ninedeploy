import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// The egress gate resolves DNS; tests never touch the network (r099).
vi.mock('../../src/lib/gitEgress.js', () => ({ assertCloneTargetAllowed: vi.fn(async () => undefined) }));

const { createRemoteDockerBuilder, nodeBuildEnv, RemoteDeployUnsupportedError, resolveNodeBuildPlan } = await import('../../src/engine/builders/remoteDocker.js');
const { findDockerfileInRepo, GENERATED_NIXPACKS_MARKER } = await import('../../src/engine/builders/docker.js');

/**
 * Multi-node T3 (design §2.2): source builds on a node — the panel side.
 *
 * - Pack resolution happens on the PANEL's checkout with the local builder's
 *   rules (parity table), and keeps every operand earlier releases sent
 *   whenever today's node build would find its Dockerfile (upgrade safety).
 * - Nixpacks is sent to an agent with `build.nixpacks` and refused, before
 *   anything is cloned, for one without it ("update the node agent").
 * - Railpack builds with Railpack on a current agent; an older one keeps
 *   r520's Dockerfile substitution unchanged (owner decision O10).
 */

const tmp = mkdtempSync(join(tmpdir(), 'nd-node-builds-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let repoSeq = 0;
/** A panel checkout with these files (paths relative to the repo). */
function repo(files: string[]): string {
  const dir = join(tmp, `r${++repoSeq}`);
  mkdirSync(join(dir, '.git'), { recursive: true });
  for (const f of files) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), 'FROM scratch\n');
  }
  return dir;
}

const ping = (version: string, caps: string[]) => `ND-AGENT ${JSON.stringify({ version, caps })}`;
const CAPS_015 = ping('0.15.1', ['build-path-guard', 'workspace.remove', 'git.credential', 'terminal', 'terminal.host']);
const CAPS_NOW = ping('0.15.2', ['build-path-guard', 'workspace.remove', 'git.credential', 'terminal', 'terminal.host', 'build.nixpacks', 'build.railpack', 'git.sshkey']);

function fakeAgent(caps: string) {
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  const agent = async (op: string, params: Record<string, unknown>) => {
    calls.push({ op, params });
    if (op === 'agent.ping') return { exitCode: 0, lines: [caps] };
    if (op === 'file.writeEnv') return { exitCode: 0, lines: [`wrote .agent-env/${String(params['name'])}.env`] };
    if (op === 'docker.inspect') return { exitCode: 0, lines: ['running|none|0|0'] };
    return { exitCode: 0, lines: [] };
  };
  return { agent, calls, ops: () => calls.map((c) => c.op), find: (op: string) => calls.find((c) => c.op === op) };
}

const ctx = (workDir: string, buildConfig: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({
    deploymentId: 7,
    service: { id: 1, name: 'web', slug: 'web', type: 'docker', image: null, repoUrl: 'https://github.com/acme/web.git', branch: null, port: null, healthPath: '/', cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0, volumeMount: null, publishedPort: null, serverId: 4 },
    buildConfig,
    workDir,
    commitSha: 'deadbeefcafe',
    env: { API_URL: 'https://api', 'bad-name': 'x' },
    log: () => undefined,
    ...over,
  }) as never;

describe('pack resolution on the panel checkout (parity with the local builder)', () => {
  const log = () => undefined;

  it('the parity table: root Dockerfile, nested Dockerfile, pinned path, none', async () => {
    // Root Dockerfile: the local builder builds it from the root; so does the node (today's operands).
    expect(await resolveNodeBuildPlan(repo(['Dockerfile']), { buildPack: 'auto' }, log)).toEqual({ pack: 'dockerfile', dockerfile: 'Dockerfile', context: '.' });
    // Nested only: the local builder discovers it (findDockerfileInRepo); the node now builds the same file.
    const nested = repo(['apps/api/Dockerfile', 'README.md']);
    const local = findDockerfileInRepo(nested, log)!;
    expect(await resolveNodeBuildPlan(nested, { buildPack: 'auto' }, log)).toEqual({ pack: 'dockerfile', dockerfile: local.dockerfilePath, context: local.baseDir });
    expect(local).toEqual({ dockerfilePath: 'apps/api/Dockerfile', baseDir: 'apps/api' });
    // A pinned path is a deliberate choice: built as given, found or not (local: same).
    expect(await resolveNodeBuildPlan(repo([]), { buildPack: 'auto', dockerfilePath: 'docker/Prod.Dockerfile' }, log)).toEqual({
      pack: 'dockerfile',
      dockerfile: 'docker/Prod.Dockerfile',
      context: '.',
    });
    // Nothing to build from: Nixpacks, as on the panel host.
    expect(await resolveNodeBuildPlan(repo(['package.json']), { buildPack: 'auto' }, log)).toEqual({ pack: 'nixpacks', baseDir: '.' });
  });

  it('upgrade safety: what built on a node before keeps its exact operands', async () => {
    // baseDir + a ROOT Dockerfile: the agent's r666 rule builds the root file with the baseDir context.
    expect(await resolveNodeBuildPlan(repo(['Dockerfile', 'apps/web/index.js']), { buildPack: 'auto', baseDir: '/apps/web' }, log)).toEqual({
      pack: 'dockerfile',
      dockerfile: 'Dockerfile',
      context: 'apps/web',
    });
    // baseDir + its own Dockerfile.
    expect(await resolveNodeBuildPlan(repo(['apps/web/Dockerfile']), { buildPack: 'auto', baseDir: 'apps/web' }, log)).toEqual({
      pack: 'dockerfile',
      dockerfile: 'Dockerfile',
      context: 'apps/web',
    });
    // No panel checkout to look at (fan-out, tests): exactly the old operands.
    expect(await resolveNodeBuildPlan(join(tmp, 'missing'), { buildPack: 'auto', baseDir: 'x' }, log)).toEqual({ pack: 'dockerfile', dockerfile: 'Dockerfile', context: 'x' });
    // The explicit packs.
    expect(await resolveNodeBuildPlan(repo([]), { buildPack: 'dockerfile' }, log)).toMatchObject({ pack: 'dockerfile' });
    expect(await resolveNodeBuildPlan(repo([]), { buildPack: 'nixpacks', baseDir: '/svc' }, log)).toEqual({ pack: 'nixpacks', baseDir: 'svc' });
    expect(await resolveNodeBuildPlan(repo(['Dockerfile']), { buildPack: 'railpack' }, log)).toEqual({ pack: 'railpack', baseDir: '.' });
  });
});

describe('the node build', () => {
  it('Nixpacks on a current agent: build.nixpacks with the build env, then the Nixpacks port default', async () => {
    const a = fakeAgent(CAPS_NOW);
    const lines: string[] = [];
    const manifest = { version: 1, build: { start: 'node server.js' } };
    const runtime = await createRemoteDockerBuilder(a.agent).buildAndRun(ctx(repo(['package.json']), { buildPack: 'auto', installCmd: 'npm ci' }, { log: (l: string) => lines.push(l), manifest }));
    const build = a.find('build.nixpacks')!;
    expect(build.params).toMatchObject({ workspace: 'web', baseDir: '.', tag: 'ninedeploy/web:deadbee', installCmd: 'npm ci', env: { API_URL: 'https://api' } });
    // The manifest's build section reaches the node as the panel-generated nixpacks.toml.
    const toml = String(build.params['nixpacksToml']);
    expect(toml.startsWith(`${GENERATED_NIXPACKS_MARKER}\n`)).toBe(true);
    expect(toml).toContain('[phases.start]\ncmd = "node server.js"');
    expect(a.ops()).not.toContain('docker.build');
    // Capabilities are asked before anything is cloned.
    expect(a.ops().indexOf('agent.ping')).toBeLessThan(a.ops().indexOf('git.ensure'));
    // Same default as the panel host: port 3000 and PORT in the container env.
    expect(runtime.port).toBe(3000);
    expect(a.find('file.writeEnv')!.params['env']).toMatchObject({ PORT: '3000', API_URL: 'https://api' });
    expect(lines.join('\n')).toMatch(/not passed to the node build.*bad-name/);
  });

  it('Nixpacks on a 0.15 agent: refused with the update message before anything is cloned', async () => {
    const a = fakeAgent(CAPS_015);
    const err = await createRemoteDockerBuilder(a.agent, { nodeLabel: '"edge-1" (#4)' })
      .buildAndRun(ctx(repo(['package.json']), { buildPack: 'nixpacks' }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteDeployUnsupportedError);
    expect((err as Error).message).toMatch(/"edge-1" \(#4\) \(version 0\.15\.1\) cannot build with Nixpacks\. Update the node agent to v0\.15\.2 or newer/);
    expect(a.ops().filter((op) => op.startsWith('git.') || op.startsWith('build.') || op === 'docker.build')).toEqual([]);
  });

  it('Railpack on a current agent builds with Railpack; on a 0.15 agent the r520 substitution is unchanged', async () => {
    const now = fakeAgent(CAPS_NOW);
    await createRemoteDockerBuilder(now.agent).buildAndRun(ctx(repo(['Dockerfile']), { buildPack: 'railpack' }));
    expect(now.find('build.railpack')!.params).toEqual({ workspace: 'web', baseDir: '.', tag: 'ninedeploy/web:deadbee', env: { API_URL: 'https://api' } });
    expect(now.ops()).not.toContain('docker.build');

    const old = fakeAgent(CAPS_015);
    const lines: string[] = [];
    await createRemoteDockerBuilder(old.agent).buildAndRun(ctx(repo(['Dockerfile']), { buildPack: 'railpack' }, { log: (l: string) => lines.push(l) }));
    expect(old.find('docker.build')!.params).toEqual({ workspace: 'web', tag: 'ninedeploy/web:deadbee', dockerfile: 'Dockerfile', context: '.' });
    expect(old.ops()).not.toContain('build.railpack');
    expect(lines.join('\n')).toMatch(/Railpack is not available on a remote node — building the repository Dockerfile instead/);
  });

  it('a Dockerfile build asks the agent nothing new', async () => {
    const a = fakeAgent(CAPS_015);
    await createRemoteDockerBuilder(a.agent).buildAndRun(ctx(repo(['Dockerfile']), { buildPack: 'auto' }));
    expect(a.ops().filter((op) => op === 'agent.ping')).toHaveLength(1); // r660's guard only
    expect(a.find('docker.build')!.params).toEqual({ workspace: 'web', tag: 'ninedeploy/web:deadbee', dockerfile: 'Dockerfile', context: '.' });
  });

  it('nodeBuildEnv keeps what the agent takes and names what it leaves out', () => {
    const lines: string[] = [];
    expect(nodeBuildEnv({ OK: '1', 'a.b': '2', BIG: 'x'.repeat(40_000), NUL: 'a\0b' }, (l) => lines.push(l))).toEqual({ OK: '1' });
    expect(lines[0]).toMatch(/3 environment variable\(s\) not passed to the node build.*a\.b, BIG, NUL/);
  });
});
