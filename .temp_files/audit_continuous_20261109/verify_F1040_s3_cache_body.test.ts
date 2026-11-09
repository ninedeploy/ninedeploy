import { expect, it, vi } from 'vitest';
import { S3BuildCache } from '../../apps/server/src/kernel/drivers/s3BuildCache.js';
const config = { endpoint: 'https://fixture.invalid', bucket: 'fixture', region: 'fixture', accessKeyId: 'fixture', secretAccessKey: 'fixture' };
it('releases repeated misses, null bodies and failed cancellation without touching a valid hit', async () => {
  let cancellations = 0;
  try {
    const cache = new S3BuildCache({ config });
    for (const status of [301, 403, 404, 429, 500, 503]) {
      for (const mode of ['normal', 'reject', 'empty']) {
        const body = mode === 'empty' ? null : new ReadableStream({ cancel() {
          cancellations++;
          if (mode === 'reject') throw new Error('fixture cleanup failure');
        } });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })));
        await expect(cache.lookup('missing')).resolves.toBeNull();
      }
    }
    expect(cancellations).toBe(12);
    expect((await cache.stats()).misses).toBe(18);
    const response = new Response(JSON.stringify({ digest: `sha256:${'a'.repeat(64)}`, sizeBytes: 3 }));
    vi.stubGlobal('fetch', vi.fn(async () => response));
    await expect(cache.lookup('hit')).resolves.toMatchObject({ sizeBytes: 3 });
    expect(response.bodyUsed).toBe(true);
    expect((await cache.stats()).hits).toBe(1);
    let release!: () => void, entered!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel() { entered(); return done; } }), { status: 404 })));
    let settled = false;
    const pending = cache.lookup('gated').finally(() => { settled = true; });
    await Promise.race([started, pending]);
    expect(settled).toBe(false);
    release();
    await expect(pending).resolves.toBeNull();
    expect((await cache.stats()).misses).toBe(19);
    console.log('EXPECTED: 18 misses cleaned or bodyless, hit consumed | ACTUAL: 12 cancellations, 18 misses, 1 hit');
    console.log('GATED: lookup waits until body cancellation completes; final misses=19');
    console.log('FIX VERIFIED');
  } finally { vi.unstubAllGlobals(); }
});
