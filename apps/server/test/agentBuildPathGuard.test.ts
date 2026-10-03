/**
 * r660 regression guard: a node agent never builds (or composes) through a
 * symlink the repository committed.
 *
 * The agent runs as root, in one work root every tenant on the node shares.
 * `RE_PATH` only checked the TEXT of `dockerfile` / `context` / compose `file`,
 * so a repository holding `ln -s / ctx` plus `baseDir: ctx` sent the node's
 * filesystem — or another service's checkout and its `.env` — to the builder,
 * and a symlinked Dockerfile echoed the file it pointed at into the deploy log.
 * Every repository path is now lstat-walked under the workspace first.
 *
 * Symlinks need a privilege on Windows; the symlink cases skip there and run
 * on Linux CI.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_CAPABILITIES, runOp } from '../src/agent.js';

const spawnMock = vi.hoisted(() => vi.fn(async () => 0));
vi.mock('../src/lib/spawnValidated.js', () => ({ spawnValidated: spawnMock }));

let root: string;
let cwdSpy: { mockRestore(): void };
/** The service workspace `.agent-work/web` under the fake agent cwd. */
let ws: string;

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockResolvedValue(0);
  root = mkdtempSync(join(tmpdir(), 'nd-agent-guard-'));
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root);
  ws = join(root, '.agent-work', 'web');
  mkdirSync(ws, { recursive: true });
});

afterEach(() => {
  cwdSpy.mockRestore();
  rmSync(root, { recursive: true, force: true });
});

/** Create a symlink, or report that this platform/user cannot. */
function link(target: string, at: string, type: 'file' | 'dir' = 'file'): boolean {
  try {
    symlinkSync(target, at, process.platform === 'win32' && type === 'dir' ? 'junction' : type);
    return true;
  } catch {
    return false;
  }
}

const argv = () => (spawnMock.mock.calls.at(-1) as unknown[] | undefined)?.[1] as string[] | undefined;

describe('r660: node-side build paths', () => {
  it('builds an ordinary checkout exactly as before', async () => {
    writeFileSync(join(ws, 'Dockerfile'), 'FROM scratch\n');
    await expect(runOp('docker.build', { workspace: 'web', tag: 'app:1', dockerfile: 'Dockerfile', context: '.' }, () => {})).resolves.toBe(0);
    expect(argv()).toEqual(['build', '-t', 'app:1', '-f', 'Dockerfile', '.']);
  });

  it('refuses a build context that is a symlink out of the workspace, without spawning', async (ctx) => {
    writeFileSync(join(ws, 'Dockerfile'), 'FROM scratch\n');
    if (!link(root, join(ws, 'ctx'), 'dir')) return ctx.skip();
    await expect(
      runOp('docker.build', { workspace: 'web', tag: 'app:1', dockerfile: 'Dockerfile', context: 'ctx' }, () => {}),
    ).rejects.toThrow(/symlink/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses a context that only passes THROUGH a symlinked directory', async (ctx) => {
    const other = join(root, '.agent-work', 'other-tenant');
    mkdirSync(join(other, 'src'), { recursive: true });
    writeFileSync(join(ws, 'Dockerfile'), 'FROM scratch\n');
    if (!link(other, join(ws, 'peer'), 'dir')) return ctx.skip();
    await expect(
      runOp('docker.build', { workspace: 'web', tag: 'app:1', dockerfile: 'Dockerfile', context: 'peer/src' }, () => {}),
    ).rejects.toThrow(/symlink/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses a symlinked Dockerfile — its target would be echoed as a parse error', async (ctx) => {
    const secret = join(root, 'shadow');
    writeFileSync(secret, 'root:$6$secret\n');
    if (!link(secret, join(ws, 'Dockerfile'))) return ctx.skip();
    await expect(
      runOp('docker.build', { workspace: 'web', tag: 'app:1', dockerfile: 'Dockerfile', context: '.' }, () => {}),
    ).rejects.toThrow(/symlink/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses a DANGLING symlink too', async (ctx) => {
    if (!link(join(root, 'does-not-exist'), join(ws, 'Dockerfile'))) return ctx.skip();
    await expect(
      runOp('docker.build', { workspace: 'web', tag: 'app:1', dockerfile: 'Dockerfile', context: '.' }, () => {}),
    ).rejects.toThrow(/symlink/);
  });

  it('refuses an absolute build path inside a workspace (the panel always sends repo-relative ones)', async () => {
    await expect(
      runOp('docker.build', { workspace: 'web', tag: 'app:1', dockerfile: 'Dockerfile', context: '/etc' }, () => {}),
    ).rejects.toThrow(/inside the service workspace/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses a symlinked compose file and override for every compose op that reads them', async (ctx) => {
    writeFileSync(join(root, 'outside.yml'), 'services: {}\n');
    if (!link(join(root, 'outside.yml'), join(ws, 'docker-compose.yml'))) return ctx.skip();
    for (const op of ['docker.composeConfig', 'docker.composePull', 'docker.composeUp', 'docker.composePs']) {
      await expect(runOp(op, { workspace: 'web', project: 'p', file: 'docker-compose.yml' }, () => {})).rejects.toThrow(/symlink/);
    }
    await expect(runOp('docker.composeRestartPolicy', { workspace: 'web', project: 'p', file: 'docker-compose.yml' }, () => {})).rejects.toThrow(
      /symlink/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('never writes a workspace file through a symlinked .tmp the repository committed', async (ctx) => {
    const victim = join(root, 'authorized_keys');
    writeFileSync(victim, 'ssh-ed25519 AAAA original\n');
    if (!link(victim, join(ws, '.env.tmp'))) return ctx.skip();
    await runOp('file.writeWorkspace', { workspace: 'web', kind: 'dotenv', content: 'SECRET=1\n' }, () => {});
    // The secrets landed in the workspace, never in the file the link named.
    expect(readFileSync(victim, 'utf8')).toBe('ssh-ed25519 AAAA original\n');
    expect(readFileSync(join(ws, '.env'), 'utf8')).toBe('SECRET=1\n');
  });

  it('advertises the guard inside the sealed ping answer', async () => {
    const lines: string[] = [];
    await runOp('agent.ping', {}, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    const info = JSON.parse((lines[0] as string).replace(/^ND-AGENT /, '')) as { version: string; caps: string[] };
    expect(info.caps).toEqual([...AGENT_CAPABILITIES]);
    expect(info.caps).toContain('build-path-guard');
    expect(typeof info.version).toBe('string');
  });
});

/**
 * r666 on the node: the panel sends `dockerfile` repo-relative with the
 * context apart, while the Settings field means "relative to the base
 * directory". A root file that exists keeps winning (no working build changes
 * file); otherwise the one under the context is built instead of failing.
 */
describe('r666: which Dockerfile a node builds', () => {
  it('baseDir + root Dockerfile (the layout that already built) — unchanged', async () => {
    mkdirSync(join(ws, 'apps', 'web'), { recursive: true });
    writeFileSync(join(ws, 'Dockerfile'), 'FROM scratch\n');
    await runOp('docker.build', { workspace: 'web', tag: 'a:1', dockerfile: 'Dockerfile', context: 'apps/web' }, () => {});
    expect(argv()).toEqual(['build', '-t', 'a:1', '-f', 'Dockerfile', 'apps/web']);
  });

  it('baseDir + root Dockerfile + baseDir Dockerfile — still the root one', async () => {
    mkdirSync(join(ws, 'apps', 'web'), { recursive: true });
    writeFileSync(join(ws, 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(ws, 'apps', 'web', 'Dockerfile'), 'FROM scratch\n');
    await runOp('docker.build', { workspace: 'web', tag: 'a:1', dockerfile: 'Dockerfile', context: 'apps/web' }, () => {});
    expect(argv()).toEqual(['build', '-t', 'a:1', '-f', 'Dockerfile', 'apps/web']);
  });

  it('baseDir + a root-relative dockerfilePath — unchanged', async () => {
    mkdirSync(join(ws, 'apps', 'web'), { recursive: true });
    writeFileSync(join(ws, 'apps', 'web', 'Dockerfile'), 'FROM scratch\n');
    await runOp('docker.build', { workspace: 'web', tag: 'a:1', dockerfile: 'apps/web/Dockerfile', context: 'apps/web' }, () => {});
    expect(argv()).toEqual(['build', '-t', 'a:1', '-f', 'apps/web/Dockerfile', 'apps/web']);
  });

  it('baseDir + a Dockerfile only under it — now builds it (used to fail: no root Dockerfile)', async () => {
    mkdirSync(join(ws, 'apps', 'web'), { recursive: true });
    writeFileSync(join(ws, 'apps', 'web', 'Dockerfile'), 'FROM scratch\n');
    await runOp('docker.build', { workspace: 'web', tag: 'a:1', dockerfile: 'Dockerfile', context: 'apps/web' }, () => {});
    expect(argv()).toEqual(['build', '-t', 'a:1', '-f', 'apps/web/Dockerfile', 'apps/web']);
  });

  it('neither exists — the operand is passed as before and docker reports it', async () => {
    mkdirSync(join(ws, 'apps', 'web'), { recursive: true });
    await runOp('docker.build', { workspace: 'web', tag: 'a:1', dockerfile: 'Dockerfile', context: 'apps/web' }, () => {});
    expect(argv()).toEqual(['build', '-t', 'a:1', '-f', 'Dockerfile', 'apps/web']);
  });
});

/** r662: a service's node checkout can finally be removed. */
describe('r662: workspace.remove', () => {
  it('deletes the service workspace and only it', async () => {
    writeFileSync(join(ws, 'Dockerfile'), 'FROM scratch\n');
    const other = join(root, '.agent-work', 'other');
    mkdirSync(other, { recursive: true });
    const lines: string[] = [];
    await expect(runOp('workspace.remove', { workspace: 'web' }, (l) => lines.push(l))).resolves.toBe(0);
    expect(existsSync(ws)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(lines).toEqual(['workspace web removed']);
  });

  it('removes a symlink inside the workspace as a link, never what it points at', async (ctx) => {
    const outside = join(root, 'keep');
    mkdirSync(outside);
    writeFileSync(join(outside, 'data'), 'precious');
    if (!link(outside, join(ws, 'escape'), 'dir')) return ctx.skip();
    await runOp('workspace.remove', { workspace: 'web' }, () => {});
    expect(readFileSync(join(outside, 'data'), 'utf8')).toBe('precious');
  });

  it('refuses a name that could leave the work root', async () => {
    for (const bad of ['..', '../x', '.', '', 'a/b']) {
      await expect(runOp('workspace.remove', { workspace: bad }, () => {})).rejects.toThrow(/Invalid workspace name/);
    }
    expect(existsSync(join(root, '.agent-work'))).toBe(true);
  });
});
