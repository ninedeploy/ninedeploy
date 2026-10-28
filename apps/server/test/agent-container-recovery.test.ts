import { afterEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../src/lib/spawnValidated.js', () => ({ spawnValidated: io.spawn }));
const { runRegisteredOp } = await import('../src/agentOps/index.js');
const id = 'a'.repeat(64);
const retireDockerStub = (name = 'web-9') => async (_exe: unknown, argv: unknown, sink: (line: string) => void) => {
  if ((argv as string[])[0] === 'inspect') sink(JSON.stringify({ id, name: '/' + name, managed: null, serviceId: null, deploymentId: null, composeProject: null }));
  return 0;
};
afterEach(() => io.spawn.mockReset());
describe('sealed immutable container recovery operations', () => {
  it('honors the requested stop grace with a matching child timeout before removing the immutable ID', async () => {
    io.spawn.mockImplementation(retireDockerStub());
    await runRegisteredOp('docker.retire', { id, name: 'web-9', graceSeconds: '37' }, () => {}, { sealed: true });
    expect(io.spawn.mock.calls[1][1]).toEqual(['stop', '-t', '37', id]);
    expect(io.spawn.mock.calls[1][3].timeoutMs).toBeGreaterThanOrEqual(42_000);
  });
  it.each(['-1', '301', '1.5', '', 'forever'])('refuses invalid retirement grace %j before inspecting or changing Docker', async graceSeconds => {
    await expect(runRegisteredOp('docker.retire', { id, name: 'web-9', graceSeconds }, () => {}, { sealed: true })).rejects.toThrow(/grace/i);
    expect(io.spawn).not.toHaveBeenCalled();
  });
  it('returns only fixed identity fields and ignores caller-selected formats', async () => {
    io.spawn.mockImplementation(async (_exe, _args, sink) => { sink(JSON.stringify({ id, name: '/web-9', managed: 'service', serviceId: '1', deploymentId: '9' })); return 0; });
    const out: string[] = [];
    expect(await runRegisteredOp('docker.identity', { name: 'web-9', format: '{{json .Config.Env}}' }, s => out.push(s), { sealed: true })).toBe(0);
    expect(out[0]).toContain(`"id":"${id}"`); expect(out[0]).toContain('"name":"web-9"');
    expect(io.spawn.mock.calls[0][1].join(' ')).not.toContain('.Config.Env');
    expect(io.spawn.mock.calls[0][3]).toEqual({ timeoutMs: 10000 });
  });
  it('distinguishes a missing container from an unreachable Docker daemon', async () => {
    io.spawn.mockImplementationOnce(async (_e, _a, sink) => { sink('Error: No such object: web-9'); return 1; });
    const out: string[] = [];
    await runRegisteredOp('docker.identity', { name: 'web-9' }, s => out.push(s), { sealed: true });
    expect(out).toEqual(['ND-CONTAINER null']);
    io.spawn.mockImplementationOnce(async (_e, _a, sink) => { sink('Cannot connect to Docker daemon'); return 1; });
    await expect(runRegisteredOp('docker.identity', { name: 'web-9' }, () => {}, { sealed: true })).rejects.toThrow('unavailable');
  });
  it('does not report an absent container when Docker also reports another error', async () => {
    io.spawn.mockImplementationOnce(async (_e, _a, sink) => {
      sink('Error: No such object: web-9');
      sink('Cannot connect to Docker daemon');
      return 1;
    });
    const out: string[] = [];
    await expect(runRegisteredOp('docker.identity', { name: 'web-9' }, s => out.push(s), { sealed: true })).rejects.toThrow('unavailable');
    expect(out).toEqual([]);
  });
  it('does not treat a different container as the missing requested container', async () => {
    io.spawn.mockImplementationOnce(async (_e, _a, sink) => { sink('Error: No such object: other'); return 1; });
    await expect(runRegisteredOp('docker.identity', { name: 'web-9' }, () => {}, { sealed: true })).rejects.toThrow('unavailable');
  });
  it('does not report retirement after a mixed Docker removal failure', async () => {
    io.spawn.mockImplementation(async (_e, argv, sink) => {
      if (argv[0] === 'inspect') return retireDockerStub()(_e, argv, sink);
      sink(`Error: No such container: ${id}`);
      sink('Docker daemon unavailable');
      return 1;
    });
    const out: string[] = [];
    await expect(runRegisteredOp('docker.retire', { id, name: 'web-9' }, s => out.push(s), { sealed: true })).rejects.toThrow('unconfirmed');
    expect(out).toEqual([]);
  });
  it('does not report retirement when inspection says a different ID is missing', async () => {
    io.spawn.mockImplementationOnce(async (_e, _argv, sink) => {
      sink(`Error: No such object: ${'b'.repeat(64)}`);
      return 1;
    });
    const out: string[] = [];
    await expect(runRegisteredOp('docker.retire', { id, name: 'web-9' }, s => out.push(s), { sealed: true })).rejects.toThrow('unavailable');
    expect(out).toEqual([]);
  });
  it('confirms an already absent retirement target only for its exact ID', async () => {
    io.spawn.mockImplementationOnce(async (_e, _argv, sink) => { sink(`Error: No such object: ${id}`); return 1; });
    const out: string[] = [];
    expect(await runRegisteredOp('docker.retire', { id, name: 'web-9' }, s => out.push(s), { sealed: true })).toBe(0);
    expect(out).toEqual([`ND-RETIRED ${id}`]);
  });
  it('accepts an exact missing-ID response during retirement', async () => {
    io.spawn.mockImplementation(async (_e, argv, sink) => {
      if (argv[0] === 'inspect') return retireDockerStub()(_e, argv, sink);
      sink(`Error response from daemon: No such container: ${id}`);
      return 1;
    });
    const out: string[] = [];
    expect(await runRegisteredOp('docker.retire', { id, name: 'web-9' }, s => out.push(s), { sealed: true })).toBe(0);
    expect(out).toEqual([`ND-RETIRED ${id}`]);
  });
  it('stops and removes only the immutable ID, after matching its expected name', async () => {
    io.spawn.mockImplementation(retireDockerStub());
    const out: string[] = [];
    await runRegisteredOp('docker.retire', { id, name: 'web-9' }, s => out.push(s), { sealed: true });
    expect(io.spawn.mock.calls.slice(1).map(c => c[1])).toEqual([['stop', '-t', '5', id], ['rm', '-f', id]]);
    expect(out).toEqual([`ND-RETIRED ${id}`]);
  });
  it('keeps a renamed container and refuses arbitrary IDs before side effects', async () => {
    io.spawn.mockImplementation(retireDockerStub('different-owner'));
    await expect(runRegisteredOp('docker.retire', { id, name: 'web-9' }, () => {}, { sealed: true })).rejects.toThrow('changed');
    expect(io.spawn).toHaveBeenCalledTimes(1); io.spawn.mockClear();
    await expect(runRegisteredOp('docker.retire', { id: '--all', name: 'web-9' }, () => {}, { sealed: true })).rejects.toThrow('Invalid');
    expect(io.spawn).not.toHaveBeenCalled();
  });
  it.each(['docker.identity', 'docker.retire'])('refuses unsealed %s without inspecting or stopping anything', async op => {
    await expect(runRegisteredOp(op, { id, name: 'web-9' }, () => {}, { sealed: false })).rejects.toThrow(/sealed/i);
    expect(io.spawn).not.toHaveBeenCalled();
  });
});
