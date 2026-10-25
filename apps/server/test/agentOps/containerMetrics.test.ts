import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { advertisedCapabilities, runRegisteredOp } from '../../src/agentOps/index.js';

const io = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../../src/lib/spawnValidated.js', () => ({ spawnValidated: io.spawn }));
const target = { id: 'a'.repeat(64), name: 'web-9' };
const input = { requestId: 'b'.repeat(32), serviceId: 7, deploymentId: 9, targets: [target], timeoutMs: 5000 };
let inspect: Record<string, unknown>, stats: Record<string, unknown>;
beforeEach(() => {
  inspect = { ...target, name: '/web-9', managed: 'service', serviceId: '7', deploymentId: '9', status: 'running', restarts: 0,
    memoryLimit: 128 * 1024 * 1024, nanoCpus: 500_000_000, cpuQuota: 0, cpuPeriod: 0 };
  stats = { ...target, cpu: '25.50%', memory: '32MiB / 128MiB' };
  io.spawn.mockReset().mockImplementation(async (_bin, args, sink) => {
    sink(JSON.stringify(args[0] === 'stats' ? stats : inspect));
    return 0;
  });
});
afterEach(() => vi.restoreAllMocks());
async function sample(params: Record<string, unknown> = input) {
  const lines: string[] = [];
  const code = await runRegisteredOp('docker.metrics', params, line => lines.push(line), { sealed: true }, {});
  expect(code).toBe(0);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^ND-METRICS /);
  return JSON.parse(lines[0]!.slice(11));
}

describe('immutable node container metrics', () => {
  it('binds actual CPU/memory and configured limits to the requested service generation', async () => {
    const reply = await sample();
    expect(reply).toMatchObject({ requestId: input.requestId, serviceId: 7, deploymentId: 9, complete: true,
      items: [{ ...target, cpuPct: 25.5, memBytes: 32 * 1024 * 1024, memLimitBytes: 128 * 1024 * 1024, cpuLimitMilli: 500, restarts: 0 }] });
    const commands = io.spawn.mock.calls.map(call => call[1]);
    expect(commands).toHaveLength(3);
    expect(commands.every(args => args.at(-1) === target.id)).toBe(true);
  });
  it('never mistakes host RAM for an unconstrained container memory limit', async () => {
    inspect.memoryLimit = 0; inspect.nanoCpus = 0;
    stats.memory = '32MiB / 8GiB';
    expect((await sample()).items[0]).toMatchObject({ memLimitBytes: 0, cpuLimitMilli: 0 });
  });
  it('keeps existing immutable identity lookups working as a control', async () => {
    const lines: string[] = [];
    expect(await runRegisteredOp('docker.identity', { name: target.name }, line => lines.push(line), { sealed: true }, {})).toBe(0);
    expect(JSON.parse(lines[0]!.slice(13))).toMatchObject({ id: target.id, name: target.name });
  });
  it('refuses unsealed metrics before touching Docker', async () => {
    await expect(runRegisteredOp('docker.metrics', input, () => undefined, { sealed: false }, {})).rejects.toThrow(/sealed/i);
    expect(io.spawn).not.toHaveBeenCalled();
  });
  it.each([{ id: '--privileged', name: 'web-9' }, { id: target.id, name: '../web' }])('rejects invalid target operands %j', async changed => {
    await expect(sample({ ...input, targets: [changed] })).rejects.toThrow(/Invalid|targets|id|name/i);
    expect(io.spawn).not.toHaveBeenCalled();
  });
  it.each([{ serviceId: '8' }, { deploymentId: '10' }, { managed: 'database' }, { name: '/another' }, { status: 'exited' }])('rejects foreign or stopped containers: %j', async changed => {
    Object.assign(inspect, changed);
    await expect(sample()).rejects.toThrow(/identity|generation|running/i);
  });
  it.each(['NaN%', '-1%', 'Infinity%', '25.5% invalid'])('rejects invalid CPU instead of returning zero: %s', async cpu => {
    stats.cpu = cpu;
    await expect(sample()).rejects.toThrow(/metric|sample/i);
  });
  it('rejects a restart during sampling', async () => {
    const original = io.spawn.getMockImplementation()!;
    let inspections = 0;
    io.spawn.mockImplementation(async (...args) => {
      if (args[1][0] === 'inspect' && ++inspections === 2) inspect.restarts = 1;
      return original(...args);
    });
    await expect(sample()).rejects.toThrow(/changed|generation/i);
  });
  it('uses quota/period limits and decimal memory units without substituting host capacity', async () => {
    inspect.nanoCpus = 0; inspect.cpuQuota = 75_000; inspect.cpuPeriod = 100_000;
    stats.memory = '1.25MB / 8GB';
    expect((await sample()).items[0]).toMatchObject({ cpuLimitMilli: 750, memBytes: 1_250_000, memLimitBytes: 128 * 1024 * 1024 });
  });
  it('omits the capability and refuses work when the node owner disables sampling', async () => {
    const env = { NINEDEPLOY_AGENT_CONTAINER_METRICS: 'off' };
    expect(advertisedCapabilities(env)).not.toContain('docker.metrics');
    await expect(runRegisteredOp('docker.metrics', input, () => undefined, { sealed: true }, env)).rejects.toThrow(/disabled.*owner/);
    expect(io.spawn).not.toHaveBeenCalled();
  });
  it.each(['32 / 128MiB', '-1MiB / 128MiB', 'NaNMiB / 128MiB', '1e30B / 1GB', '999999999999999999EB / 1GB'])('refuses malformed or overflowing memory usage: %s', async memory => {
    stats.memory = memory;
    await expect(sample()).rejects.toThrow(/memory metric/);
  });
  it.each([{ memoryLimit: -1 }, { memoryLimit: Number.MAX_SAFE_INTEGER + 1 }, { nanoCpus: '500000000' }, { cpuQuota: -2 }, { restarts: 0.5 }])('refuses invalid inspect limits: %j', async changed => {
    Object.assign(inspect, changed);
    await expect(sample()).rejects.toThrow(/metric limits/);
    expect(io.spawn).toHaveBeenCalledTimes(1);
  });
  it.each(['garbage', 'null', '[]', '{}', 'x'.repeat(65537)])('refuses malformed or oversized command output (case %#)', async line => {
    io.spawn.mockImplementation(async (_bin, _args, sink) => { sink(line); return 0; });
    await expect(sample()).rejects.toThrow(/sample|identity/);
    expect(io.spawn).toHaveBeenCalledTimes(1);
  });
  it('requires every immutable target exactly once even when Docker succeeds', async () => {
    io.spawn.mockImplementation(async (_bin, _args, sink) => {
      sink(JSON.stringify(inspect)); sink(JSON.stringify(inspect)); return 0;
    });
    await expect(sample({ ...input, targets: [target, { id: 'c'.repeat(64), name: 'web-9-r1' }] })).rejects.toThrow(/identity/);
  });
  it('binds each of multiple out-of-order Docker rows to its immutable target', async () => {
    const second = { id: 'c'.repeat(64), name: 'web-9-r1' };
    io.spawn.mockImplementation(async (_bin, args, sink) => {
      for (const t of [second, target]) sink(JSON.stringify(args[0] === 'stats' ? { ...stats, ...t } : { ...inspect, ...t }));
      return 0;
    });
    expect((await sample({ ...input, targets: [target, second] })).items.map((item: { id: string }) => item.id)).toEqual([target.id, second.id]);
  });
  it('uses one shrinking deadline and rejects a late successful Docker command', async () => {
    let now = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    io.spawn.mockImplementation(async (_bin, args, sink) => {
      sink(JSON.stringify(args[0] === 'stats' ? stats : inspect)); now += 2000; return 0;
    });
    await expect(sample()).rejects.toThrow(/sample|deadline/);
    expect(io.spawn.mock.calls.map(call => call[3].timeoutMs)).toEqual([5000, 3000, 1000]);
  });
  it('bounds concurrent samplers and releases capacity after both success and failure', async () => {
    const normal = io.spawn.getMockImplementation()!;
    const releases: (() => void)[] = [];
    io.spawn.mockImplementation(async (...args) => {
      if (args[1][0] === 'inspect' && releases.length < 2) await new Promise<void>(resolve => releases.push(resolve));
      return normal(...args);
    });
    const one = sample(), two = sample();
    expect(releases).toHaveLength(2);
    await expect(sample()).rejects.toThrow(/capacity.*busy/);
    for (const release of releases) release();
    await Promise.all([one, two]);
    io.spawn.mockImplementation(normal);
    for (let attempt = 0; attempt < 3; attempt++) {
      stats.cpu = 'NaN%'; await expect(sample()).rejects.toThrow(/CPU metric/);
    }
    stats.cpu = '0.00%';
    expect((await sample()).complete).toBe(true);
  });
});
