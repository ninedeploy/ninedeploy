import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NineDeployKernel } from '../../src/kernel/kernel.js';
import { WebhookOutPlugin } from '../../src/kernel/plugins/webhookOut.js';

const ENDPOINT = 'https://example.test/hook';
const SECRET = 'super-secret-key-32-chars-or-more!!';
const fetchMock = vi.fn();

// `ConfigCenter.getSecret` decrypts the value through `lib/crypto.js`. In a
// real deployment the stored value is a JSON envelope; in tests we keep the
// mock value as a plain string and stub `decrypt` to round-trip it.
vi.mock('../../src/lib/crypto.js', () => ({
  encrypt: vi.fn((v: string) => v),
  decrypt: vi.fn((v: string) => v),
}));

/**
 * Sprint 1, Gap G-06.
 *
 * The plugin's contract has three layers:
 *   1. Pure helpers `WebhookOutPlugin.signBody` / `verifySignature` — the
 *      wire format the consumer sees.
 *   2. Kernel wiring — the plugin subscribes to `deployment.status_changed`
 *      and `alert.triggered`, and the listener subscribes in `init()` /
 *      releases in `destroy()`.
 *   3. Dispatch behaviour — the listener honours the `enabled`, `endpoint`,
 *      `signing_secret`, `events`, and `timeout_ms` config keys, posts
 *      a HMAC-signed JSON body, and surfaces failures as
 *      `webhook.out_error` custom events.
 */
describe('WebhookOutPlugin.signBody / verifySignature', () => {
  it('produces a sha256=hex signature that verifySignature accepts', () => {
    const body = JSON.stringify({ event: 'ping', ts: '2026-01-01T00:00:00Z' });
    const sig = WebhookOutPlugin.signBody(body, SECRET);
    expect(sig.startsWith('sha256=')).toBe(true);
    expect(WebhookOutPlugin.verifySignature(body, SECRET, sig)).toBe(true);
  });

  it('rejects signatures that match a different secret', () => {
    const body = 'unchanged-body';
    const sig = WebhookOutPlugin.signBody(body, SECRET);
    expect(WebhookOutPlugin.verifySignature(body, 'different-secret!!', sig)).toBe(false);
  });

  it('rejects signatures that match a tampered body', () => {
    const sig = WebhookOutPlugin.signBody('original', SECRET);
    expect(WebhookOutPlugin.verifySignature('tampered', SECRET, sig)).toBe(false);
  });

  it('rejects signatures that are not the same length (no oracle)', () => {
    // Short headers must be rejected without timingSafeEqual blowing up on
    // mismatched buffer lengths. Any falsy result is acceptable as long as
    // the call returns rather than throwing.
    expect(WebhookOutPlugin.verifySignature('any body', SECRET, 'sha256=abc')).toBe(false);
  });

  it('matches the canonical crypto.hmac output (no prefix drift)', () => {
    const body = 'canonical';
    const ours = WebhookOutPlugin.signBody(body, SECRET);
    const expected = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
    expect(ours).toBe(expected);
  });
});

describe('WebhookOutPlugin (kernel integration)', () => {
  const makeDb = () => ({
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
  });

  const mockConfig = {
    port: 3000,
    host: '0.0.0.0',
    jwtSecret: 'test-secret-at-least-32-chars-long-12345',
    dataDir: '/tmp/ninedeploy-test',
  };

  let kernel: NineDeployKernel;
  let plugin: WebhookOutPlugin;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: a healthy 200. Tests that need a different status mutate
    // `fetchMock.mockResolvedValueOnce(...)` on a per-case basis.
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    kernel = new NineDeployKernel(makeDb() as never, mockConfig);
    plugin = new WebhookOutPlugin();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('r168: a failing config read is caught by the bus, never an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const busLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    kernel.db.query.configEntries.findFirst.mockRejectedValue(new Error('SQLITE_BUSY') as never);

    await kernel.registerPlugin(plugin);
    kernel.events.emit('deployment.status_changed', { deploymentId: 1, status: 'success' });
    await new Promise((r) => setTimeout(r, 30));

    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(busLog).toHaveBeenCalledWith(expect.stringContaining('Uncaught async error'), expect.any(Error));
    busLog.mockRestore();
  });

  it('does nothing when `enabled` is false', async () => {
    // findFirst is called for both `enabled` and `endpoint`; the first
    // call returns `false`, the second the endpoint. We only need the
    // first one to short-circuit the plugin.
    kernel.db.query.configEntries.findFirst
      .mockResolvedValueOnce({ value: 'false' } as never) // enabled = false
      .mockResolvedValue(undefined as never);

    await kernel.registerPlugin(plugin);
    kernel.events.emit('deployment.status_changed', { deploymentId: 1, status: 'success' });

    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing when `endpoint` is empty', async () => {
    kernel.db.query.configEntries.findFirst
      .mockResolvedValueOnce({ value: 'true' } as never) // enabled
      .mockResolvedValueOnce({ value: '' } as never) // endpoint = ''
      .mockResolvedValue(undefined as never);

    await kernel.registerPlugin(plugin);
    kernel.events.emit('deployment.status_changed', { deploymentId: 1, status: 'success' });

    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing when `signing_secret` is missing', async () => {
    kernel.db.query.configEntries.findFirst
      .mockResolvedValueOnce({ value: 'true' } as never) // enabled
      .mockResolvedValueOnce({ value: ENDPOINT } as never) // endpoint
      .mockResolvedValueOnce(null as never) // signing_secret = null
      .mockResolvedValue(undefined as never);

    await kernel.registerPlugin(plugin);
    kernel.events.emit('deployment.status_changed', { deploymentId: 1, status: 'success' });

    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing when the event name is not in the `events` allowlist', async () => {
    kernel.db.query.configEntries.findFirst
      .mockResolvedValueOnce({ value: 'true' } as never) // enabled
      .mockResolvedValueOnce({ value: ENDPOINT } as never) // endpoint
      .mockResolvedValueOnce({ value: SECRET, isSecret: true } as never) // signing_secret
      .mockResolvedValueOnce({ value: JSON.stringify(['alert.triggered']) } as never) // events
      .mockResolvedValue(undefined as never);

    await kernel.registerPlugin(plugin);
    // `deployment.status_changed` is NOT in the allowlist above.
    kernel.events.emit('deployment.status_changed', { deploymentId: 1, status: 'success' });

    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts a HMAC-signed body to the configured endpoint', async () => {
    kernel.db.query.configEntries.findFirst
      .mockResolvedValueOnce({ value: 'true' } as never)
      .mockResolvedValueOnce({ value: ENDPOINT } as never)
      .mockResolvedValueOnce({ value: SECRET, isSecret: true } as never)
      .mockResolvedValueOnce(null as never) // events — fall through to default
      .mockResolvedValue(undefined as never);

    await kernel.registerPlugin(plugin);
    const payload = { deploymentId: 42, status: 'ready' as const };
    kernel.events.emit('deployment.status_changed', payload);

    await new Promise((r) => setTimeout(r, 30));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-ninedeploy-event']).toBe('deployment.status_changed');
    expect(headers['x-ninedeploy-signature'].startsWith('sha256=')).toBe(true);

    const body = init.body as string;
    expect(JSON.parse(body)).toMatchObject({
      event: 'deployment.status_changed',
      data: payload,
    });
    // The wire signature must verify with the same secret.
    expect(WebhookOutPlugin.verifySignature(body, SECRET, headers['x-ninedeploy-signature'])).toBe(true);
  });

  it('emits webhook.out_error when the consumer returns a non-2xx status', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 502 }));

    kernel.db.query.configEntries.findFirst
      .mockResolvedValueOnce({ value: 'true' } as never)
      .mockResolvedValueOnce({ value: ENDPOINT } as never)
      .mockResolvedValueOnce({ value: SECRET, isSecret: true } as never)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValue(undefined as never);

    await kernel.registerPlugin(plugin);
    const errors: unknown[] = [];
    kernel.events.onCustom('webhook.out_error', (payload) => errors.push(payload));

    // `alert.triggered` is in the default `events` allowlist.
    kernel.events.emit('alert.triggered', { title: 'CPU', message: 'hot', level: 'warn' });

    await new Promise((r) => setTimeout(r, 30));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ event: 'alert.triggered', status: 502 });
  });

  it('emits webhook.out_error on the upper bound of the non-2xx range (status = 300)', async () => {
    // 300 is the first non-2xx — the `status >= 300` branch was not hit
    // by the 502 test alone. `fetchMock.mockResolvedValueOnce` resets the
    // default 200 we set in beforeEach, so this single shot is all we need.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response('', { status: 300 }));

    kernel.db.query.configEntries.findFirst
      .mockResolvedValueOnce({ value: 'true' } as never)
      .mockResolvedValueOnce({ value: ENDPOINT } as never)
      .mockResolvedValueOnce({ value: SECRET, isSecret: true } as never)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValue(undefined as never);

    await kernel.registerPlugin(plugin);
    const errors: unknown[] = [];
    kernel.events.onCustom('webhook.out_error', (payload) => errors.push(payload));

    kernel.events.emit('deployment.status_changed', { deploymentId: 7, status: 'failed' });

    await new Promise((r) => setTimeout(r, 30));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ event: 'deployment.status_changed', status: 300 });
  });

  it('emits webhook.out_error when fetch itself throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    kernel.db.query.configEntries.findFirst
      .mockResolvedValueOnce({ value: 'true' } as never)
      .mockResolvedValueOnce({ value: ENDPOINT } as never)
      .mockResolvedValueOnce({ value: SECRET, isSecret: true } as never)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValue(undefined as never);

    await kernel.registerPlugin(plugin);
    const errors: unknown[] = [];
    kernel.events.onCustom('webhook.out_error', (payload) => errors.push(payload));

    kernel.events.emit('deployment.status_changed', { deploymentId: 1, status: 'failed' });

    await new Promise((r) => setTimeout(r, 30));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ event: 'deployment.status_changed', reason: 'ECONNREFUSED' });
  });

  it('destroy() unsubscribes — events emitted afterwards are not posted', async () => {
    kernel.db.query.configEntries.findFirst
      .mockResolvedValueOnce({ value: 'true' } as never)
      .mockResolvedValueOnce({ value: ENDPOINT } as never)
      .mockResolvedValueOnce({ value: SECRET, isSecret: true } as never)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValue(undefined as never);

    await kernel.registerPlugin(plugin);
    plugin.destroy!(kernel as never);

    kernel.events.emit('deployment.status_changed', { deploymentId: 1, status: 'success' });

    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
