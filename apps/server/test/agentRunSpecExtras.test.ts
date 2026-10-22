import { describe, expect, it } from 'vitest';
import { HEALTH_CMD_FLAGS, parseRunSpec, runSpecArgv } from '../src/agentOps/runSpec.js';
import { runSpecParams } from '../src/engine/builders/remoteRun.js';
import { nodeRunExtras, nodeRunExtrasChecks, nodeRunNeeds } from '../src/lib/remoteVolumes.js';

/**
 * 0.16.4 custom labels (`docker.userLabels`) and the command healthcheck
 * (`docker.healthCmd`) on a node: the agent takes them as `docker.runSpec`
 * fields under the panel's own rules, and the panel sends them only when the
 * service uses them, after asking for the capability.
 */

const base = { name: 'api-5', image: 'acme/api:1' };

describe('docker.runSpec userLabels and healthCmd (agent)', () => {
  it.each(['run', 'create'] as const)('never implicitly pulls an artifact image ID during %s', verb => {
    const image = `sha256:${'a'.repeat(64)}`;
    const argv = runSpecArgv(parseRunSpec({ ...base, image }), verb);
    expect(argv).toEqual(expect.arrayContaining(['--pull', 'never']));
    expect(argv.indexOf('--pull')).toBeLessThan(argv.indexOf(image));
    expect(runSpecArgv(parseRunSpec(base), verb)).not.toContain('--pull');
  });
  it('appends the user labels after the panel labels and the healthcheck flags before the image', () => {
    const spec = parseRunSpec({ ...base, serviceId: 5, userLabels: { 'com.example.team': 'payments', 'a.b': '' }, healthCmd: 'pg_isready -U app' });
    expect(spec.userLabels).toEqual([['a.b', ''], ['com.example.team', 'payments']]);
    const argv = runSpecArgv(spec, 'run');
    const labels = argv.flatMap((a, i) => (argv[i - 1] === '--label' ? [a] : []));
    expect(labels).toEqual(['ninedeploy.managed=service', 'ninedeploy.service=5', 'a.b=', 'com.example.team=payments']);
    const at = argv.indexOf('--health-cmd');
    expect(argv.slice(at, at + 2 + HEALTH_CMD_FLAGS.length)).toEqual(['--health-cmd', 'pg_isready -U app', ...HEALTH_CMD_FLAGS]);
    expect(at).toBeLessThan(argv.indexOf('acme/api:1'));
    // Neither field: the argv is what 0.16.3 built.
    const plain = runSpecArgv(parseRunSpec(base), 'run');
    expect(plain).not.toContain('--health-cmd');
    expect(plain.filter((a) => a === '--label')).toHaveLength(1);
  });

  it.each([
    ['a reserved namespace', { 'ninedeploy.service': '9' }],
    ['traefik labels', { 'traefik.http.routers.x.rule': 'Host(`a`)' }],
    ['com.docker labels', { 'com.docker.compose.project': 'x' }],
    ['a bad key', { '-flag': 'x' }],
    ['a multi-line value', { team: 'a\nb' }],
    ['a non-string value', { team: 5 }],
  ])('refuses user labels with %s', (_what, userLabels) => {
    expect(() => parseRunSpec({ ...base, userLabels })).toThrow(/Invalid user label/);
  });

  it('refuses too many user labels and a non-object', () => {
    expect(() => parseRunSpec({ ...base, userLabels: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`l${i}`, 'x'])) })).toThrow(/Invalid userLabels/);
    expect(() => parseRunSpec({ ...base, userLabels: ['a=b'] })).toThrow(/Invalid userLabels/);
  });

  it.each([['empty', ''], ['multi-line', 'true\nrm -rf /'], ['padded', ' true'], ['too long', 'x'.repeat(1001)], ['not a string', ['true']]])(
    'refuses a %s healthCmd',
    (_what, healthCmd) => {
      expect(() => parseRunSpec({ ...base, healthCmd })).toThrow(/Invalid healthCmd/);
    },
  );
});

describe('the panel side', () => {
  const service = { dockerLabels: { team: 'pay' }, healthCheck: 'command', healthCommand: ' curl -fsS localhost:3000/up ' };

  it('names what a node needs and asks for each capability with its own wording', () => {
    expect(nodeRunNeeds(service, [])).toEqual(['custom Docker labels', 'the command healthcheck']);
    expect(nodeRunExtrasChecks(service)).toEqual([
      { cap: ['docker.runSpec', 'docker.userLabels'], feature: 'set custom Docker labels' },
      { cap: ['docker.runSpec', 'docker.healthCmd'], feature: 'run the command healthcheck' },
    ]);
    // A command without the mode, an empty label set, or neither: nothing extra.
    for (const s of [{ healthCheck: null, healthCommand: 'true', dockerLabels: {} }, { healthCheck: 'command', healthCommand: '  ' }, {}]) {
      expect(nodeRunExtras(s)).toEqual({});
      expect(nodeRunExtrasChecks(s)).toEqual([]);
      expect(nodeRunNeeds(s, [])).toEqual([]);
    }
  });

  it('sends the fields only when set, trimmed as the agent requires', () => {
    const run = { name: 'api-5', image: 'acme/api:1', envFile: '.agent-env/api-5.env', envFileName: 'api-5', deploymentId: 5, volumes: [] };
    const svc = { id: 3, cpuShares: 0, cpuLimitMilli: 0, memLimitMb: 0 };
    expect(runSpecParams({ ...svc, ...service } as never, run)).toMatchObject({ userLabels: { team: 'pay' }, healthCmd: 'curl -fsS localhost:3000/up' });
    const plain = runSpecParams(svc as never, run);
    expect(plain).not.toHaveProperty('userLabels');
    expect(plain).not.toHaveProperty('healthCmd');
    // What the panel sends, the agent accepts.
    expect(() => parseRunSpec(runSpecParams({ ...svc, ...service } as never, run))).not.toThrow();
  });
});
