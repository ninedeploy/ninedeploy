import { describe, expect, it, vi } from 'vitest';

// The egress gate resolves DNS; tests never touch the network (r099).
const egressMocks = vi.hoisted(() => ({ assertCloneTargetAllowed: vi.fn(async (_url: string) => undefined) }));
vi.mock('../../src/lib/gitEgress.js', () => egressMocks);

import {
  createRemoteDockerBuilder,
  RemoteDeployUnsupportedError,
} from '../../src/engine/builders/remoteDocker.js';
import type { BuildContext } from '../../src/engine/types.js';

/**
 * Remote Docker builder — deploys onto a registered node through the typed
 * agent protocol.
 *
 * r037. `server_id` had been on the services table, on the Servers page and in
 * the BuildContext since the fleet feature shipped, and no builder read it:
 * docker, pm2 and compose all shell out locally. A service pinned to a node
 * would have been built and started on the PANEL host while the panel reported
 * the node, so the pipeline refused it outright. These tests pin the behaviour
 * that made the refusal unnecessary — and the refusals that remain.
 */

type AgentCall = (
  op: string,
  params: Record<string, unknown>,
  sink: (line: string) => void,
) => Promise<{ exitCode: number; lines: string[] }>;

/** An agent that answers every op successfully and reports a running container. */
function fakeAgent(overrides: Record<string, { exitCode: number; lines: string[] }> = {}) {
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  const agent: AgentCall = async (op, params, sink) => {
    calls.push({ op, params });
    // A real agent streams output back through the sink; exercising it keeps
    // the builder's log plumbing covered rather than merely constructed.
    sink(`${op} ok`);
    if (overrides[op]) return overrides[op]!;
    if (op === 'file.writeEnv') return { exitCode: 0, lines: ['wrote .agent-env/web-7.env'] };
    if (op === 'docker.inspect') return { exitCode: 0, lines: ['running|172.18.0.9'] };
    return { exitCode: 0, lines: [] };
  };
  return { agent, calls, ops: () => calls.map((c) => c.op) };
}

const svc = (over: Record<string, unknown> = {}) =>
  ({
    id: 1,
    name: 'web',
    slug: 'web',
    type: 'docker',
    image: null,
    repoUrl: null,
    branch: null,
    port: 3000,
    healthPath: '/',
    cpuShares: 0,
    memLimitMb: 0,
    volumeMount: null,
    publishedPort: null,
    serverId: 4,
    ...over,
  }) as never;

const ctx = (over: Partial<BuildContext> = {}): BuildContext =>
  ({
    deploymentId: 7,
    service: svc(),
    workDir: '/tmp/x',
    commitSha: '',
    env: { FOO: 'bar' },
    log: () => undefined,
    ...over,
  }) as BuildContext;

describe('remote docker builder — image services', () => {
  it('pulls and runs the image on the node, never locally', async () => {
    const { agent, calls, ops } = fakeAgent();
    const runtime = await createRemoteDockerBuilder(agent).buildAndRun(
      ctx({ service: svc({ image: 'nginx:1.27' }) }),
    );

    expect(ops()).toEqual(['docker.pull', 'file.writeEnv', 'docker.runEnv', 'file.deleteEnv']);
    expect(calls[0]!.params).toMatchObject({ image: 'nginx:1.27' });
    expect(runtime).toMatchObject({ runtimeId: 'web-7', port: 3000, imageDigest: 'nginx:1.27' });
  });

  it('pins the exact digest on a rollback rather than the mutable tag', async () => {
    const { agent, calls } = fakeAgent();
    await createRemoteDockerBuilder(agent).buildAndRun(
      ctx({ service: svc({ image: 'nginx:1.27' }), imageDigest: 'nginx@sha256:abc' }),
    );
    expect(calls[0]!.params).toMatchObject({ image: 'nginx@sha256:abc' });
  });

  it('sends the environment as a file and deletes it once the container has it', async () => {
    const { agent, calls, ops } = fakeAgent();
    await createRemoteDockerBuilder(agent).buildAndRun(ctx({ service: svc({ image: 'nginx:1' }) }));

    const write = calls.find((c) => c.op === 'file.writeEnv')!;
    expect(write.params).toMatchObject({ env: { FOO: 'bar' } });
    const run = calls.find((c) => c.op === 'docker.runEnv')!;
    // Secrets ride in a 0600 env-file, never in argv, so they stay out of the
    // node's process table.
    expect(run.params).toMatchObject({ envFile: '.agent-env/web-7.env' });
    // Leaving decrypted secrets on the node's disk after the run consumed them
    // is pure exposure.
    expect(ops().indexOf('file.deleteEnv')).toBeGreaterThan(ops().indexOf('docker.runEnv'));
  });

  it('deletes the env file even when the run fails', async () => {
    const { agent, ops } = fakeAgent();
    const failing: AgentCall = async (op, params, sink) => {
      if (op === 'docker.runEnv') throw new Error('no space left on device');
      return agent(op, params, sink);
    };
    await expect(
      createRemoteDockerBuilder(failing).buildAndRun(ctx({ service: svc({ image: 'nginx:1' }) })),
    ).rejects.toThrow(/no space left/);
    expect(ops()).toContain('file.deleteEnv');
  });

  it('logs in to a private registry and always logs out again', async () => {
    const { agent, calls, ops } = fakeAgent();
    await createRemoteDockerBuilder(agent).buildAndRun(
      ctx({
        service: svc({ image: 'ghcr.io/acme/app:1' }),
        registryAuth: { username: 'u', password: 'p', server: 'ghcr.io' },
      }),
    );
    expect(ops().slice(0, 3)).toEqual(['docker.login', 'docker.pull', 'docker.logout']);
    // The password goes in params, and the agent hands it to stdin — never argv.
    expect(calls[0]!.params).toMatchObject({ username: 'u', password: 'p', server: 'ghcr.io' });
  });

  it('logs out even when the pull fails, so no credential lingers on the node', async () => {
    const { agent, ops } = fakeAgent();
    const failing: AgentCall = async (op, params, sink) => {
      if (op === 'docker.pull') throw new Error('manifest unknown');
      return agent(op, params, sink);
    };
    await expect(
      createRemoteDockerBuilder(failing).buildAndRun(
        ctx({
          service: svc({ image: 'ghcr.io/acme/app:1' }),
          registryAuth: { username: 'u', password: 'p', server: 'ghcr.io' },
        }),
      ),
    ).rejects.toThrow(/manifest unknown/);
    expect(ops()).toContain('docker.logout');
  });
});

describe('remote docker builder — repository services', () => {
  it('checks the repo out in the node workspace and builds the Dockerfile there', async () => {
    const { agent, calls, ops } = fakeAgent();
    await createRemoteDockerBuilder(agent).buildAndRun(
      ctx({
        service: svc({ repoUrl: 'https://github.com/acme/app.git', branch: 'main' }),
        commitSha: 'deadbeefcafe',
        buildConfig: { buildPack: 'dockerfile', dockerfilePath: '/Dockerfile', baseDir: '/' } as never,
      }),
    );

    expect(ops().slice(0, 4)).toEqual(['git.ensure', 'git.fetch', 'git.checkout', 'git.reset']);
    // Every git op names the same per-service workspace: without one, a node
    // could hold exactly ONE checkout and two services would overwrite each
    // other's source tree.
    for (const call of calls.filter((c) => c.op.startsWith('git.'))) {
      expect(call.params).toMatchObject({ workspace: 'web' });
    }

    const build = calls.find((c) => c.op === 'docker.build')!;
    expect(build.params).toMatchObject({
      workspace: 'web',
      tag: 'ninedeploy/web:deadbee',
      // Leading slashes mean "repo root" in the panel's fields; on the node
      // they would be the filesystem root.
      dockerfile: 'Dockerfile',
      context: '.',
    });
  });

  it('runs the egress gate before the node clones, and stops when it refuses (r099)', async () => {
    const { agent, ops } = fakeAgent();
    egressMocks.assertCloneTargetAllowed.mockRejectedValueOnce(new Error('Refusing to send an outbound request'));
    await expect(
      createRemoteDockerBuilder(agent).buildAndRun(
        ctx({ service: svc({ repoUrl: 'https://metadata.evil.example/r.git' }), commitSha: 'abc1234' }),
      ),
    ).rejects.toThrow(/Refusing to send an outbound request/);
    expect(egressMocks.assertCloneTargetAllowed).toHaveBeenCalledWith('https://metadata.evil.example/r.git');
    expect(ops()).not.toContain('git.ensure');
  });

  it('skips the branch checkout when the service pins no branch', async () => {
    const { agent, ops } = fakeAgent();
    await createRemoteDockerBuilder(agent).buildAndRun(
      ctx({ service: svc({ repoUrl: 'https://github.com/acme/app.git' }), commitSha: 'abc1234' }),
    );
    expect(ops()).not.toContain('git.checkout');
    expect(ops()).toContain('git.reset');
  });
});

describe('remote docker builder — what it refuses', () => {
  it('refuses a Nixpacks build instead of pretending the node can do it', async () => {
    const { agent } = fakeAgent();
    await expect(
      createRemoteDockerBuilder(agent).buildAndRun(
        ctx({
          service: svc({ repoUrl: 'https://github.com/acme/app.git' }),
          buildConfig: { buildPack: 'nixpacks' } as never,
        }),
      ),
    ).rejects.toThrow(RemoteDeployUnsupportedError);
  });

  it('refuses a non-docker service', async () => {
    const { agent } = fakeAgent();
    await expect(
      createRemoteDockerBuilder(agent).buildAndRun(ctx({ service: svc({ type: 'pm2' }) })),
    ).rejects.toThrow(/docker services only/);
  });

  it('refuses a service with neither an image nor a repository', async () => {
    const { agent } = fakeAgent();
    await expect(createRemoteDockerBuilder(agent).buildAndRun(ctx())).rejects.toThrow(
      /nothing to deploy/,
    );
  });
});

describe('remote docker builder — logging', () => {
  it('streams the node output into the deploy log', async () => {
    const { agent } = fakeAgent();
    const lines: string[] = [];
    await createRemoteDockerBuilder(agent).buildAndRun(
      ctx({ service: svc({ image: 'nginx:1' }), log: (l) => lines.push(l) }),
    );
    // The operator reads one log, wherever the build ran.
    expect(lines.join(String.fromCharCode(10))).toMatch(/docker.pull ok/);
    expect(lines.join(String.fromCharCode(10))).toMatch(/Starting web-7 on the node/);
  });
});

describe('remote docker builder — runtime shape', () => {
  it('carries limits and the primary volume through to the node', async () => {
    const { agent, calls } = fakeAgent();
    await createRemoteDockerBuilder(agent).buildAndRun(
      ctx({
        service: svc({ image: 'nginx:1', cpuShares: 512, memLimitMb: 256, volumeMount: '/data' }),
      }),
    );
    expect(calls.find((c) => c.op === 'docker.runEnv')!.params).toMatchObject({
      cpuShares: '512',
      memLimitMb: '256',
      volume: 'nd-svc-web-data',
      mount: '/data',
    });
  });

  it('publishes a host port only when the service asks for direct access', async () => {
    const { agent, calls } = fakeAgent();
    await createRemoteDockerBuilder(agent).buildAndRun(ctx({ service: svc({ image: 'nginx:1' }) }));
    // Domain traffic reaches the container through the NODE's own Traefik over
    // the shared network, so the common case exposes nothing on the host.
    expect(calls.find((c) => c.op === 'docker.runEnv')!.params['publish']).toBeUndefined();

    const second = fakeAgent();
    await createRemoteDockerBuilder(second.agent).buildAndRun(
      ctx({ service: svc({ image: 'nginx:1', publishedPort: 8080 }) }),
    );
    expect(second.calls.find((c) => c.op === 'docker.runEnv')!.params).toMatchObject({
      publish: '8080:3000',
    });
  });
});

describe('remote docker builder — health and teardown', () => {
  const runtime = { runtimeId: 'web-7', port: 3000, healthPath: '/' };

  it('reports healthy once the node says the container is running', async () => {
    const { agent } = fakeAgent();
    await expect(createRemoteDockerBuilder(agent).isHealthy(runtime, 5000)).resolves.toBe(true);
  });

  it('reports unhealthy and pulls the container logs when it exited', async () => {
    const { agent, ops } = fakeAgent({ 'docker.inspect': { exitCode: 0, lines: ['exited|'] } });
    const lines: string[] = [];
    await expect(
      createRemoteDockerBuilder(agent).isHealthy(runtime, 5000, 0, (l) => lines.push(l)),
    ).resolves.toBe(false);
    // The failure has to be diagnosable from the deploy log, not only from the
    // node's own shell.
    expect(ops()).toContain('docker.logs');
    expect(lines.join('\n')).toMatch(/exited/);
  });

  it('gives up at the deadline rather than polling forever', async () => {
    vi.useFakeTimers();
    try {
      const { agent } = fakeAgent({ 'docker.inspect': { exitCode: 0, lines: ['created|'] } });
      const lines: string[] = [];
      const promise = createRemoteDockerBuilder(agent).isHealthy(runtime, 4000, 0, (l) => lines.push(l));
      await vi.advanceTimersByTimeAsync(6000);
      await expect(promise).resolves.toBe(false);
      expect(lines.join('\n')).toMatch(/did not reach a running state/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fail a good deploy because the logout call failed', async () => {
    const { agent } = fakeAgent();
    const flaky: AgentCall = async (op, params, sink) => {
      if (op === 'docker.logout') throw new Error('daemon busy');
      return agent(op, params, sink);
    };
    // The image is pulled and the container is running; a stuck logout is a
    // hygiene problem on the node, not a reason to fail the deployment.
    await expect(
      createRemoteDockerBuilder(flaky).buildAndRun(
        ctx({
          service: svc({ image: 'ghcr.io/acme/app:1' }),
          registryAuth: { username: 'u', password: 'p' },
        }),
      ),
    ).resolves.toMatchObject({ runtimeId: 'web-7' });
  });

  it('tolerates a teardown where both stop and rm fail', async () => {
    const boom: AgentCall = async () => {
      throw new Error('node unreachable');
    };
    // A node that is down must not wedge the pipeline's cleanup path.
    await expect(createRemoteDockerBuilder(boom).stop('web-7')).resolves.toBeUndefined();
  });

  it('stops and removes the container, tolerating one that is already gone', async () => {
    const { agent, ops } = fakeAgent();
    const flaky: AgentCall = async (op, params, sink) => {
      if (op === 'docker.stop') throw new Error('No such container');
      return agent(op, params, sink);
    };
    await expect(createRemoteDockerBuilder(flaky).stop('web-7')).resolves.toBeUndefined();
    // A teardown must not fail because the container had already exited.
    expect(ops()).toContain('docker.rm');
  });
});
