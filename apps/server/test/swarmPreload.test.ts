import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('../src/lib/exec.js', async original => ({ ...await original<typeof import('../src/lib/exec.js')>(), capture: h.capture }));
const { unusedSwarmPreloadLabel, SWARM_PLACEMENT_FORMAT } = await import('../src/engine/swarmPreload.js');
const { swarmImageTag } = await import('../src/lib/swarm.js');
type Placement = { current: string[] | null; previous: string[] | null };
let specs: Placement[];
const key = (i: number) => `nd.preload.web.g${i}`;
const constraint = (i: number) => `node.labels.${key(i)}==${'a'.repeat(64)}`;
const id = (i: number) => i.toString(36).padStart(25, '0');
beforeEach(() => {
  specs = [];
  h.capture.mockReset().mockImplementation(async (_cmd: string, args: string[]) => {
    if (args[1] === 'ls') return specs.map((_, i) => id(i)).join('\n');
    if (args[1] === 'inspect' && args[3] === SWARM_PLACEMENT_FORMAT) return args.slice(4).map(n => JSON.stringify(specs[Number.parseInt(n, 36)])).join('\n');
    throw Error('Unexpected Docker operation');
  });
});
describe('bounded Swarm preload slots', () => {
  it('chooses the first slot on an empty manager', async () => {
    expect(await unusedSwarmPreloadLabel('web')).toBe(key(0));
    expect(h.capture).toHaveBeenCalledTimes(1);
    expect(h.capture.mock.calls[0]?.[1]).toEqual(['service', 'ls', '--quiet']);
  });
  it('reads Docker CLI truncated IDs and refuses ambiguous prefixes', async () => {
    h.capture.mockResolvedValueOnce('abcdefghijkl').mockResolvedValueOnce(JSON.stringify({ current: [constraint(0)], previous: null }));
    expect(await unusedSwarmPreloadLabel('web')).toBe(key(1));
    expect(h.capture.mock.calls[1]?.[1].at(-1)).toBe('abcdefghijkl');
    h.capture.mockResolvedValueOnce('abcdefghijkl').mockRejectedValueOnce(Error('service is ambiguous'));
    await expect(unusedSwarmPreloadLabel('web')).rejects.toThrow('service is ambiguous');
  });
  it('protects legacy placement and uses a separate slot without changing its value', async () => {
    specs = [{ current: ['node.labels.nd.preload.web==aaaaaaaaaaaa'], previous: null }];
    expect(await unusedSwarmPreloadLabel('web')).toBe(key(0));
  });
  it('protects current and rollback slots, including references from other services', async () => {
    specs = [{ current: [constraint(0)], previous: [constraint(1)] }];
    expect(await unusedSwarmPreloadLabel('web')).toBe(key(2));
    specs.push({ current: [constraint(2)], previous: null });
    await expect(unusedSwarmPreloadLabel('web')).rejects.toThrow('All Swarm preload slots are referenced');
  });
  it('rotates through the same three keys as current and rollback specs advance', async () => {
    const selected: string[] = [];
    for (let n = 0; n < 20; n++) {
      const next = await unusedSwarmPreloadLabel('web'); selected.push(next);
      const current = specs[0]?.current ?? null;
      specs = [{ current: [`node.labels.${next}==${'b'.repeat(64)}`], previous: current }];
    }
    expect(new Set(selected)).toEqual(new Set([key(0), key(1), key(2)]));
  });
  it('recognizes spaced and inequality references without confusing service slugs', async () => {
    specs = [{ current: [' node.labels.nd.preload.web.g0 != 0 ', 'node.labels.nd.preload.web-other.g1==1'], previous: null }];
    expect(await unusedSwarmPreloadLabel('web')).toBe(key(1));
  });
  it('protects mixed-case Docker constraint prefixes while keeping label keys case-sensitive', async () => {
    specs = [{ current: ['NODE.LABELS.' + key(0) + '==held', 'node.labels.ND.preload.web.g1==held'], previous: ['Node.Labelſ.' + key(2) + '!=other'] }];
    expect(await unusedSwarmPreloadLabel('web')).toBe(key(1));
  });
  it('batches metadata reads with bounded argv', async () => {
    specs = Array.from({ length: 130 }, () => ({ current: null, previous: null }));
    expect(await unusedSwarmPreloadLabel('web')).toBe(key(0));
    expect(h.capture.mock.calls.slice(1).map(c => c[1].length - 4)).toEqual([64, 64, 2]);
  });
  it.each(['bad', 'not-an-id ' + id(0), Array.from({ length: 4097 }, (_, i) => id(i)).join('\n')])('refuses an unconfirmed or oversized service inventory', async output => {
    h.capture.mockResolvedValueOnce(output);
    await expect(unusedSwarmPreloadLabel('web')).rejects.toThrow('placement inventory is unconfirmed');
    expect(h.capture).toHaveBeenCalledTimes(1);
  });
  it.each(['', 'not JSON', '{}', '{"current":null}', '{"current":{},"previous":null}', '{"current":[7],"previous":null}'])('fails closed for incomplete service metadata: %s', async output => {
    specs = [{ current: null, previous: null }]; h.capture.mockResolvedValueOnce(id(0)).mockResolvedValueOnce(output);
    await expect(unusedSwarmPreloadLabel('web')).rejects.toThrow(/placement|constraints/);
  });
  it('leaves placement alone if the manager is unavailable', async () => {
    h.capture.mockRejectedValueOnce(Error('manager unavailable'));
    await expect(unusedSwarmPreloadLabel('web')).rejects.toThrow('manager unavailable');
  });
  it('rejects an invalid slug without calling Docker', async () => {
    await expect(unusedSwarmPreloadLabel('../web')).rejects.toThrow('Invalid Swarm preload service');
    expect(h.capture).not.toHaveBeenCalled();
  });
  it('uses the full image identity and refuses unconfirmed inputs', () => {
    expect(swarmImageTag('sha256:' + 'a'.repeat(64))).toBe('a'.repeat(64));
    expect(swarmImageTag('registry.test/app@sha256:' + 'b'.repeat(64))).toBe('b'.repeat(64));
    for (const input of ['mutable:latest', 'a'.repeat(12), '--help']) expect(() => swarmImageTag(input)).toThrow('image identity is unconfirmed');
  });
});
