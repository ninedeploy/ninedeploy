import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { advertisedCapabilities, runRegisteredOp } from '../../src/agentOps/index.js';
import { capabilityRefusalFor } from '../../src/lib/agentCapabilities.js';

const io = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../../src/lib/spawnValidated.js', () => ({ spawnValidated: io.spawn }));
const target = { id: 'a'.repeat(64), name: 'web-9' };
const input = { requestId: 'b'.repeat(32), serviceId: 7, deploymentId: 9, revision: 1, action: 'start', targets: [target], timeoutMs: 5000 };
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nd-lifecycle-op-')); vi.spyOn(process, 'cwd').mockReturnValue(root);
  let running = false;
  io.spawn.mockReset().mockImplementation(async (_bin, args, sink) => {
    if (args[0] === 'inspect') sink(JSON.stringify({ ...target, name: `/${target.name}`, managed: 'service', serviceId: '7', deploymentId: '9',
      status: running ? 'running' : 'exited', running }));
    else running = true;
    return 0;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (dirname(root) !== tmpdir() || !basename(root).startsWith('nd-lifecycle-op-')) throw Error('Unexpected fixture cleanup path');
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});
describe('registered node lifecycle capability', () => {
  it('advertises and executes the sealed operation with one typed receipt', async () => {
    expect(advertisedCapabilities({})).toContain('docker.lifecycle');
    expect(advertisedCapabilities({})).toContain('docker.lifecycle.generations');
    expect(advertisedCapabilities({})).toContain('docker.lifecycle.creationFence');
    const lines: string[] = [];
    expect(await runRegisteredOp('docker.lifecycle', input, line => lines.push(line), { sealed: true }, {})).toBe(0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!.slice('ND-LIFECYCLE '.length))).toMatchObject({ serviceId: 7, deploymentId: 9, revision: 1, complete: true, items: [{ ...target, running: true }] });
    expect(existsSync(join(root, '.agent-work', '.lifecycle', 'service-7.sqlite'))).toBe(true);
  });
  it('refuses unsealed requests before any journal or Docker access', async () => {
    await expect(runRegisteredOp('docker.lifecycle', input, () => undefined, { sealed: false }, {})).rejects.toThrow(/sealed/);
    expect(readdirSync(root)).toEqual([]); expect(io.spawn).not.toHaveBeenCalled();
  });
  it('honors the node owner switch before journal or Docker access', async () => {
    const env = { NINEDEPLOY_AGENT_CONTAINER_LIFECYCLE: 'off' };
    expect(advertisedCapabilities(env)).not.toContain('docker.lifecycle');
    expect(advertisedCapabilities(env)).not.toContain('docker.lifecycle.generations');
    expect(advertisedCapabilities(env)).not.toContain('docker.lifecycle.creationFence');
    await expect(runRegisteredOp('docker.lifecycle', input, () => undefined, { sealed: true }, env)).rejects.toThrow(/disabled.*owner/);
    expect(readdirSync(root)).toEqual([]); expect(io.spawn).not.toHaveBeenCalled();
  });
  it('distinguishes an old agent from owner-disabled lifecycle operations', () => {
    const option = { cap: 'docker.lifecycle' as const, feature: 'control immutable container state' };
    expect(capabilityRefusalFor({ version: '0.18.2', caps: new Set() }, '#7', option)).toMatchObject({ code: 'node_agent_outdated', message: expect.stringMatching(/v0.18.3/) });
    expect(capabilityRefusalFor({ version: '0.18.3', caps: new Set() }, '#7', option)).toMatchObject({ code: 'node_feature_disabled', message: expect.stringMatching(/NINEDEPLOY_AGENT_CONTAINER_LIFECYCLE=off/) });
  });
});
