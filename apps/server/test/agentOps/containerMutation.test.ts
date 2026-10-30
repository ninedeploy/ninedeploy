import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { advertisedCapabilities, runRegisteredOp } from '../../src/agentOps/index.js';
import { capabilityRefusalFor } from '../../src/lib/agentCapabilities.js';
const io = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../../src/lib/spawnValidated.js', () => ({ spawnValidated: io.spawn }));
const ops = ['docker.runtimeInventory', 'docker.stopSet', 'docker.runtimeFence', 'docker.runtimeLegacyHandoff', 'docker.prepare', 'docker.networkSet', 'docker.retireSet'];
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'nd-mutation-op-')); vi.spyOn(process, 'cwd').mockReturnValue(root); io.spawn.mockReset(); });
afterEach(async () => {
  vi.restoreAllMocks();
  if (dirname(root) !== tmpdir() || !basename(root).startsWith('nd-mutation-op-')) throw Error('Invalid mutation operation fixture cleanup');
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});
it('advertises the ordered mutation capability only while its owner permits it', () => {
  expect(advertisedCapabilities({})).toContain('docker.mutations');
  expect(advertisedCapabilities({ NINEDEPLOY_AGENT_CONTAINER_MUTATIONS: 'off' })).not.toContain('docker.mutations');
});
it('distinguishes an owner-disabled 0.18.10 mutation agent from an older agent', () => {
  const option = { cap: 'docker.mutations' as const, feature: 'control ordered node mutations' };
  expect(capabilityRefusalFor({ version: '0.18.10', caps: new Set() }, '#7', option)).toMatchObject({ code: 'node_feature_disabled', message: expect.stringMatching(/NINEDEPLOY_AGENT_CONTAINER_MUTATIONS=off/) });
  expect(capabilityRefusalFor({ version: '0.18.9', caps: new Set() }, '#7', option)).toMatchObject({ code: 'node_agent_outdated', message: expect.stringMatching(/v0\.18\.10/) });
});
it.each(ops)('refuses unsealed %s before validation, journal or Docker access', async op => {
  await expect(runRegisteredOp(op, {}, () => {}, { sealed: false }, {})).rejects.toThrow(/unencrypted/);
  expect(io.spawn).not.toHaveBeenCalled(); expect(existsSync(join(root, '.agent-work'))).toBe(false);
});
it.each(ops)('refuses owner-disabled %s before validation, journal or Docker access', async op => {
  await expect(runRegisteredOp(op, {}, () => {}, { sealed: true }, { NINEDEPLOY_AGENT_CONTAINER_MUTATIONS: 'off' })).rejects.toThrow(/disabled.*NINEDEPLOY_AGENT_CONTAINER_MUTATIONS/);
  expect(io.spawn).not.toHaveBeenCalled(); expect(existsSync(join(root, '.agent-work'))).toBe(false);
});
it('dispatches real fence and empty-retirement operations and returns bound machine receipts', async () => {
  const input = { requestId: 'a'.repeat(32), serviceId: 7, revision: 8, timeoutMs: 5000 }, lines: string[] = [];
  expect(await runRegisteredOp('docker.runtimeFence', input, line => lines.push(line), { sealed: true }, {})).toBe(0);
  expect(JSON.parse(lines[0]!.slice('ND-RUNTIME-FENCE '.length))).toEqual({ requestId: input.requestId, serviceId: 7, revision: 8, complete: true });
  expect(await runRegisteredOp('docker.retireSet', { ...input, revision: 9, targets: [], graceSeconds: 5 }, line => lines.push(line), { sealed: true }, {})).toBe(0);
  expect(JSON.parse(lines[1]!.slice('ND-RETIRED-SET '.length))).toEqual({ requestId: input.requestId, serviceId: 7, revision: 9, complete: true, items: [] });
  expect(io.spawn).not.toHaveBeenCalled();
});
it('owner opt-out does not downgrade an already-adopted service to unsafe legacy creation', async () => {
  await runRegisteredOp('docker.runtimeFence', { requestId: 'a'.repeat(32), serviceId: 7, revision: 8, timeoutMs: 5000 }, () => {}, { sealed: true }, {});
  const disabled = { NINEDEPLOY_AGENT_CONTAINER_MUTATIONS: 'off' };
  await expect(runRegisteredOp('docker.prepare', {}, () => {}, { sealed: true }, disabled)).rejects.toThrow(/disabled/);
  await expect(runRegisteredOp('docker.runSpec', { name: 'web-10', image: 'sha256:' + 'b'.repeat(64), serviceId: 7, deploymentId: 10 }, () => {}, { sealed: true }, disabled)).rejects.toThrow(/fenced/);
  expect(io.spawn).not.toHaveBeenCalled();
});
it('dispatches fenced inventory and empty Stop with complete owner-bound machine frames', async () => {
  const input = { requestId: 'a'.repeat(32), serviceId: 7, revision: 8, timeoutMs: 5000 }, lines: string[] = [];
  io.spawn.mockImplementation(async (_bin, args: string[]) => { expect(args[0]).toBe('ps'); return 0; });
  await runRegisteredOp('docker.runtimeFence', input, () => {}, { sealed: true }, {});
  expect(await runRegisteredOp('docker.runtimeInventory', input, line => lines.push(line), { sealed: true }, {})).toBe(0);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toBe('ND-RUNTIME-INVENTORY ' + JSON.stringify({ requestId: input.requestId, serviceId: 7, revision: 8, complete: true, items: [] }));
  io.spawn.mockClear(); lines.length = 0;
  expect(await runRegisteredOp('docker.stopSet', { ...input, revision: 9, targets: [], graceSeconds: 1 }, line => lines.push(line), { sealed: true }, {})).toBe(0);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toBe('ND-STOPPED-SET ' + JSON.stringify({ requestId: input.requestId, serviceId: 7, revision: 9, complete: true, items: [] }));
  expect(io.spawn).not.toHaveBeenCalled();
});
