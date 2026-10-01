import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NineDeployClient } from '@ninedeploy/sdk';
import { InvalidArgumentError } from 'commander';
import { housekeepingPrune, positiveIntOption } from '../src/commands/housekeeping.js';

describe('CLI housekeeping command', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  const fakeClient = {
    housekeeping: {
      runPrune: vi.fn(),
    },
  } as unknown as NineDeployClient;

  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('runs housekeeping prune successfully and prints reclaimed space and details', async () => {
    vi.mocked(fakeClient.housekeeping.runPrune).mockResolvedValueOnce({
      ok: true,
      freedBytes: 104857600,
      diskUsedPercentAfter: 42,
      details: {
        imagesFreed: '2.5 GB',
      },
    });

    await housekeepingPrune(fakeClient);

    expect(logSpy).toHaveBeenCalledWith('  ✓ System housekeeping prune completed.');
    expect(logSpy).toHaveBeenCalledWith('    Space reclaimed: 100.0 MB');
    expect(logSpy).toHaveBeenCalledWith('    Disk used after: 42%');
    expect(logSpy).toHaveBeenCalledWith('    Images freed:    2.5 GB');
  });

  it('runs housekeeping prune with defaults when details are omitted', async () => {
    vi.mocked(fakeClient.housekeeping.runPrune).mockResolvedValueOnce({
      ok: true,
      freedBytes: 0,
      diskUsedPercentAfter: 20,
      details: {},
    });

    await housekeepingPrune(fakeClient);

    expect(logSpy).toHaveBeenCalledWith('  ✓ System housekeeping prune completed.');
    expect(logSpy).toHaveBeenCalledWith('    Space reclaimed: 0 B');
    expect(logSpy).toHaveBeenCalledWith('    Disk used after: 20%');
  });

  it('handles housekeeping error', async () => {
    vi.mocked(fakeClient.housekeeping.runPrune).mockRejectedValueOnce(new Error('Prune failed'));
    await expect(housekeepingPrune(fakeClient)).rejects.toThrow('Prune failed');
  });
});

// r554: `images prune --older-than 1.5` / `--keep-last abc` went through
// `Number(v)` and reached the server as 1.5 / NaN (an opaque 422).
describe('positiveIntOption (images prune flags)', () => {
  const parse = positiveIntOption(1000);

  it('accepts whole numbers in range', () => {
    expect(parse('1')).toBe(1);
    expect(parse(' 24 ')).toBe(24);
    expect(parse('1000')).toBe(1000);
  });

  it.each(['1.5', 'abc', '', '0', '-3', '1e3', '0x10', '1001'])('rejects %j with a clear message', (v) => {
    expect(() => parse(v)).toThrow(InvalidArgumentError);
    expect(() => parse(v)).toThrow(/whole number between 1 and 1000/);
  });
});
