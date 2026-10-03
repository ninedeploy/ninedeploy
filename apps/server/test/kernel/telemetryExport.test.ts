import { describe, expect, it, vi } from 'vitest';
import { NineDeployKernel } from '../../src/kernel/kernel.js';
import { TelemetryStreamerPlugin } from '../../src/kernel/plugins/telemetry.js';
import { NotificationsDispatcherPlugin } from '../../src/kernel/plugins/notifications.js';

describe('TelemetryStreamerPlugin export', () => {
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
          findFirst: vi.fn().mockImplementation(() => {
            return Promise.resolve(queue.shift() ?? undefined);
          }),
        },
      },
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockResolvedValue([]),
        }),
      }),
    };
  }

  it('POSTs every record to the configured export_endpoint', async () => {
    const localDb = makeDb([{ value: EXPORT_URL }, undefined, null]);
    const kernel = new NineDeployKernel(localDb as never, mockConfig);
    const plugin = new TelemetryStreamerPlugin();
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await kernel.registerPlugin(plugin);
      kernel.events.emit('custom.system_event', { key: 'value' });
      await new Promise((r) => setTimeout(r, 30));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(EXPORT_URL);
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers['content-type']).toBe('application/json');
      expect(headers['x-ninedeploy-signature']).toBeUndefined();
      const body = String(init.body);
      expect(JSON.parse(body)).toMatchObject({
        sourceEvent: 'custom.system_event',
        data: { key: 'value' },
      });
    } finally {
      vi.unstubAllGlobals();
      plugin.destroy();
    }
  });

  it('does not re-emit plugin.registered as a telemetry record', async () => {
    const localDb = makeDb([{ value: EXPORT_URL }, undefined, null]);
    const kernel = new NineDeployKernel(localDb as never, mockConfig);
    const plugin = new TelemetryStreamerPlugin();
    const recorded: unknown[] = [];
    kernel.events.on('telemetry.recorded', (p) => recorded.push(p));
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await kernel.registerPlugin(plugin);
      await new Promise((r) => setTimeout(r, 30));
      expect(recorded).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      plugin.destroy();
    }
  });
});

describe('NotificationsDispatcherPlugin menu', () => {
  const mockConfig = {
    port: 3000,
    host: '0.0.0.0',
    jwtSecret: 'test-secret-at-least-32-chars-long-12345',
    dataDir: '/tmp/ninedeploy-test',
  };

  const mockDb = {
    query: {
      configEntries: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(undefined),
      },
    },
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue([]),
      }),
    }),
  };

  it('registers a command-palette menu item pointing to the notifications section', async () => {
    const kernel = new NineDeployKernel(mockDb as never, mockConfig);
    const plugin = new NotificationsDispatcherPlugin();
    await kernel.registerPlugin(plugin);
    try {
      const items = kernel.menuRegistry.getItemsForSlot('command:palette', true);
      const me = items.find((i) => i.id === 'notifications-dispatcher-command');
      expect(me).toBeDefined();
      expect(me?.route).toBe('/settings?section=notifications');
      expect(me?.slot).toBe('command:palette');
    } finally {
      plugin.destroy();
    }
  });
});
