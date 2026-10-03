import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCacheStats, buildCacheStatsAction } from '../src/commands/buildCache.js';

const h = vi.hoisted(() => ({
  errorSpy: vi.fn(),
  infoSpy: vi.fn(),
  successSpy: vi.fn(),
  headerSpy: vi.fn(),
}));

vi.mock('../src/lib/format.js', () => ({
  error: h.errorSpy,
  header: h.headerSpy,
  info: h.infoSpy,
  success: h.successSpy,
}));

interface FakeBuildCache {
  stats: ReturnType<typeof vi.fn>;
}

function newClient(): { buildCache: FakeBuildCache } {
  return {
    buildCache: { stats: vi.fn() },
  };
}

let savedExitCode: number | undefined;
beforeEach(() => {
  savedExitCode = process.exitCode;
  process.exitCode = 0;
  h.errorSpy.mockReset();
  h.infoSpy.mockReset();
  h.successSpy.mockReset();
  h.headerSpy.mockReset();
});
afterEach(() => {
  process.exitCode = savedExitCode;
});

describe('build-cache stats', () => {
  it('delegates to client.buildCache.stats', async () => {
    const client = newClient();
    (client.buildCache.stats as ReturnType<typeof vi.fn>).mockResolvedValue({
      backends: [],
      totals: { entries: 0, totalBytes: 0, hits: 0, misses: 0, stores: 0, evictions: 0 },
    });
    await buildCacheStats(client as never);
    expect(client.buildCache.stats).toHaveBeenCalledOnce();
  });

  it('prints a hint when no backends are registered', async () => {
    const client = newClient();
    (client.buildCache.stats as ReturnType<typeof vi.fn>).mockResolvedValue({
      backends: [],
      totals: { entries: 0, totalBytes: 0, hits: 0, misses: 0, stores: 0, evictions: 0 },
    });
    await buildCacheStatsAction(client as never);
    expect(h.headerSpy).toHaveBeenCalledWith('Build cache stats');
    expect(h.infoSpy).toHaveBeenCalledWith(expect.stringMatching(/No build-cache backends are registered/));
    expect(h.successSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it('prints per-backend counters + merged totals + hit rate', async () => {
    const client = newClient();
    (client.buildCache.stats as ReturnType<typeof vi.fn>).mockResolvedValue({
      backends: [{ name: 'inline', entries: 1, totalBytes: 1024, hits: 4, misses: 6, stores: 5, evictions: 1 }],
      totals: { entries: 1, totalBytes: 1024, hits: 4, misses: 6, stores: 5, evictions: 1 },
    });
    await buildCacheStatsAction(client as never);
    const printed = h.infoSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('Backend: inline');
    expect(printed).toContain('entries:   1');
    expect(printed).toContain('bytes:     1024');
    expect(printed).toContain('Totals:');
    expect(h.successSpy).toHaveBeenCalledWith('Done. Hit rate: 40.0%');
    expect(process.exitCode).toBe(0);
  });

  it('renders a 0.0 hit rate when there are no lookups', async () => {
    const client = newClient();
    (client.buildCache.stats as ReturnType<typeof vi.fn>).mockResolvedValue({
      backends: [{ name: 'inline', entries: 0, totalBytes: 0, hits: 0, misses: 0, stores: 0, evictions: 0 }],
      totals: { entries: 0, totalBytes: 0, hits: 0, misses: 0, stores: 0, evictions: 0 },
    });
    await buildCacheStatsAction(client as never);
    expect(h.successSpy).toHaveBeenCalledWith('Done. Hit rate: 0.0%');
  });

  it('surfaces a thrown error and sets exitCode=1', async () => {
    const client = newClient();
    (client.buildCache.stats as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network error'));
    await buildCacheStatsAction(client as never);
    expect(h.errorSpy).toHaveBeenCalledWith('network error');
    expect(process.exitCode).toBe(1);
  });

  it('falls back to String() when a non-Error is rejected', async () => {
    const client = newClient();
    (client.buildCache.stats as ReturnType<typeof vi.fn>).mockRejectedValue('plain failure');
    await buildCacheStatsAction(client as never);
    expect(h.errorSpy).toHaveBeenCalledWith('plain failure');
    expect(process.exitCode).toBe(1);
  });
});
