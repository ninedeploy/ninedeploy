import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveWorkspace, runOp } from '../src/agent.js';

const spawnMock = vi.hoisted(() => vi.fn(async () => 0));
vi.mock('../src/lib/spawnValidated.js', () => ({ spawnValidated: spawnMock }));
const dockerPullMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../src/lib/dockerPull.js', () => ({ pullDockerImage: dockerPullMock }));

/** Capture the argv a runOp call spawned with. */
/** The `-c` hardening every network git op on the node carries (r099). */
const EGRESS = ['-c', 'http.followRedirects=false', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never'];

async function argvOf(op: string, params: Record<string, unknown>): Promise<string[]> {
  const code = await runOp(op, params, () => {});
  expect(code).toBe(0);
  return (spawnMock.mock.calls.at(-1) as unknown[])[1] as string[];
}

describe('agent typed-op argv templates', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockResolvedValue(0);
  });

  it('docker.pull', async () => {
    const log = vi.fn();
    await expect(runOp('docker.pull', { image: 'nginx:1' }, log)).resolves.toBe(0);
    expect(dockerPullMock).toHaveBeenCalledWith('nginx:1', log);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('docker.networkCreate builds a validated argv', async () => {
    expect(await argvOf('docker.networkCreate', { name: 'net-a', driver: 'overlay' })).toEqual([
      'network', 'create', '--driver', 'overlay', 'net-a',
    ]);
    // Unknown drivers fall back to bridge; omitted driver adds no flag.
    expect(await argvOf('docker.networkCreate', { name: 'net-b', driver: 'weird' })).toEqual([
      'network', 'create', '--driver', 'bridge', 'net-b',
    ]);
    expect(await argvOf('docker.networkCreate', { name: 'net-c' })).toEqual(['network', 'create', 'net-c']);
  });

  it('docker.networkCreate rejects hostile names', async () => {
    await expect(argvOf('docker.networkCreate', { name: 'a;rm' })).rejects.toThrow('Invalid network name');
  });

  it('docker.networkRm / connect / disconnect', async () => {
    expect(await argvOf('docker.networkRm', { name: 'net-a' })).toEqual(['network', 'rm', 'net-a']);
    expect(await argvOf('docker.networkConnect', { network: 'net-a', container: 'web-1' })).toEqual([
      'network', 'connect', 'net-a', 'web-1',
    ]);
    expect(await argvOf('docker.networkDisconnect', { network: 'net-a', container: 'web-1' })).toEqual([
      'network', 'disconnect', 'net-a', 'web-1',
    ]);
    await expect(argvOf('docker.networkConnect', { network: 'net-a', container: 'x;y' })).rejects.toThrow(
      'Invalid container name',
    );
  });

  it('docker.build', async () => {
    expect(await argvOf('docker.build', { tag: 'app:1', dockerfile: 'Dockerfile', context: '.' })).toEqual(
      ['build', '-t', 'app:1', '-f', 'Dockerfile', '.'],
    );
    await expect(argvOf('docker.build', { tag: 'app:1', dockerfile: '../Dockerfile', context: '.' })).rejects.toThrow(
      'Invalid dockerfile',
    );
    await expect(argvOf('docker.build', { tag: 'app:1', dockerfile: 'Dockerfile', context: 'foo/../../bar' })).rejects.toThrow(
      'Invalid context',
    );
  });

  it('docker.run builds the fixed flag block', async () => {
    const argv = await argvOf('docker.run', { name: 'web-3', image: 'nginx' });
    expect(argv.slice(0, 8)).toEqual(['run', '-d', '--name', 'web-3', '--restart', 'unless-stopped', '--network', 'ninedeploy']);
    expect(argv[argv.length - 1]).toBe('nginx');
  });

  it('docker.run appends resource limits and volume when given', async () => {
    const argv = await argvOf('docker.run', {
      name: 'w', image: 'i', cpuShares: '512', memLimitMb: '256', volume: 'nd-svc-w-data', mount: '/data',
    });
    expect(argv).toContain('--cpu-shares');
    expect(argv).toContain('512');
    expect(argv).toContain('--memory');
    expect(argv).toContain('256m');
    expect(argv).toContain('nd-svc-w-data:/data');
  });

  it('docker.run clamps non-numeric limits', async () => {
    const argv = await argvOf('docker.run', { name: 'w', image: 'i', cpuShares: 'abc', memLimitMb: 'xyz' });
    expect(argv).toContain('0');
    expect(argv).toContain('0m');
  });

  it('docker.runEnv appends the env-file flag', async () => {
    const argv = await argvOf('docker.runEnv', { name: 'w', image: 'i', envFile: '.agent-env/w.env' });
    expect(argv).toContain('--env-file');
    expect(argv).toContain('.agent-env/w.env');
  });

  it('docker.stop / rm / logs / inspect', async () => {
    expect(await argvOf('docker.stop', { name: 'c1' })).toEqual(['stop', '-t', '5', 'c1']);
    expect(await argvOf('docker.rm', { name: 'c1' })).toEqual(['rm', '-f', 'c1']);
    expect(await argvOf('docker.logs', { name: 'c1' })).toEqual(['logs', '--tail', '300', '--timestamps', 'c1']);
    expect((await argvOf('docker.inspect', { name: 'c1', format: 'state' }))[3]).toContain('{{.State.Status}}');
    expect((await argvOf('docker.inspect', { name: 'c1' }))[3]).toBe('{{.Image}}');
  });

  it('docker.login/logout with and without a registry server', async () => {
    expect(await argvOf('docker.login', { username: 'u', password: 'p' })).toEqual([
      'login', '--username', 'u', '--password-stdin',
    ]);
    expect(await argvOf('docker.login', { username: 'u', password: 'p', server: 'ghcr.io' })).toEqual(
      ['login', '--username', 'u', '--password-stdin', 'ghcr.io'],
    );
    expect(await argvOf('docker.logout', {})).toEqual(['logout']);
    expect(await argvOf('docker.logout', { server: 'ghcr.io' })).toEqual(['logout', 'ghcr.io']);
  });

  /**
   * r037. The argv is built with `--password-stdin` so the credential never
   * reaches `ps` — but nothing ever WROTE to that pipe, so `docker login` sat
   * blocked on a stdin that was never closed and every remote private-registry
   * deploy hung until the agent's 600 s request timeout.
   */
  it('feeds the registry password to docker login through stdin, never argv', async () => {
    await runOp('docker.login', { username: 'u', password: 's3cret', server: 'ghcr.io' }, () => {});
    const [, argv, , opts] = spawnMock.mock.calls.at(-1) as [string, string[], unknown, { stdin?: string }];
    expect(argv).not.toContain('s3cret');
    expect(opts.stdin).toBe(`s3cret${String.fromCharCode(10)}`);
  });

  it('refuses a login with no password rather than hanging on stdin', async () => {
    await expect(runOp('docker.login', { username: 'u' }, () => {})).rejects.toThrow(
      /Invalid registry password/,
    );
  });

  it('docker compose up/down', async () => {
    expect(await argvOf('docker.composeUp', { project: 'p', file: 'docker-compose.yml' })).toEqual(
      ['compose', '-p', 'p', '-f', 'docker-compose.yml', 'up', '-d', '--build', '--remove-orphans'],
    );
    expect(await argvOf('docker.composeDown', { project: 'p' })).toEqual(['compose', '-p', 'p', 'down', '--remove-orphans']);
  });

  it('git ops', async () => {
    expect(await argvOf('git.clone', { url: 'https://x/y.git', dir: 'repo' })).toEqual(
      [...EGRESS, 'clone', 'https://x/y.git', 'repo'],
    );
    expect(await argvOf('git.clone', { url: 'https://x/y.git', depth: '50' })).toEqual(
      [...EGRESS, 'clone', '--depth', '50', 'https://x/y.git', '.'],
    );
    expect(await argvOf('git.fetch', {})).toEqual([...EGRESS, 'fetch', '--all']);
    expect(await argvOf('git.checkout', { ref: 'main' })).toEqual(['checkout', 'main']);
    expect(await argvOf('git.checkout', {})).toEqual(['checkout', 'HEAD']);
    expect(await argvOf('git.rev-parse', {})).toEqual(['rev-parse', 'HEAD']);
    expect(await argvOf('git.reset', { sha: 'abcdef1234' })).toEqual(['reset', '--hard', 'abcdef1234']);
    expect(await argvOf('git.reset', {})).toEqual(['reset', '--hard', 'HEAD']);
  });

  it('rejects dash-leading git operands as options, not refs (r011)', async () => {
    // Both of these passed RE_REF before the position-0 anchor was added:
    // git would read them as options (`checkout -b`, and `clone --upload-pack`
    // consuming the target dir as its value), not as the intended operands.
    await expect(argvOf('git.checkout', { ref: '-b' })).rejects.toThrow('Invalid ref');
    await expect(argvOf('git.clone', { url: '--upload-pack', dir: 'repo' })).rejects.toThrow('Invalid repo url');
    // Belt and braces: `=` was never in the charset, but it must stay rejected.
    await expect(argvOf('git.clone', { url: '--config=core.sshCommand=/bin/true', dir: 'r' })).rejects.toThrow(
      'Invalid repo url',
    );
  });

  it('refuses non-network repo urls and pins egress flags on clones (r099)', async () => {
    // RE_REF alone accepted these; the node must not clone its own filesystem.
    for (const url of ['file:///etc', '/srv/other-tenant.git', 'repo.git', 'ext::sh']) {
      await expect(argvOf('git.clone', { url, dir: 'r' }), url).rejects.toThrow('Invalid repo url');
    }
    for (const url of ['https://github.com/a/b.git', 'ssh://git@h/a.git', 'git@github.com:a/b.git', 'git://h/a']) {
      const argv = await argvOf('git.clone', { url, dir: 'r' });
      expect(argv.slice(0, EGRESS.length), url).toEqual(EGRESS);
    }
  });

  it('docker.runEnv without limits or volume', async () => {
    const argv = await argvOf('docker.runEnv', { name: 'w', image: 'i', envFile: 'e.env' });
    expect(argv).not.toContain('--cpu-shares');
    expect(argv).not.toContain('--memory');
    expect(argv).not.toContain('-v');
  });

  it('docker.runEnv with limits, volume and mount default', async () => {
    const argv = await argvOf('docker.runEnv', {
      name: 'w', image: 'i', envFile: 'e.env', cpuShares: '128', memLimitMb: '64',
      volume: 'nd-svc-w-data',
    });
    expect(argv).toContain('128');
    expect(argv).toContain('64m');
    expect(argv).toContain('nd-svc-w-data:/');
  });

  it('docker.runEnv clamps non-numeric limits', async () => {
    const argv = await argvOf('docker.runEnv', { name: 'w', image: 'i', envFile: 'e.env', cpuShares: 'oops', memLimitMb: 'nah' });
    expect(argv).toContain('0');
    expect(argv).toContain('0m');
  });

  it('docker.run volume without an explicit mount defaults to /', async () => {
    const argv = await argvOf('docker.run', { name: 'w', image: 'i', volume: 'nd-svc-w-data' });
    expect(argv).toContain('nd-svc-w-data:/');
  });

  it('clamps an invalid clone depth to 1', async () => {
    expect(await argvOf('git.clone', { url: 'https://x/y.git', depth: '9999' })).toEqual(
      [...EGRESS, 'clone', '--depth', '1', 'https://x/y.git', '.'],
    );
  });
});

/**
 * r037 — per-service workspaces.
 *
 * Git has no per-invocation repository operand: `fetch`, `checkout`, `reset`
 * and `rev-parse` act on the process cwd. The agent used to run every git op in
 * its OWN cwd, so a host could hold exactly one checkout and two remote
 * services would overwrite each other's source tree. Remote deploys are only
 * safe once each service builds in its own directory.
 */
describe('agent workspaces', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockResolvedValue(0);
  });

  it('runs a workspace-scoped op inside that service directory', async () => {
    await runOp('git.fetch', { workspace: 'web' }, () => {});
    const opts = (spawnMock.mock.calls.at(-1) as unknown[])[3] as { cwd?: string };
    const posix = (opts.cwd ?? '').split(sep).join('/');
    expect(posix.endsWith('/.agent-work/web')).toBe(true);
  });

  it('leaves host-level ops in the agent cwd', async () => {
    await runOp('docker.networkRm', { name: 'net-a' }, () => {});
    expect((spawnMock.mock.calls.at(-1) as unknown[])[3]).toEqual({});
  });

  it('keeps two services in separate checkouts', async () => {
    await runOp('git.fetch', { workspace: 'alpha' }, () => {});
    const a = ((spawnMock.mock.calls.at(-1) as unknown[])[3] as { cwd: string }).cwd;
    await runOp('git.fetch', { workspace: 'beta' }, () => {});
    const b = ((spawnMock.mock.calls.at(-1) as unknown[])[3] as { cwd: string }).cwd;
    expect(a).not.toBe(b);
  });

  it('refuses a workspace name that could escape the work root', async () => {
    // RE_NAME already forbids a slash and a leading dot, so a traversal cannot
    // be spelled — this pins it, because the value becomes a child process cwd.
    for (const bad of ['..', '../etc', '/etc', '.ssh', 'a/b', '']) {
      await expect(resolveWorkspace(bad)).rejects.toThrow(/Invalid workspace name/);
    }
    await expect(runOp('git.fetch', { workspace: '../etc' }, () => {})).rejects.toThrow(
      /Invalid workspace name/,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('agent publish ports', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockResolvedValue(0);
  });

  it('publishes a validated host:container pair', async () => {
    const argv = await argvOf('docker.run', { name: 'web', image: 'nginx:1', publish: '8080:80' });
    expect(argv).toContain('-p');
    expect(argv[argv.indexOf('-p') + 1]).toBe('8080:80');
    // The image stays the LAST operand — docker reads a trailing flag as the
    // command to run inside the container.
    expect(argv.at(-1)).toBe('nginx:1');
  });

  it('publishes on the env-file variant too', async () => {
    const argv = await argvOf('docker.runEnv', {
      name: 'web',
      image: 'nginx:1',
      envFile: '.agent-env/web.env',
      publish: '443:8443',
    });
    expect(argv[argv.indexOf('-p') + 1]).toBe('443:8443');
    expect(argv.at(-1)).toBe('nginx:1');
  });

  it('omits the flag entirely when nothing is published', async () => {
    expect(await argvOf('docker.run', { name: 'web', image: 'nginx:1' })).not.toContain('-p');
  });

  it('refuses a malformed or out-of-range publish spec', async () => {
    for (const bad of ['80', 'a:80', '80:0', '0:80', '99999:80', '80:99999', '80:80:80', '-p 80:80']) {
      await expect(
        runOp('docker.run', { name: 'web', image: 'nginx:1', publish: bad }, () => {}),
      ).rejects.toThrow(/Invalid publish spec/);
    }
  });
});

/**
 * r037 — the node-local reverse proxy.
 *
 * Each remote node terminates TLS for its own services (the Coolify/Dokploy
 * model), so production traffic never hairpins through the panel. The panel
 * renders both Traefik configs and ships the text; the agent writes it to a
 * FIXED location — `kind` is an enum, never a filename, so no caller can steer
 * the write.
 */
describe('agent node proxy', () => {
  const work = mkdtempSync(join(tmpdir(), 'nd-agent-'));
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockResolvedValue(0);
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(work);
  });
  afterEach(() => {
    cwdSpy.mockRestore();
  });

  it('writes the static config to a fixed path', async () => {
    const lines: string[] = [];
    await expect(
      runOp('proxy.writeConfig', { kind: 'static', content: 'entryPoints: {}' }, (l) => lines.push(l)),
    ).resolves.toBe(0);
    expect(readFileSync(join(work, '.agent-proxy', 'traefik.yml'), 'utf8')).toBe('entryPoints: {}');
    // A distinct marker: the exec route scrapes `wrote ` lines to surface the
    // env-file path, and a proxy config is not an env file. The changed/
    // unchanged suffix is what decides whether the proxy must be recreated.
    expect(lines[0]).toMatch(/^proxy-config .*traefik\.yml changed$/);
  });

  it('writes the dynamic config into the watched directory', async () => {
    await runOp('proxy.writeConfig', { kind: 'dynamic', content: 'http: {}' }, () => {});
    expect(readFileSync(join(work, '.agent-proxy', 'dynamic', 'ninedeploy.yml'), 'utf8')).toBe('http: {}');
  });

  it('reports an unchanged write so the caller does not restart the proxy', async () => {
    const lines: string[] = [];
    await runOp('proxy.writeConfig', { kind: 'static', content: 'same' }, () => {});
    await runOp('proxy.writeConfig', { kind: 'static', content: 'same' }, (l) => lines.push(l));
    // Recreating Traefik on every routing change would turn each domain edit
    // into a brief ingress outage on that node.
    expect(lines[0]).toMatch(/unchanged$/);
  });

  it('refuses a kind that is not one of the two known configs', async () => {
    for (const kind of ['../../etc/passwd', 'acme', '', undefined]) {
      await expect(runOp('proxy.writeConfig', { kind, content: 'x' }, () => {})).rejects.toThrow(
        /Invalid config kind/,
      );
    }
  });

  it('refuses content carrying a NUL or exceeding the size cap', async () => {
    const withNul = `a${String.fromCharCode(0)}b`;
    await expect(
      runOp('proxy.writeConfig', { kind: 'static', content: withNul }, () => {}),
    ).rejects.toThrow(/Invalid config content/);
    await expect(
      runOp('proxy.writeConfig', { kind: 'static', content: 'a'.repeat(1024 * 1024 + 1) }, () => {}),
    ).rejects.toThrow(/Config too large/);
  });

  it('starts the proxy with a literal argv, seeding acme.json as a file', async () => {
    await expect(runOp('proxy.ensure', {}, () => {})).resolves.toBe(0);

    // acme.json must exist as a FILE before the bind mount, or Docker creates a
    // directory in its place and Traefik cannot store certificates.
    expect(statSync(join(work, '.agent-proxy', 'acme.json')).isFile()).toBe(true);

    const argvs = spawnMock.mock.calls.map((c) => (c as unknown[])[1] as string[]);
    expect(argvs[0]).toEqual(['network', 'create', 'ninedeploy']);
    expect(argvs[1]).toEqual(['rm', '-f', 'ninedeploy-proxy']);
    const runArgv = argvs[2]!;
    expect(runArgv.slice(0, 6)).toEqual([
      'run', '-d', '--name', 'ninedeploy-proxy', '--restart', 'unless-stopped',
    ]);
    expect(runArgv.filter((_a, i) => runArgv[i - 1] === '-p')).toEqual(['80:80', '443:443']);
    expect(runArgv.at(-1)).toBe('traefik:v3.1');
  });

  it('accepts an operator-pinned image but validates it as an image ref', async () => {
    await runOp('proxy.ensure', { image: 'traefik:v3.2' }, () => {});
    expect((spawnMock.mock.calls.at(-1) as unknown[])[1] as string[]).toContain('traefik:v3.2');

    await expect(runOp('proxy.ensure', { image: '--privileged' }, () => {})).rejects.toThrow(
      /Invalid proxy image/,
    );
  });
});

/**
 * r037 — the operations a remote compose deploy needs.
 *
 * Most of the one-click template catalogue is compose-shaped, so until these
 * existed multi-node worked for hand-rolled docker services and nothing else.
 */
describe('agent compose operations', () => {
  const work = mkdtempSync(join(tmpdir(), 'nd-agent-compose-'));
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockResolvedValue(0);
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(work);
  });
  afterEach(() => {
    cwdSpy.mockRestore();
  });

  it('writes each workspace file to its fixed name', async () => {
    for (const [kind, name] of [
      ['compose', 'docker-compose.yml'],
      ['dotenv', '.env'],
      ['compose-override', '.ninedeploy.compose.override.yml'],
    ] as const) {
      await runOp('file.writeWorkspace', { workspace: 'ghost', kind, content: `# ${kind}` }, () => {});
      expect(readFileSync(join(work, '.agent-work', 'ghost', name), 'utf8')).toBe(`# ${kind}`);
    }
  });

  it('refuses a kind that is not one of the three known files', async () => {
    // `kind` is an enum, never a filename, so no caller can steer the write.
    for (const kind of ['../../etc/passwd', 'acme.json', '', undefined]) {
      await expect(
        runOp('file.writeWorkspace', { workspace: 'ghost', kind, content: 'x' }, () => {}),
      ).rejects.toThrow(/Invalid workspace file kind/);
    }
  });

  it('refuses content with a NUL or past the size cap', async () => {
    const withNul = `a${String.fromCharCode(0)}b`;
    await expect(
      runOp('file.writeWorkspace', { workspace: 'ghost', kind: 'compose', content: withNul }, () => {}),
    ).rejects.toThrow(/Invalid file content/);
    await expect(
      runOp(
        'file.writeWorkspace',
        { workspace: 'ghost', kind: 'compose', content: 'a'.repeat(1024 * 1024 + 1) },
        () => {},
      ),
    ).rejects.toThrow(/File too large/);
  });

  it('refuses a workspace name that could escape the work root', async () => {
    await expect(
      runOp('file.writeWorkspace', { workspace: '../etc', kind: 'compose', content: 'x' }, () => {}),
    ).rejects.toThrow(/Invalid workspace name/);
  });

  it('deletes a workspace file that carried secrets', async () => {
    await runOp('file.writeWorkspace', { workspace: 'ghost', kind: 'dotenv', content: 'A=1' }, () => {});
    await runOp('file.deleteWorkspace', { workspace: 'ghost', kind: 'dotenv' }, () => {});
    expect(existsSync(join(work, '.agent-work', 'ghost', '.env'))).toBe(false);
    // Deleting one that is already gone must not throw — the deploy path calls
    // this in a `finally`.
    await expect(
      runOp('file.deleteWorkspace', { workspace: 'ghost', kind: 'dotenv' }, () => {}),
    ).resolves.toBe(0);
  });

  it('builds the preflight argvs that run before the live stack is touched', async () => {
    expect(await argvOf('docker.composeConfig', { project: 'ndcmp-ghost', file: 'docker-compose.yml' })).toEqual(
      ['compose', '-p', 'ndcmp-ghost', '-f', 'docker-compose.yml', 'config', '--quiet'],
    );
    expect(await argvOf('docker.composePull', { project: 'ndcmp-ghost', file: 'docker-compose.yml' })).toEqual(
      ['compose', '-p', 'ndcmp-ghost', '-f', 'docker-compose.yml', 'pull', '--ignore-buildable', '--quiet'],
    );
  });

  it('passes the override file to every compose operation that takes one', async () => {
    // Compose merges -f left to right, so the override wins on duplicate keys —
    // writing the file and not naming it would silently drop the attachments.
    const argv = await argvOf('docker.composeUp', {
      project: 'ndcmp-ghost',
      file: 'docker-compose.yml',
      override: '.ninedeploy.compose.override.yml',
    });
    expect(argv.slice(0, 7)).toEqual([
      'compose', '-p', 'ndcmp-ghost',
      '-f', 'docker-compose.yml',
      '-f', '.ninedeploy.compose.override.yml',
    ]);
  });

  it('refuses an override path that climbs out of the workspace', async () => {
    await expect(
      runOp(
        'docker.composeUp',
        { project: 'p', file: 'docker-compose.yml', override: '../../etc/passwd' },
        () => {},
      ),
    ).rejects.toThrow(/Invalid compose override file/);
  });

  it('applies the restart policy to the containers compose reported', async () => {
    // A compose file without `restart:` leaves every container dead after a
    // host reboot, and compose offers no override — on a node nobody is
    // watching that happen.
    spawnMock.mockImplementation(async (_exe: string, argv: string[], onLine: (l: string) => void) => {
      if (argv.includes('ps')) {
        onLine('a1b2c3d4e5f6');
        onLine('f6e5d4c3b2a1');
        onLine('some progress noise');
      }
      return 0;
    });

    await expect(
      runOp('docker.composeRestartPolicy', { workspace: 'ghost', project: 'ndcmp-ghost', file: 'docker-compose.yml' }, () => {}),
    ).resolves.toBe(0);

    const update = spawnMock.mock.calls.find((c) => (c[1] as string[])[0] === 'update')!;
    expect(update[1]).toEqual(['update', '--restart', 'unless-stopped', 'a1b2c3d4e5f6', 'f6e5d4c3b2a1']);
  });

  it('says so and stops when compose reports no containers', async () => {
    spawnMock.mockImplementation(async () => 0);
    const lines: string[] = [];
    await expect(
      runOp('docker.composeRestartPolicy', { workspace: 'ghost', project: 'ndcmp-ghost', file: 'docker-compose.yml' }, (l) => lines.push(l)),
    ).resolves.toBe(0);
    expect(lines.join(String.fromCharCode(10))).toMatch(/no containers/);
    expect(spawnMock.mock.calls.some((c) => (c[1] as string[])[0] === 'update')).toBe(false);
  });
});

describe('agent inspect formats', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockResolvedValue(0);
  });

  it('offers a fixed set of literal formats and never a caller-supplied one', async () => {
    const state = await argvOf('docker.inspect', { name: 'web-1', format: 'state' });
    expect(state.at(-1)).toContain('{{.State.Status}}');

    const health = await argvOf('docker.inspect', { name: 'web-1', format: 'health' });
    // A compose stack that boots, stays `running` and fails its own healthcheck
    // forever must not deploy green.
    expect(health.at(-1)).toContain('{{.State.Health.Status}}');
    expect(health.at(-1)).toContain('{{.RestartCount}}');

    // Anything else falls back to the image format — a caller-supplied template
    // would be an injection surface into the docker CLI.
    const injected = await argvOf('docker.inspect', { name: 'web-1', format: '{{.Config.Env}}' });
    expect(injected.at(-1)).toBe('{{.Image}}');
  });
});
