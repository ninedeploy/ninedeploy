import { describe, expect, it, vi } from 'vitest';
import { inspectOwnedSmokeResource, removeOwnedSmokeResource } from '../../../scripts/lib/owned-smoke-resources.mjs';

const owner = 'a'.repeat(32), id = 'b'.repeat(64);
describe('upgrade smoke resource ownership', () => {
  it.each(['container', 'network'] as const)('removes an owned %s by immutable ID', kind => {
    const run = vi.fn().mockReturnValueOnce({ status: 0, stdout: id + '|' + owner + '\n' }).mockReturnValueOnce({ status: 0 });
    expect(removeOwnedSmokeResource(run, kind, 'nd-fixture', owner)).toBe('removed');
    expect(run.mock.calls[1]![0]).toEqual(kind === 'container' ? ['rm', '-f', id] : ['network', 'rm', id]);
  });
  it('requires an exact matching volume name and owner before removal', () => {
    const run = vi.fn().mockReturnValueOnce({ status: 0, stdout: 'nd-data|' + owner }).mockReturnValueOnce({ status: 0 });
    expect(removeOwnedSmokeResource(run, 'volume', 'nd-data', owner)).toBe('removed');
    expect(run.mock.calls[1]![0]).toEqual(['volume', 'rm', 'nd-data']);
  });
  it.each([{ status: 1, stdout: '' }, { status: 0, stdout: id + '|' + 'c'.repeat(32) },
    { status: 0, stdout: 'short|' + owner }, { status: 0, stdout: id + '|' + owner + '|extra' }])
    ('never removes an unconfirmed or foreign container: %j', response => {
      const run = vi.fn().mockReturnValue(response);
      expect(removeOwnedSmokeResource(run, 'container', 'nd-fixture', owner)).not.toBe('removed');
      expect(run).toHaveBeenCalledOnce();
    });
  it('retains a foreign same-name volume', () => {
    const run = vi.fn().mockReturnValue({ status: 0, stdout: 'nd-data|' + 'c'.repeat(32) });
    expect(inspectOwnedSmokeResource(run, 'volume', 'nd-data', owner)).toEqual({ status: 'foreign' });
    expect(removeOwnedSmokeResource(run, 'volume', 'nd-data', owner)).toBe('foreign');
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('does not report removal when Docker rejects it', () => {
    const run = vi.fn().mockReturnValueOnce({ status: 0, stdout: id + '|' + owner }).mockReturnValueOnce({ status: 1 });
    expect(removeOwnedSmokeResource(run, 'container', 'nd-fixture', owner)).toBe('unavailable');
  });
  it.each([['container', '--unsafe', owner], ['container', 'nd-fixture', 'bad'], ['image', 'nd-fixture', owner]])
    ('refuses invalid identity without invoking Docker', (kind, name, token) => {
      const run = vi.fn(); expect(() => removeOwnedSmokeResource(run, kind, name, token)).toThrow(/Invalid/); expect(run).not.toHaveBeenCalled();
    });
});
