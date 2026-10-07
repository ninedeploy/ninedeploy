import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/kernel/eventBus.js';
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

describe('TelemetryStreamerPlugin export hardening (F284, F285, F286)', () => {
  function directExport(endpoint: string) {
    const events = new EventBus();
    const errors: Array<Record<string, unknown>> = [];
    events.onCustom('telemetry.export.error', (p) => errors.push(p as Record<string, unknown>));
    const ctx = {
      events,
      configCenter: {
        get: async (key: string, def?: unknown) => (key === 'plugin:telemetry-streamer:export_endpoint' ? endpoint : def),
        getSecret: async () => 'sig-secret',
      },
    } as never;
    const run = () =>
      (new TelemetryStreamerPlugin() as unknown as { export: (...a: unknown[]) => Promise<void> }).export(ctx, {
        sourceEvent: 'service.deployed',
        timestamp: '2026-10-07T00:00:00.000Z',
        data: { serviceId: 1 },
      });
    return { run, errors };
  }

  it('F284: never follows a redirect from the collector; a 3xx is a failed export', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 307, headers: { location: 'http://169.254.169.254/latest/api/token' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { run, errors } = directExport('https://otel.example.com/v1/ingest');
      await run();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].redirect).toBe('manual');
      expect(errors).toEqual([expect.objectContaining({ status: 307 })]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('F285: the error event carries scheme + host only, never endpoint credentials', async () => {
    // The real Request constructor rejects a credentialed URL with a message
    // that repeats it — before any I/O.
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      new Request(url, init);
      return { status: 401 } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const cred = directExport('https://otel-user:S3CRET-PASS@otel.example.com/v1/ingest');
      await cred.run();
      const qs = directExport('https://influx.example.com/write?db=nd&u=admin&p=S3CRET-QS');
      await qs.run();
      expect(JSON.stringify([...cred.errors, ...qs.errors])).not.toMatch(/S3CRET/);
      expect(cred.errors[0]?.endpoint).toBe('https://otel.example.com');
      expect(qs.errors[0]).toMatchObject({ endpoint: 'https://influx.example.com', status: 401 });
      // The export itself still targets the configured URL.
      expect(fetchMock.mock.calls[1]?.[0]).toBe('https://influx.example.com/write?db=nd&u=admin&p=S3CRET-QS');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('F286: releases the response body after every export', async () => {
    const res = new Response('{"ok":true}', { status: 503 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));
    try {
      const { run, errors } = directExport('https://otel.example.com/v1/ingest');
      await run();
      expect(res.bodyUsed).toBe(true);
      expect(errors).toEqual([expect.objectContaining({ status: 503 })]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
