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
    // r660: a current agent names its capabilities in the sealed ping.
    if (op === 'agent.ping') return { exitCode: 0, lines: ['ND-AGENT {"version":"0.10.42","caps":["build-path-guard","workspace.remove"]}'] };
    if (op === 'file.writeEnv') return { exitCode: 0, lines: ['wrote .agent-env/web-7.env'] };
    if (op === 'docker.inspect') return { exitCode: 0, lines: ['running|none|0|0'] };
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
  it('preserves an explicitly configured container-state readiness mode', async () => {
    const { agent } = fakeAgent();
    const runtime = await createRemoteDockerBuilder(agent).buildAndRun(ctx({ service: svc({ image: 'nginx:1', healthCheck: 'running' }) }));
    expect(runtime.healthCheck).toBe('running');
  });
  it('records the actual image and pack conventions of an ordinary node source build when requested', async () => {
    const imageId = `sha256:${'c'.repeat(64)}`;
    const { agent, ops } = fakeAgent({ 'docker.inspect': { exitCode: 0, lines: [imageId] } });
    const runtime = await createRemoteDockerBuilder(agent).buildAndRun(ctx({ service: svc({ repoUrl: 'https://example.test/repo.git' }), recordDockerArtifact: true } as Partial<BuildContext>));
    expect(runtime).toMatchObject({ imageDigest: imageId, artifactBuild: { builtWithNixpacks: false, builtStatic: false } });
    expect(ops()).toContain('docker.build');
    expect(ops()).toContain('git.ensure');
  });
  it.each(['unreachable', 'invalid image'])('keeps an ordinary deployment usable when optional image observation fails: %s', async reason => {
    const base = fakeAgent();
    const agent: AgentCall = async (op, params, sink) => op === 'docker.inspect'
      ? reason === 'unreachable' ? Promise.reject(new Error('temporary disconnect')) : { exitCode: 0, lines: ['mutable:latest'] }
      : base.agent(op, params, sink);
    const runtime = await createRemoteDockerBuilder(agent).buildAndRun(ctx({ service: svc({ repoUrl: 'https://example.test/repo.git' }), recordDockerArtifact: true }));
    expect(runtime.runtimeId).toBe('web-7');
    expect(runtime.artifactBuild).toBeUndefined();
    expect(base.calls.some(call => call.op === 'docker.rm')).toBe(false);
  });
  it.each([{ builtWithNixpacks: true, builtStatic: false }, { builtWithNixpacks: false, builtStatic: true }])('records placed source build conventions %j without changing legacy placement', async pack => {
    const imageId = `sha256:${'c'.repeat(64)}`;
    const { agent } = fakeAgent({ 'docker.inspect': { exitCode: 0, lines: [imageId] } });
    const runtime = await createRemoteDockerBuilder(agent, { prebuiltImage: { tag: 'ninedeploy/web:placed', imageId, ...pack } }).buildAndRun(ctx({ service: svc({ repoUrl: 'https://example.test/repo.git' }), recordDockerArtifact: true }));
    expect(runtime).toMatchObject({ imageDigest: imageId, artifactBuild: pack });
  });
  it('does not record a placed tag that no longer names the shipped image', async () => {
    const imageId = `sha256:${'c'.repeat(64)}`;
    const { agent } = fakeAgent({ 'docker.inspect': { exitCode: 0, lines: [`sha256:${'d'.repeat(64)}`] } });
    const runtime = await createRemoteDockerBuilder(agent, { prebuiltImage: { tag: 'ninedeploy/web:placed', imageId } }).buildAndRun(ctx({ service: svc({ repoUrl: 'https://example.test/repo.git' }), recordDockerArtifact: true }));
    expect(runtime.artifactBuild).toBeUndefined();
    expect(runtime.imageDigest).toBeUndefined();
  });
  it.each([{ builtWithNixpacks: true, builtStatic: false, port: 3000 }, { builtWithNixpacks: false, builtStatic: true, port: 80 }])('runs an immutable artifact with its original pack conventions %j', async pack => {
    const imageId = `sha256:${'a'.repeat(64)}`;
    const { agent, calls, ops } = fakeAgent({ 'docker.inspect': { exitCode: 0, lines: [imageId] } });
    const runtime = await createRemoteDockerBuilder(agent, { prebuiltImage: { tag: imageId, imageId, ...pack } }).buildAndRun(ctx({ service: svc({ port: null, repoUrl: 'https://example.test/repo.git' }) }));
    expect(runtime).toMatchObject({ port: pack.port, imageDigest: imageId });
    expect(calls.find(call => call.op === 'docker.runEnv')?.params.image).toBe(imageId);
    expect(ops()).not.toContain('docker.pull');
    expect(ops()).not.toContain('git.ensure');
    expect(ops()).not.toContain('docker.build');
    expect(calls.find(call => call.op === 'file.writeEnv')?.params.env).toMatchObject(pack.builtWithNixpacks ? { PORT: '3000', FOO: 'bar' } : { FOO: 'bar' });
  });
  it('removes only the candidate when the node reports a different runtime image', async () => {
    const imageId = `sha256:${'a'.repeat(64)}`;
    const { agent, calls } = fakeAgent({ 'docker.inspect': { exitCode: 0, lines: [`sha256:${'b'.repeat(64)}`] } });
    await expect(createRemoteDockerBuilder(agent, { prebuiltImage: { tag: imageId, imageId } }).buildAndRun(ctx(), { runtimeId: 'old-serving', port: 3000, healthPath: '/' })).rejects.toThrow('Runtime image identity');
    expect(calls.filter(call => call.op === 'docker.rm').map(call => call.params.name)).toEqual(['web-7']);
  });
  it('cleans the candidate if image verification loses contact with the node', async () => {
    const imageId = `sha256:${'a'.repeat(64)}`;
    const node = fakeAgent();
    const agent: AgentCall = async (op, params, sink) => {
      if (op === 'docker.inspect') throw new Error('node disconnected');
      return node.agent(op, params, sink);
    };
    await expect(createRemoteDockerBuilder(agent, { prebuiltImage: { tag: imageId, imageId } }).buildAndRun(ctx())).rejects.toThrow('node disconnected');
    expect(node.calls.filter(call => call.op === 'docker.rm').map(call => call.params.name)).toEqual(['web-7']);
  });
  it.each([
    { name: 'missing', lines: [] },
    { name: 'wrong path', lines: ['wrote .agent-env/other-7.env'] },
    { name: 'duplicate', lines: ['wrote .agent-env/web-7.env', 'wrote .agent-env/web-7.env'] },
    { name: 'failed operation', lines: ['wrote .agent-env/web-7.env'], code: 1 },
  ])('refuses an unconfirmed environment receipt: $name', async ({ lines, code = 0 }) => {
    const { agent, ops } = fakeAgent({ 'file.writeEnv': { exitCode: code, lines } });
    await expect(createRemoteDockerBuilder(agent).buildAndRun(ctx({ service: svc({ image: 'nginx:1.27' }) })))
      .rejects.toThrow(/environment.*receipt/i);
    expect(ops()).not.toContain('docker.runEnv');
    expect(ops()).not.toContain('docker.runSpec');
  });

  it('pulls and runs the image on the node, never locally', async () => {
    const { agent, calls, ops } = fakeAgent();
    const runtime = await createRemoteDockerBuilder(agent).buildAndRun(
      ctx({ service: svc({ image: 'nginx:1.27' }) }),
    );

    expect(ops()).toEqual(['docker.networkCreate', 'docker.pull', 'file.writeEnv', 'docker.runEnv', 'file.deleteEnv']);
    expect(calls[1]!.params).toMatchObject({ image: 'nginx:1.27' });
    expect(runtime).toMatchObject({ runtimeId: 'web-7', port: 3000 });
  });

  it('pins the exact digest on a rollback rather than the mutable tag', async () => {
    const { agent, calls } = fakeAgent();
    await createRemoteDockerBuilder(agent).buildAndRun(
      ctx({ service: svc({ image: 'nginx:1.27' }), imageDigest: 'nginx@sha256:abc' }),
    );
    expect(calls[1]!.params).toMatchObject({ image: 'nginx@sha256:abc' });
  });

  it('r270: never records a mutable tag as the release digest', async () => {
    const { agent } = fakeAgent();
    const runtime = await createRemoteDockerBuilder(agent).buildAndRun(ctx({ service: svc({ image: 'nginx:1.27' }) }));
    // A rollback copies this onto the new deployment and pulls it: a tag here
    // re-pulled today's image while the history claimed a pinned digest.
    expect(runtime.imageDigest).toBeUndefined();

    const built = await createRemoteDockerBuilder(fakeAgent().agent).buildAndRun(
      ctx({ service: svc({ repoUrl: 'https://github.com/acme/app.git' }), commitSha: 'deadbeefcafe' }),
    );
    expect(built.imageDigest).toBeUndefined();
  });

  it('r270: keeps a genuine digest pin', async () => {
    const pinned = `nginx@sha256:${'a'.repeat(64)}`;
    const runtime = await createRemoteDockerBuilder(fakeAgent().agent).buildAndRun(
      ctx({ service: svc({ image: 'nginx:1.27' }), imageDigest: pinned }),
    );
    expect(runtime.imageDigest).toBe(pinned);
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

  it('r267: escapes multi-line values the agent would otherwise refuse', async () => {
    const { agent, calls } = fakeAgent();
    await createRemoteDockerBuilder(agent).buildAndRun(
      ctx({ service: svc({ image: 'nginx:1' }), env: { KEY: '-----BEGIN-----\nabc\r\n-----END-----', _JAVA_OPTIONS: '-Xmx1g' } }),
    );
    // Same literal `\n` convention the local builder's env-file uses.
    expect(calls.find((c) => c.op === 'file.writeEnv')!.params['env']).toEqual({
      KEY: '-----BEGIN-----\\nabc\\n-----END-----',
      _JAVA_OPTIONS: '-Xmx1g',
    });
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
    expect(ops().slice(1, 4)).toEqual(['docker.login', 'docker.pull', 'docker.logout']);
    // The password goes in params, and the agent hands it to stdin — never argv.
    expect(calls[1]!.params).toMatchObject({ username: 'u', password: 'p', server: 'ghcr.io' });
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

    // r660: the agent is asked whether it can build safely BEFORE anything is cloned.
    expect(ops().slice(1, 6)).toEqual(['agent.ping', 'git.ensure', 'git.fetch', 'git.checkout', 'git.reset']);
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
  it('reports an unsupported default port probe without waiting for the readiness timeout', async () => {
    const { agent, calls } = fakeAgent(); const logs: string[] = [];
    const result = await createRemoteDockerBuilder(agent).isHealthy({ runtimeId: 'web-7', port: 3000, healthPath: '/' }, 300, 10_000, line => logs.push(line));
    expect(result).toBe(false);
    expect(logs.join('\n')).toMatch(/agent|probe/i);
    expect(calls.some(call => call.op === 'docker.inspect' || call.op === 'docker.probe')).toBe(false);
  });
  it('does not accept a running default-health candidate before its configured port listens', async () => {
    vi.useFakeTimers();
    try {
      const { agent, calls } = fakeAgent({ 'agent.ping': { exitCode: 0, lines: ['ND-AGENT {"version":"0.19.0","caps":["docker.probe"]}'] },
        'docker.probe': { exitCode: 0, lines: ['ND-PROBE {"ready":false,"protocol":"tcp"}'] } });
      const pending = createRemoteDockerBuilder(agent, { pollMs: 100 }).isHealthy({ runtimeId: 'web-7', port: 3000, healthPath: '/' }, 300, 10_000);
      await vi.advanceTimersByTimeAsync(300);
      expect(await pending).toBe(false);
      expect(calls.some(call => call.op === 'docker.probe' && call.params.protocol === 'tcp')).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('accepts a default-health candidate only after consecutive successful TCP probes', async () => {
    vi.useFakeTimers();
    try {
      let probes = 0; const { agent: base } = fakeAgent({ 'agent.ping': { exitCode: 0, lines: ['ND-AGENT {"version":"0.19.0","caps":["docker.probe"]}'] } });
      const agent: AgentCall = async (op, params, sink) => op === 'docker.probe'
        ? { exitCode: 0, lines: [`ND-PROBE ${JSON.stringify({ ready: ++probes >= 2, protocol: 'tcp' })}`] } : base(op, params, sink);
      const pending = createRemoteDockerBuilder(agent, { pollMs: 100 }).isHealthy({ runtimeId: 'web-7', port: 3000, healthPath: '/' }, 1000, 10_000);
      await vi.advanceTimersByTimeAsync(300);
      expect(await pending).toBe(true); expect(probes).toBe(4);
    } finally { vi.useRealTimers(); }
  });
  it('refuses opted-in readiness on an old agent before creating any runtime', async () => {
    const { agent, ops } = fakeAgent();
    await expect(createRemoteDockerBuilder(agent).buildAndRun(ctx({ service: svc({ image: 'nginx:1', healthCheck: 'http-strict' }) }))).rejects.toThrow(/Update the node agent/);
    expect(ops()).toEqual(['agent.ping']);
  });

  it('keeps a running container unready until its HTTP readiness succeeds', async () => {
    vi.useFakeTimers();
    try {
      let probes = 0;
      const { agent: base } = fakeAgent();
      const agent: AgentCall = async (op, params, sink) => op === 'docker.probe'
        ? { exitCode: 0, lines: [`ND-PROBE ${JSON.stringify({ ready: ++probes >= 3, protocol: 'http', status: probes >= 3 ? 200 : 503 })}`] }
        : base(op, params, sink);
      const pending = createRemoteDockerBuilder(agent, { pollMs: 100 }).isHealthy({ runtimeId: 'web-7', port: 3000, healthPath: '/ready', healthCheck: 'http-strict' }, 5000, 0);
      await vi.advanceTimersByTimeAsync(200);
      expect(await pending).toBe(true);
      expect(probes).toBe(3);
    } finally { vi.useRealTimers(); }
  });
  it.each(['restarting|none|0|1', 'running|none|0|1', 'running|unhealthy|1|0', 'running|none||0'])
  ('rejects a probe result if the container changes during that probe: %s', async after => {
    vi.useFakeTimers();
    try {
      let inspections = 0;
      const agent: AgentCall = async op => {
        if (op === 'docker.inspect') return { exitCode: 0, lines: [++inspections === 1 ? 'running|none|0|0' : inspections === 2 ? after : 'restarting|none|0|1'] };
        if (op === 'docker.probe') return { exitCode: 0, lines: ['ND-PROBE {"ready":true,"protocol":"tcp"}'] };
        return { exitCode: 0, lines: [] };
      };
      const pending = createRemoteDockerBuilder(agent, { pollMs: 100 }).isHealthy({ runtimeId: 'web-7', port: 3000, healthPath: '/', healthCheck: 'tcp' }, 300, 0);
      await vi.advanceTimersByTimeAsync(300);
      expect(await pending).toBe(false); expect(inspections).toBeGreaterThan(1);
    } finally { vi.useRealTimers(); }
  });

  it('fails an always-unready application even while its container stays running', async () => {
    vi.useFakeTimers();
    try {
      const { agent } = fakeAgent({ 'docker.probe': { exitCode: 0, lines: ['ND-PROBE {"ready":false,"protocol":"http","status":503}'] } });
      const pending = createRemoteDockerBuilder(agent, { pollMs: 100 }).isHealthy({ runtimeId: 'web-7', port: 3000, healthPath: '/ready', healthCheck: 'http-strict' }, 300, 0);
      await vi.advanceTimersByTimeAsync(300);
      expect(await pending).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it.each([
    { exitCode: 0, lines: ['ND-PROBE {"ready":true,"protocol":"tcp"}'] },
    { exitCode: 0, lines: ['ND-PROBE {"ready":true,"protocol":"http","status":200}', 'ND-PROBE {"ready":true,"protocol":"http","status":200}'] },
    { exitCode: 1, lines: ['ND-PROBE {"ready":true,"protocol":"http","status":200}'] },
    { exitCode: 0, lines: ['ND-PROBE {"ready":true,"protocol":"http"}'] },
    { exitCode: 0, lines: ['ND-PROBE {"ready":true,"protocol":"http","status":503}'] },
  ])('does not route on contradictory or ambiguous HTTP probe evidence: %j', async response => {
    vi.useFakeTimers();
    try {
      const { agent } = fakeAgent({ 'docker.probe': response });
      const pending = createRemoteDockerBuilder(agent, { pollMs: 100 }).isHealthy({ runtimeId: 'web-7', port: 3000, healthPath: '/ready', healthCheck: 'http-strict' }, 300, 0);
      await vi.advanceTimersByTimeAsync(300);
      expect(await pending).toBe(false);
    } finally { vi.useRealTimers(); }
  });
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

  it('r264: retires the previous runtime before re-binding a published host port', async () => {
    const { agent, calls, ops } = fakeAgent();
    await createRemoteDockerBuilder(agent).buildAndRun(
      ctx({ service: svc({ image: 'nginx:1', publishedPort: 8080 }) }),
      { runtimeId: 'web-6', port: 3000, healthPath: '/' },
    );
    // Both generations cannot bind 8080: the old one must be gone before the
    // new `docker run -p`, or every redeploy fails "port is already allocated".
    const rm = calls.findIndex((c) => c.op === 'docker.rm' && c.params['name'] === 'web-6');
    expect(rm).toBeGreaterThanOrEqual(0);
    expect(rm).toBeLessThan(ops().indexOf('docker.runEnv'));
  });

  it('r264: keeps blue-green (previous untouched) when no host port is published', async () => {
    const { agent, ops } = fakeAgent();
    await createRemoteDockerBuilder(agent).buildAndRun(ctx({ service: svc({ image: 'nginx:1' }) }), {
      runtimeId: 'web-6',
      port: 3000,
      healthPath: '/',
    });
    expect(ops()).not.toContain('docker.rm');
  });

  it('r264: a failed run removes its Created container and still fails the deploy', async () => {
    const { agent, calls } = fakeAgent();
    const failing: AgentCall = async (op, params, sink) => {
      if (op === 'docker.runEnv') {
        await agent(op, params, sink);
        throw new Error('agent docker.runEnv exited with 125');
      }
      return agent(op, params, sink);
    };
    await expect(
      createRemoteDockerBuilder(failing).buildAndRun(
        ctx({ service: svc({ image: 'nginx:1', publishedPort: 8080 }) }),
        { runtimeId: 'web-6', port: 3000, healthPath: '/' },
      ),
    ).rejects.toThrow(/exited with 125/);
    expect(calls.some((c) => c.op === 'docker.rm' && c.params['name'] === 'web-7')).toBe(true);
  });
});

describe('remote docker builder — health and teardown', () => {
  const runtime = { runtimeId: 'web-7', port: 3000, healthPath: '/', healthCheck: 'running' as const };

  it('does not treat failed Docker inspection output as a healthy container', async () => {
    vi.useFakeTimers();
    try {
      const { agent } = fakeAgent({ 'docker.inspect': { exitCode: 1, lines: ['running|none|0|0'] } });
      const pending = createRemoteDockerBuilder(agent, { pollMs: 100 }).isHealthy(runtime, 300, 1000);
      await vi.advanceTimersByTimeAsync(300);
      expect(await pending).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it.each([
    { lines: ['running|none|0|0', 'running|none|0|0'] },
    { lines: ['running|none|0|unknown'] },
    { lines: ['running|none|unknown|0'] },
    { lines: ['running|none||0'] },
  ])('does not accept ambiguous or malformed running-state evidence: $lines', async ({ lines }) => {
    vi.useFakeTimers();
    try {
      const { agent } = fakeAgent({ 'docker.inspect': { exitCode: 0, lines } });
      const pending = createRemoteDockerBuilder(agent, { pollMs: 100 }).isHealthy(runtime, 300, 1000);
      await vi.advanceTimersByTimeAsync(300);
      expect(await pending).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it.each([
    { samples: ['running|none|0|0', null, 'running|none|0|0', null, 'running|none|0|0', 'exited|none|0|0'], healthy: false, inspects: 6 },
    { samples: ['running|none|0|0', null, 'running|none|0|0', 'running|none|0|0', 'running|none|0|0'], healthy: true, inspects: 5 },
  ])('requires consecutive healthy samples after an inspect failure ($healthy)', async ({ samples, healthy, inspects }) => {
    let index = 0;
    const agent: AgentCall = async (op) => {
      if (op !== 'docker.inspect') return { exitCode: 0, lines: [] };
      const sample = samples[Math.min(index++, samples.length - 1)];
      if (sample == null) throw new Error('node offline');
      return { exitCode: 0, lines: [sample] };
    };

    await expect(createRemoteDockerBuilder(agent, { pollMs: 1 }).isHealthy(runtime, 5000)).resolves.toBe(healthy);
    expect(index).toBe(inspects);
  });

  it('reports healthy once the node says the container is running', async () => {
    const { agent } = fakeAgent();
    await expect(createRemoteDockerBuilder(agent, { pollMs: 1 }).isHealthy(runtime, 5000)).resolves.toBe(true);
  });

  /** An agent whose `docker.inspect` answers walk through `samples` (the last one repeats). */
  const sampledAgent = (samples: string[]) => {
    let i = 0;
    const inner = fakeAgent();
    const agent: AgentCall = async (op, params, sink) => {
      if (op === 'docker.inspect') {
        inner.calls.push({ op, params });
        const line = samples[Math.min(i, samples.length - 1)]!;
        i += 1;
        return { exitCode: 0, lines: [line] };
      }
      return inner.agent(op, params, sink);
    };
    return { agent, ops: inner.ops, inspects: () => i };
  };

  it('r265: fails a crash-looping container even though it samples as running', async () => {
    // `--restart unless-stopped` brings a crashing app straight back, so it is
    // `running` between crashes — the first sample used to deploy it green.
    const { agent, ops } = sampledAgent([
      'running|none|0|0',
      'restarting|none|0|1',
      'running|none|0|2',
      'running|none|0|3',
    ]);
    const lines: string[] = [];
    await expect(
      createRemoteDockerBuilder(agent, { pollMs: 1 }).isHealthy(runtime, 5000, 10_000, (l) => lines.push(l)),
    ).resolves.toBe(false);
    expect(lines.join('\n')).toMatch(/crash-looping/);
    expect(ops()).toContain('docker.logs');
  });

  it('r265: needs several consecutive running samples with no restart in between', async () => {
    const { agent, inspects } = sampledAgent([
      'running|none|0|0',
      'running|none|0|1', // restarted between samples: the count starts over
      'running|none|0|1',
      'running|none|0|1',
    ]);
    await expect(createRemoteDockerBuilder(agent, { pollMs: 1 }).isHealthy(runtime, 5000)).resolves.toBe(true);
    expect(inspects()).toBe(4);
  });

  it('r265: `restarting` never counts as healthy', async () => {
    const { agent } = sampledAgent(['restarting|none|0|0']);
    await expect(createRemoteDockerBuilder(agent, { pollMs: 1 }).isHealthy(runtime, 200)).resolves.toBe(false);
  });

  it('r265: waits for an image HEALTHCHECK to pass', async () => {
    const { agent, inspects } = sampledAgent(['running|starting|0|0', 'running|healthy|0|0']);
    await expect(createRemoteDockerBuilder(agent, { pollMs: 1 }).isHealthy(runtime, 5000)).resolves.toBe(true);
    expect(inspects()).toBe(4);
  });

  it('r265: the rollback probe (grace 0) settles on one good sample', async () => {
    const { agent, inspects } = sampledAgent(['running|none|0|7']);
    await expect(createRemoteDockerBuilder(agent, { pollMs: 1 }).isHealthy(runtime, 3000, 0)).resolves.toBe(true);
    expect(inspects()).toBe(1);
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

  // r526: the service's stop grace used to be dropped (`void opts`), so a
  // node container always got the agent's pinned 5 s before SIGKILL.
  it('r526: passes the stop grace to the node (old agents ignore the operand)', async () => {
    const { agent, calls } = fakeAgent();
    await createRemoteDockerBuilder(agent).stop('web-7', { graceSeconds: 45 });
    expect(calls.find((c) => c.op === 'docker.stop')?.params).toEqual({ name: 'web-7', graceSeconds: '45' });
    const plain = fakeAgent();
    await createRemoteDockerBuilder(plain.agent).stop('web-7');
    expect(plain.calls.find((c) => c.op === 'docker.stop')?.params).toEqual({ name: 'web-7' });
  });
});

/**
 * r660: an agent older than the node-side symlink walk would build whatever
 * a repository symlink points at, as root, in the work root every tenant on
 * the node shares — so the panel refuses SOURCE builds to it, naming the node
 * and the version to update to. Image releases never take that path.
 */
describe('r660: source builds need an agent that guards build paths', () => {
  const sourceCtx = () =>
    ctx({
      service: svc({ repoUrl: 'https://github.com/acme/app.git', branch: 'main' }),
      commitSha: 'deadbeefcafe',
      buildConfig: { buildPack: 'dockerfile', dockerfilePath: 'Dockerfile', baseDir: '/' } as never,
    });

  it('refuses a source build to an agent that predates the guard, before anything is cloned', async () => {
    // Older agents answer agent.ping with no lines at all.
    const { agent, ops } = fakeAgent({ 'agent.ping': { exitCode: 0, lines: [] } });
    const err = await createRemoteDockerBuilder(agent, { nodeLabel: '"edge-1" (#4)' }).buildAndRun(sourceCtx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('"edge-1" (#4)');
    expect((err as Error).message).toContain('v0.10.42');
    expect((err as Error).message).toContain('Image deployments to this node keep working');
    expect(ops()).not.toContain('git.ensure');
    expect(ops()).not.toContain('docker.build');
  });

  it('names the version an agent reports when it lacks the capability', async () => {
    const { agent } = fakeAgent({ 'agent.ping': { exitCode: 0, lines: ['ND-AGENT {"version":"0.10.99","caps":[]}'] } });
    await expect(createRemoteDockerBuilder(agent, { nodeLabel: '#4' }).buildAndRun(sourceCtx())).rejects.toThrow(/version 0\.10\.99/);
  });

  it('refuses when the agent cannot even answer the ping (pre-ping agents answer unknown_op)', async () => {
    const { agent, ops } = fakeAgent();
    const failing: typeof agent = async (op, params, sink) => {
      if (op === 'agent.ping') throw new Error('agent agent.ping failed (400): unknown_op');
      return agent(op, params, sink);
    };
    await expect(createRemoteDockerBuilder(failing).buildAndRun(sourceCtx())).rejects.toThrow(/Could not confirm .* node #4/);
    expect(ops()).not.toContain('git.ensure');
  });

  it('keeps deploying IMAGE releases to an old agent, without asking', async () => {
    const { agent, ops } = fakeAgent({ 'agent.ping': { exitCode: 0, lines: [] } });
    await createRemoteDockerBuilder(agent).buildAndRun(ctx({ service: svc({ image: 'nginx:1' }) }));
    expect(ops()).not.toContain('agent.ping');
    expect(ops()).toContain('docker.runEnv');
  });
});

describe('0.16: the shared ninedeploy network on the node', () => {
  /** An agent whose `docker network create` fails like the daemon does (exit 1, the reason on stderr). */
  function networkFails(reason: string) {
    const base = fakeAgent();
    const agent: AgentCall = async (op, params, sink) => {
      if (op !== 'docker.networkCreate') return base.agent(op, params, sink);
      base.calls.push({ op, params });
      sink(`Error response from daemon: ${reason}`);
      throw new Error('agent docker.networkCreate exited with 1');
    };
    return { ...base, agent };
  }

  it('an existing network is a silent no-op: no daemon error in the deploy log, the deploy goes on', async () => {
    const { agent, ops } = networkFails('network with name ninedeploy already exists');
    const lines: string[] = [];
    const runtime = await createRemoteDockerBuilder(agent).buildAndRun(ctx({ service: svc({ image: 'nginx:1.27' }), log: (l) => lines.push(l) }));
    expect(runtime).toMatchObject({ runtimeId: 'web-7' });
    expect(ops()).toEqual(['docker.networkCreate', 'docker.pull', 'file.writeEnv', 'docker.runEnv', 'file.deleteEnv']);
    expect(lines.join('\n')).not.toMatch(/Error response from daemon|already exists/);
  });

  it('any other failure still reaches the deploy log', async () => {
    const { agent } = networkFails('permission denied while trying to connect to the Docker daemon socket');
    const lines: string[] = [];
    await createRemoteDockerBuilder(agent).buildAndRun(ctx({ service: svc({ image: 'nginx:1.27' }), log: (l) => lines.push(l) }));
    expect(lines.join('\n')).toContain('Error response from daemon: permission denied');
    expect(lines.join('\n')).toMatch(/Could not create the "ninedeploy" network on the node: agent docker.networkCreate exited with 1/);
  });
});
