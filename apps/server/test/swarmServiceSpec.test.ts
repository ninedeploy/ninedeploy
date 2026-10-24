import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StackSpec } from '../src/kernel/types.js';
const h = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('../src/lib/exec.js', async original => ({ ...await original<typeof import('../src/lib/exec.js')>(), capture: h.capture }));
const { managedSwarmServiceSpec, swarmSpecFingerprint } = await import('../src/engine/swarmServiceSpec.js');
const NETWORK = 'net0000000000000000000001';
const input = (): StackSpec => ({ name: 'nd-web', services: [{ name: 'web', image: 'ninedeploy/web:source-b9', replicas: 2, port: 8080,
  env: { EMPTY: '', LITERAL: '$HOME\n$${UNCHANGED}' }, networks: ['nd-swarm-web'], secrets: [], configs: [], labels: { 'ninedeploy.service': '1', 'ninedeploy.deployment': '9' },
  command: ['node', 'app.js'], healthCommand: 'check-ready', stopGraceSeconds: 12, cpuLimitMilli: 1500, memLimitMb: 128, constraints: ['node.labels.nd.member==1'], containerLabels: { 'app.role': 'web' } }],
  networks: [{ name: 'nd-swarm-web', driver: 'overlay', attachable: true }], secrets: [], configs: [], volumes: [] });
beforeEach(() => h.capture.mockReset().mockResolvedValue(NETWORK));
describe('managed Swarm ServiceSpec', () => {
  it('preserves literal runtime values, command healthcheck, placement, limits and graceful stop', async () => {
    expect(await managedSwarmServiceSpec(input())).toMatchObject({ Name: 'nd-web_web', Labels: { 'ninedeploy.service': '1', 'ninedeploy.deployment': '9', 'com.docker.stack.namespace': 'nd-web' },
      TaskTemplate: { ContainerSpec: { Image: 'ninedeploy/web:source-b9', Args: ['node', 'app.js'], Env: ['EMPTY=', 'LITERAL=$HOME\n$${UNCHANGED}'], StopGracePeriod: 12_000_000_000,
        Labels: { 'app.role': 'web', 'com.docker.stack.namespace': 'nd-web' }, Healthcheck: { Test: ['CMD-SHELL', 'check-ready'], Interval: 5_000_000_000, Timeout: 10_000_000_000, Retries: 3 } },
        Networks: [{ Target: NETWORK, Aliases: ['web'] }], Placement: { Constraints: ['node.labels.nd.member==1'] }, Resources: { Limits: { NanoCPUs: 1_500_000_000, MemoryBytes: 134217728 } } },
      Mode: { Replicated: { Replicas: 2 } }, UpdateConfig: { Order: 'start-first', FailureAction: 'rollback' }, RollbackConfig: { Order: 'start-first' } });
  });
  it('uses the existing ten-second stop default and keeps the image command and healthcheck inherited', async () => {
    const stack = input(); delete stack.services[0]!.command; delete stack.services[0]!.healthCommand; delete stack.services[0]!.stopGraceSeconds;
    const spec = await managedSwarmServiceSpec(stack), container = (spec.TaskTemplate as { ContainerSpec: Record<string, unknown> }).ContainerSpec;
    expect(container.StopGracePeriod).toBe(10_000_000_000); expect(container).not.toHaveProperty('Args'); expect(container).not.toHaveProperty('Healthcheck');
  });
  it.each(['--help', 'network-name', 'f'.repeat(64)])('refuses an unconfirmed overlay identity: %s', async id => {
    h.capture.mockResolvedValue(id); await expect(managedSwarmServiceSpec(input())).rejects.toThrow('overlay network identity is unconfirmed');
  });
  it('rejects a multi-service or mounted secret shape outside the managed service contract', async () => {
    const stack = input(); stack.services.push({ ...stack.services[0]!, name: 'other' });
    await expect(managedSwarmServiceSpec(stack)).rejects.toThrow('Unsupported managed Swarm service shape');
    expect(h.capture).not.toHaveBeenCalled();
  });
});
describe('full Swarm spec fingerprints', () => {
  it('ignores only daemon defaults and object ordering', () => {
    expect(swarmSpecFingerprint({ Name: 'web', TaskTemplate: { Runtime: 'container', ForceUpdate: 0 }, Labels: {} })).toBe(swarmSpecFingerprint({ TaskTemplate: { Runtime: 'container' }, Name: 'web' }));
  });
  it.each([{ ContainerSpec: { Init: false } }, { ContainerSpec: { StopGracePeriod: 0 } }, { unexpected: false }])('preserves explicit false and meaningful zero values: %j', value => {
    expect(swarmSpecFingerprint({ Name: 'web', TaskTemplate: value })).not.toBe(swarmSpecFingerprint({ Name: 'web' }));
  });
  it('keeps empty and special label keys in the fingerprint', () => {
    const base = { Name: 'web', Labels: { 'app.empty': '' } };
    expect(swarmSpecFingerprint(base)).not.toBe(swarmSpecFingerprint({ Name: 'web' }));
    expect(swarmSpecFingerprint({ Name: 'web', Labels: JSON.parse('{"__proto__":"label"}') })).not.toBe(swarmSpecFingerprint({ Name: 'web' }));
  });
  it('detects environment, command, image and placement changes', () => {
    const original = { Name: 'web', TaskTemplate: { ContainerSpec: { Image: 'pinned', Env: ['KEY=one'], Args: ['app'] }, Placement: { Constraints: ['original'] } } };
    for (const value of [{ ContainerSpec: { Image: 'changed', Env: ['KEY=one'], Args: ['app'] }, Placement: { Constraints: ['original'] } },
      { ContainerSpec: { Image: 'pinned', Env: ['KEY=two'], Args: ['app'] }, Placement: { Constraints: ['original'] } },
      { ContainerSpec: { Image: 'pinned', Env: ['KEY=one'], Args: ['other'] }, Placement: { Constraints: ['original'] } },
      { ContainerSpec: { Image: 'pinned', Env: ['KEY=one'], Args: ['app'] }, Placement: { Constraints: ['changed'] } }]) expect(swarmSpecFingerprint({ Name: 'web', TaskTemplate: value })).not.toBe(swarmSpecFingerprint(original));
  });
});
