import { expect, it, vi } from 'vitest';
import { S3BuildCache } from '../../apps/server/src/kernel/drivers/s3BuildCache.js';
const config = { endpoint: 'https://fixture.invalid', bucket: 'fixture', region: 'fixture', accessKeyId: 'fixture', secretAccessKey: 'fixture' };
it('releases an unused cache-miss response body', async () => {
  try {
    const cache = new S3BuildCache({ config });
    const control = new Response(JSON.stringify({ digest: `sha256:${'a'.repeat(64)}`, sizeBytes: 1 }), { status: 200 });
    vi.stubGlobal('fetch', vi.fn(async () => control));
    expect(await cache.lookup('control')).not.toBeNull();
    expect(control.bodyUsed).toBe(true);
    console.log('CONTROL EXPECTED: hit body consumed | ACTUAL:', control.bodyUsed);
    let cancelled = false;
    const miss = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 404 });
    vi.stubGlobal('fetch', vi.fn(async () => miss));
    expect(await cache.lookup('missing')).toBeNull();
    console.log('EXPECTED: miss body released | ACTUAL:', { cancelled, bodyUsed: miss.bodyUsed });
    console.log(cancelled || miss.bodyUsed ? 'PROBLEM NOT REPRODUCED' : 'PROBLEM CONFIRMED');
    expect(cancelled || miss.bodyUsed).toBe(true);
  } finally { vi.unstubAllGlobals(); }
});
