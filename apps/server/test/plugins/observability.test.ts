import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { metrics, configEntries } from '@ninedeploy/db';
import { eq } from 'drizzle-orm';
import observabilityPlugin from '../../src/plugins/observability.js';
import { observabilityDb } from '../fixtures/observability.js';

const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../src/lib/egressGuard.js', () => ({ guardedFetch: network.fetch }));
const resources: Array<{ app: ReturnType<typeof Fastify>; f: Awaited<ReturnType<typeof observabilityDb>> }> = [];
afterEach(async () => {
  for (const { app, f } of resources.splice(0)) { await app.close(); f.close(); }
  vi.useRealTimers(); vi.restoreAllMocks(); network.fetch.mockReset();
});
async function fixture() {
  const f = await observabilityDb();
  const app = Fastify();
  resources.push({ app, f });
  app.decorate('db', f.db);
  await f.db.insert(metrics).values({ serviceId: 1, kind: 'cpu', value: 1250, ts: new Date() });
  return { app, f, start: async () => { await app.register(observabilityPlugin); await app.ready(); } };
}
describe('resource export lifecycle', () => {
  it('keeps disabled export offline without inventing an attempt', async () => {
    const { app, start } = await fixture();
    await start();
    expect(await app.observability.exportNow()).toMatchObject({ ok: false, error: 'not_configured' });
    expect(network.fetch).not.toHaveBeenCalled();
    expect(app.observability.status()).toEqual({ lastAttemptAt: null, lastSuccessAt: null, result: null });
  });
  it('exports automatically after 15 seconds and repeats after 30 seconds without overlapping cycles', async () => {
    const { app, f, start } = await fixture();
    await f.configure({ otlpEndpoint: 'https://collector.example/v1/metrics' });
    network.fetch.mockImplementation(async () => new Response('{}', { status: 200 }));
    vi.useFakeTimers();
    await start();
    await vi.advanceTimersByTimeAsync(14999);
    expect(network.fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(app.observability.status().result).toMatchObject({ ok: true, samples: 1 }));
    expect(network.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30000);
    await vi.waitFor(() => expect(network.fetch).toHaveBeenCalledTimes(2));
    await app.close();
    await vi.advanceTimersByTimeAsync(60000);
    expect(network.fetch).toHaveBeenCalledTimes(2);
  });
  it('coalesces concurrent tests and aborts an active network request on shutdown', async () => {
    const { app, f, start } = await fixture();
    await f.configure({ otlpEndpoint: 'https://collector.example/v1/metrics' });
    let captured: AbortSignal | undefined;
    network.fetch.mockImplementation((_url, opts) => new Promise((_resolve, reject) => {
      captured = opts.signal;
      captured!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }));
    await start();
    const first = app.observability.exportNow(), second = app.observability.exportNow();
    await vi.waitFor(() => expect(network.fetch).toHaveBeenCalledTimes(1));
    await app.close();
    expect(captured?.aborted).toBe(true);
    expect(await first).toMatchObject({ ok: false, error: 'transport_or_protocol_error' });
    expect(await second).toEqual(await first);
  });
  it('fails closed on unreadable settings and retains the previous success timestamp on a later failure', async () => {
    const { app, f, start } = await fixture();
    await f.configure({ otlpEndpoint: 'https://collector.example/v1/metrics' });
    network.fetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await start(); await app.observability.exportNow();
    const previous = app.observability.status().lastSuccessAt;
    expect(previous).not.toBeNull();
    await f.db.update(configEntries).set({ value: 'broken ciphertext' }).where(eq(configEntries.key, 'observability.settings'));
    expect(await app.observability.exportNow()).toMatchObject({ ok: false, error: 'settings_or_samples_unavailable' });
    expect(network.fetch).toHaveBeenCalledTimes(1);
    expect(app.observability.status().lastSuccessAt).toBe(previous);
  });
});
