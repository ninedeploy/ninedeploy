import { describe, expect, it } from 'vitest';
import { advertisedCapabilities } from '../src/agentOps/index.js';
import { parseRunSpec, runSpecArgv } from '../src/agentOps/runSpec.js';
import { runRemoteContainer, runSpecParams } from '../src/engine/builders/remoteRun.js';
import { AGENT_CAPABILITY_VERSION, CAPABILITY_SWITCH } from '../src/lib/agentCapabilities.js';
import { hasRuntimeOptions, runtimeOptionArgs } from '../src/lib/runtimeOptionArgs.js';
import { nodeRuntimeOptions } from '../src/lib/remoteVolumes.js';

/**
 * 0.16.6 container options on a node (`docker.runtimeOptions`): the agent
 * takes them as a `docker.runSpec` field under the panel's own schema and
 * builds the panel's flags; its owner can switch them off. An agent that
 * cannot apply them is no refusal — the container starts without them, as
 * every node deploy did before 0.16.6, and the log says why.
 */

const base = { name: 'gpu-7', image: 'acme/infer:1' };
const ALL = { gpus: 'all' as const, shmSizeMb: 2048, init: true, ulimitNofile: 65536, capAdd: ['NET_ADMIN' as const, 'SYS_NICE' as const] };
const pingLine = (version: string, caps: string[]) => `ND-AGENT ${JSON.stringify({ version, caps })}`;
const BASE_CAPS = ['build-path-guard', 'workspace.remove', 'git.credential', 'terminal', 'docker.runSpec', 'volume.manage'];
const CAPS_0165 = pingLine('0.16.5', [...BASE_CAPS, 'docker.ports', 'docker.userLabels', 'docker.healthCmd', 'docker.fileMounts']);
const CAPS_0166 = pingLine('0.16.6', [...BASE_CAPS, 'docker.ports', 'docker.userLabels', 'docker.healthCmd', 'docker.fileMounts', 'docker.runtimeOptions']);

describe('docker.runSpec runtimeOptions (agent)', () => {
  it('builds the panel host flags, after the resource limits and before the image', () => {
    const argv = runSpecArgv(parseRunSpec({ ...base, memLimitMb: 512, runtimeOptions: ALL }, {}), 'run');
    const flags = runtimeOptionArgs(ALL);
    expect(flags).toEqual(['--gpus', 'all', '--shm-size', '2048m', '--init', '--ulimit', 'nofile=65536:65536', '--cap-add', 'NET_ADMIN', '--cap-add', 'SYS_NICE']);
    const at = argv.indexOf('--gpus');
    expect(argv.slice(at, at + flags.length)).toEqual(flags);
    expect(at).toBeGreaterThan(argv.indexOf('--memory-swap'));
    expect(at).toBeLessThan(argv.indexOf('acme/infer:1'));
    // No field: the argv is what 0.16.5 built.
    expect(runSpecArgv(parseRunSpec(base, {}), 'run')).not.toContain('--init');
  });

  it.each([
    ['a capability outside the allow-list', { capAdd: ['SYS_ADMIN'] }],
    ['an unknown option', { privileged: true }],
    ['a GPU count past 16', { gpus: 17 }],
    ['a string shared-memory size', { shmSizeMb: '2g' }],
    ['not an object', '--privileged'],
  ])('refuses %s', (_what, runtimeOptions) => {
    expect(() => parseRunSpec({ ...base, runtimeOptions }, {})).toThrow(/Invalid runtimeOptions/);
  });

  it("the node's owner switches them off: not advertised, and the op refuses them", () => {
    const off = { NINEDEPLOY_AGENT_RUNTIME_OPTIONS: 'off' };
    expect(advertisedCapabilities({})).toContain('docker.runtimeOptions');
    expect(advertisedCapabilities(off)).not.toContain('docker.runtimeOptions');
    expect(() => parseRunSpec({ ...base, runtimeOptions: { init: true } }, off)).toThrow(/disabled on this node by its owner \(NINEDEPLOY_AGENT_RUNTIME_OPTIONS=off\)/);
    // A spec without them still runs on that node.
    expect(() => parseRunSpec(base, off)).not.toThrow();
    expect(CAPABILITY_SWITCH['docker.runtimeOptions']).toBe('NINEDEPLOY_AGENT_RUNTIME_OPTIONS');
    expect(AGENT_CAPABILITY_VERSION['docker.runtimeOptions']).toBe('0.16.6');
  });
});

describe('the panel side', () => {
  function nodeAgent(ping: string) {
    const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
    const agent = async (op: string, params: Record<string, unknown>) => {
      calls.push({ op, params });
      if (op === 'agent.ping') return { exitCode: 0, lines: [ping] };
      if (op === 'file.writeEnv') return { exitCode: 0, lines: [`wrote .agent-env/${params['name']}.env`] };
      return { exitCode: 0, lines: [] };
    };
    return { agent, calls, ops: () => calls.map((c) => c.op) };
  }
  const service = (over: Record<string, unknown> = {}) =>
    ({ id: 11, name: 'infer', slug: 'infer', serverId: 1, port: 8000, cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0, volumeMount: null, publishedPort: null, cmd: null, dockerSocket: false, ...over }) as never;
  const input = (svc: never, log: string[]) => ({ service: svc, deploymentId: 7, env: {}, name: 'infer-7', image: 'acme/infer:1', log: (l: string) => log.push(l), nodeLabel: '"gpu-1" (#1)' });

  it('a 0.16.6 agent runs the container on docker.runSpec with the options — which the agent accepts', async () => {
    const n = nodeAgent(CAPS_0166);
    const log: string[] = [];
    await runRemoteContainer(n.agent, input(service({ runtimeOptions: ALL }), log));
    expect(n.ops()).toEqual(['agent.ping', 'agent.ping', 'file.writeEnv', 'docker.runSpec', 'file.deleteEnv']);
    const spec = n.calls.find((c) => c.op === 'docker.runSpec')!.params;
    expect(spec['runtimeOptions']).toEqual(ALL);
    expect(runSpecArgv(parseRunSpec(spec, {}), 'run')).toEqual(expect.arrayContaining(['--gpus', 'all', '--init']));
    expect(log.join(' ')).not.toMatch(/not applied/);
  });

  it('an older agent: started without them on docker.runEnv exactly as before, with a warning naming the update', async () => {
    const n = nodeAgent(CAPS_0165);
    const log: string[] = [];
    await runRemoteContainer(n.agent, input(service({ runtimeOptions: ALL }), log));
    expect(n.ops()).toEqual(['agent.ping', 'file.writeEnv', 'docker.runEnv', 'file.deleteEnv']);
    expect(log.join(' ')).toMatch(/Container options \(GPUs, shared memory, init, ulimit, capabilities\) are not applied on node "gpu-1" \(#1\): .*version 0\.16\.5.*Update the node agent to v0\.16\.6/);
  });

  it('with other run needs, an older agent still runs them on docker.runSpec — only the options are left out', async () => {
    const n = nodeAgent(CAPS_0165);
    await runRemoteContainer(n.agent, input(service({ runtimeOptions: { init: true }, cmd: ['serve'] }), []));
    expect(n.calls.find((c) => c.op === 'docker.runSpec')!.params).not.toHaveProperty('runtimeOptions');
  });

  it('a service without options asks the node nothing new', async () => {
    for (const runtimeOptions of [null, undefined, {}, { capAdd: [] }]) {
      const n = nodeAgent(CAPS_0166);
      await runRemoteContainer(n.agent, input(service({ runtimeOptions }), []));
      expect(n.ops()).toEqual(['file.writeEnv', 'docker.runEnv', 'file.deleteEnv']);
      expect(hasRuntimeOptions(runtimeOptions as never)).toBe(false);
    }
  });

  it('an unreachable node is a warning here; the run that follows reports it', async () => {
    const log: string[] = [];
    const agent = async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.9:4600');
    };
    expect(await nodeRuntimeOptions(agent, '#9', true, { runtimeOptions: { init: true } }, (l) => log.push(l))).toBeNull();
    expect(log.join(' ')).toMatch(/not applied on node #9: .*/);
  });

  it('runSpecParams sends the options only when they are applied', () => {
    const run = { name: 'infer-7', image: 'acme/infer:1', envFile: '.agent-env/infer-7.env', envFileName: 'infer-7', deploymentId: 7, volumes: [] };
    expect(runSpecParams(service(), { ...run, runtimeOptions: ALL })['runtimeOptions']).toEqual(ALL);
    expect(runSpecParams(service(), { ...run, runtimeOptions: null })).not.toHaveProperty('runtimeOptions');
    expect(runSpecParams(service(), run)).not.toHaveProperty('runtimeOptions');
  });
});
