import { describe, expect, it, vi } from 'vitest';
import { NineDeployKernel } from '../../src/kernel/kernel.js';
import { TelemetryStreamerPlugin } from '../../src/kernel/plugins/telemetry.js';

describe('TelemetryStreamerPlugin export error paths', () => {
  const EXPORT_URL = 'https://otel.example.com/v1/ingest';
  const mockConfig = {
    port: 3000,
    host: '0.0.0.0',
    jwtSecret: 'test-secret-at-least-32-chars-long-12345',
    dataDir: '/tmp/ninedeploy-test',
  };

  function makeDb(findFirstQueue: Array<unknown>) {
    const queue = findFirstQueue.map((v) => v);
    return {
      query: {
        configEntries: {
          findMany: vi.fn().mockResolvedValue([]),
          findFirst: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? undefined)),
        },
      },
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockResolvedValue([]),
        }),
      }),
    };
  }

  it('emits telemetry.export.error on a non-2xx response', async () => {
    const localDb = makeDb([{ value: EXPORT_URL }, undefined, null]);
    const kernel = new NineDeployKernel(localDb as never, mockConfig);
    const plugin = new TelemetryStreamerPlugin();
    const fetchMock = vi.fn().mockResolvedValue({ status: 503 });
    vi.stubGlobal('fetch', fetchMock);
    const errors: unknown[] = [];
    kernel.events.onCustom('telemetry.export.error', (p) => errors.push(p));
    try {
      await kernel.registerPlugin(plugin);
      kernel.events.emit('custom.system_event', { hello: 'world' });
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      vi.unstubAllGlobals();
      plugin.destroy();
    }
    expect(fetchMock).toHaveBeenCalled();
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect((errors[0] as { status: number }).status).toBe(503);
  });

  it('emits telemetry.export.error when fetch throws', async () => {
    const localDb = makeDb([{ value: EXPORT_URL }, undefined, null]);
    const kernel = new NineDeployKernel(localDb as never, mockConfig);
    const plugin = new TelemetryStreamerPlugin();
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);
    const errors: unknown[] = [];
    kernel.events.onCustom('telemetry.export.error', (p) => errors.push(p));
    try {
      await kernel.registerPlugin(plugin);
      kernel.events.emit('custom.system_event', { hello: 'world' });
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      vi.unstubAllGlobals();
      plugin.destroy();
    }
    expect(fetchMock).toHaveBeenCalled();
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect((errors[0] as { reason: string }).reason).toBe('ECONNREFUSED');
  });

  it('does not loop the export on a failure (no infinite re-emit)', async () => {
    // The critical regression guard: if the plugin emits
    // `telemetry.export.error` and the wildcard handler re-emits it as
    // `telemetry.recorded`, every record re-triggers a fetch, which can
    // fail again, which re-emits … and the test process OOMs. We assert
    // that after a non-2xx the recorded-list has NOT grown infinitely.
    const localDb = makeDb([{ value: EXPORT_URL }, undefined, null]);
    const kernel = new NineDeployKernel(localDb as never, mockConfig);
    const plugin = new TelemetryStreamerPlugin();
    const fetchMock = vi.fn().mockResolvedValue({ status: 503 });
    vi.stubGlobal('fetch', fetchMock);
    const recorded: unknown[] = [];
    kernel.events.on('telemetry.recorded', (p) => recorded.push(p));
    const errors: unknown[] = [];
    kernel.events.onCustom('telemetry.export.error', (p) => errors.push(p));
    try {
      await kernel.registerPlugin(plugin);
      kernel.events.emit('custom.system_event', { hello: 'world' });
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      vi.unstubAllGlobals();
      plugin.destroy();
    }
    // Exactly one `custom.system_event` produces exactly one
    // `telemetry.recorded` (which fails export once).
    expect(recorded).toHaveLength(1);
    // The single failure is reported exactly once.
    expect(errors).toHaveLength(1);
    // Fetch is called once — not 50, not infinite.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
