// `ConfigCenter.getSecret` decrypts through `lib/crypto.js`. We stub the
// module so the test can store a plain secret and the kernel round-trips
// it without paying the cost of a real GCM cipher. The plugin's own
// `signBody` helper is pure (`crypto.createHmac` only), so the HMAC test
// stays honest. Kept in a separate file from `telemetryExport.test.ts` so
// pulling in `@node-rs/argon2` via the unmocked path is opt-in.
vi.mock('../../src/lib/crypto.js', () => ({
  encrypt: (v: string) => v,
  decrypt: (v: string) => v,
}));

import { describe, expect, it, vi } from 'vitest';
import { NineDeployKernel } from '../../src/kernel/kernel.js';
import { TelemetryStreamerPlugin } from '../../src/kernel/plugins/telemetry.js';

describe('TelemetryStreamerPlugin HMAC signing', () => {
  const EXPORT_URL = 'https://otel.example.com/v1/ingest';
  const SECRET = 's3cret-key-32-chars-or-more-padded!!';

  const mockConfig = {
    port: 3000,
    host: '0.0.0.0',
    jwtSecret: 'test-secret-at-least-32-chars-long-12345',
    dataDir: '/tmp/ninedeploy-test',
  };

  it('signs every POSTed body with HMAC-SHA256 when signing_secret is set', async () => {
    const localDb = {
      query: {
        configEntries: {
          findMany: vi.fn().mockResolvedValue([]),
          findFirst: vi
            .fn()
            .mockResolvedValueOnce({ value: EXPORT_URL } as never)
            .mockResolvedValueOnce({ value: SECRET, isSecret: true } as never)
            .mockResolvedValueOnce(null as never)
            .mockResolvedValue(undefined as never),
        },
      },
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockResolvedValue([]),
        }),
      }),
    };
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
      const headers = init.headers as Record<string, string>;
      expect(headers['x-ninedeploy-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
      const body = String(init.body);
      // The wire signature must verify with the same secret.
      expect(TelemetryStreamerPlugin.signBody(body, SECRET)).toBe(
        headers['x-ninedeploy-signature'],
      );
    } finally {
      vi.unstubAllGlobals();
      plugin.destroy();
    }
  });
});
