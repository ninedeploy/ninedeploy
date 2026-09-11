import { describe, expect, it, vi } from 'vitest';

// The egress gate resolves DNS; tests never touch the network (r099).
const egressMocks = vi.hoisted(() => ({ assertCloneTargetAllowed: vi.fn(async (_url: string) => undefined) }));
vi.mock('../../src/lib/gitEgress.js', () => egressMocks);

import { createRemoteComposeBuilder } from '../../src/engine/builders/remoteCompose.js';
import { RemoteDeployUnsupportedError } from '../../src/engine/builders/remoteDocker.js';
import type { BuildContext } from '../../src/engine/types.js';

/**
 * Remote Compose builder — brings a compose stack up on a registered node.
 *
 * r037. Most of the one-click template catalogue is compose-shaped, so until
 * this existed multi-node worked for hand-rolled docker services and nothing
 * else: the entire template library was unavailable on a node.
 *
 * The ORDER is the part worth pinning. Preflight (`config`, then `pull`) runs
 * while the previous revision is still serving, so a broken `${VAR}` reference
 * or a bad tag fails the deployment without ever having torn the live stack
 * down — the same ordering the local builder uses and for the same reason.
 */

type AgentCall = (
  op: string,
  params: Record<string, unknown>,
  sink: (line: string) => void,
) => Promise<{ exitCode: number; lines: string[] }>;

function fakeAgent(overrides: Record<string, { exitCode: number; lines: string[] }> = {}) {
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  const agent: AgentCall = async (op, params, sink) => {
    calls.push({ op, params });
    sink(`${op} ok`);
    if (overrides[op]) return overrides[op]!;
    if (op === 'docker.inspect') return { exitCode: 0, lines: ['running|healthy|0|0'] };
    return { exitCode: 0, lines: [] };
  };
  return { agent, calls, ops: () => calls.map((c) => c.op) };
}

const svc = (over: Record<string, unknown> = {}) =>
  ({
    id: 1,
    name: 'ghost',
    slug: 'ghost',
    type: 'compose',
    composeService: 'ghost',
    composeContent: 'services:\n  ghost:\n    image: ghost:5\n',
    repoUrl: null,
    branch: null,
    port: 2368,
    healthPath: '/',
    serverId: 4,
    ...over,
  }) as never;

const ctx = (over: Partial<BuildContext> = {}): BuildContext =>
  ({
    deploymentId: 7,
    service: svc(),
    workDir: '/tmp/x',
    commitSha: '',
    env: {},
    log: () => undefined,
    ...over,
  }) as BuildContext;

describe('remote compose builder — inline stacks', () => {
  it('ships the YAML to the node and brings the project up', async () => {
    const { agent, calls, ops } = fakeAgent();
    const runtime = await createRemoteComposeBuilder(agent).buildAndRun(ctx());

    const write = calls.find((c) => c.op === 'file.writeWorkspace')!;
    expect(write.params).toMatchObject({
      workspace: 'ghost',
      // `kind` is an enum, never a filename, so no caller can steer the write.
      kind: 'compose',
      content: 'services:\n  ghost:\n    image: ghost:5\n',
    });
    expect(ops()).toContain('docker.composeUp');
    expect(calls.find((c) => c.op === 'docker.composeUp')!.params).toMatchObject({
      project: 'ndcmp-ghost',
      file: 'docker-compose.yml',
    });
    expect(runtime.runtimeId).toBe('ndcmp-ghost-ghost-1');
  });

  it('runs both preflight gates before touching the live stack', async () => {
    const { agent, ops } = fakeAgent();
    await createRemoteComposeBuilder(agent).buildAndRun(ctx());

    const order = ops();
    expect(order.indexOf('docker.composeConfig')).toBeLessThan(order.indexOf('docker.composeUp'));
    expect(order.indexOf('docker.composePull')).toBeLessThan(order.indexOf('docker.composeUp'));
  });

  it('continues to up --build when the pre-pull is unavailable', async () => {
    const { agent, ops } = fakeAgent();
    const noPull: AgentCall = async (op, params, sink) => {
      // Older compose CLIs lack --ignore-buildable, and a build-only stack has
      // nothing to pull. Neither is a reason to fail before `up` has tried.
      if (op === 'docker.composePull') throw new Error('unknown flag: --ignore-buildable');
      return agent(op, params, sink);
    };
    const lines: string[] = [];
    await createRemoteComposeBuilder(noPull).buildAndRun(ctx({ log: (l) => lines.push(l) }));
    expect(ops()).toContain('docker.composeUp');
    expect(lines.join(String.fromCharCode(10))).toMatch(/pre-pull skipped/);
  });

  it('attaches the node proxy to the compose project network', async () => {
    const { agent, calls, ops } = fakeAgent();
    await createRemoteComposeBuilder(agent).buildAndRun(ctx());

    // The node's Traefik is on the shared `ninedeploy` network, but a compose
    // project creates its OWN default network — without this every domain on
    // the stack answers 502.
    const connect = calls.find((c) => c.op === 'docker.networkConnect')!;
    expect(connect.params).toMatchObject({
      network: 'ndcmp-ghost_default',
      container: 'ninedeploy-proxy',
    });
    expect(ops().indexOf('docker.networkConnect')).toBeGreaterThan(ops().indexOf('docker.composeUp'));
  });

  it('does not fail a healthy deploy because the proxy was already attached', async () => {
    const { agent } = fakeAgent();
    const already: AgentCall = async (op, params, sink) => {
      // docker reports an existing attachment as an error on every redeploy.
      if (op === 'docker.networkConnect') throw new Error('endpoint already exists in network');
      return agent(op, params, sink);
    };
    const lines: string[] = [];
    await expect(
      createRemoteComposeBuilder(already).buildAndRun(ctx({ log: (l) => lines.push(l) })),
    ).resolves.toMatchObject({ runtimeId: 'ndcmp-ghost-ghost-1' });
    expect(lines.join(String.fromCharCode(10))).toMatch(/already attached is normal/);
  });

  it('applies the platform restart policy after a successful up', async () => {
    const { agent, ops } = fakeAgent();
    await createRemoteComposeBuilder(agent).buildAndRun(ctx());
    // Compose offers no restart override, and a file without `restart:` leaves
    // every container dead after a reboot — on a node nobody is watching.
    expect(ops().indexOf('docker.composeRestartPolicy')).toBeGreaterThan(ops().indexOf('docker.composeUp'));
  });

  it('does not fail a deployed stack because the restart policy could not be set', async () => {
    const { agent } = fakeAgent();
    const flaky: AgentCall = async (op, params, sink) => {
      if (op === 'docker.composeRestartPolicy') throw new Error('docker update refused');
      return agent(op, params, sink);
    };
    const lines: string[] = [];
    await expect(
      createRemoteComposeBuilder(flaky).buildAndRun(ctx({ log: (l) => lines.push(l) })),
    ).resolves.toMatchObject({ runtimeId: 'ndcmp-ghost-ghost-1' });
    expect(lines.join(String.fromCharCode(10))).toMatch(/restart policy not applied/);
  });
});

describe('remote compose builder — secrets and attachments', () => {
  it('writes a dotenv the node can read, then deletes it', async () => {
    const { agent, calls, ops } = fakeAgent();
    await createRemoteComposeBuilder(agent).buildAndRun(ctx({ env: { TOKEN: 'abc' } }));

    const dotenv = calls.find((c) => c.op === 'file.writeWorkspace' && c.params['kind'] === 'dotenv')!;
    expect(dotenv.params['content']).toBe('TOKEN="abc"\n');
    // The stack has read it; leaving decrypted secrets on the node is exposure.
    expect(ops()).toContain('file.deleteWorkspace');
  });

  it('quotes and escapes dotenv values the way compose parses them', async () => {
    const { agent, calls } = fakeAgent();
    await createRemoteComposeBuilder(agent).buildAndRun(
      // Unquoted values are truncated at the first " #", and double-quoted ones
      // undergo $VAR expansion from the CLI's own environment.
      ctx({ env: { A: 'abc #def', B: 'x$HOME', C: 'line1\nline2' } }),
    );
    const content = calls.find((c) => c.params['kind'] === 'dotenv')!.params['content'] as string;
    expect(content).toContain('A="abc #def"');
    expect(content).toContain('B="x\\$HOME"');
    expect(content).toContain('C="line1\\nline2"');
  });

  it('writes no dotenv at all when the service has no environment', async () => {
    const { agent, calls } = fakeAgent();
    await createRemoteComposeBuilder(agent).buildAndRun(ctx({ env: {} }));
    expect(calls.some((c) => c.params['kind'] === 'dotenv')).toBe(false);
  });

  it('adds volume attachments through a compose override that wins on merge', async () => {
    const { agent, calls } = fakeAgent();
    await createRemoteComposeBuilder(agent).buildAndRun(
      ctx({
        volumeAttachments: [
          { volumeName: 'nd-data', containerPath: '/var/lib/data', readOnly: false },
          { volumeName: 'nd-ro', containerPath: '/ref', readOnly: true },
        ] as never,
      }),
    );

    const override = calls.find((c) => c.params['kind'] === 'compose-override')!;
    const body = override.params['content'] as string;
    expect(body).toContain('- "nd-data:/var/lib/data"');
    expect(body).toContain('- "nd-ro:/ref:ro"');
    // Externally-managed volumes: compose must not try to create them.
    expect(body).toContain('external: true');
    // Compose merges -f left to right, so the override has to be passed too —
    // writing the file and not naming it would silently drop the attachments.
    expect(calls.find((c) => c.op === 'docker.composeUp')!.params).toMatchObject({
      override: '.ninedeploy.compose.override.yml',
    });
  });

  it('passes no override when the service has no attachments', async () => {
    const { agent, calls } = fakeAgent();
    await createRemoteComposeBuilder(agent).buildAndRun(ctx());
    expect(calls.find((c) => c.op === 'docker.composeUp')!.params['override']).toBeUndefined();
  });

  it('still removes the secret files when the up fails', async () => {
    const { agent, calls } = fakeAgent();
    const failing: AgentCall = async (op, params, sink) => {
      if (op === 'docker.composeUp') throw new Error('port is already allocated');
      return agent(op, params, sink);
    };
    await expect(
      createRemoteComposeBuilder(failing).buildAndRun(ctx({ env: { TOKEN: 'abc' } })),
    ).rejects.toThrow(/already allocated/);
    expect(calls.some((c) => c.op === 'file.deleteWorkspace')).toBe(true);
  });
});

describe('remote compose builder — repository stacks', () => {
  it('checks the repository out on the node and honours its compose path', async () => {
    const { agent, calls, ops } = fakeAgent();
    await createRemoteComposeBuilder(agent).buildAndRun(
      ctx({
        service: svc({ composeContent: null, repoUrl: 'https://github.com/acme/stack.git', branch: 'main' }),
        commitSha: 'abc1234',
        buildConfig: { dockerfilePath: '/deploy/compose.yml' } as never,
      }),
    );
    expect(ops().slice(0, 4)).toEqual(['git.ensure', 'git.fetch', 'git.checkout', 'git.reset']);
    // A leading slash means "repo root" in the panel's field; on the node it
    // would be the filesystem root.
    expect(calls.find((c) => c.op === 'docker.composeUp')!.params).toMatchObject({
      file: 'deploy/compose.yml',
    });
  });

  it('runs the egress gate before the node clones, and stops when it refuses (r099)', async () => {
    const { agent, ops } = fakeAgent();
    egressMocks.assertCloneTargetAllowed.mockRejectedValueOnce(new Error('Refusing to send an outbound request'));
    await expect(
      createRemoteComposeBuilder(agent).buildAndRun(
        ctx({ service: svc({ composeContent: null, repoUrl: 'https://metadata.evil.example/s.git' }), commitSha: 'abc1234' }),
      ),
    ).rejects.toThrow(/Refusing to send an outbound request/);
    expect(egressMocks.assertCloneTargetAllowed).toHaveBeenCalledWith('https://metadata.evil.example/s.git');
    expect(ops()).not.toContain('git.ensure');
  });

  it('refuses a compose service with neither inline YAML nor a repository', async () => {
    const { agent } = fakeAgent();
    await expect(
      createRemoteComposeBuilder(agent).buildAndRun(
        ctx({ service: svc({ composeContent: null, repoUrl: null }) }),
      ),
    ).rejects.toThrow(RemoteDeployUnsupportedError);
  });
});

describe('remote compose builder — health and teardown', () => {
  const runtime = { runtimeId: 'ndcmp-ghost-ghost-1', port: 2368, healthPath: '/' };

  it('accepts a running container that declares no healthcheck', async () => {
    const { agent } = fakeAgent({ 'docker.inspect': { exitCode: 0, lines: ['running|none|0|0'] } });
    await expect(createRemoteComposeBuilder(agent).isHealthy(runtime, 5000)).resolves.toBe(true);
  });

  it('waits for a declared healthcheck instead of trusting `running`', async () => {
    vi.useFakeTimers();
    try {
      // An app that boots, stays `running` and never goes healthy is not green.
      const { agent } = fakeAgent({ 'docker.inspect': { exitCode: 0, lines: ['running|starting|0|0'] } });
      const promise = createRemoteComposeBuilder(agent).isHealthy(runtime, 4000);
      await vi.advanceTimersByTimeAsync(6000);
      await expect(promise).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails fast on a crash-looping stack rather than burning the window', async () => {
    let restarts = 0;
    const agent: AgentCall = async (op) => {
      if (op !== 'docker.inspect') return { exitCode: 0, lines: [] };
      restarts += 2;
      return { exitCode: 0, lines: [`running|starting|0|${restarts}`] };
    };
    const lines: string[] = [];
    await expect(
      createRemoteComposeBuilder(agent).isHealthy(runtime, 30_000, 0, (l) => lines.push(l)),
    ).resolves.toBe(false);
    expect(lines.join(String.fromCharCode(10))).toMatch(/crash-looping/);
  });

  it('fails fast on a healthcheck that keeps failing', async () => {
    const { agent } = fakeAgent({ 'docker.inspect': { exitCode: 0, lines: ['running|unhealthy|20|0'] } });
    const lines: string[] = [];
    await expect(
      createRemoteComposeBuilder(agent).isHealthy(runtime, 30_000, 0, (l) => lines.push(l)),
    ).resolves.toBe(false);
    expect(lines.join(String.fromCharCode(10))).toMatch(/healthcheck keeps failing/);
  });

  it('pulls the container logs when the stack exited', async () => {
    const { agent, ops } = fakeAgent({ 'docker.inspect': { exitCode: 0, lines: ['exited|none|0|0'] } });
    await expect(createRemoteComposeBuilder(agent).isHealthy(runtime, 5000)).resolves.toBe(false);
    // The failure has to be diagnosable from the deploy log, not only the node.
    expect(ops()).toContain('docker.logs');
  });

  it('brings the project down by the name it minted', async () => {
    const { agent, calls } = fakeAgent();
    // The builder records the project→runtimeId mapping at buildAndRun time
    // (r008), so stop() can tear down the right project without string
    // surgery. Drive buildAndRun first to populate that map.
    const builder = createRemoteComposeBuilder(agent);
    const runtime = await builder.buildAndRun(ctx());
    await builder.stop(runtime.runtimeId);
    expect(calls.find((c) => c.op === 'docker.composeDown')!.params).toMatchObject({
      project: 'ndcmp-ghost',
    });
  });

  /**
   * r008 — the previous stop() recovered the project via
   * `runtimeId.replace(/-[^-]+-\d+$/, '')`, which strips exactly ONE
   * trailing `-[^-]+-\d+` block. The compose service key is a user-
   * controlled YAML map name and can itself contain hyphens
   * (`services.frontend-api:`), in which case the regex stops inside
   * the service name and leaves partial residue. `ndcmp-web-frontend-api-1`
   * extracted `ndcmp-web-frontend` instead of `ndcmp-web`, so the
   * production path called `docker compose down -p ndcmp-web-frontend`
   * on the node — tearing down the WRONG project. The fix records the
   * project at buildAndRun return and looks it up at stop() time, so
   * no string surgery can drift.
   */
  it('tears down the right project when the compose service key contains a hyphen (r008)', async () => {
    const { agent, calls } = fakeAgent();
    const builder = createRemoteComposeBuilder(agent);
    const runtime = await builder.buildAndRun(
      ctx({ service: svc({ slug: 'web', composeService: 'frontend-api' }) }),
    );
    expect(runtime.runtimeId).toBe('ndcmp-web-frontend-api-1');
    await builder.stop(runtime.runtimeId);
    expect(calls.find((c) => c.op === 'docker.composeDown')!.params).toMatchObject({
      project: 'ndcmp-web',
    });
  });

  it('tears down the right project when both slug and service key contain hyphens (r008)', async () => {
    const { agent, calls } = fakeAgent();
    const builder = createRemoteComposeBuilder(agent);
    const runtime = await builder.buildAndRun(
      ctx({ service: svc({ slug: 'web-app', composeService: 'frontend-api' }) }),
    );
    expect(runtime.runtimeId).toBe('ndcmp-web-app-frontend-api-1');
    await builder.stop(runtime.runtimeId);
    expect(calls.find((c) => c.op === 'docker.composeDown')!.params).toMatchObject({
      project: 'ndcmp-web-app',
    });
  });

  it('refuses to bring anything down for a container it did not name', async () => {
    const { agent, ops } = fakeAgent();
    // `docker compose down -p` on a guessed project would tear down whatever
    // happened to match — never guess from a foreign container name.
    await createRemoteComposeBuilder(agent).stop('some-other-container-1');
    expect(ops()).not.toContain('docker.composeDown');
  });

  it('tolerates a node that is unreachable during teardown', async () => {
    const boom: AgentCall = async () => {
      throw new Error('node unreachable');
    };
    await expect(
      createRemoteComposeBuilder(boom).stop('ndcmp-ghost-ghost-1'),
    ).resolves.toBeUndefined();
  });
});
