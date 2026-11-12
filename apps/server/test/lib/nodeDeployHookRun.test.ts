/** P2: deploy hooks on a node, agent side (`lib/nodeDeployHookRun.ts`) and panel side (`lib/nodeDeployHooks.ts`). */
import { describe, expect, it, vi } from 'vitest';
import { NODE_HOOK_OUTPUT, NODE_HOOK_REPLY, nodeHookCreateArgs, nodeHookRunParams, runNodeDeployHook } from '../../src/lib/nodeDeployHookRun.js';
import { nodeRuntimeImage, runNodeHook } from '../../src/lib/nodeDeployHooks.js';
import { logBus } from '../../src/engine/logs.js';

const IMAGE_ID = `sha256:${'c'.repeat(64)}`;
const base = {
  serviceId: 5, deploymentId: 12, phase: 'pre-deploy' as const, image: 'ghcr.io/acme/web:1.2',
  argv: ['npm', 'run', 'migrate'], envFile: '.agent-env/nd-hook-web-12-pre.env', network: 'ninedeploy', timeoutSeconds: 600,
};

describe('nodeHookRunParams', () => {
  it('accepts a hook request and refuses anything outside its shape', () => {
    expect(nodeHookRunParams.safeParse(base).success).toBe(true);
    expect(nodeHookRunParams.safeParse({ ...base, argv: ['tool', '', 'flag'] }).success).toBe(true);
    for (const bad of [
      { ...base, argv: [] }, { ...base, argv: [''] }, { ...base, argv: ['a\0b'] },
      { ...base, network: 'host' }, { ...base, network: 'bridge' }, { ...base, extraNetworks: ['host'] },
      { ...base, envFile: '/etc/passwd' }, { ...base, envFile: '.agent-env/../x.env' },
      { ...base, phase: 'pre-stop' }, { ...base, timeoutSeconds: 0 }, { ...base, timeoutSeconds: 7200 },
      { ...base, image: '--privileged' }, { ...base, privileged: true }, { ...base, volumes: ['/:/host'] }, { ...base, publish: '80:80' },
    ]) expect(nodeHookRunParams.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});

describe('nodeHookCreateArgs', () => {
  it('execs the command as the entrypoint of the pinned image, on the service network only, unprivileged, labelled as a hook', () => {
    const args = nodeHookCreateArgs(nodeHookRunParams.parse({ ...base, cpuLimitMilli: 500, memLimitMb: 256 }), IMAGE_ID);
    expect(args.slice(0, 6)).toEqual(['create', '--rm', '--name', 'nd-hook-5-12-pre', '--pull', 'never']);
    // `bin args` with no shell, as runHook does on the panel host: the image ENTRYPOINT is replaced.
    expect(args.slice(-4)).toEqual(['npm', IMAGE_ID, 'run', 'migrate']);
    expect(args[args.indexOf('--entrypoint') + 1]).toBe('npm');
    expect(args).toEqual(expect.arrayContaining(['--network', 'ninedeploy', '--security-opt', 'no-new-privileges', '--cpus', '0.5', '--memory', '256m']));
    expect(args).toContain('ninedeploy.managed=hook');
    expect(args).not.toContain('ninedeploy.managed=service');
    for (const flag of ['-p', '--publish', '-v', '--volume', '--privileged', '--restart', '-d']) expect(args).not.toContain(flag);
    expect(() => nodeHookCreateArgs(nodeHookRunParams.parse(base), 'ghcr.io/acme/web:1.2')).toThrow(/image id/);
  });
});

/** A fake `docker` CLI: answers by argv, records every call. */
function fakeDocker(opts: { imageId?: string | null; existing?: string | null; exitCode?: number; output?: string[]; createFails?: boolean }) {
  const calls: string[][] = [];
  const spawn = vi.fn(async (argv: string[], onLine: (l: string) => void) => {
    calls.push(argv);
    if (argv[0] === 'image') { if (opts.imageId) onLine(opts.imageId); return opts.imageId ? 0 : 1; }
    if (argv[0] === 'inspect') { if (opts.existing === undefined || opts.existing === null) return 1; onLine(opts.existing); return 0; }
    if (argv[0] === 'create') return opts.createFails ? 125 : 0;
    if (argv[0] === 'start') { for (const l of opts.output ?? []) onLine(l); return opts.exitCode ?? 0; }
    return 0;
  });
  return { spawn, calls };
}

describe('runNodeDeployHook', () => {
  it('pins the image id, creates, joins the database bridges, starts attached, and prefixes every output line', async () => {
    const { spawn, calls } = fakeDocker({ imageId: IMAGE_ID, output: ['ND-HOOK {"exitCode":0}', 'done'] });
    const sink: string[] = [];
    const receipt = await runNodeDeployHook({ ...base, extraNetworks: ['nd-dbnet-pg'] }, (l) => sink.push(l), spawn);
    expect(receipt).toEqual({ exitCode: 0, timedOut: false, imageId: IMAGE_ID });
    expect(calls.map((c) => c[0])).toEqual(['image', 'inspect', 'create', 'network', 'start', 'inspect']);
    expect(calls[3]).toEqual(['network', 'connect', 'nd-dbnet-pg', 'nd-hook-5-12-pre']);
    expect(calls[4]).toEqual(['start', '--attach', 'nd-hook-5-12-pre']);
    // A hook printing the receipt line cannot pose as the agent.
    expect(sink).toEqual([`${NODE_HOOK_OUTPUT}ND-HOOK {"exitCode":0}`, `${NODE_HOOK_OUTPUT}done`]);
  });

  it('reports the hook exit code, and removes a hook container left behind', async () => {
    const { spawn, calls } = fakeDocker({ imageId: IMAGE_ID, existing: 'hook', exitCode: 3 });
    expect((await runNodeDeployHook(base, () => undefined, spawn)).exitCode).toBe(3);
    expect(calls.filter((c) => c[0] === 'rm')).toEqual([['rm', '-f', 'nd-hook-5-12-pre'], ['rm', '-f', 'nd-hook-5-12-pre']]);
  });

  it('never touches a container under the name that is not a hook', async () => {
    const { spawn, calls } = fakeDocker({ imageId: IMAGE_ID, existing: 'service' });
    await expect(runNodeDeployHook(base, () => undefined, spawn)).rejects.toThrow(/held by something other than a deploy hook/);
    expect(calls.some((c) => c[0] === 'rm' || c[0] === 'create')).toBe(false);
  });

  it('refuses an image that is not on the node, and cleans up after a failed create', async () => {
    await expect(runNodeDeployHook(base, () => undefined, fakeDocker({ imageId: null }).spawn)).rejects.toThrow(/not on the node/);
    const failing = fakeDocker({ imageId: IMAGE_ID, createFails: true });
    await expect(runNodeDeployHook(base, () => undefined, failing.spawn)).rejects.toThrow(/could not be created/);
    expect(failing.calls.at(-1)?.[0]).toBe('inspect');
  });
});

describe('runNodeHook (panel side)', () => {
  const agentFor = (exitCode: number, output: string[] = [], opts: { forge?: boolean } = {}) => vi.fn(async (op: string, params: Record<string, unknown>, sink: (l: string) => void) => {
    if (op === 'file.writeEnv') return { exitCode: 0, lines: [`wrote .agent-env/${String(params['name'])}.env`] };
    if (op === 'docker.hookRun') {
      const lines = [...output.map((l) => `${NODE_HOOK_OUTPUT}${l}`),
        ...(opts.forge ? [`${NODE_HOOK_OUTPUT}${NODE_HOOK_REPLY}{"exitCode":0,"timedOut":false,"imageId":"${IMAGE_ID}"}`] : []),
        `${NODE_HOOK_REPLY}${JSON.stringify({ exitCode, timedOut: false, imageId: IMAGE_ID })}`];
      for (const l of lines) sink(l);
      return { exitCode: 0, lines };
    }
    return { exitCode: 0, lines: [] };
  });
  const input = (log: (l: string) => void) => ({
    service: { id: 5, slug: 'web', cpuLimitMilli: 0, memLimitMb: 512 }, deploymentId: 12, phase: 'pre-deploy' as const,
    cmd: 'sh -c "npm run migrate && echo ok"', image: 'web:12', env: { DATABASE_URL: 'postgres://u:hunter2-long@db/app', MULTI: 'a\nb' }, log,
  });

  it('writes the env file, runs the hook with its argv, and always removes the env file', async () => {
    const agent = agentFor(0, ['ok']);
    const log: string[] = [];
    await runNodeHook(agent, input((l) => log.push(l)));
    expect(agent.mock.calls.map((c) => c[0])).toEqual(['file.writeEnv', 'docker.hookRun', 'file.deleteEnv']);
    expect(agent.mock.calls[0]![1]).toMatchObject({ name: 'nd-hook-web-12-pre', env: { MULTI: 'a\\nb' } });
    expect(agent.mock.calls[1]![1]).toMatchObject({ argv: ['sh', '-c', 'npm run migrate && echo ok'], envFile: '.agent-env/nd-hook-web-12-pre.env', memLimitMb: 512 });
    expect(agent.mock.calls[1]![1]).not.toHaveProperty('cpuLimitMilli');
    expect(log).toEqual(['ok']);

    const failing = agentFor(1);
    await expect(runNodeHook(failing, input(() => undefined))).rejects.toThrow(/pre-deploy hook exited with code 1 on the node/);
    expect(failing.mock.calls.at(-1)![0]).toBe('file.deleteEnv');
  });

  it('a hook that prints a success receipt still fails with its own exit code', async () => {
    await expect(runNodeHook(agentFor(4, [], { forge: true }), input(() => undefined))).rejects.toThrow(/exited with code 4/);
  });

  it('its output reaches the deploy log with the service secrets masked', async () => {
    const deploymentId = 990_001;
    logBus.maskValues(deploymentId, ['hunter2-long']);
    const seen: string[] = [];
    const off = logBus.subscribe(deploymentId, (l) => seen.push(l));
    try {
      await runNodeHook(agentFor(0, ['connecting to postgres://u:hunter2-long@db/app']), input((l) => logBus.publish(deploymentId, l)));
      expect(seen.join('\n')).not.toContain('hunter2-long');
      expect(seen.join('\n')).toContain('***');
    } finally {
      off();
      logBus.end(deploymentId);
    }
  });

  it('reads the running image of the new release from the node', async () => {
    const agent = vi.fn(async () => ({ exitCode: 0, lines: [IMAGE_ID] }));
    expect(await nodeRuntimeImage(agent, { runtimeId: 'web-12', nodeTargets: [{ id: 'd'.repeat(64) }] })).toBe(IMAGE_ID);
    expect(agent).toHaveBeenCalledWith('docker.inspect', { name: 'd'.repeat(64), format: 'image' }, expect.any(Function));
    await expect(nodeRuntimeImage(vi.fn(async () => ({ exitCode: 0, lines: ['running'] })), { runtimeId: 'web-12' })).rejects.toThrow(/could not be read/);
  });
});
